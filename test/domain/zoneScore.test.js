// Unit tests for the zone-based region scoring in domain/zoneScore.js —
// built on top of heatField.js + cellClass.js + geometry.js. Small
// `galaxyMax` fixtures keep this readable, mirroring test/domain/regions.test.js.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  ZONES,
  HARM_WEIGHTS,
  contiguousFreeRun,
  computeZoneChannels,
  zoneFit,
  annotateAndSortByZone,
} from '../../src/domain/zoneScore.js';
import { buildThreatFarmField } from '../../src/domain/heatField.js';

/** A confirmed-empty slot. */
const empty = { status: 'empty' };
/** An occupied (active) slot owned by player `id`. @param {number} id @param {number} [militaryScore] */
const occ = (id, militaryScore) => ({ status: 'occupied', player: { id, name: 'P' + id, militaryScore } });
/** An inactive (farmable) slot owned by player `id`. @param {number} id @param {number} [score] */
const inact = (id, score) => ({ status: 'inactive', player: { id, name: 'P' + id, score } });

/**
 * Build a GalaxyScans fixture from `{ "g:s": { slot: Position } }` shorthand.
 * @param {Record<string, Record<number, any>>} spec
 */
const scansOf = (spec) => {
  /** @type {any} */
  const out = {};
  for (const [key, positions] of Object.entries(spec)) {
    out[key] = { scannedAt: 1, positions };
  }
  return out;
};

const G10 = 10;

describe('ZONES / HARM_WEIGHTS', () => {
  it('each zone weight vector sums to 1', () => {
    for (const key of Object.keys(ZONES)) {
      const w = ZONES[key].weights;
      const sum = w.safety + w.farm + w.streak + w.target;
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('HARM_WEIGHTS carries the fixed exclusion basis', () => {
    expect(HARM_WEIGHTS).toEqual({ bandit: -1, strong: -1, occupied: -0.5, honored: -0.4 });
  });
});

describe('contiguousFreeRun', () => {
  it('returns 0 when the centre itself is not free', () => {
    const scans = scansOf({ '4:5': { 8: occ(1) } });
    expect(contiguousFreeRun(scans, 4, 5, [8], 'empty', G10)).toBe(0);
  });

  it('counts a run correctly in both directions from the centre', () => {
    // Free at 3,4,5,6,7 (centre 5); occupied elsewhere.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [3, 4, 5, 6, 7]) spec[`4:${s}`] = { 8: empty };
    spec['4:2'] = { 8: occ(1) };
    spec['4:8'] = { 8: occ(1) };
    const run = contiguousFreeRun(scansOf(spec), 4, 5, [8], 'empty', G10);
    expect(run).toBe(5);
  });

  it('wraps around the galaxyMax boundary', () => {
    // Free at 9,10,1,2,3 (centre 10) in a galaxyMax=10 galaxy.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [9, 10, 1, 2, 3]) spec[`4:${s}`] = { 8: empty };
    spec['4:4'] = { 8: occ(1) };
    spec['4:8'] = { 8: occ(1) };
    const run = contiguousFreeRun(scansOf(spec), 4, 10, [8], 'empty', G10);
    expect(run).toBe(5);
  });

  it('is bounded at galaxyMax for a fully-free galaxy', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= G10; s++) spec[`4:${s}`] = { 8: empty };
    const run = contiguousFreeRun(scansOf(spec), 4, 5, [8], 'empty', G10);
    expect(run).toBe(G10);
  });
});

describe('computeZoneChannels — no field (degrades gracefully)', () => {
  it('safety reads a neutral 0.5-derived value and farm is 0 when ctx.field is omitted', () => {
    const scans = scansOf({ '4:5': { 8: empty } });
    /** @type {any} */
    const region = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };
    const ch = computeZoneChannels(region, { scans, positions: [8], galaxyMax: G10 });
    expect(ch.safety).toBeCloseTo(0.5, 10);
    expect(ch.farm).toBe(0);
  });

  it('also degrades gracefully when ctx.field is explicitly null', () => {
    const scans = scansOf({ '4:5': { 8: empty } });
    /** @type {any} */
    const region = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };
    const ch = computeZoneChannels(region, { scans, positions: [8], galaxyMax: G10, field: null });
    expect(ch.safety).toBeCloseTo(0.5, 10);
    expect(ch.farm).toBe(0);
  });
});

describe('computeZoneChannels — with a real field', () => {
  it('safety/farm reflect the sampled field values', () => {
    const scans = scansOf({
      '4:5': { 8: empty },
      '4:6': { 3: occ(1, 50000) },
    });
    const field = buildThreatFarmField(scans, { galaxies: 4, systems: G10 }, { cols: G10, ownMilitary: 5000 });
    /** @type {any} */
    const region = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };
    const ch = computeZoneChannels(region, { scans, positions: [8], galaxyMax: G10, field });
    // A strong active neighbour one system away must depress safety below the
    // no-field neutral baseline of 0.5.
    expect(ch.safety).toBeLessThan(0.5);
    expect(ch.safety).toBeGreaterThanOrEqual(0);
  });

  it('farm channel reflects nonzero sampled farm value near an inactive neighbour', () => {
    const scans = scansOf({
      '4:5': { 8: empty },
      '4:6': { 3: inact(1, 20000) },
    });
    const field = buildThreatFarmField(scans, { galaxies: 4, systems: G10 }, { cols: G10, farmReach: 30 });
    /** @type {any} */
    const region = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };
    const ch = computeZoneChannels(region, { scans, positions: [8], galaxyMax: G10, field });
    expect(ch.farm).toBeGreaterThan(0);
  });
});

describe('computeZoneChannels — streak channel', () => {
  it('for a region with a center, streak derives from contiguousFreeRun (saturating curve)', () => {
    // Two centre regions with different run lengths — longer run must score
    // strictly higher, and always < 1.
    /** @type {Record<string, Record<number, any>>} */
    const shortSpec = {};
    for (const s of [4, 5, 6]) shortSpec[`4:${s}`] = { 8: empty };
    shortSpec['4:3'] = { 8: occ(1) };
    shortSpec['4:7'] = { 8: occ(1) };
    /** @type {any} */
    const shortRegion = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };
    const shortCh = computeZoneChannels(shortRegion, { scans: scansOf(shortSpec), positions: [8], galaxyMax: G10 });

    /** @type {Record<string, Record<number, any>>} */
    const longSpec = {};
    for (let s = 1; s <= G10; s++) longSpec[`4:${s}`] = { 8: empty };
    /** @type {any} */
    const longRegion = { galaxy: 4, start: 1, end: G10, center: 5, matched: 1 };
    const longCh = computeZoneChannels(longRegion, { scans: scansOf(longSpec), positions: [8], galaxyMax: G10 });

    expect(longCh.streak).toBeGreaterThan(shortCh.streak);
    expect(longCh.streak).toBeLessThan(1);
    expect(shortCh.streak).toBeGreaterThan(0);
  });

  it('for a streak region (no center), streak uses region.matched directly', () => {
    const scans = scansOf({ '4:1': { 8: empty } });
    /** @type {any} */
    const shortRegion = { galaxy: 4, start: 1, end: 3, matched: 3 };
    /** @type {any} */
    const longRegion = { galaxy: 4, start: 1, end: 30, matched: 30 };
    const shortCh = computeZoneChannels(shortRegion, { scans, positions: [8], galaxyMax: 499 });
    const longCh = computeZoneChannels(longRegion, { scans, positions: [8], galaxyMax: 499 });

    expect(shortCh.streak).toBeCloseTo(1 - Math.exp(-3 / 15), 10);
    expect(longCh.streak).toBeCloseTo(1 - Math.exp(-30 / 15), 10);
    expect(longCh.streak).toBeGreaterThan(shortCh.streak);
    expect(longCh.streak).toBeLessThan(1);
  });
});

describe('computeZoneChannels — target/coverage from region.score', () => {
  const scans = scansOf({ '4:1': { 8: empty } });
  /** @type {any} */
  const baseRegion = { galaxy: 4, start: 1, end: 5, matched: 5 };

  it('target/coverage move with score fields as expected', () => {
    const lowActivity = {
      ...baseRegion,
      score: { scanned: 5, occupied: 0, honorable: 0, honoredTierSum: 0, systemCount: 5 },
    };
    const highActivity = {
      ...baseRegion,
      score: { scanned: 5, occupied: 4, honorable: 1, honoredTierSum: 10, systemCount: 5 },
    };
    const lowCh = computeZoneChannels(lowActivity, { scans, positions: [8], galaxyMax: 499 });
    const highCh = computeZoneChannels(highActivity, { scans, positions: [8], galaxyMax: 499 });

    expect(lowCh.target).toBe(0);
    expect(highCh.target).toBeGreaterThan(0);
    expect(highCh.target).toBeLessThanOrEqual(1);
    expect(lowCh.coverage).toBeCloseTo(1, 10); // 5/5
    expect(highCh.coverage).toBeCloseTo(1, 10);
  });

  it('coverage reflects partial scanning (scanned/systemCount)', () => {
    const partial = {
      ...baseRegion,
      score: { scanned: 2, occupied: 0, honorable: 0, honoredTierSum: 0, systemCount: 8 },
    };
    const ch = computeZoneChannels(partial, { scans, positions: [8], galaxyMax: 499 });
    expect(ch.coverage).toBeCloseTo(0.25, 10);
  });

  it('target and coverage both stay 0 when region.score.scanned is 0', () => {
    const zeroScanned = {
      ...baseRegion,
      score: { scanned: 0, occupied: 5, honorable: 5, honoredTierSum: 99, systemCount: 5 },
    };
    const ch = computeZoneChannels(zeroScanned, { scans, positions: [8], galaxyMax: 499 });
    expect(ch.target).toBe(0);
    expect(ch.coverage).toBe(0);
  });

  it('target and coverage both stay 0 when region.score is absent', () => {
    const ch = computeZoneChannels(baseRegion, { scans, positions: [8], galaxyMax: 499 });
    expect(ch.target).toBe(0);
    expect(ch.coverage).toBe(0);
  });
});

describe('computeZoneChannels — region.excluded field-aware threat adjustment', () => {
  it('excluding the local threat maximum RAISES safety (or, at worst, leaves it unchanged) vs. no exclusion', () => {
    // A single strong active neighbour at system 6, inside the region span
    // 3..7 around centre 5. That player IS the local threat max in the span.
    const scans = scansOf({
      '4:5': { 8: empty },
      '4:6': { 3: occ(42, 80000) },
    });
    const field = buildThreatFarmField(scans, { galaxies: 4, systems: G10 }, { cols: G10, ownMilitary: 5000 });
    /** @type {any} */
    const baseRegion = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };

    const unexcludedCh = computeZoneChannels({ ...baseRegion }, {
      scans, positions: [8], galaxyMax: G10, field, ownMilitary: 5000,
    });

    const excludedRegion = { ...baseRegion, excluded: [{ id: 42, name: 'P42' }] };
    const excludedCh = computeZoneChannels(excludedRegion, {
      scans, positions: [8], galaxyMax: G10, field, ownMilitary: 5000,
    });

    // Precise magnitude of the adjustment is fragile (depends on the reach
    // kernel + p95 scale interacting), so assert the direction only: dropping
    // the local threat max must never make the window read LESS safe.
    expect(excludedCh.safety).toBeGreaterThanOrEqual(unexcludedCh.safety);
    // And in this fixture (single threat source, well within reach) it should
    // measurably improve, not just tie.
    expect(excludedCh.safety).toBeGreaterThan(unexcludedCh.safety);
  });

  it('an empty/omitted region.excluded leaves safety unchanged', () => {
    const scans = scansOf({
      '4:5': { 8: empty },
      '4:6': { 3: occ(42, 80000) },
    });
    const field = buildThreatFarmField(scans, { galaxies: 4, systems: G10 }, { cols: G10, ownMilitary: 5000 });
    /** @type {any} */
    const baseRegion = { galaxy: 4, start: 3, end: 7, center: 5, matched: 1 };

    const omittedCh = computeZoneChannels({ ...baseRegion }, {
      scans, positions: [8], galaxyMax: G10, field, ownMilitary: 5000,
    });
    const emptyExcludedCh = computeZoneChannels({ ...baseRegion, excluded: [] }, {
      scans, positions: [8], galaxyMax: G10, field, ownMilitary: 5000,
    });

    expect(emptyExcludedCh.safety).toBe(omittedCh.safety);
  });
});

describe('zoneFit', () => {
  it('a high-safety/low-target channel set scores higher under "safe" than "pvp"', () => {
    const ch = { safety: 0.9, farm: 0.1, streak: 0.5, target: 0.1, coverage: 1 };
    const safeFit = zoneFit(ch, 'safe');
    const pvpFit = zoneFit(ch, 'pvp');
    expect(safeFit).toBeGreaterThan(pvpFit);
  });

  it('a high-target/low-safety channel set scores higher under "pvp" than "safe"', () => {
    const ch = { safety: 0.1, farm: 0.1, streak: 0.1, target: 0.9, coverage: 1 };
    const safeFit = zoneFit(ch, 'safe');
    const pvpFit = zoneFit(ch, 'pvp');
    expect(pvpFit).toBeGreaterThan(safeFit);
  });

  it('coverage=0 returns the UNKNOWN_PRIOR (0.25) regardless of channel values', () => {
    const highCh = { safety: 1, farm: 1, streak: 1, target: 1, coverage: 0 };
    const lowCh = { safety: 0, farm: 0, streak: 0, target: 0, coverage: 0 };
    expect(zoneFit(highCh, 'safe')).toBeCloseTo(0.25, 10);
    expect(zoneFit(lowCh, 'pvp')).toBeCloseTo(0.25, 10);
  });

  it('an unknown zoneKey falls back to ZONES.safe weights', () => {
    const ch = { safety: 0.7, farm: 0.2, streak: 0.4, target: 0.1, coverage: 1 };
    expect(zoneFit(ch, 'not-a-real-zone')).toBeCloseTo(zoneFit(ch, 'safe'), 10);
  });
});

describe('annotateAndSortByZone', () => {
  it('annotates each region with channels+fit, returns a NEW array sorted by fit desc (tie-broken by matched then galaxy)', () => {
    const scans = scansOf({ '1:1': { 8: empty }, '2:1': { 8: empty }, '3:1': { 8: empty } });
    /** @type {any} */
    const regionLow = {
      galaxy: 3, start: 1, end: 1, matched: 1,
      score: { scanned: 1, occupied: 0, honorable: 0, honoredTierSum: 0, systemCount: 1 },
    };
    /** @type {any} */
    const regionHigh = {
      galaxy: 1, start: 1, end: 1, matched: 1,
      score: { scanned: 1, occupied: 1, honorable: 1, honoredTierSum: 3, systemCount: 1 },
    };
    /** @type {any} */
    const regionTieHigherMatched = {
      galaxy: 2, start: 1, end: 1, matched: 5,
      score: { scanned: 1, occupied: 1, honorable: 1, honoredTierSum: 3, systemCount: 1 },
    };

    const regions = [regionLow, regionHigh, regionTieHigherMatched];
    const ctx = { scans, positions: [8], galaxyMax: 499 };
    const sorted = annotateAndSortByZone(regions, 'pvp', ctx);

    // New array reference, same length.
    expect(sorted).not.toBe(regions);
    expect(sorted).toHaveLength(3);

    // Each region got mutated in place with channels + fit (elements ARE
    // shared/mutated — only the array wrapper is new).
    for (const r of regions) {
      expect(r.channels).toBeTruthy();
      expect(typeof r.fit).toBe('number');
    }

    // regionHigh and regionTieHigherMatched have identical target-driving
    // score fields (tie on fit); tie-break by matched (5 > 1) puts
    // regionTieHigherMatched first among the two, and both must outrank
    // regionLow (0 activity → 0 target).
    expect(sorted[0]).toBe(regionTieHigherMatched);
    expect(sorted[1]).toBe(regionHigh);
    expect(sorted[2]).toBe(regionLow);
  });
});
