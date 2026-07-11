// @ts-check

// Unit tests for domain/unitCosts — the resource↔points conversions that the
// hidden-fleet model rests on. The load-bearing fact under test: OGame's
// military highscore counts CIVIL ships (cargos, recyclers, colony ships,
// probes, satellites, crawlers) at HALF their resource value, combat ships
// and defence in full. Validated numerically against the pentagon case.

import { describe, it, expect } from 'vitest';
import {
  UNIT_COSTS,
  CIVIL_SHIP_IDS,
  resourceValueOf,
  sumResourceValue,
  splitResourceValue,
  militaryPointsOf,
  pointsToResources,
  pointsOf,
} from '../../src/domain/unitCosts.js';

describe('resourceValueOf', () => {
  it('sums metal+crystal+deuterium of a known unit', () => {
    // Cruiser (206): 20000 + 7000 + 2000.
    expect(resourceValueOf(206)).toBe(29000);
  });
  it('is 0 for an unpriced id (missiles / unknown)', () => {
    expect(resourceValueOf(409)).toBe(0);
    expect(resourceValueOf(999)).toBe(0);
  });
});

describe('CIVIL_SHIP_IDS', () => {
  it('flags the logistics/utility hulls and NOT warships', () => {
    for (const id of [202, 203, 208, 209, 210, 212, 217]) {
      expect(CIVIL_SHIP_IDS.has(id)).toBe(true);
    }
    for (const id of [204, 205, 206, 207, 211, 213, 214, 215, 218, 219]) {
      expect(CIVIL_SHIP_IDS.has(id)).toBe(false);
    }
  });
});

describe('splitResourceValue', () => {
  it('separates combat from civil resource value', () => {
    // 1 Cruiser (206, combat, 29000) + 1 Large Cargo (203, civil, 12000).
    const { combat, civil } = splitResourceValue({ 206: 1, 203: 1 });
    expect(combat).toBe(29000);
    expect(civil).toBe(12000);
  });
  it('ignores unpriced ids and non-positive counts', () => {
    const { combat, civil } = splitResourceValue({ 409: 5, 206: 0, 203: -3 });
    expect(combat).toBe(0);
    expect(civil).toBe(0);
  });
  it('empty / undefined → zeros', () => {
    expect(splitResourceValue()).toEqual({ combat: 0, civil: 0 });
    expect(splitResourceValue({})).toEqual({ combat: 0, civil: 0 });
  });
});

describe('militaryPointsOf — civil ships weigh half', () => {
  it('combat ship counts in full, civil ship at 50%', () => {
    // Cruiser 29000 res → 29 pts full. Large Cargo 12000 res → 6 pts (half).
    expect(militaryPointsOf({ 206: 1 })).toBe(29);
    expect(militaryPointsOf({ 203: 1 })).toBe(6);
  });
  it('reproduces the pentagon fleet within ~1% of the score identity', () => {
    // The spied moon fleet from the live case (ids → counts).
    const fleet = {
      204: 105195, 205: 41016, 206: 35108, 207: 6781, 215: 1155, 211: 929,
      213: 689, 214: 96, 218: 768, 219: 16480,
      202: 109670, 203: 1585913, 209: 491,
    };
    const full = sumResourceValue(fleet);
    // Full resource value matches the report's fleetValue exactly.
    expect(full).toBe(23_596_076_000);
    // At civil@50% the fleet is ~13.86M pts (fits the 54.7M score beside ~40M
    // defence); at full weight it would be 23.6M pts and break the identity.
    const pts = militaryPointsOf(fleet);
    expect(Math.round(pts / 1000)).toBe(13857); // ≈ 13.86M pts (fits the 54.7M score)
    expect(pts).toBeLessThan(pointsOf(full)); // strictly cheaper than naive full
  });
});

describe('pointsToResources — inverse given a combat share', () => {
  it('all-combat (share 1) → ×1000 (points are resources/1000)', () => {
    expect(pointsToResources(1000, 1)).toBe(1_000_000);
  });
  it('all-civil (share 0) → ×2000 (half-weighted points double back)', () => {
    expect(pointsToResources(1000, 0)).toBe(2_000_000);
  });
  it('is monotonic: more civil share → more resources per point', () => {
    expect(pointsToResources(1000, 0.2)).toBeGreaterThan(pointsToResources(1000, 0.8));
  });
  it('clamps the share to [0,1]', () => {
    expect(pointsToResources(1000, -5)).toBe(pointsToResources(1000, 0));
    expect(pointsToResources(1000, 5)).toBe(pointsToResources(1000, 1));
  });
  it('round-trips militaryPointsOf at the fleet\'s true combat share', () => {
    const fleet = { 206: 1, 203: 1 }; // 29000 combat + 12000 civil = 41000 res
    const pts = militaryPointsOf(fleet);
    const share = 29000 / 41000;
    expect(Math.round(pointsToResources(pts, share))).toBe(41000);
  });
});

describe('UNIT_COSTS defence validation (regression guard)', () => {
  it('sums the live-report defence JSON to its data-raw-defenseValue', () => {
    // The exact composition + total quoted in the unitCosts header note.
    const defense = { 401: 453493, 402: 190113, 403: 8896, 404: 10691, 405: 443, 406: 7779 };
    expect(sumResourceValue(defense)).toBe(2_768_761_000);
  });
  it('prices every id it claims to (no accidental holes)', () => {
    for (const id of Object.keys(UNIT_COSTS)) {
      expect(resourceValueOf(Number(id))).toBeGreaterThan(0);
    }
  });
});
