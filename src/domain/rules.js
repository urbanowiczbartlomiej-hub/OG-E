// OGame world-shape constants. Single source of truth for the numbers
// that every domain module wants to reach for — galaxy/system bounds,
// position range, mission-type ids. Pure data, no logic.
//
// We use literal numbers rather than reading the universe's config at
// runtime because:
//   1. These values are stable across the OGame universes OG-E targets.
//   2. The domain layer must stay pure (no DOM, no storage, no I/O),
//      so it cannot consult anything dynamic anyway.
//   3. If a future universe does vary a value, we pass it in through
//      function parameters (see e.g. the `maxSystem` override in
//      `positions.sysDist`) rather than mutating a global.
//
// Mission ids are numbers here. The game's XHR bodies carry them as
// decimal strings — bridges convert once at the boundary, domain code
// works with plain numbers throughout.

/**
 * Highest numbered system in a galaxy. Systems are 1..COL_MAX_SYSTEM
 * inclusive. Wraparound (system 1 ↔ system COL_MAX_SYSTEM) matters for
 * distance calculations — see `positions.sysDist`.
 */
export const COL_MAX_SYSTEM = 499;

/**
 * Number of galaxies in the universe. Galaxies are 1..COL_MAX_GALAXY
 * inclusive, no wraparound (travel from galaxy 1 to COL_MAX_GALAXY
 * really is `COL_MAX_GALAXY - 1` hops, not 1).
 */
export const COL_MAX_GALAXY = 7;

/** Lowest valid planet position within a system. */
export const MIN_POSITION = 1;

/** Highest valid planet position within a system. */
export const MAX_POSITION = 15;

/** Game's `mission` parameter for expedition sends. */
export const MISSION_EXPEDITION = 15;

/** Game's `mission` parameter for colonization sends. */
export const MISSION_COLONIZE = 7;
