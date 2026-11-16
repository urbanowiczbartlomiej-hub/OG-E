// @ts-check

import { GAME } from '../../lib/gameDom.js';
import { readFreshPlanets, hasAbandonableSurplus } from '../shared/planetRows.js';
import { ingameComponentUrl } from '../../domain/ogameUrl.js';

// Fresh-planet detection helpers — scan `#planetList` for a colony where
// nothing has been built yet (`usedFields === 0`) and project the page's
// overview-navigation bits. Pure DOM reads, no UI: the unified FAB's colony
// module (`./colonyFab.js`) consumes these to decide whether to surface the
// "new colony / abandon" button and where it navigates.
//
// The give-up criterion itself lives in `shared/planetRows.readFreshPlanets`.

/**
 * One planet-list row, as projected by `features/shared/planetRows.js`.
 * Aliased here so this module's consumers keep a stable type name while the
 * projection itself stays shared with the colony recorder.
 *
 * @typedef {import('../shared/planetRows.js').PlanetRow} PlanetRow
 */


/** Re-exported: the surplus rule lives with the row projection it counts. */
export { hasAbandonableSurplus };

/**
 * The first give-up candidate in `#planetList` (document order = the
 * sidebar's visual order), or `null`. The criterion itself — fresh
 * (`used === 0`), optionally below `belowFields`, never the last planet —
 * is `shared/planetRows.readFreshPlanets`, shared with the Spyglass so the
 * colony this FAB proposes to delete is never also proposed as "your
 * neighbourhood".
 *
 * @param {{ belowFields?: number }} [opts]
 * @returns {PlanetRow | null}
 */
export const findFirstFreshPlanet = (opts) => readFreshPlanets(opts)[0] ?? null;

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
