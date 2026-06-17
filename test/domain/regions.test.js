// Unit tests for the pure region finders in domain/regions.js.
// `findFreeSystems` (the "individual free systems" view) is exercised
// alongside characterization tests for `findBestRegions` — the latter
// previously had no coverage and is the safety net for extracting the
// shared pre-pass (`collectMatchesAndMines`) that both finders run.
// The one contrast that motivated `findFreeSystems` is pinned directly:
// scattered free slots yield NO region but DO yield free systems.
//
// Small `galaxyMax` (10) keeps fixtures readable; the algorithm is
// range-agnostic.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  findBestRegions,
  findFreeSystems,
  scoreRegion,
  sortRegionsByStrategy,
  MIN_REGION_LENGTH,
} from '../../src/domain/regions.js';

/** A confirmed-empty slot. */
const empty = { status: 'empty' };
/** An occupied slot owned by player `id`. @param {number} id */
const occ = (id) => ({ status: 'occupied', player: { id, name: 'P' + id } });
/** An inactive (farmable) slot owned by player `id`. @param {number} id */
const inact = (id) => ({ status: 'inactive', player: { id, name: 'P' + id } });

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

const G10 = { galaxyMax: 10 };

describe('findFreeSystems', () => {
  it('returns [] when positions is empty', () => {
    const scans = scansOf({ '4:1': { 8: empty } });
    expect(findFreeSystems(scans, { positions: [], ...G10 })).toEqual([]);
  });

  it('returns [] when no system matches', () => {
    const scans = scansOf({ '4:1': { 8: occ(1) }, '4:2': { 8: inact(2) } });
    expect(findFreeSystems(scans, { positions: [8], ...G10 })).toEqual([]);
  });

  it('returns one length-1 region per matching system', () => {
    const scans = scansOf({
      '4:1': { 8: empty },
      '4:3': { 8: empty },
      '5:7': { 8: empty },
    });
    const res = findFreeSystems(scans, { positions: [8], ...G10 });
    expect(res.map((r) => `${r.galaxy}:${r.start}`).sort()).toEqual(['4:1', '4:3', '5:7']);
    for (const r of res) {
      expect(r.length).toBe(1);
      expect(r.start).toBe(r.end);
      expect(r.matched).toBe(1);
      expect(r.gaps).toBe(0);
      expect(r.score).toBeTruthy();
    }
  });

  it('requires ALL requested positions empty (AND semantics)', () => {
    const scans = scansOf({
      '4:1': { 8: empty, 9: empty },
      '4:2': { 8: empty, 9: occ(1) },
    });
    const res = findFreeSystems(scans, { positions: [8, 9], ...G10 });
    expect(res.map((r) => r.start)).toEqual([1]);
  });

  it('scores the neighbourhood of each free system', () => {
    const scans = scansOf({
      '4:1': { 8: empty, 3: occ(1), 5: inact(2) },
    });
    const [r] = findFreeSystems(scans, { positions: [8], ...G10 });
    const sc = /** @type {any} */ (r.score);
    expect(sc.scanned).toBe(1);
    expect(sc.systemCount).toBe(1);
    expect(sc.occupied).toBe(1);
    expect(sc.inactive).toBe(1);
  });

  it('finds scattered free systems where findBestRegions finds NO region', () => {
    // The motivating bug: slot 8 free at non-adjacent systems. With the
    // default 0-gap tolerance nothing forms a run of MIN_REGION_LENGTH, so
    // the region finder is empty — but each system is individually free.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [1, 3, 5, 7, 9]) spec[`4:${s}`] = { 8: empty };
    const scans = scansOf(spec);

    expect(MIN_REGION_LENGTH).toBeGreaterThan(1);
    expect(
      findBestRegions(scans, { positions: [8], status: 'empty', maxGaps: 0, ...G10 }),
    ).toEqual([]);
    expect(findFreeSystems(scans, { positions: [8], ...G10 })).toHaveLength(5);
  });

  it('skips unscanned and malformed keys defensively', () => {
    const scans = scansOf({
      '4:1': { 8: empty },
      nokey: { 8: empty }, // no "g:s" colon → skipped
      '4:0': { 8: empty }, // system 0 out of range → skipped
    });
    const res = findFreeSystems(scans, { positions: [8], ...G10 });
    expect(res.map((r) => `${r.galaxy}:${r.start}`)).toEqual(['4:1']);
  });
});

describe('findBestRegions', () => {
  it('returns [] when positions is empty', () => {
    const scans = scansOf({ '4:1': { 8: empty }, '4:2': { 8: empty } });
    expect(findBestRegions(scans, { positions: [], maxGaps: 0, ...G10 })).toEqual([]);
  });

  it('finds a basic contiguous region (run ≥ MIN_REGION_LENGTH)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [1, 2, 3, 4, 5]) spec[`4:${s}`] = { 8: empty };
    const res = findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, ...G10 });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ galaxy: 4, start: 1, end: 5, length: 5, matched: 5, gaps: 0 });
  });

  it('drops runs shorter than MIN_REGION_LENGTH', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s < MIN_REGION_LENGTH; s++) spec[`4:${s}`] = { 8: empty };
    expect(findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, ...G10 })).toEqual([]);
  });

  it('finds a region wrapping across the galaxyMax → 1 boundary', () => {
    // Slot 8 free at 9,10,1,2,3 — a 5-system run crossing the 10 → 1 seam.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [9, 10, 1, 2, 3]) spec[`4:${s}`] = { 8: empty };
    const res = findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, ...G10 });
    expect(res).toHaveLength(1);
    // end < start signals the wrap.
    expect(res[0]).toMatchObject({ galaxy: 4, start: 9, end: 3, length: 5, matched: 5, gaps: 0 });
  });

  it('bridges a non-matching system when maxGaps allows', () => {
    // Slot 8 free at 1,2,4,5,6 — system 3 is a gap. maxGaps:1 lets the span
    // 1..6 form one region (5 matched + 1 tolerated gap).
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [1, 2, 4, 5, 6]) spec[`4:${s}`] = { 8: empty };
    const res = findBestRegions(scansOf(spec), { positions: [8], maxGaps: 1, ...G10 });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ galaxy: 4, start: 1, end: 6, length: 6, matched: 5, gaps: 1 });
    // With no tolerance the longest 0-gap run is only 3 (4,5,6) < MIN → nothing.
    expect(findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, ...G10 })).toEqual([]);
  });

  it('caps extracted regions per galaxy at MAX_REGIONS_PER_GALAXY (5)', () => {
    // Six isolated blocks of 5 contiguous free systems in one galaxy; the
    // internal per-galaxy cap keeps only 5. Needs a larger galaxyMax to fit.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let block = 0; block < 6; block++) {
      const base = block * 10 + 1; // 1, 11, 21, … — a 5-system gap between blocks
      for (let i = 0; i < 5; i++) spec[`4:${base + i}`] = { 8: empty };
    }
    const res = findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, galaxyMax: 100 });
    expect(res).toHaveLength(5);
    for (const r of res) expect(r.length).toBe(5);
  });

  it('attaches a neighbourhood score computed over the region span', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [1, 2, 3, 4, 5]) spec[`4:${s}`] = { 8: empty };
    spec['4:3'][5] = occ(1);   // an active neighbour inside the span
    spec['4:4'][6] = inact(2); // a farmable neighbour inside the span
    const [r] = findBestRegions(scansOf(spec), { positions: [8], maxGaps: 0, ...G10 });
    const sc = /** @type {any} */ (r.score);
    expect(sc).toBeTruthy();
    expect(sc.systemCount).toBe(5);
    expect(sc.scanned).toBe(5);
    expect(sc.occupied).toBe(1);
    expect(sc.inactive).toBe(1);
  });
});

describe('scoreRegion — player-cache signals (2b)', () => {
  // A single-system region 4:1, with three occupied neighbours in other slots.
  const scans = scansOf({
    '4:1': { 8: empty, 3: occ(1), 5: occ(2), 7: { status: 'vacation', player: { id: 3, name: 'P3' } } },
  });
  const region = { galaxy: 4, start: 1, end: 1 };

  /** @type {any} */
  const players = {
    1: { id: 1, name: 'P1', flags: { strong: true } },
    2: { id: 2, name: 'P2', flags: { outlaw: true, allianceMember: true } },
    3: { id: 3, name: 'P3', flags: { active: true } }, // active AND status vacation
  };

  it('derives strong/outlaw/active-on-vacation/ally counts from the cache', () => {
    const sc = scoreRegion(region, scans, { players, ...G10 });
    expect(sc.strong).toBe(1);
    expect(sc.outlaw).toBe(1);
    expect(sc.activeOnVacation).toBe(1); // player 3: vacation status + active flag
    expect(sc.allyNearby).toBe(1); // player 2 isAllianceMember
  });

  it('leaves the new counts at 0 when no cache is supplied', () => {
    const sc = scoreRegion(region, scans, { ...G10 });
    expect(sc.strong).toBe(0);
    expect(sc.outlaw).toBe(0);
    expect(sc.activeOnVacation).toBe(0);
    expect(sc.newbie).toBe(0);
    expect(sc.buddy).toBe(0);
  });

  it('falls back to ownAllyTag for allyNearby when no cache is supplied', () => {
    const tagged = scansOf({
      '4:1': { 8: empty, 3: { status: 'occupied', player: { id: 1, name: 'P1', ally: 'FORM' } } },
    });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 1 }, tagged, { ownAllyTag: 'FORM', ...G10 });
    expect(sc.allyNearby).toBe(1);
  });
});

describe('sortRegionsByStrategy — strong penalty (2b)', () => {
  it("ranks a region with a strong neighbour below an equivalent one without, under 'peaceful'", () => {
    // Two single-system free regions, each with one active neighbour; only
    // 4:1's neighbour is flagged strong. Under 'peaceful' (strong: -1.5) the
    // clean region should sort first.
    const scans = scansOf({
      '4:1': { 8: empty, 3: occ(10) },
      '4:2': { 8: empty, 3: occ(20) },
    });
    /** @type {any} */
    const players = { 10: { id: 10, name: 'A', flags: { strong: true } } };
    const free = findFreeSystems(scans, { positions: [8], players, ...G10 });
    const sorted = sortRegionsByStrategy(free, 'peaceful');
    expect(sorted[0].start).toBe(2); // the strong-free system wins
    expect(sorted[1].start).toBe(1);
  });
});
