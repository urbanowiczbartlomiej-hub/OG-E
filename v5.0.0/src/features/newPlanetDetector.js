// New-planet detector — paints a prominent center-screen banner when
// the player has just colonized a planet and hasn't confirmed it yet.
//
// # Why this feature exists
//
// After a successful colonize landing, OGame adds a new row to
// `#planetList` but gives no loud visual cue — the freshly-minted
// planet is just another tiny thumbnail, easy to miss amidst 8+
// existing colonies. Missing the landing is bad: the player may want
// to inspect the planet's field count immediately so they can decide
// whether to keep it (via `abandonOverview` flow below the threshold)
// or build on it (confirming the keep). This banner makes the new
// planet impossible to miss and one-clicks into the overview page.
//
// # Four-phase lifecycle
//
// Every content-script mount runs the same five steps, and the store
// is always in agreement with the DOM by the time the banner call is
// made. Phases may each mutate the store (via the persist wiring) but
// all reads of the "new" set come from the in-memory mirror after all
// phases have run.
//
//   1. INITIAL SEED. If the known set is empty on load AND the planet
//      list has entries, we seed ALL current CPs at once. This keeps
//      a fresh install from painting a banner for every existing
//      planet — nothing is "new" the very first time we see a player.
//
//   2. CLEANUP — abandoned planets. Known CPs missing from the
//      current list are removed. Without this step, abandoning a
//      planet (via the existing `abandonOverview` flow or the game's
//      native giveup) would leave a stale CP in the set forever,
//      growing the persisted payload unbounded over months.
//
//   3. MARK-BUILT ON OVERVIEW. If the URL says we're on
//      `component=overview&cp=X` and X is currently "new" (in list,
//      not in known), we read `#diameterContentField` and parse its
//      `(used/max)` tuple. When `used > 0` the user has built at
//      least one field on the planet — that is our "confirm keep"
//      signal — so we add X to known. If `used === 0` we leave the
//      set alone; the user may still be deciding, and could hand off
//      to the `abandonOverview` flow.
//
//   4. DETECT. After phases 1-3, `new = current - known` contains
//      exactly the planets the user has colonized but not confirmed.
//      Per the queue-like UX, only the FIRST entry is surfaced — once
//      the user resolves it (builds OR abandons), the next mount
//      picks up whichever entry is next.
//
// # Why no MutationObserver
//
// `#planetList` only updates on a full page reload in the game's
// current flow (the game server-renders the planet list in every
// top-level navigation). Because our content script reinstalls on
// every page load — which is when `#planetList` changes — a
// MutationObserver would just add noise.
//
// # Banner UX notes
//
// We show the banner fixed at the top-1/3 center of the viewport
// with an eye-catching warm background and a high z-index so it wins
// against the game's own overlays. Click → direct navigation to the
// planet's overview. We intentionally do NOT render the banner when
// the user is already on the overview of that same cp — that would
// be redundant, and would double-trigger briefly on the mark-built
// cycle if the user is just now building the first field.
//
// @see ../state/knownPlanets.js — the persisted Set this feature is
//   the sole writer of.
// @see ./abandonOverview.js — orthogonal: handles the "too small,
//   giveup" flow. A planet can be below the fields threshold AND
//   new; the two overlays are independent and both appear.
//
// @ts-check

import { knownPlanetsStore } from '../state/knownPlanets.js';

/**
 * DOM id of the banner element. Stable so repeated `showBanner` calls
 * short-circuit and so tests / CSS overrides can target it.
 */
const BANNER_ID = 'oge5-new-planet-banner';

/**
 * One entry from `#planetList`, projected to just the fields this
 * module needs to render the banner and key the store.
 *
 * @typedef {object} PlanetEntry
 * @property {number} cp
 *   Planet cp-id. Parsed from `id="planet-<cp>"` on the `.smallplanet`
 *   row. Must be finite and positive to be included.
 * @property {string} coords
 *   Coords string as the game renders them — `"[g:s:p]"` with the
 *   brackets included — read from `.planet-koords`. May be empty on
 *   broken DOMs; consumers treat empty as "unknown coords".
 * @property {string} name
 *   Planet name as the game renders it — read from `.planet-name`.
 *   May be empty; consumers treat empty as "unknown name".
 */

/**
 * Read every `#planetList .smallplanet[id^="planet-"]` row into a
 * {@link PlanetEntry} array. Rows whose id is unparseable or whose cp
 * is non-finite are dropped silently — a corrupt row in the page
 * shouldn't block the banner from appearing for the other planets.
 *
 * @returns {PlanetEntry[]}
 */
const getCurrentPlanets = () => {
  const rows = document.querySelectorAll(
    '#planetList .smallplanet[id^="planet-"]',
  );
  /** @type {PlanetEntry[]} */
  const out = [];
  for (const row of rows) {
    const id = row.id;
    if (!id || !id.startsWith('planet-')) continue;
    const cp = parseInt(id.slice('planet-'.length), 10);
    if (!Number.isFinite(cp) || cp <= 0) continue;
    const coords = (row.querySelector('.planet-koords')?.textContent ?? '').trim();
    const name = (row.querySelector('.planet-name')?.textContent ?? '').trim();
    out.push({ cp, coords, name });
  }
  return out;
};

/**
 * First-run bootstrap: when the store is empty AND we have at least
 * one current planet, seed ALL current CPs into the store at once.
 * No-op otherwise (including the edge case where both are empty).
 *
 * @param {PlanetEntry[]} current
 * @returns {void}
 */
const maybeSeedFirstRun = (current) => {
  const known = knownPlanetsStore.get();
  if (known.size > 0) return;
  if (current.length === 0) return;
  const next = new Set(current.map((p) => p.cp));
  knownPlanetsStore.set(next);
};

/**
 * Remove any stored CP that is not in the current planet list. Fires
 * when the user has abandoned a planet between mounts (either via our
 * own `abandonOverview` flow or the game's native giveup panel).
 *
 * No-op when no pruning is needed, which is the common case. When a
 * diff IS found we build a fresh Set rather than mutating in place —
 * the persist wiring subscribes on `set`, so mutating the existing
 * Set would not fire write-through.
 *
 * @param {PlanetEntry[]} current
 * @returns {void}
 */
const pruneAbandoned = (current) => {
  const known = knownPlanetsStore.get();
  if (known.size === 0) return;
  const currentCps = new Set(current.map((p) => p.cp));
  /** @type {Set<number>} */
  const next = new Set();
  let dropped = false;
  for (const cp of known) {
    if (currentCps.has(cp)) {
      next.add(cp);
    } else {
      dropped = true;
    }
  }
  if (dropped) knownPlanetsStore.set(next);
};

/**
 * Return the current URL's cp value iff the URL says we're on the
 * overview page. `null` otherwise — the caller bails the mark-built
 * phase entirely in that case.
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
 * When on an overview page AND its cp is currently in the
 * "new" bucket, read `#diameterContentField` and confirm the planet
 * if the user has already built something on it. Mirrors the
 * `(used/max)` parsing used by `abandonOverview` / `abandon.js`.
 *
 * @param {PlanetEntry[]} current
 * @returns {void}
 */
const markBuiltOnOverview = (current) => {
  const overviewCp = getOverviewCp();
  if (overviewCp === null) return;
  // Must be in the current list (no point confirming a planet that
  // has disappeared from our list since) and NOT yet known.
  const known = knownPlanetsStore.get();
  if (known.has(overviewCp)) return;
  if (!current.some((p) => p.cp === overviewCp)) return;
  const field = document.getElementById('diameterContentField');
  const text = field?.textContent ?? '';
  const m = text.match(/\((\d+)\/(\d+)\)/);
  if (!m) return;
  const used = parseInt(m[1], 10);
  if (!Number.isFinite(used) || used <= 0) return;
  const next = new Set(known);
  next.add(overviewCp);
  knownPlanetsStore.set(next);
};

/**
 * Compute the "new" (unknown) subset of current planets, preserving
 * the order they appear in `#planetList`. Used by the detector to
 * pick the first new planet to banner.
 *
 * @param {PlanetEntry[]} current
 * @returns {PlanetEntry[]}
 */
const computeNew = (current) => {
  const known = knownPlanetsStore.get();
  return current.filter((p) => !known.has(p.cp));
};

/**
 * True iff `location.search` says we're on the overview of exactly
 * the given cp. Used to suppress the banner when navigating would
 * be a no-op (we're already there).
 *
 * @param {number} cp
 * @returns {boolean}
 */
const isOnOverviewOfCp = (cp) => getOverviewCp() === cp;

/**
 * Build the overview URL for the given cp. Base is derived from
 * `location.href` so we stay on the origin/path the game served; the
 * query tail is dropped to avoid leaking stale params into the nav.
 *
 * @param {number} cp
 * @returns {string}
 */
const buildOverviewUrl = (cp) => {
  const base = location.href.split('?')[0];
  return `${base}?page=ingame&component=overview&cp=${cp}`;
};

/**
 * Remove the banner if present. Safe to call when not mounted.
 *
 * @returns {void}
 */
const removeBanner = () => {
  const el = document.getElementById(BANNER_ID);
  if (el) el.remove();
};

/**
 * Mount the banner for `planet`. Idempotent — bails early if the
 * banner element already exists (e.g. double-call in the same mount
 * phase). The banner is a fixed-position body-level child; we don't
 * insert it into `#planetList` because AJAX swaps inside the game
 * could nuke it.
 *
 * @param {PlanetEntry} planet
 * @returns {void}
 */
const showBanner = (planet) => {
  if (document.getElementById(BANNER_ID)) return;
  if (!document.body) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.style.cssText = [
    'position:fixed',
    'top:25%',
    'left:50%',
    'transform:translateX(-50%)',
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
  ].join(';');

  const titleLine = document.createElement('div');
  titleLine.textContent = '\uD83C\uDF0D Nowa planeta';
  titleLine.style.cssText = 'font-size:18px;margin-bottom:6px;opacity:0.9';

  // Coords + name is the decisive signal — paint it biggest so the
  // user can read it at a glance and decide whether to click.
  const bigLine = document.createElement('div');
  const coordsText = planet.coords || '';
  const nameText = planet.name ? ` ${planet.name}` : '';
  bigLine.textContent = `${coordsText}${nameText}`.trim();
  bigLine.style.cssText = 'font-size:28px;margin:4px 0;line-height:1.1;letter-spacing:1px';

  const hintLine = document.createElement('div');
  hintLine.textContent = 'click to inspect';
  hintLine.style.cssText = 'font-size:12px;opacity:0.8;margin-top:6px';

  banner.appendChild(titleLine);
  banner.appendChild(bigLine);
  banner.appendChild(hintLine);

  banner.addEventListener('click', () => {
    location.href = buildOverviewUrl(planet.cp);
  });

  document.body.appendChild(banner);
};

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make `installNewPlanetDetector`
 * idempotent (second call returns the same dispose without touching
 * DOM or the store).
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the new-planet detector. Runs the four-phase lifecycle
 * documented in the file header and then either mounts the banner
 * for the first unknown planet or removes it.
 *
 * Idempotent: calling `installNewPlanetDetector()` a second time
 * while already installed returns the SAME dispose fn as the first
 * call without re-running the lifecycle.
 *
 * @returns {() => void} Dispose handle — removes the banner.
 */
export const installNewPlanetDetector = () => {
  if (installed) return installed.dispose;

  const current = getCurrentPlanets();

  // Phases 1-3 may each write to `knownPlanetsStore` — the persist
  // wiring takes care of propagating those writes to chrome.storage.
  maybeSeedFirstRun(current);
  pruneAbandoned(current);
  markBuiltOnOverview(current);

  // Phase 4 — compute + paint.
  const newOnes = computeNew(current);
  if (newOnes.length > 0 && !isOnOverviewOfCp(newOnes[0].cp)) {
    showBanner(newOnes[0]);
  } else {
    removeBanner();
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
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM
 * and fresh module state. Exported with a `_` prefix to signal
 * "do not import from production code".
 *
 * @returns {void}
 */
export const _resetNewPlanetDetectorForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  // Also scrub the banner in case it was mounted outside the install
  // sentinel (defensive — the module doesn't expose that path, but a
  // test that manipulates DOM directly wouldn't want leftover state).
  removeBanner();
};
