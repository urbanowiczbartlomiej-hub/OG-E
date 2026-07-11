// @ts-check

// Reverse-engineered OGame BASE build costs (metal/crystal/deuterium) per
// ship and defense unit, plus the resources→points conversion. This is
// in-code game knowledge with no other home (OG-E has no access to OGame's
// source) — do NOT trim it under a DRY banner (see CLAUDE.md carve-out).
//
// # Why we need costs at all
//
// A spy report already hands us `data-raw-fleetValue` / `data-raw-defenseValue`
// (the game pre-sums them, in resources). So these tables are the FALLBACK that
// recomputes those values from the raw `{id: count}` JSON when an attribute is
// missing, and the source for any per-unit breakdown UI. They were validated
// against a live report: summing the defense table over the report's
// `defense` JSON ({401:453493, 402:190113, 403:8896, 404:10691, 405:443,
// 406:7779}) yields exactly 2,768,761,000 — matching `data-raw-defenseValue`.
//
// # Points
//
// One OGame point = 1000 resources invested (metal+crystal+deuterium counted
// equally) — `pointsOf(resources)` does that divide. BUT the highscore
// "military" score weighs CIVIL ships at only 50% of their value:
//
//   military = defence + combat ships + civil ships / 2   (in points)
//
// Civil = Small/Large Cargo, Colony Ship, Recycler, Espionage Probe, Solar
// Satellite, Crawler (`CIVIL_SHIP_IDS`); combat ships and ALL defence count
// in full. Validated against a live case ("pentagon", s163-pl): one moon held
// a spied fleet of exactly 23,596,076,000 res (4.118G combat + 19.478G civil)
// while the player's military score was 54.7M with ~40M pts of spied defence
// — at civil@100% that fleet alone (23.6M pts) breaks the identity
// (40 + 23.6 > 54.7); at civil@50% (13.86M pts) it fits within ~1%.
// `militaryPointsOf` computes that weighted value from a composition;
// `pointsToResources` inverts points back to resources given a combat share.
//
// Costs are BASE build costs: lifeform / research bonuses change build TIME and
// some production, not the resource cost that the point score is computed from.

/**
 * Base build cost of one unit, in resources.
 * @typedef {object} UnitCost
 * @property {number} m   Metal.
 * @property {number} c   Crystal.
 * @property {number} d   Deuterium.
 */

/**
 * Base build cost per technology id, covering every mobile ship (202–219) and
 * the planetary defenses that count toward the military score (401–408).
 * Solar Satellite (212) and Crawler (217) are included — they can't fly, but
 * they DO appear in a planet's fleet list and carry resource value.
 *
 * Interplanetary/anti-ballistic missiles (409/410) are intentionally absent:
 * they are not reported in the `fleet`/`defense` JSON nor in fleetValue.
 *
 * @type {Record<number, UnitCost>}
 */
export const UNIT_COSTS = {
  // --- ships -------------------------------------------------------------
  202: { m: 2000, c: 2000, d: 0 }, // Small Cargo (Mały transporter)
  203: { m: 6000, c: 6000, d: 0 }, // Large Cargo (Duży transporter)
  204: { m: 3000, c: 1000, d: 0 }, // Light Fighter (lm)
  205: { m: 6000, c: 4000, d: 0 }, // Heavy Fighter (cm)
  206: { m: 20000, c: 7000, d: 2000 }, // Cruiser (kr)
  207: { m: 45000, c: 15000, d: 0 }, // Battleship (OW)
  208: { m: 10000, c: 20000, d: 10000 }, // Colony Ship (Statek kolonizacyjny)
  209: { m: 10000, c: 6000, d: 2000 }, // Recycler (Recykler)
  210: { m: 0, c: 1000, d: 0 }, // Espionage Probe (ss)
  211: { m: 50000, c: 25000, d: 15000 }, // Bomber (bom)
  212: { m: 0, c: 2000, d: 500 }, // Solar Satellite (Satelita słoneczny)
  213: { m: 60000, c: 50000, d: 15000 }, // Destroyer (nisz)
  214: { m: 5000000, c: 4000000, d: 1000000 }, // Deathstar (gs)
  215: { m: 30000, c: 40000, d: 15000 }, // Battlecruiser (Pan)
  217: { m: 2000, c: 2000, d: 1000 }, // Crawler (Pełzacz)
  218: { m: 85000, c: 55000, d: 20000 }, // Reaper (rozp)
  219: { m: 8000, c: 15000, d: 8000 }, // Pathfinder (pion)
  // --- defenses (validated against a live report) ------------------------
  401: { m: 2000, c: 0, d: 0 }, // Rocket Launcher (Wyrzutnia rakiet)
  402: { m: 1500, c: 500, d: 0 }, // Light Laser (Lekkie działo laserowe)
  403: { m: 6000, c: 2000, d: 0 }, // Heavy Laser (Ciężkie działo laserowe)
  404: { m: 20000, c: 15000, d: 2000 }, // Gauss Cannon (Działo Gaussa)
  405: { m: 5000, c: 3000, d: 0 }, // Ion Cannon (Działo jonowe)
  406: { m: 50000, c: 50000, d: 30000 }, // Plasma Turret (Wyrzutnia plazmy)
  407: { m: 10000, c: 10000, d: 0 }, // Small Shield Dome (Mała Osłona)
  408: { m: 50000, c: 50000, d: 0 }, // Large Shield Dome (Duża Osłona)
};

/**
 * Ship ids the military highscore counts at 50% (OGame's civil ships):
 * Small Cargo, Large Cargo, Colony Ship, Recycler, Espionage Probe, Solar
 * Satellite, Crawler. Everything else in `UNIT_COSTS` (combat ships 2xx and
 * defence 4xx) counts in full. See the "# Points" header note.
 *
 * @type {Set<number>}
 */
export const CIVIL_SHIP_IDS = new Set([202, 203, 208, 209, 210, 212, 217]);

/**
 * Split a `{id: count}` composition's resource value into the military
 * highscore's two weight classes.
 *
 * @param {Record<string|number, number>} [units]
 * @returns {{ combat: number, civil: number }}  Resources (not points).
 */
export function splitResourceValue(units) {
  let combat = 0;
  let civil = 0;
  if (units) {
    for (const [id, count] of Object.entries(units)) {
      const n = Number(count);
      if (!Number.isFinite(n) || n <= 0) continue;
      const idNum = Number(id);
      const v = resourceValueOf(idNum) * n;
      if (CIVIL_SHIP_IDS.has(idNum)) civil += v;
      else combat += v;
    }
  }
  return { combat, civil };
}

/**
 * The military-highscore point value of a composition — combat units (and
 * defence) in full, civil ships at 50%. This is the ONLY correct currency to
 * subtract from a player's military score (see threatModel.js).
 *
 * @param {Record<string|number, number>} [units]
 * @returns {number}  Points (float; callers round at display time).
 */
export function militaryPointsOf(units) {
  const { combat, civil } = splitResourceValue(units);
  return pointsOf(combat + civil / 2);
}

/**
 * Invert military points back to a resource estimate, given the fleet's
 * combat share BY VALUE (0 = all civil → ×2000, 1 = all combat → ×1000):
 *
 *   res = pts·1000 / (share + (1−share)/2) = pts·2000 / (1 + share)
 *
 * @param {number} points
 * @param {number} combatShare  0..1 (clamped).
 * @returns {number}  Resources.
 */
export function pointsToResources(points, combatShare) {
  const s = combatShare < 0 ? 0 : combatShare > 1 ? 1 : combatShare;
  return (points * 2000) / (1 + s);
}

/**
 * Total resource value of one unit (metal + crystal + deuterium).
 * @param {number} unitId
 * @returns {number}  0 for ids we don't price (missiles, unknown).
 */
export function resourceValueOf(unitId) {
  const cost = UNIT_COSTS[unitId];
  return cost ? cost.m + cost.c + cost.d : 0;
}

/**
 * Sum the resource value of a `{id: count}` composition — works for either a
 * fleet JSON or a defense JSON, since ship ids (2xx) and defense ids (4xx)
 * are disjoint keys in `UNIT_COSTS`. Unknown ids contribute 0.
 * @param {Record<string|number, number>} [units]
 * @returns {number}
 */
export function sumResourceValue(units) {
  if (!units) return 0;
  let total = 0;
  for (const [id, count] of Object.entries(units)) {
    const n = Number(count);
    if (Number.isFinite(n) && n > 0) total += resourceValueOf(Number(id)) * n;
  }
  return total;
}

/**
 * Convert a resource amount to OGame points (1 point = 1000 resources).
 * Kept as a float; callers round at display time.
 * @param {number} resources
 * @returns {number}
 */
export function pointsOf(resources) {
  return resources / 1000;
}
