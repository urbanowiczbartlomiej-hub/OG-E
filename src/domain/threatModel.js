// @ts-check

// Pure hidden-fleet estimator. The whole feature's thesis in one function:
//
//   hiddenFleet ≈ militaryPoints − Σ_bodies (defenseValue + visibleFleetValue)/1000
//
// The military score (points) is the player's CURRENT fleet + defense across
// their whole empire. Spying reveals, per body, the defense and the parked
// (visible) fleet. What the military score has that the spy reports don't is
// fleet that isn't sitting anywhere we can see — i.e. flying on a fleet-save.
// That gap is the signal: a big positive hidden value = a fleet worth chasing.
//
// Two honesty knobs baked in:
//   - coverage: we can only subtract bodies we actually spied. `planetCount`
//     (from the API) is the denominator; until spied == known, the estimate is
//     PROVISIONAL and biased high (unspied bodies look like hidden fleet).
//   - clamp at 0: if known defense already exceeds the military score (stale
//     score, or moon defense we didn't spy under planets-only), hidden can't be
//     negative — report 0, not a phantom debt.

import { pointsOf } from './unitCosts.js';
import { bodyKey } from './espionageReport.js';

/**
 * @typedef {import('./espionageReport.js').SpyReport} SpyReport
 */

/**
 * @typedef {object} HiddenFleetEstimate
 * @property {number} defensePoints        Σ defense over spied bodies, in points.
 * @property {number} visibleFleetPoints   Σ parked fleet over spied bodies, in points.
 * @property {number} accountedPoints       defensePoints + visibleFleetPoints.
 * @property {number} hiddenFleetPoints     max(0, military − accounted).
 * @property {number} militaryPoints        The military score used (0 if unknown).
 * @property {number} spiedCount            Distinct bodies counted.
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

  let defenseRes = 0;
  let fleetRes = 0;
  for (const r of reports) {
    defenseRes += r.defenseValue || 0;
    fleetRes += r.fleetValue || 0;
  }

  const defensePoints = pointsOf(defenseRes);
  const visibleFleetPoints = pointsOf(fleetRes);
  const accountedPoints = defensePoints + visibleFleetPoints;
  const hiddenFleetPoints = Math.max(0, militaryPoints - accountedPoints);

  const spiedCount = reports.length;
  const planetCount = input.planetCount;
  const coverageComplete =
    typeof planetCount === 'number' && planetCount > 0 && spiedCount >= planetCount;

  return {
    defensePoints,
    visibleFleetPoints,
    accountedPoints,
    hiddenFleetPoints,
    militaryPoints,
    spiedCount,
    planetCount,
    coverageComplete,
    provisional: !coverageComplete,
  };
}
