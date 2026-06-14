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

/**
 * Game's `mission` parameter for deployment ("Stacjonuj") sends — a
 * one-way mission where the fleet stations at the target and stays.
 * Used by the fleet-save micro-fleet feature (`features/dailyRun`).
 */
export const MISSION_DEPLOYMENT = 4;

/**
 * Target-type ids used in the fleetdispatch URL `type=` param and the
 * galaxy-row target icons (`.targetIcons a[data-type]`). A moon shares
 * its planet's `galaxy:system:position` but is reached with `type=3`.
 *
 *   1 = planet, 2 = debris field, 3 = moon.
 */
export const TARGET_PLANET = 1;
export const TARGET_DEBRIS = 2;
export const TARGET_MOON = 3;

/**
 * Ship ids used to preload a fleet via the fleetdispatch URL param
 * `am<shipId>=<count>` (e.g. `am203=15000`). Only the ships the
 * fleet-save workflow uses for micro-fleets are listed here.
 *
 *   202 = small cargo (Mały transporter)
 *   203 = large cargo (Duży transporter)
 *   219 = pathfinder (Pionier)
 */
export const SHIP_SMALL_CARGO = 202;
export const SHIP_LARGE_CARGO = 203;
export const SHIP_PATHFINDER = 219;
/** Colony ship (Statek kolonizacyjny) — the one a colonize mission needs. */
export const SHIP_COLONY = 208;
