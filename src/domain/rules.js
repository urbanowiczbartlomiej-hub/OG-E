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

/** Game's `mission` parameter for attack sends. */
export const MISSION_ATTACK = 1;
/** Game's `mission` parameter for transport sends (drop cargo, fleet returns). */
export const MISSION_TRANSPORT = 3;
/** Game's `mission` parameter for espionage-probe sends. */
export const MISSION_ESPIONAGE = 6;
/** Game's `mission` parameter for debris-field harvest (recycle) sends. */
export const MISSION_HARVEST = 8;

/**
 * Missions a Daily Run route may fly, in display order (deployment — the
 * park-the-fleet default — first). The game still validates each mission
 * against the chosen target via checkTarget, so an illegal pick surfaces as
 * "Bad target" rather than being blocked here. `id` is the `mission=` param;
 * `name` labels the dashboard dropdown.
 *
 * @type {ReadonlyArray<{ id: number, name: string }>}
 */
export const ROUTE_MISSION_CATALOG = [
  { id: MISSION_DEPLOYMENT, name: 'Deployment' },
  { id: MISSION_TRANSPORT, name: 'Transport' },
  { id: MISSION_ATTACK, name: 'Attack' },
  { id: MISSION_ESPIONAGE, name: 'Espionage' },
];

/**
 * Target-type ids used in the fleetdispatch URL `type=` param and the
 * galaxy-row target icons (`.targetIcons a[data-type]`). A moon shares
 * its planet's `galaxy:system:position` but is reached with `type=3`.
 *
 *   1 = planet, 2 = debris field, 3 = moon.
 */
export const TARGET_PLANET = 1;
// 2 = debris field (see the enum above) — no OG-E flow targets debris, so no
// const is exported for it; the gap between 1 and 3 is intentional.
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
/** Espionage probe (Sonda szpiegowska) — the ship an espionage mission sends. */
export const SHIP_ESPIONAGE_PROBE = 210;

/**
 * Mobile ships selectable for a Daily Run route fleet, in display order
 * (the everyday transport ships first). Immobile units — Solar Satellite
 * (212) and Crawler (217) — are intentionally absent: they cannot fly a
 * mission. `id` is the OGame technology id used both to preselect ships via
 * the `am<id>=count` param and to read on-planet availability. `name` is the
 * canonical English ship name; the dashboard runs on the extension origin
 * and can't read the game's localized labels, so the catalog is static.
 *
 * @type {ReadonlyArray<{ id: number, name: string }>}
 */
export const SHIP_CATALOG = [
  { id: SHIP_SMALL_CARGO, name: 'Small Cargo' },
  { id: SHIP_LARGE_CARGO, name: 'Large Cargo' },
  { id: SHIP_PATHFINDER, name: 'Pathfinder' },
  { id: 209, name: 'Recycler' },
  { id: 210, name: 'Espionage Probe' },
  { id: SHIP_COLONY, name: 'Colony Ship' },
  { id: 204, name: 'Light Fighter' },
  { id: 205, name: 'Heavy Fighter' },
  { id: 206, name: 'Cruiser' },
  { id: 207, name: 'Battleship' },
  { id: 215, name: 'Battlecruiser' },
  { id: 211, name: 'Bomber' },
  { id: 213, name: 'Destroyer' },
  { id: 214, name: 'Deathstar' },
  { id: 218, name: 'Reaper' },
];
