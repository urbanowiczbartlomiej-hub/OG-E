// @ts-check

// Our TERRITORY — the own bodies whose surroundings are worth watching.
//
// Every own body, minus the give-up candidates: a fresh, too-small colony the
// abandon FAB is proposing to delete (`shared/planetRows.readFreshPlanets`
// with the same `colonyMinFields` floor). Without this, colonizing such a
// planet put TWO buttons up at once — "Abandon" and a Spyglass "Look ·
// neighbours" at the very system we were about to leave. The moment the colony
// is kept (one field built) it stops being a candidate and joins the territory.
//
// Shared by the Spyglass (home + patrol looks) and Home watch (arrival diff),
// so both agree on what "around us" means.

import { bodiesStore } from '../../state/bodies.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { withoutBodiesAt } from '../../domain/bodies.js';
import { readFreshPlanets } from './planetRows.js';

/**
 * Own bodies to watch around. Off-game pages (no `#planetList`) read no
 * candidates and return the full inventory.
 *
 * @returns {import('../../domain/bodies.js').Body[]}
 */
export const territoryBodies = () => withoutBodiesAt(
  bodiesStore.get().bodies,
  readFreshPlanets({ belowFields: galaxyScanConfigStore.get().colonyMinFields }),
);
