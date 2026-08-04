// @ts-check

// Unit tests for domain/homeWatch — the defensive "who moved in next to me?"
// math. Pure functions over plain scan/body fixtures: no DOM, no storage, no
// clock (nowMs is always injected).

import { describe, it, expect } from 'vitest';
import {
  HOME_LOOK_WEIGHT,
  HOME_ALERT_BOOST,
  HOME_ARRIVALS_CAP,
  homeSystemKeys,
  systemOccupants,
  diffHomeSystems,
  mergeHomeArrivals,
  buildHomeLookPlan,
} from '../../src/domain/homeWatch.js';

/** An occupied slot owned by `id`. @param {number} id */
const occ = (id) => ({ status: 'occupied', player: { id, name: 'P' + id } });
const mine = { status: 'mine' };
const empty = { status: 'empty' };

/**
 * `{ "g:s": { scannedAt, positions } }` from shorthand.
 * @param {Record<string, { at: number, pos: Record<number, any> }>} spec
 */
const scansOf = (spec) => {
  /** @type {any} */
  const out = {};
  for (const [key, v] of Object.entries(spec)) out[key] = { scannedAt: v.at, positions: v.pos };
  return out;
};

describe('homeSystemKeys', () => {
  it('collapses a planet and its moon in one system to a single key', () => {
    const keys = homeSystemKeys([
      { galaxy: 4, system: 151 },
      { galaxy: 4, system: 151 }, // the moon of the same slot
      { galaxy: 2, system: 8 },
    ]);
    expect([...keys].sort()).toEqual(['2:8', '4:151']);
  });

  it('ignores malformed bodies and an empty inventory', () => {
    expect(homeSystemKeys([]).size).toBe(0);
    // @ts-expect-error — exercising the runtime guard.
    expect(homeSystemKeys([null, { galaxy: 1 }, { system: 2 }]).size).toBe(0);
  });
});

describe('systemOccupants', () => {
  it('lists foreign bodies by slot, excluding ours twice over', () => {
    const occs = systemOccupants({ 3: occ(207), 1: mine, 8: occ(103), 5: empty }, 103);
    expect(occs).toEqual([{ id: 207, position: 3 }]);
  });

  it('is empty for an unscanned system or a system of only empties', () => {
    expect(systemOccupants(undefined)).toEqual([]);
    expect(systemOccupants({ 1: empty, 2: empty })).toEqual([]);
  });
});

describe('diffHomeSystems', () => {
  const systems = new Set(['4:151']);

  it('seeds the baseline on first sight WITHOUT alerting', () => {
    // Everyone already there is simply a neighbour — reporting a dozen
    // "arrivals" the first time would train the user to ignore the alert.
    const scans = scansOf({ '4:151': { at: 1000, pos: { 1: mine, 3: occ(207), 8: occ(9) } } });
    const { arrivals, baseline, changed } = diffHomeSystems({
      systems, scans, baseline: {}, ownId: 103,
    });
    expect(arrivals).toEqual([]);
    expect(changed).toBe(true);
    expect(baseline['4:151']).toEqual({ ids: [207, 9], seenAt: 1000 });
  });

  it('reports a stranger who appeared since the previous sighting', () => {
    const baseline = { '4:151': { ids: [207], seenAt: 1000 } };
    const scans = scansOf({ '4:151': { at: 2000, pos: { 3: occ(207), 12: occ(555) } } });
    const { arrivals, baseline: next } = diffHomeSystems({ systems, scans, baseline, ownId: 103 });
    expect(arrivals).toEqual([
      { system: '4:151', coord: '4:151:12', playerId: 555, atMs: 2000 },
    ]);
    expect(next['4:151'].ids).toEqual([207, 555]);
  });

  it('does not re-report on a sighting that is not newer (repaint safety)', () => {
    const baseline = { '4:151': { ids: [207], seenAt: 2000 } };
    const scans = scansOf({ '4:151': { at: 2000, pos: { 3: occ(207), 12: occ(555) } } });
    const { arrivals, changed } = diffHomeSystems({ systems, scans, baseline, ownId: 103 });
    expect(arrivals).toEqual([]);
    expect(changed).toBe(false);
  });

  it('ignores departures (only the risk-increasing direction alerts)', () => {
    const baseline = { '4:151': { ids: [207, 555], seenAt: 1000 } };
    const scans = scansOf({ '4:151': { at: 2000, pos: { 3: occ(207) } } });
    const { arrivals, baseline: next } = diffHomeSystems({ systems, scans, baseline, ownId: 103 });
    expect(arrivals).toEqual([]);
    expect(next['4:151'].ids).toEqual([207]);
  });

  it('carries a baseline forward for a system we have not browsed yet', () => {
    const baseline = { '4:151': { ids: [207], seenAt: 1000 } };
    const { arrivals, baseline: next } = diffHomeSystems({
      systems, scans: {}, baseline, ownId: 103,
    });
    expect(arrivals).toEqual([]);
    expect(next['4:151']).toEqual(baseline['4:151']);
  });

  it('flags changed when a home system disappears (last body abandoned)', () => {
    const baseline = { '4:151': { ids: [207], seenAt: 1000 }, '2:8': { ids: [], seenAt: 1000 } };
    const { baseline: next, changed } = diffHomeSystems({
      systems, scans: {}, baseline, ownId: 103,
    });
    expect(changed).toBe(true);
    expect(Object.keys(next)).toEqual(['4:151']);
  });

  it('treats our OWN new colony in the system as nothing to report', () => {
    const baseline = { '4:151': { ids: [207], seenAt: 1000 } };
    const scans = scansOf({ '4:151': { at: 2000, pos: { 3: occ(207), 9: mine, 10: occ(103) } } });
    const { arrivals } = diffHomeSystems({ systems, scans, baseline, ownId: 103 });
    expect(arrivals).toEqual([]);
  });
});

describe('mergeHomeArrivals', () => {
  /** @param {string} system @param {number} playerId @param {number} atMs */
  const arr = (system, playerId, atMs) => ({ system, coord: `${system}:5`, playerId, atMs });

  it('keeps one entry per (system, player), newest first, fresh side winning', () => {
    const stored = [arr('4:151', 555, 1000), arr('2:8', 9, 900)];
    const fresh = [arr('4:151', 555, 3000), arr('4:151', 777, 2000)];
    const out = mergeHomeArrivals(stored, fresh);
    expect(out.map((a) => [a.system, a.playerId, a.atMs])).toEqual([
      ['4:151', 555, 3000],
      ['4:151', 777, 2000],
      ['2:8', 9, 900],
    ]);
  });

  it('counts the same player in a DIFFERENT system as separate news', () => {
    const out = mergeHomeArrivals([], [arr('4:151', 555, 2000), arr('2:8', 555, 1000)]);
    expect(out).toHaveLength(2);
  });

  it('caps the log', () => {
    const many = Array.from({ length: HOME_ARRIVALS_CAP + 10 }, (_, i) => arr(`4:${i}`, i, 1000 + i));
    const out = mergeHomeArrivals(many, []);
    expect(out).toHaveLength(HOME_ARRIVALS_CAP);
    // Newest survived the cut.
    expect(out[0].atMs).toBe(1000 + HOME_ARRIVALS_CAP + 9);
  });
});

describe('buildHomeLookPlan', () => {
  const NOW = 10_000_000;
  const STALE = 3_600_000; // 1 h cadence

  it('proposes a system we have never looked at, with an empty body list', () => {
    const { entries } = buildHomeLookPlan({
      systems: new Set(['4:151']), scans: {}, nowMs: NOW, staleMs: STALE,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      galaxy: 4, system: 151, label: '4:151', worst: 'none', home: true, bodies: [],
    });
    expect(entries[0].why).toContain('home');
  });

  it('skips a system looked at within the cadence', () => {
    const scans = { '4:151': { scannedAt: NOW - 60_000 } };
    const { entries } = buildHomeLookPlan({
      systems: new Set(['4:151']), scans, nowMs: NOW, staleMs: STALE,
    });
    expect(entries).toEqual([]);
  });

  it('proposes a fresh system anyway when it holds an open arrival, boosted first', () => {
    const scans = { '4:151': { scannedAt: NOW - 60_000 }, '2:8': { scannedAt: 0 } };
    const { entries } = buildHomeLookPlan({
      systems: new Set(['4:151', '2:8']),
      scans,
      nowMs: NOW,
      staleMs: STALE,
      alertSystems: new Set(['4:151']),
    });
    expect(entries[0].label).toBe('4:151');
    expect(entries[0].why).toBe('home · new neighbour');
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority);
    // Sanity on the two weights driving that order.
    expect(HOME_ALERT_BOOST).toBeGreaterThan(HOME_LOOK_WEIGHT);
  });

  it('returns nothing for an empty home set', () => {
    expect(buildHomeLookPlan({
      systems: new Set(), scans: {}, nowMs: NOW, staleMs: STALE,
    }).entries).toEqual([]);
  });
});
