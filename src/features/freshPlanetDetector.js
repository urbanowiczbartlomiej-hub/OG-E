// @ts-check

import { installDrag } from '../lib/draggableButton.js';
import { safeLS } from '../lib/storage.js';

// Fresh-planet detector — scans `#planetList` on every mount for a
// colony where nothing has been built yet (`usedFields === 0`) and
// paints a top-of-screen banner pointing to the first one. Clicking
// the banner navigates to that planet's overview, where
// `abandonOverview.js` takes over with the red abandon overlay. The
// banner is draggable (same drag helper as sendExp/sendCol) and its
// position is persisted, so the user can park it anywhere on screen
// and only the first arrival-load needs a conscious placement.
//
// # Why the criterion is strictly `used === 0`
//
// Triggering the banner for any planet below `colMinFields` would
// produce false positives: a colony with ~100 fields built
// (legitimately kept, mid-build) falls under the threshold and keeps
// flashing the banner on every page load. The signal the user
// actually wants is "you just colonized here and haven't touched it
// yet — decide if you're keeping". That is exactly `used === 0`: the
// moment the user lays down ONE field the banner disappears.
//
// # Lifecycle
//
//   1. install scans `#planetList`, picks the first row whose
//      `usedFields === 0`, paints the banner.
//   2. dispose removes the banner.
//
// No store subscriptions: the criterion doesn't depend on any
// setting. The banner is re-evaluated on the next page load — OGame
// reloads on every top-level navigation, so this is more than often
// enough. If a future setting needs to affect banner visibility, add
// a subscription then, not speculatively.
//
// # Why no MutationObserver
//
// `#planetList` only repaints on a full page load, and our content
// script reinstalls on every page load. A MutationObserver would
// just add noise.
//
// @see ./abandon/overview.js — the overview-page overlay that actions
//   the candidate the banner points to.

/** Stable DOM id of the banner — lets re-paints dedupe on it. */
const BANNER_ID = 'oge-fresh-planet-banner';

/** localStorage key for the dragged banner position `{ x, y }`. */
const POS_KEY = 'oge_freshPlanetBannerPos';

/**
 * One planet-list row projected to just the fields the banner needs.
 * `used` / `max` are the parsed field counts from the tooltip's
 * `(used/max)` parenthetical.
 *
 * @typedef {object} PlanetRow
 * @property {number} cp
 * @property {string} coords `[g:s:p]` with brackets.
 * @property {string} name   Planet display name, may be empty.
 * @property {number} used   Currently built fields.
 * @property {number} max    Maximum field slots on the planet.
 */

/** Matches the `[g:s:p]` coord block in a tooltip's `<b>` header. */
const COORD_RE = /\[(\d+):(\d+):(\d+)\]/;

/**
 * Matches the `DDD.DDkm (used/max)` parenthetical in a tooltip. OGame
 * renders the diameter with a decimal point (thousand separator in
 * some locales, dot in others); `\d+(?:[.,]\d+)?` keeps the regex
 * locale-tolerant. The `km` anchor protects against stray "(X/Y)"
 * patterns that could appear elsewhere in the tooltip HTML.
 */
const FIELDS_RE = /(\d+(?:[.,]\d+)?)\s*km\s*\((\d+)\/(\d+)\)/;

/**
 * Parse one `.smallplanet` row from `#planetList` into the subset of
 * fields the banner cares about. Returns `null` when the row id, the
 * tooltip format, or the parsed numbers don't look right — we prefer
 * silently skipping a malformed row over blocking the whole feature.
 *
 * @param {Element} row
 * @returns {PlanetRow | null}
 */
const parsePlanetRow = (row) => {
  const id = row.id;
  if (!id || !id.startsWith('planet-')) return null;
  const cp = parseInt(id.slice('planet-'.length), 10);
  if (!Number.isFinite(cp) || cp <= 0) return null;

  const link = row.querySelector('.planetlink');
  if (!link) return null;
  const tooltip = link.getAttribute('data-tooltip-title') ?? '';
  if (!tooltip) return null;

  const coordMatch = tooltip.match(COORD_RE);
  const fieldsMatch = tooltip.match(FIELDS_RE);
  if (!coordMatch || !fieldsMatch) return null;

  const coords = `[${coordMatch[1]}:${coordMatch[2]}:${coordMatch[3]}]`;
  const used = parseInt(fieldsMatch[2], 10);
  const max = parseInt(fieldsMatch[3], 10);
  if (!Number.isFinite(used) || !Number.isFinite(max)) return null;

  const name = (row.querySelector('.planet-name')?.textContent ?? '').trim();
  return { cp, coords, name, used, max };
};

/**
 * Scan `#planetList` and return the first row whose `usedFields` is
 * exactly zero (i.e. a freshly-colonized planet where the user has
 * not built anything yet). Row order is preserved — we return the
 * first hit in document order, matching the sidebar's visual order.
 *
 * @returns {PlanetRow | null}
 */
export const findFirstFreshPlanet = () => {
  const rows = document.querySelectorAll(
    '#planetList .smallplanet[id^="planet-"]',
  );
  for (const row of rows) {
    const p = parsePlanetRow(row);
    if (!p) continue;
    if (p.used === 0) return p;
  }
  return null;
};

/**
 * Return the `cp` in `location.search` iff the URL says we're on the
 * overview page. Used to suppress the banner when navigating to it
 * would be a no-op (we're already there). `null` in every other case.
 *
 * @returns {number | null}
 */
const getOverviewCp = () => {
  const search = location.search || '';
  if (!search.includes('component=overview')) return null;
  const m = search.match(/[?&]cp=(\d+)/);
  if (!m) return null;
  const cp = parseInt(m[1], 10);
  return Number.isFinite(cp) && cp > 0 ? cp : null;
};

/**
 * Build the overview URL for `cp`. Base is derived from
 * `location.href` so we stay on whatever origin / path the game
 * served; the query tail is dropped to avoid leaking stale params.
 *
 * @param {number} cp
 * @returns {string}
 */
const buildOverviewUrl = (cp) => {
  const base = location.href.split('?')[0];
  return `${base}?page=ingame&component=overview&cp=${cp}`;
};

/**
 * Remove the banner if present. Safe to call when the banner is not
 * mounted.
 *
 * @returns {void}
 */
const removeBanner = () => {
  const el = document.getElementById(BANNER_ID);
  if (el) el.remove();
};

/**
 * Mount the banner for `planet`. Short-circuits if a banner is
 * already mounted for the same cp. The banner is draggable (position
 * persisted to {@link POS_KEY}) so the user can move it out of the
 * way without dismissing it — click is still a navigation shortcut
 * once released.
 *
 * @param {PlanetRow} planet
 * @returns {void}
 */
const showBanner = (planet) => {
  const existing = document.getElementById(BANNER_ID);
  if (existing && existing.dataset.cp === String(planet.cp)) return;
  if (existing) existing.remove();
  if (!document.body) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.dataset.cp = String(planet.cp);
  banner.style.cssText = [
    'position:fixed',
    'background:rgba(220, 120, 0, 0.95)',
    'color:#fff',
    'padding:20px 40px',
    'border:3px solid #fff',
    'border-radius:12px',
    'z-index:99998',
    'cursor:pointer',
    'text-align:center',
    'font-weight:bold',
    'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
    // `touch-action: none` keeps touch gestures from scrolling the
    // page while the user drags the banner. Matches sendExp/sendCol.
    'touch-action:none',
  ].join(';');

  const titleLine = document.createElement('div');
  titleLine.textContent = 'New planet';
  titleLine.style.cssText = 'font-size:18px;margin-bottom:6px;opacity:0.9';

  const bigLine = document.createElement('div');
  const nameText = planet.name ? ` ${planet.name}` : '';
  bigLine.textContent = `${planet.coords}${nameText}`.trim();
  bigLine.style.cssText =
    'font-size:28px;margin:4px 0;line-height:1.1;letter-spacing:1px';

  const fieldsLine = document.createElement('div');
  fieldsLine.textContent = `0/${planet.max} fields`;
  fieldsLine.style.cssText = 'font-size:14px;margin-top:4px;opacity:0.95';

  const hintLine = document.createElement('div');
  hintLine.textContent = 'click to open';
  hintLine.style.cssText = 'font-size:12px;opacity:0.8;margin-top:6px';

  banner.appendChild(titleLine);
  banner.appendChild(bigLine);
  banner.appendChild(fieldsLine);
  banner.appendChild(hintLine);

  document.body.appendChild(banner);

  // Position: restore from localStorage if the user dragged us
  // before, otherwise center horizontally at 25% from top. We need
  // the banner mounted first to measure its width for the default
  // center calculation.
  const saved = safeLS.json(POS_KEY, null);
  if (
    saved &&
    typeof (/** @type {any} */ (saved)).x === 'number' &&
    typeof (/** @type {any} */ (saved)).y === 'number'
  ) {
    banner.style.left = (/** @type {any} */ (saved)).x + 'px';
    banner.style.top = (/** @type {any} */ (saved)).y + 'px';
  } else {
    const w = banner.offsetWidth;
    const iw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const ih =
      window.innerHeight || document.documentElement.clientHeight || 768;
    banner.style.left = Math.max(0, Math.round((iw - w) / 2)) + 'px';
    banner.style.top = Math.round(ih * 0.25) + 'px';
  }

  // Wire drag. The banner's width is roughly text-dependent but the
  // drag helper only uses `size` to clamp to [0, viewport - size];
  // passing the actual measured width gives a correct clamp.
  const drag = installDrag({
    element: banner,
    posKey: POS_KEY,
    size: banner.offsetWidth,
  });

  banner.addEventListener('click', () => {
    if (drag.wasDrag()) {
      drag.resetDrag();
      return;
    }
    location.href = buildOverviewUrl(planet.cp);
  });
};

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Makes
 * {@link installFreshPlanetDetector} idempotent.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the fresh-planet detector. Scans `#planetList` once at
 * mount and paints the banner for the first `used === 0` row, unless
 * we're already on its overview page (in which case the click target
 * would be a no-op).
 *
 * Idempotent: calling `installFreshPlanetDetector()` twice while
 * installed returns the same dispose fn.
 *
 * @returns {() => void} Dispose — removes the banner.
 */
export const installFreshPlanetDetector = () => {
  if (installed) return installed.dispose;

  const match = findFirstFreshPlanet();
  if (match && getOverviewCp() !== match.cp) {
    showBanner(match);
  }

  installed = {
    dispose: () => {
      removeBanner();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs
 * the current dispose (if any) so each test case starts with a clean
 * DOM. Prefixed with `_` to signal "do not import from production
 * code".
 *
 * @returns {void}
 */
export const _resetFreshPlanetDetectorForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  removeBanner();
};
