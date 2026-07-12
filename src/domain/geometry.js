// Shared server geometry — the ONE place OG-E converts coordinates into
// distance, flight time and reach. Extracted from domain/heatField.js so every
// consumer (server map, settlement analyzer) shares the same wrap rules and
// flight constants instead of growing private, contradictory distance models
// (regions.js used to wrap 499↔1 unconditionally, ignoring the server's donut
// flags).
//
// Reverse-engineered OGame knowledge lives in these comments — keep them.
//
// Pure: no DOM/timers/storage/chrome — the `domain/` contract.
//
// @ts-check

// Verified OGame flight-distance constants (galaxy / system terms).
export const GALAXY_STEP = 20000;
export const SYSTEM_BASE = 2700;
export const SYSTEM_STEP = 95;
// Same-vicinity distance (source in the target's own system) — reads as an
// in-system flight.
export const SAME_SYSTEM_D = 1005;
// Systems-of-distance a galaxy hop costs (20000 = 2700 + 95·183) — for
// system-radius reaches so they barely cross galaxies.
export const GALAXY_IN_SYSTEMS = 183;

/** Clamp to the unit interval. @param {number} x @returns {number} */
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Wrap-aware absolute difference on a circular axis (the donut `min()`).
 * Honours the server's donut flag — on a non-donut server 1 and 499 are FAR.
 *
 * @param {number} a @param {number} b @param {number} total @param {boolean} donut
 * @returns {number}
 */
export const axisDelta = (a, b, total, donut) => {
  const d = Math.abs(a - b);
  return donut ? Math.min(d, total - d) : d;
};

/**
 * OGame flight distance between two coordinates already reduced to axis
 * deltas: `ag` galaxies apart dominates when > 0; else `dSys` systems apart;
 * else same-system vicinity.
 *
 * @param {number} ag    Galaxy-axis delta (≥ 0, wrap already applied).
 * @param {number} dSys  System-axis delta (≥ 0, wrap already applied).
 * @returns {number}
 */
export const flightDistance = (ag, dSys) =>
  ag > 0 ? GALAXY_STEP * ag : (dSys === 0 ? SAME_SYSTEM_D : SYSTEM_BASE + SYSTEM_STEP * dSys);

/**
 * OGame flight distance straight from two parsed coordinates + server bounds.
 * Applies the donut wrap on both axes (per the server's flags) before the
 * {@link flightDistance} reduction — the game ALWAYS flies the wrapped
 * shortest path, so any "which of my planets is closest?" question must go
 * through this, never through raw `Math.abs` deltas.
 *
 * Bounds default to the classic 9-galaxy / 499-system donut server when the
 * apiContext snapshot isn't available yet — wrong for exotic servers but
 * strictly better than no wrap at all.
 *
 * @param {{ galaxy: number, system: number }} a
 * @param {{ galaxy: number, system: number }} b
 * @param {{ galaxies?: number, systems?: number, donutGalaxy?: boolean, donutSystem?: boolean }} [bounds]
 * @returns {number}
 */
export const flightDistanceBetween = (a, b, bounds = {}) => {
  const gTot = Number(bounds.galaxies) > 0 ? Number(bounds.galaxies) : 9;
  const sTot = Number(bounds.systems) > 0 ? Number(bounds.systems) : 499;
  const ag = axisDelta(a.galaxy, b.galaxy, gTot, bounds.donutGalaxy !== false);
  const dSys = axisDelta(a.system, b.system, sTot, bounds.donutSystem !== false);
  return flightDistance(ag, dSys);
};

/**
 * Moon-destruction (NISZCZ / RIP) flight time in hours for an OGame
 * flight-distance `d`. Post-v12.9.0 that mission flies at a FIXED speed —
 * independent of drive tech and server speed — so its flight time is a pure
 * function of distance: `t = 3500·√(d/31) + 10` s.
 *
 * @param {number} d @returns {number}
 */
export const niszczHours = (d) => (3500 * Math.sqrt(d / 31) + 10) / 3600;

/**
 * Threat reach 0..1 for distance `d` and an offline window (hours): 1 while a
 * RIP arrives inside the window, fading to 0 by 1.5× the window.
 *
 * @param {number} d @param {number} windowH @returns {number}
 */
export const reachThreat = (d, windowH) => clamp01(3 - 2 * (niszczHours(d) / windowH));
