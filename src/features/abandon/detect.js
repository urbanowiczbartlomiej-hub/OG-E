// @ts-check

import { GAME } from '../../lib/gameDom.js';
import { parsePlanetRow } from '../shared/planetRows.js';
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
 * One planet-list row, as projected by `features/shared/planetRows.js`.
 * Aliased here so this module's consumers keep a stable type name while the
 * projection itself stays shared with the colony recorder.
 *
 * @typedef {import('../shared/planetRows.js').PlanetRow} PlanetRow
 */


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
  // Never offer the LAST planet (see {@link hasAbandonableSurplus}).
  if (!hasAbandonableSurplus()) return null;
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

/**
 * Plain overview URL (no `cp`) — the colony FAB's "Refresh" tap: a full page
 * load is what refreshes `#planetList` after a colonization lands, so the
 * fresh-colony detection above can take over.
 *
 * @returns {string}
 */
export const overviewUrl = () => ingameComponentUrl(location.href, 'overview', {});

/**
 * Outbound colonization arrivals in the live event list, epoch SECONDS.
 *
 * `null` when the event table is absent (unknown — the caller falls back to
 * its cache); `[]` when the table is present but no outbound colonization is
 * in flight. Entries may sit slightly in the past: a landed leg's row lingers
 * until OGame's next eventbox refresh, and that lingering is exactly what
 * lets an open page detect "landed while you were here" (see
 * `./pure.js deriveLanding`).
 *
 * @returns {number[] | null}
 */
export const readColoArrivals = () => {
  if (!document.querySelector(GAME.EVENT_CONTENT)) return null;
  /** @type {number[]} */
  const out = [];
  for (const row of document.querySelectorAll(GAME.EVENT_FLEET_ROWS)) {
    if (row.getAttribute('data-mission-type') !== '7') continue;
    if (row.getAttribute('data-return-flight') !== 'false') continue;
    const at = parseInt(row.getAttribute('data-arrival-time') || '', 10);
    if (Number.isFinite(at) && at > 0) out.push(at);
  }
  return out;
};
