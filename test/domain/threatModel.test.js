// @ts-check

// Unit tests for domain/threatModel — the hidden-fleet estimator. Focus: the
// civil-50% weighting (subtracting a parked cargo fleet in the score's own
// currency, not full resources), the resource echoes the displays need, and
// the aggression-leaned composition prior (estimateCombatShare).

import { describe, it, expect } from 'vitest';
import { estimateHiddenFleet, estimateCombatShare } from '../../src/domain/threatModel.js';

/**
 * Minimal SpyReport builder — only the fields the estimator reads.
 * @param {Partial<import('../../src/domain/espionageReport.js').SpyReport>} o
 * @returns {any}
 */
const rep = (o) => ({
  galaxy: 1, system: 1, position: 1, planetType: 1, playerId: 42,
  defenseValue: 0, fleetValue: 0, ...o,
});

describe('estimateHiddenFleet — visible fleet subtracted at civil weight', () => {
  it('subtracts a parked CARGO fleet in points (civil ×0.5), not full resources', () => {
    // 1000 Large Cargo (203): 12,000,000 res full → 6000 pts (half). A naive
    // full-value subtraction would remove 12000 pts and hide 6000 pts of real
    // combat fleet.
    const est = estimateHiddenFleet({
      militaryPoints: 20000,
      reports: [rep({ fleet: { 203: 1000 }, fleetValue: 12_000_000 })],
    });
    expect(est.visibleFleetPoints).toBe(6000);        // civil-weighted
    expect(est.visibleFleetRes).toBe(12_000_000);     // full res for display
    expect(est.visibleCombatShare).toBe(0);           // all civil
    expect(est.hiddenFleetPoints).toBe(14000);        // 20000 − 6000
  });

  it('subtracts a COMBAT fleet at full weight', () => {
    // 1000 Cruisers (206): 29,000,000 res → 29000 pts full.
    const est = estimateHiddenFleet({
      militaryPoints: 40000,
      reports: [rep({ fleet: { 206: 1000 }, fleetValue: 29_000_000 })],
    });
    expect(est.visibleFleetPoints).toBe(29000);
    expect(est.visibleCombatShare).toBe(1);
    expect(est.hiddenFleetPoints).toBe(11000);
  });

  it('mixed fleet: combat full + civil half, combat share by VALUE', () => {
    // 1 Cruiser (29000 combat) + 1 Large Cargo (12000 civil).
    const est = estimateHiddenFleet({
      militaryPoints: 100,
      reports: [rep({ fleet: { 206: 1, 203: 1 }, fleetValue: 41_000 })],
    });
    // 29 + 6 = 35 pts.
    expect(est.visibleFleetPoints).toBe(35);
    expect(est.visibleCombatShare).toBeCloseTo(29000 / 41000, 6);
  });

  it('value-only report (no composition) falls back to a neutral ×0.75 weight', () => {
    // fleetValue present, no `fleet` map → weight 0.75 (neutral 50/50 by value).
    const est = estimateHiddenFleet({
      militaryPoints: 10000,
      reports: [rep({ fleetValue: 4_000_000 })], // 4000 res-pts × 0.75 = 3000
    });
    expect(est.visibleFleetPoints).toBe(3000);
    expect(est.visibleCombatShare).toBeUndefined();
  });
});

describe('estimateHiddenFleet — coverage + clamp (unchanged invariants)', () => {
  it('clamps hidden at 0 when known defence already exceeds the score', () => {
    const est = estimateHiddenFleet({
      militaryPoints: 100,
      reports: [rep({ defenseValue: 500_000 })], // 500 pts > 100
    });
    expect(est.hiddenFleetPoints).toBe(0);
  });

  it('a fleet-only partial (defence withheld) does not advance coverage', () => {
    const est = estimateHiddenFleet({
      militaryPoints: 5000,
      planetCount: 2,
      reports: [rep({
        fleet: { 206: 1 }, fleetValue: 29000,
        revealed: { defense: false, fleet: true, resources: true, buildings: false, research: false },
      })],
    });
    expect(est.spiedCount).toBe(0);          // defence never shown
    expect(est.coverageComplete).toBe(false);
    expect(est.provisional).toBe(true);
    expect(est.visibleFleetPoints).toBe(29); // fleet still subtracts
  });

  it('dedupes a re-spied body, keeping the newest', () => {
    const est = estimateHiddenFleet({
      militaryPoints: 1000,
      reports: [
        rep({ defenseValue: 100_000, timestamp: 1 }),
        rep({ defenseValue: 300_000, timestamp: 2 }), // newer wins
      ],
    });
    expect(est.spiedCount).toBe(1);
    expect(est.defensePoints).toBe(300); // not 400
  });
});

describe('estimateCombatShare — aggression leans the hidden-fleet composition', () => {
  it('defaults to 0.35 when no composition was ever seen', () => {
    expect(estimateCombatShare({})).toBeCloseTo(0.35, 6);
  });

  it('starts from the spied composition share', () => {
    expect(estimateCombatShare({ visibleCombatShare: 0.6 })).toBeCloseTo(0.6, 6);
  });

  it('each aggression tell bumps +0.12, capped at +0.30', () => {
    // One tell.
    expect(estimateCombatShare({ visibleCombatShare: 0.3, warriorAlliance: true }))
      .toBeCloseTo(0.42, 6);
    // Four tells → +0.48 raw, capped at +0.30.
    expect(estimateCombatShare({
      visibleCombatShare: 0.3,
      warriorAlliance: true, wideReach: true, heavyKills: true, bandit: true,
    })).toBeCloseTo(0.6, 6);
  });

  it('stays within [0.05, 0.95]', () => {
    expect(estimateCombatShare({ visibleCombatShare: 0 })).toBeGreaterThanOrEqual(0.05);
    expect(estimateCombatShare({
      visibleCombatShare: 0.9, warriorAlliance: true, wideReach: true, heavyKills: true,
    })).toBeLessThanOrEqual(0.95);
  });
});
