// @ts-check

import { GAME } from '../../lib/gameDom.js';
import { ingameComponentUrl } from '../../domain/ogameUrl.js';

// Fresh-planet detection helpers — scan `#planetList` for a colony where
// nothing has been built yet (`usedFields === 0`) and project the page's
// overview-navigation bits. Pure DOM reads, no UI: the unified FAB's colony
// module (`./colonyFab.js`) consumes these to decide whether to surface the
// "new colony / abandon" button and where it navigates.
//
// # Why the criterion is strictly `used === 0`
//
// Triggering for any planet below `colonyMinFields` would produce false
// positives: a colony with ~100 fields built (legitimately kept, mid-build)
// falls under the threshold and would keep flashing. The signal the user
// actually wants is "you just colonized here and haven't touched it yet" —
// exactly `used === 0`; the moment one field is laid down the signal clears.

/**
 * One planet-list row projected to just the fields the colony FAB needs.
 * `used` / `max` are the parsed field counts from the tooltip's `(used/max)`
 * parenthetical.
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
 * Matches the `DDD.DDkm (used/max)` parenthetical in a tooltip. OGame renders
 * the diameter with a decimal point (thousand separator in some locales, dot in
 * others); `\d+(?:[.,]\d+)?` keeps the regex locale-tolerant. The `km` anchor
 * protects against stray "(X/Y)" patterns elsewhere in the tooltip HTML.
 */
const FIELDS_RE = /(\d+(?:[.,]\d+)?)\s*km\s*\((\d+)\/(\d+)\)/;

/**
 * Parse one `.smallplanet` row from `#planetList` into the subset of fields the
 * colony FAB cares about. Returns `null` when the row id, the tooltip format,
 * or the parsed numbers don't look right — we prefer silently skipping a
 * malformed row over blocking the whole feature.
 *
 * @param {Element} row
 * @returns {PlanetRow | null}
 */
const parsePlanetRow = (row) => {
  const id = row.id;
  if (!id || !id.startsWith('planet-')) return null;
  const cp = parseInt(id.slice('planet-'.length), 10);
  if (!Number.isFinite(cp) || cp <= 0) return null;

  const link = row.querySelector(GAME.PLANET_LINK);
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

  const name = (row.querySelector(GAME.PLANET_NAME)?.textContent ?? '').trim();
  return { cp, coords, name, used, max };
};

/**
 * Scan `#planetList` and return the first row whose `usedFields` is exactly
 * zero (a freshly-colonized planet with nothing built). Document order — the
 * first hit matches the sidebar's visual order.
 *
 * Pass `belowFields` to additionally require the planet be SMALL (its `max`
 * below that threshold) — this lets the colony FAB decide "too small to keep"
 * straight from the planet-list tooltip, without first navigating to the
 * colony's overview.
 *
 * @param {{ belowFields?: number }} [opts]
 * @returns {PlanetRow | null}
 */
export const findFirstFreshPlanet = ({ belowFields } = {}) => {
  const rows = document.querySelectorAll(GAME.SMALL_PLANET_ONLY);
  for (const row of rows) {
    const p = parsePlanetRow(row);
    if (!p) continue;
    if (p.used !== 0) continue;
    if (belowFields != null && p.max >= belowFields) continue;
    return p;
  }
  return null;
};

/**
 * Return the `cp` in `location.search` iff the URL says we're on the overview
 * page. Lets the colony FAB tell "we're already on the fresh planet's overview"
 * (→ offer abandon) from "a fresh planet is elsewhere" (→ offer navigate).
 * `null` in every other case.
 *
 * @returns {number | null}
 */
export const getOverviewCp = () => {
  const search = location.search || '';
  if (!search.includes('component=overview')) return null;
  const m = search.match(/[?&]cp=(\d+)/);
  if (!m) return null;
  const cp = parseInt(m[1], 10);
  return Number.isFinite(cp) && cp > 0 ? cp : null;
};

/**
 * Build the overview URL for `cp`. Base is derived from `location.href` so we
 * stay on whatever origin / path the game served; the query tail is dropped to
 * avoid leaking stale params.
 *
 * @param {number} cp
 * @returns {string}
 */
export const buildOverviewUrl = (cp) =>
  ingameComponentUrl(location.href, 'overview', { cp });
