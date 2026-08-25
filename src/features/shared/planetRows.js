// features/shared/planetRows.js
//
// The single DOM read of `#planetList`'s planet rows, shared by every
// feature that needs per-planet field counts. Two consumers today:
// `abandon/detect.js` (find a fresh colony small enough to give up) and
// `colonyRecorder.js` (append fresh colonies to the histogram dataset).
// Both used to answer "is this planet untouched?" their own way — abandon
// from this attribute, the recorder from the overview panel — which is why
// the recorder could only ever see the planet you were standing on.
//
// The fragile bits are split by layer: the selectors live in
// `lib/gameDom.js`, the tooltip string format in `domain/planetTooltip.js`,
// and this module owns only the row → data projection.
//
// Moons are excluded by construction: `GAME.SMALL_PLANET_ONLY` filters on
// the `planet-<id>` id, which moon rows do not carry. That is deliberate —
// a moon's field count is lunar-base capacity, a different quantity that
// must never enter a planet-field statistic.

import { GAME } from '../../lib/gameDom.js';
import { parsePlanetTooltip } from '../../domain/planetTooltip.js';

/**
 * One planet-list row projected to the fields consumers care about.
 *
 * @typedef {object} PlanetRow
 * @property {number} cp       OGame planet id (strictly positive).
 * @property {string} coords   `[g:s:p]` with brackets.
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position Slot number, 1..15.
 * @property {string} name     Display name; may be empty.
 * @property {number} used     Fields currently built on.
 * @property {number} max      Field slots available.
 */

/**
 * Project one `.smallplanet` row.
 *
 * Returns `null` when the row id, the tooltip, or the parsed numbers don't
 * look right — we prefer silently skipping a malformed row over failing the
 * whole scan, because the sidebar is external markup that can change shape
 * under us at any OGame release.
 *
 * @param {Element} row
 * @returns {PlanetRow | null}
 */
export const parsePlanetRow = (row) => {
  const id = row.id;
  if (!id || !id.startsWith('planet-')) return null;
  const cp = parseInt(id.slice('planet-'.length), 10);
  // cp === 0 is rejected as well as NaN: OGame ids are strictly positive and
  // 0 collides with "unset" sentinels used elsewhere in the codebase.
  if (!Number.isFinite(cp) || cp <= 0) return null;

  const link = row.querySelector(GAME.PLANET_LINK);
  if (!link) return null;
  const parsed = parsePlanetTooltip(link.getAttribute('data-tooltip-title'));
  if (!parsed) return null;

  // Name comes from the row's own span, not the tooltip header: the span is
  // the raw name, while the tooltip header is a localised composite.
  const name = (row.querySelector(GAME.PLANET_NAME)?.textContent ?? '').trim();

  return { cp, name, ...parsed };
};

/**
 * Project every planet row in the sidebar, in document order (which is the
 * order the user sees). Malformed rows are dropped, so the result may be
 * shorter than the row count — and empty when the sidebar is absent, which
 * is the correct reading on non-ingame pages.
 *
 * @returns {PlanetRow[]}
 */
export const readPlanetRows = () => {
  /** @type {PlanetRow[]} */
  const out = [];
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET_ONLY)) {
    const parsed = parsePlanetRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
};
