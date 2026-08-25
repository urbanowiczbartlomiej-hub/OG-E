// Parser of the `data-tooltip-title` blob OGame renders on every
// `#planetList` planet link. Pure string → data; the DOM read that feeds
// it lives in `features/shared/planetRows.js`.
//
// # Why this attribute matters
//
// The tooltip is the ONLY place the game exposes a planet's field counts
// for EVERY planet at once, on EVERY ingame page. `#diameterContentField`
// (the overview panel) carries the same `(used/max)` pair but only for the
// planet you are currently looking at, which forces one page-load per
// planet to read them all. The sidebar is rendered server-side on every
// page, so one read covers the whole account.
//
// The decoded attribute value looks like (locale-dependent labels):
//
//   <b>Colony [4:9:8]</b><br/>Forma życia: Mechy
//   <br/>16.494km (0/235)<br/>od -165 °C do -125 °C<br/><a …>Podgląd</a>…
//
// `getAttribute` returns it already entity-decoded (`&lt;b&gt;` → `<b>`),
// so this parser sees real angle brackets and must not re-decode.
//
// # What is deliberately NOT parsed
//
// Only the coords and the field pair. The name is read from the row's
// `.planet-name` span instead (localisation-independent), the lifeform and
// temperature lines are unused, and the diameter number is noise — we
// anchor on it only to disambiguate the parenthetical (see FIELDS_RE).

/** @ts-check */

/** Matches the `[g:s:p]` coord block in the tooltip's `<b>` header. */
const COORD_RE = /\[(\d+):(\d+):(\d+)\]/;

/**
 * Matches the `DDD.DDkm (used/max)` parenthetical.
 *
 * OGame renders the diameter with a locale-dependent separator (dot in
 * some markets, comma in others), hence `\d+(?:[.,]\d+)?`. The `km`
 * anchor is load-bearing: the tooltip's trailing `<a>` links carry query
 * strings and the temperature line carries its own parentheses, so a bare
 * `\((\d+)\/(\d+)\)` could latch onto the wrong pair.
 */
const FIELDS_RE = /(\d+(?:[.,]\d+)?)\s*km\s*\((\d+)\/(\d+)\)/;

/**
 * One planet-list tooltip projected to the data downstream consumers need.
 *
 * @typedef {object} PlanetTooltip
 * @property {string} coords   `[g:s:p]`, brackets included (the format the
 *   game-DOM uses everywhere, so consumers can compare strings directly).
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position Slot number, 1..15.
 * @property {number} used     Fields currently built on.
 * @property {number} max      Field slots available.
 */

/**
 * Parse a decoded `data-tooltip-title` value.
 *
 * Returns `null` when either the coord block or the field parenthetical is
 * missing or malformed — a partially-understood tooltip is never returned
 * half-filled, because every caller treats a non-null result as a complete
 * observation.
 *
 * @param {string | null | undefined} tooltip
 * @returns {PlanetTooltip | null}
 */
export const parsePlanetTooltip = (tooltip) => {
  if (typeof tooltip !== 'string' || tooltip === '') return null;

  const coordMatch = tooltip.match(COORD_RE);
  const fieldsMatch = tooltip.match(FIELDS_RE);
  if (!coordMatch || !fieldsMatch) return null;

  const galaxy = parseInt(coordMatch[1], 10);
  const system = parseInt(coordMatch[2], 10);
  const position = parseInt(coordMatch[3], 10);
  const used = parseInt(fieldsMatch[2], 10);
  const max = parseInt(fieldsMatch[3], 10);

  // `max` of zero would be a nonsense planet; `used` of zero is the whole
  // point of the fresh-colony signal, so only `max` is floor-checked.
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(galaxy) || !Number.isFinite(system) || !Number.isFinite(position)) {
    return null;
  }

  return {
    coords: `[${galaxy}:${system}:${position}]`,
    galaxy,
    system,
    position,
    used,
    max,
  };
};
