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
  findNeighbourhoodCandidates,
  spaceOutCandidates,
  scoreRegion,
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

  it('counts honorable targets and newbies (weak) from the cache', () => {
    const occScans = scansOf({
      '4:1': { 8: empty, 3: occ(1), 5: occ(2), 7: occ(3) },
    });
    /** @type {any} */
    const cache = {
      1: { id: 1, name: 'H1', flags: { honorable: true } },
      2: { id: 2, name: 'H2', flags: { honorable: true } },
      3: { id: 3, name: 'N1', flags: { newbie: true } },
    };
    const sc = scoreRegion(region, occScans, { players: cache, ...G10 });
    expect(sc.honorable).toBe(2);
    expect(sc.newbie).toBe(1);
  });

  it('counts "normal" (white) live-scanned occupants with no special standing', () => {
    const occScans = scansOf({
      '4:1': { 8: empty, 3: occ(1), 5: occ(2), 7: occ(3) },
    });
    /** @type {any} */
    const cache = {
      1: { id: 1, name: 'W1', flags: { active: true } }, // plain white target
      2: { id: 2, name: 'W2' },                          // cached, no flags → white
      3: { id: 3, name: 'H', flags: { honorable: true } }, // a band, not normal
    };
    const sc = scoreRegion(region, occScans, { players: cache, ...G10 });
    expect(sc.normal).toBe(2);
    expect(sc.honorable).toBe(1);
  });

  it('breaks bandits down by honour tier (banditTiers)', () => {
    const occScans = scansOf({
      '4:1': {
        8: empty,
        3: { status: 'occupied', player: { id: 1, name: 'KB', rankClass: 'rank_bandit3' } },
        5: { status: 'occupied', player: { id: 2, name: 'KB2', rankClass: 'rank_bandit3' } },
        7: { status: 'occupied', player: { id: 3, name: 'B', rankClass: 'rank_bandit1' } },
      },
    });
    const sc = scoreRegion(region, occScans, { ...G10 });
    expect(sc.bandits).toBe(3);
    expect(sc.banditTiers[3]).toBe(2);
    expect(sc.banditTiers[1]).toBe(1);
    expect(sc.banditTiers[2]).toBeUndefined();
  });

  it('does NOT count a cached buddy / alliance member as "normal"', () => {
    const occScans = scansOf({ '4:1': { 8: empty, 3: occ(1), 5: occ(2) } });
    /** @type {any} */
    const cache = {
      1: { id: 1, name: 'Friend', flags: { buddy: true } },
      2: { id: 2, name: 'Mate', flags: { allianceMember: true } },
    };
    const sc = scoreRegion(region, occScans, { players: cache, ...G10 });
    expect(sc.normal).toBe(0);
  });

  it('leaves the new counts at 0 when no cache is supplied', () => {
    const sc = scoreRegion(region, scans, { ...G10 });
    expect(sc.strong).toBe(0);
    expect(sc.outlaw).toBe(0);
    expect(sc.activeOnVacation).toBe(0);
    expect(sc.newbie).toBe(0);
    expect(sc.honorable).toBe(0);
    expect(sc.normal).toBe(0);
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

/**
 * An occupied slot owned by `id` with a rank class (bandit/honored).
 * @param {number} id @param {string} rankClass @param {number} [rank]
 */
const ranked = (id, rankClass, rank) => ({
  status: 'occupied', player: { id, name: 'P' + id, rankClass, rank },
});

describe('scoreRegion — banned = eternal vacation', () => {
  it('counts a banned bandit as vacation, never as a threat or a rank', () => {
    const scans = scansOf({
      '4:1': {
        8: empty,
        3: { status: 'banned', player: { id: 7, name: 'B', rank: 5, rankClass: 'rank_bandit3' } },
      },
    });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 1 }, scans, { ...G10 });
    expect(sc.vacation).toBe(1);     // folded into the protected bucket
    expect(sc.bandits).toBe(0);      // NOT a bandit threat
    expect(sc.banditTierSum).toBe(0);
    expect(sc.ranks).toEqual([]);    // rank not recorded → not "above you"
  });

  it('does not let a banned strong player count via the cache', () => {
    const scans = scansOf({
      '4:1': { 8: empty, 3: { status: 'banned', player: { id: 9, name: 'S' } } },
    });
    /** @type {any} */
    const players = { 9: { id: 9, name: 'S', flags: { strong: true } } };
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 1 }, scans, { players, ...G10 });
    expect(sc.strong).toBe(0);
  });
});

describe('scoreRegion — points temperature (avgTotal / avgMilitary)', () => {
  /**
   * An occupied slot whose player carries API-joined highscore POINTS.
   * @param {number} id @param {number} [score] @param {number} [militaryScore]
   */
  const pts = (id, score, militaryScore) => ({
    status: 'occupied', player: { id, name: 'P' + id, score, militaryScore },
  });

  it('averages points over DISTINCT players (rounded)', () => {
    const scans = scansOf({
      '4:1': { 8: empty, 3: pts(1, 1000, 100), 5: pts(2, 2001) },
      // player 1's second colony — the account must not be double-counted.
      '4:2': { 4: pts(1, 1000, 100) },
    });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 2 }, scans, { ...G10 });
    expect(sc.avgTotal).toBe(1501); // (1000 + 2001) / 2, rounded
    expect(sc.avgMilitary).toBe(100); // only player 1 exposes military points
  });

  it("fills a player's points from whichever position first exposes them", () => {
    const scans = scansOf({
      '4:1': { 8: empty, 3: occ(1) }, // live-scan sighting: no points
      '4:2': { 3: pts(1, 500) }, // API sighting fills them in
    });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 2 }, scans, { ...G10 });
    expect(sc.avgTotal).toBe(500);
  });

  it('is 0 when no scanned player carries points (live-only scans)', () => {
    const scans = scansOf({ '4:1': { 8: empty, 3: occ(1) } });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 1 }, scans, { ...G10 });
    expect(sc.avgTotal).toBe(0);
    expect(sc.avgMilitary).toBe(0);
  });

  it('excludes a banned account from the averages (eternal vacation)', () => {
    const scans = scansOf({
      '4:1': {
        8: empty,
        3: { status: 'banned', player: { id: 7, name: 'B', score: 9000000, militaryScore: 9000000 } },
        5: pts(8, 1000),
      },
    });
    const sc = scoreRegion({ galaxy: 4, start: 1, end: 1 }, scans, { ...G10 });
    expect(sc.avgTotal).toBe(1000);
    expect(sc.avgMilitary).toBe(0);
  });
});

describe('findNeighbourhoodCandidates', () => {
  it('windows [S-R, S+R] around each free-slot centre', () => {
    const scans = scansOf({ '4:5': { 8: empty } });
    const res = findNeighbourhoodCandidates(scans, { positions: [8], radius: 2, ...G10 });
    expect(res).toHaveLength(1);
    expect(res[0].center).toBe(5);
    expect(res[0].start).toBe(3);
    expect(res[0].end).toBe(7);
    expect(res[0].length).toBe(5);
  });

  it('qualifies a centre on ANY free slot (not all, unlike streak mode)', () => {
    const scans = scansOf({ '4:5': { 8: empty, 9: occ(1) } });
    const res = findNeighbourhoodCandidates(scans, { positions: [8, 9], radius: 1, ...G10 });
    expect(res).toHaveLength(1);
    expect(res[0].center).toBe(5);
  });

  it('drops the N worst players from the score and reports them', () => {
    const scans = scansOf({
      '4:5': { 8: empty },
      '4:6': { 3: ranked(9, 'rank_bandit3') },
    });
    const res = findNeighbourhoodCandidates(scans, {
      positions: [8], radius: 2, excludeN: 1, weights: { bandit: -3 }, ...G10,
    });
    expect(res[0].excluded ?? []).toHaveLength(1);
    expect(res[0].excluded?.[0]?.id).toBe(9);
    expect(res[0].score?.bandits).toBe(0); // excluded → no longer a threat in the score
  });
});

describe('spaceOutCandidates', () => {
  /** @param {Partial<import('../../src/domain/regions.js').Region>} r */
  const region = (r) => /** @type {any} */ ({ length: 5, matched: 1, gaps: 0, ...r });

  it('suppresses an overlapping lower-ranked centre, keeps a distant one', () => {
    const near = region({ galaxy: 4, center: 6, start: 4, end: 8 });
    const far = region({ galaxy: 4, center: 9, start: 7, end: 1 });
    // Input order = rank order (best first); centre 5 wins its overlap with 6.
    const best = region({ galaxy: 4, center: 5, start: 3, end: 7 });
    const out = spaceOutCandidates([best, near, far], 2, 10);
    expect(out.map((r) => r.center)).toEqual([5, 9]);
  });

  it('passes non-neighbourhood regions (no center) straight through', () => {
    const streak = region({ galaxy: 4, start: 1, end: 5 });
    expect(spaceOutCandidates([streak], 2, 10)).toHaveLength(1);
  });
});
