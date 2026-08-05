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
  friendlyNeighbourIds,
  rankHomeNeighbours,
  findHomeCoalitions,
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

  it('keeps one entry per (system, player), newest first, the STORED side winning', () => {
    // A re-derived arrival must NOT refresh atMs: acknowledgement compares
    // against it, so a fresh copy would resurrect a neighbour the user cleared
    // every time they walked the galaxy. 555 keeps its original 1000.
    const stored = [arr('4:151', 555, 1000), arr('2:8', 9, 900)];
    const fresh = [arr('4:151', 555, 3000), arr('4:151', 777, 2000)];
    const out = mergeHomeArrivals(stored, fresh);
    expect(out.map((a) => [a.system, a.playerId, a.atMs])).toEqual([
      ['4:151', 777, 2000],
      ['4:151', 555, 1000],
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
      // The arrival was logged FROM that sighting, so the boost is still owed.
      alerts: new Map([['4:151', NOW - 60_000]]),
    });
    expect(entries[0].label).toBe('4:151');
    expect(entries[0].why).toBe('home · new neighbour');
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority);
    // Sanity on the two weights driving that order.
    expect(HOME_ALERT_BOOST).toBeGreaterThan(HOME_LOOK_WEIGHT);
  });

  it('drops the boost once the system has been looked at since the arrival', () => {
    // The one-shot rule: the alert buys ONE look. Keyed to acknowledgement
    // instead, the Spy button would re-propose this system forever (tap → look →
    // same proposal) until the user found the dashboard's "clear NEW".
    const scans = { '4:151': { scannedAt: NOW - 30_000 } };
    const { entries } = buildHomeLookPlan({
      systems: new Set(['4:151']),
      scans,
      nowMs: NOW,
      staleMs: STALE,
      alerts: new Map([['4:151', NOW - 60_000]]),
    });
    expect(entries).toEqual([]);
  });

  it('returns nothing for an empty home set', () => {
    expect(buildHomeLookPlan({
      systems: new Set(), scans: {}, nowMs: NOW, staleMs: STALE,
    }).entries).toEqual([]);
  });
});

describe('friendlyNeighbourIds', () => {
  it('collects ids from the danger profiles’ friendly verdict', () => {
    const danger = new Map([
      [100, { friendly: true }],
      [200, { friendly: false }],
    ]);
    expect(friendlyNeighbourIds({ danger })).toEqual(new Set(['100']));
  });

  it('collects ids flagged buddy or allianceMember in the player cache', () => {
    /** @type {Record<string, { flags?: { buddy?: true, allianceMember?: true } }>} */
    const playerFlags = {
      100: { flags: { buddy: true } },
      200: { flags: { allianceMember: true } },
      300: { flags: {} },
      400: {},
    };
    expect(friendlyNeighbourIds({ playerFlags })).toEqual(new Set(['100', '200']));
  });

  it('collects ids sharing our own alliance on the public players feed', () => {
    const apiPlayers = {
      100: { alliance: '77' },
      200: { alliance: '88' },
    };
    expect(friendlyNeighbourIds({ apiPlayers, ownAlliance: '77' })).toEqual(new Set(['100']));
  });

  it('ignores the public feed when our own alliance is unknown', () => {
    const apiPlayers = { 100: { alliance: '77' } };
    expect(friendlyNeighbourIds({ apiPlayers })).toEqual(new Set());
  });

  it('unions all three sources and returns empty for no input', () => {
    const danger = new Map([[100, { friendly: true }]]);
    /** @type {Record<string, { flags?: { buddy?: true, allianceMember?: true } }>} */
    const playerFlags = { 200: { flags: { buddy: true } } };
    const apiPlayers = { 300: { alliance: '77' } };
    expect(friendlyNeighbourIds({
      danger, playerFlags, apiPlayers, ownAlliance: '77',
    })).toEqual(new Set(['100', '200', '300']));
    expect(friendlyNeighbourIds({})).toEqual(new Set());
  });
});

describe('rankHomeNeighbours', () => {
  it('folds per-system slots into one row per player, systems sorted ascending', () => {
    const occupants = {
      '4:151': [{ playerId: '100' }],
      '2:8': [{ playerId: '100' }],
    };
    const [row] = rankHomeNeighbours({ occupants });
    expect(row.playerId).toBe('100');
    expect(row.systems).toEqual(['2:8', '4:151']);
    expect(row.danger).toBeNull();
    expect(row.isNew).toBe(false);
    expect(row.allianceId).toBeUndefined();
  });

  it('orders worst danger first, reach as the tiebreaker, unknown danger last', () => {
    const occupants = {
      '1:1': [{ playerId: '100' }, { playerId: '200' }],
      '1:2': [{ playerId: '200' }],
      '1:3': [{ playerId: '300' }],
    };
    const dangerByPlayer = { 100: 0.2, 200: 0.9 };
    const rows = rankHomeNeighbours({ occupants, dangerByPlayer });
    expect(rows.map((r) => r.playerId)).toEqual(['200', '100', '300']);
    expect(rows[2].danger).toBeNull();
  });

  it('breaks a danger tie by reach (systems.length), not insertion order', () => {
    const occupants = {
      '1:1': [{ playerId: '100' }],
      '1:2': [{ playerId: '200' }],
      '1:3': [{ playerId: '200' }],
    };
    const dangerByPlayer = { 100: 0.5, 200: 0.5 };
    const rows = rankHomeNeighbours({ occupants, dangerByPlayer });
    expect(rows.map((r) => r.playerId)).toEqual(['200', '100']);
  });

  it('marks isNew when any of the player’s slots is in newKeys, and carries the alliance id', () => {
    const occupants = { '4:151': [{ playerId: '100' }] };
    const allianceByPlayer = { 100: '55' };
    const newKeys = new Set(['4:151|100']);
    const [row] = rankHomeNeighbours({
      occupants, allianceByPlayer, newKeys,
    });
    expect(row.isNew).toBe(true);
    expect(row.allianceId).toBe('55');
  });

  it('returns nothing for no occupants', () => {
    expect(rankHomeNeighbours({ occupants: {} })).toEqual([]);
  });
});

describe('findHomeCoalitions', () => {
  it('reports an alliance whose members TOGETHER reach more systems than any solo member', () => {
    // 100 alone reaches 1:1 and 1:2 (solo best = 2); 200 only reaches 1:3.
    // Together the alliance covers 3 systems — lift = 3 - 2 = 1.
    const occupants = {
      '1:1': [{ playerId: '100' }],
      '1:2': [{ playerId: '100' }],
      '1:3': [{ playerId: '200' }],
    };
    const allianceByPlayer = { 100: '77', 200: '77' };
    const coalitions = findHomeCoalitions({ occupants, allianceByPlayer });
    expect(coalitions).toEqual([{
      allianceId: '77',
      playerIds: ['100', '200'],
      systems: ['1:1', '1:2', '1:3'],
      soloBest: 2,
      lift: 1,
    }]);
  });

  it('does not report two members sharing the SAME system only (no lift)', () => {
    const occupants = { '1:1': [{ playerId: '100' }, { playerId: '200' }] };
    const allianceByPlayer = { 100: '77', 200: '77' };
    expect(findHomeCoalitions({ occupants, allianceByPlayer })).toEqual([]);
  });

  it('does not report a member whose systems are a subset of an ally’s (no lift)', () => {
    // 100 reaches 1:1 and 1:2; 200 only reaches 1:1 (a subset) — union stays 2,
    // equal to 100's solo reach, so lift is 0.
    const occupants = {
      '1:1': [{ playerId: '100' }, { playerId: '200' }],
      '1:2': [{ playerId: '100' }],
    };
    const allianceByPlayer = { 100: '77', 200: '77' };
    expect(findHomeCoalitions({ occupants, allianceByPlayer })).toEqual([]);
  });

  it('requires at least two members — a lone alliance member never qualifies', () => {
    const occupants = { '1:1': [{ playerId: '100' }], '1:2': [{ playerId: '100' }] };
    const allianceByPlayer = { 100: '77' };
    expect(findHomeCoalitions({ occupants, allianceByPlayer })).toEqual([]);
  });

  it('ignores players with no known alliance', () => {
    const occupants = { '1:1': [{ playerId: '100' }], '1:2': [{ playerId: '200' }] };
    expect(findHomeCoalitions({ occupants, allianceByPlayer: undefined })).toEqual([]);
  });

  it('orders widest joint reach first, lift breaking ties', () => {
    // Alliance 'AA': 100 -> 1:1,1:2 ; 200 -> 1:3 (union 3, solo 2, lift 1).
    // Alliance 'BB': 300 -> 2:1 ; 400 -> 2:2,2:3 (union 3, solo 2, lift 1) — tie
    // on systems.length AND lift, so alphabetical id order breaks it.
    const occupants = {
      '1:1': [{ playerId: '100' }],
      '1:2': [{ playerId: '100' }],
      '1:3': [{ playerId: '200' }],
      '2:1': [{ playerId: '300' }],
      '2:2': [{ playerId: '400' }],
      '2:3': [{ playerId: '400' }],
    };
    const allianceByPlayer = {
      100: 'AA', 200: 'AA', 300: 'BB', 400: 'BB',
    };
    const coalitions = findHomeCoalitions({ occupants, allianceByPlayer });
    expect(coalitions.map((c) => c.allianceId)).toEqual(['AA', 'BB']);
  });
});
