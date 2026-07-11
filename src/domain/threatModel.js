// @ts-check

// Pure hidden-fleet estimator. The whole feature's thesis in one function:
//
//   hiddenFleet ≈ militaryPoints − Σ_bodies militaryPointsOf(defence + visible fleet)
//
// The military score (points) is the player's CURRENT fleet + defense across
// their whole empire — with CIVIL ships counted at 50% (see unitCosts.js
// "# Points"; validated on the pentagon case). Spying reveals, per body, the
// defense and the parked (visible) fleet. What the military score has that
// the spy reports don't is fleet that isn't sitting anywhere we can see —
// i.e. flying on a fleet-save. That gap is the signal: a big positive hidden
// value = a fleet worth chasing.
//
// UNITS. All `*Points` fields live in MILITARY-POINT space, where hidden
// civil value counts half — so a cargo-heavy hidden fleet's true resource
// value is up to 2× points·1000. Consumers must convert via
// `pointsToResources(pts, combatShare)` for any resource-denominated display
// (the pentagon fleet read "14.5M hidden" but was 23.6G of resources).
// `estimateCombatShare` builds that share from the spied composition plus
// aggression tells.
//
// Two honesty knobs baked in:
//   - coverage: we can only subtract bodies we actually spied. `planetCount`
//     (from the API) is the denominator; until spied == known, the estimate is
//     PROVISIONAL and biased high (unspied bodies look like hidden fleet).
//   - clamp at 0: if known defense already exceeds the military score (stale
//     score, or moon defense we didn't spy under planets-only), hidden can't be
//     negative — report 0, not a phantom debt.

import { pointsOf, splitResourceValue } from './unitCosts.js';
import { bodyKey } from './espionageReport.js';

/**
 * @typedef {import('./espionageReport.js').SpyReport} SpyReport
 */

/**
 * @typedef {object} HiddenFleetEstimate
 * @property {number} defensePoints        Σ defense over DEFENCE-covered bodies, in points.
 * @property {number} visibleFleetPoints   Σ parked fleet over fleet-revealed bodies, in
 *   MILITARY points (civil ships weighted ×0.5 — the score's own currency).
 * @property {number} visibleFleetRes      Σ parked fleet in FULL resources (display currency —
 *   matches the game's own report fleetValue).
 * @property {number} [visibleCombatShare] Combat share BY VALUE of the composition-bearing
 *   visible fleet (0..1). Undefined when no report carried a unit breakdown.
 * @property {number} accountedPoints       defensePoints + visibleFleetPoints.
 * @property {number} hiddenFleetPoints     max(0, military − accounted) — MILITARY points;
 *   convert with pointsToResources() before comparing to resource values.
 * @property {number} militaryPoints        The military score used (0 if unknown).
 * @property {number} spiedCount            Distinct DEFENCE-covered bodies (coverage numerator).
 * @property {number} [planetCount]         Known total bodies (coverage denominator).
 * @property {boolean} coverageComplete     spiedCount ≥ planetCount (false if unknown).
 * @property {boolean} provisional          Estimate not yet trustworthy (incomplete coverage).
 */

/**
 * @typedef {object} EstimateInput
 * @property {number} [militaryPoints]   Player military score (from API or a report).
 * @property {SpyReport[]} [reports]     Spied bodies for THIS player (planets, under planets-only).
 * @property {number} [planetCount]      Total bodies the player has (from API), for coverage.
 */

/**
 * Deduplicate reports by body, keeping the newest (a re-spy supersedes an old
 * one; without this, two scans of the same planet would double-count).
 * @param {SpyReport[]} reports
 * @returns {SpyReport[]}
 */
function dedupeNewest(reports) {
  /** @type {Map<string, SpyReport>} */
  const byBody = new Map();
  for (const r of reports) {
    const key = bodyKey(r);
    const prev = byBody.get(key);
    if (!prev || (r.timestamp ?? 0) >= (prev.timestamp ?? 0)) byBody.set(key, r);
  }
  return [...byBody.values()];
}

/**
 * Estimate the fleet a player is hiding on fleet-save.
 * @param {EstimateInput} input
 * @returns {HiddenFleetEstimate}
 */
export function estimateHiddenFleet(input) {
  const militaryPoints = input.militaryPoints ?? 0;
  const reports = dedupeNewest(input.reports ?? []);

  // Gate each body's contribution on what its report actually revealed (§9bis):
  // a resources-only partial scan (fleet/defence withheld) must NOT read its
  // absent defence as a real zero — that would subtract nothing and report the
  // player's WHOLE military score as hidden fleet (a dangerous over-estimate).
  // So defence only accrues when `revealed.defense`, fleet only when
  // `revealed.fleet`, and coverage counts only defence-covered bodies. A report
  // with no `revealed` map is legacy (it passed the old numeric-defence gate),
  // so it counts as a full reveal.
  let defenseRes = 0;
  let fleetRes = 0;
  let defenceCovered = 0;
  // The visible fleet must be subtracted in the military score's OWN currency
  // (civil ×0.5) — subtracting full resource value over-subtracts a parked
  // cargo fleet and eats real hidden combat fleet. Reports carry the fleet
  // `{id: count}` map, so the split is exact; value-only reports (rare legacy
  // shape) fall back to the composition-bearing reports' observed civil share
  // below, or to a neutral 50/50 split (weight ×0.75) when nothing was seen.
  let combatRes = 0;
  let civilRes = 0;
  let valueOnlyRes = 0;
  for (const r of reports) {
    const rev = r.revealed;
    const showedDef = rev ? rev.defense : true;
    const showedFleet = rev ? rev.fleet : true;
    if (showedDef) {
      defenseRes += r.defenseValue || 0;
      defenceCovered += 1;
    }
    if (showedFleet) {
      fleetRes += r.fleetValue || 0;
      if (r.fleet && Object.keys(r.fleet).length) {
        const split = splitResourceValue(r.fleet);
        combatRes += split.combat;
        civilRes += split.civil;
      } else {
        valueOnlyRes += r.fleetValue || 0;
      }
    }
  }

  const splitSeen = combatRes + civilRes > 0;
  const visibleCombatShare = splitSeen ? combatRes / (combatRes + civilRes) : undefined;
  // Value-only remainder: weight by the observed share, else neutral 0.75.
  const valueOnlyWeight = splitSeen
    ? /** @type {number} */ (visibleCombatShare) + (1 - /** @type {number} */ (visibleCombatShare)) / 2
    : 0.75;

  const defensePoints = pointsOf(defenseRes);
  const visibleFleetPoints = pointsOf(combatRes + civilRes / 2 + valueOnlyRes * valueOnlyWeight);
  const accountedPoints = defensePoints + visibleFleetPoints;
  const hiddenFleetPoints = Math.max(0, militaryPoints - accountedPoints);

  // A resources-only partial advances loot/routine coverage but NOT the
  // hidden-fleet denominator, so a player is never read as "fully spied" off
  // partial reports that never showed a defence.
  const spiedCount = defenceCovered;
  const planetCount = input.planetCount;
  const coverageComplete =
    typeof planetCount === 'number' && planetCount > 0 && spiedCount >= planetCount;

  return {
    defensePoints,
    visibleFleetPoints,
    visibleFleetRes: fleetRes,
    ...(visibleCombatShare !== undefined ? { visibleCombatShare } : {}),
    accountedPoints,
    hiddenFleetPoints,
    militaryPoints,
    spiedCount,
    planetCount,
    coverageComplete,
    provisional: !coverageComplete,
  };
}

/**
 * Combat share BY VALUE assumed for a player's HIDDEN (flying) fleet — the
 * knob `pointsToResources` needs. Base is what the scans actually saw parked
 * (the best predictor of what the player builds), or a neutral 0.35 when no
 * composition was ever seen. Aggression tells then shift the assumption
 * toward warships: an aggressive player's flying fleet is combat-heavier
 * than their parked logistics suggest. Each tell bumps +0.12, capped at
 * +0.30 so the prior stays a lean, not a verdict. All heuristic/tunable.
 *
 * @param {object} input
 * @param {number} [input.visibleCombatShare]  From {@link estimateHiddenFleet}.
 * @param {boolean} [input.warriorAlliance]    Alliance class = warrior.
 * @param {boolean} [input.wideReach]          Wide server spread / striking reach
 *   (e.g. the danger model's APEX reach tell).
 * @param {boolean} [input.heavyKills]         Top-percentile military-destroyed.
 * @param {boolean} [input.bandit]             High bandit honour rank (tier ≥ 2).
 * @returns {number} 0.05..0.95 combat share.
 */
export function estimateCombatShare(input) {
  const base = typeof input.visibleCombatShare === 'number'
    ? Math.min(1, Math.max(0, input.visibleCombatShare))
    : 0.35;
  let bump = 0;
  if (input.warriorAlliance) bump += 0.12;
  if (input.wideReach) bump += 0.12;
  if (input.heavyKills) bump += 0.12;
  if (input.bandit) bump += 0.12;
  if (bump > 0.3) bump = 0.3;
  return Math.min(0.95, Math.max(0.05, base + bump));
}
