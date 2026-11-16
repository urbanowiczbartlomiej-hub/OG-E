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

/**
 * Does the account hold MORE than one planet — i.e. is any planet abandonable
 * at all?
 *
 * OGame forbids giving up your last planet: an account must always own at
 * least one. Early game that is exactly the case the abandon FAB got wrong —
 * the starting homeworld is usually small (well under the default 320-field
 * keep threshold) and has nothing built on it yet, so it reads as a textbook
 * "fresh colony, too small to keep" and the button offered to delete the only
 * planet the player has. The game would refuse it; the button must not propose
 * it in the first place.
 *
 * Counted off `#planetList` rows carrying a `planet-<n>` id — moon rows have no
 * such id, so a planet+moon account still reads as one planet. A list we cannot
 * read at all counts as zero and therefore also blocks: for an irreversible
 * action, "unsure" must fail closed.
 *
 * @returns {boolean}
 */
export const hasAbandonableSurplus = () =>
  document.querySelectorAll(GAME.SMALL_PLANET_ONLY).length > 1;

/**
 * Every planet-list row that is a GIVE-UP CANDIDATE: freshly colonized with
 * nothing built (`used === 0`), optionally also SMALL (`max` below
 * `belowFields`). Document order. Empty when the account has a single planet
 * (see {@link hasAbandonableSurplus}).
 *
 * One criterion, two readers: the abandon FAB proposes the first of these for
 * deletion, and the Spyglass leaves them out of "your own territory" — a
 * colony the FAB is telling you to delete has no neighbourhood worth watching.
 *
 * # Why the criterion is strictly `used === 0`
 *
 * Triggering for any planet below `colonyMinFields` would produce false
 * positives: a colony with ~100 fields built (legitimately kept, mid-build)
 * falls under the threshold and would keep flashing. The signal the user
 * actually wants is "you just colonized here and haven't touched it yet" —
 * exactly `used === 0`; the moment one field is laid down the signal clears.
 *
 * @param {{ belowFields?: number }} [opts]
 * @returns {PlanetRow[]}
 */
export const readFreshPlanets = ({ belowFields } = {}) => {
  if (!hasAbandonableSurplus()) return [];
  return readPlanetRows().filter((p) =>
    p.used === 0 && (belowFields == null || p.max < belowFields));
};
