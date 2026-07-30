// Unit tests for the pure target-finder predicate, ranking, and the
// universe-occupancy planet enumerator.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  sortTargetList,
  playerPlanets,
  targetExclusionReason,
  buildTargetCandidates,
  matchAllianceMembers,
} from '../../src/domain/targets.js';

describe('sortTargetList', () => {
  it('sorts by hiddenFleet via hiddenById, missing estimates sinking to the bottom', () => {
    const list = [
      { id: 'a', militaryScore: 100, totalScore: 1000 },
      { id: 'b', militaryScore: 200, totalScore: 2000 }, // no estimate
      { id: 'c', militaryScore: 300, totalScore: 3000 },
    ];
    const hiddenById = { a: 50, c: 90 };

    const desc = sortTargetList(list, 'hiddenFleet', 'desc', hiddenById);
    expect(desc.map((c) => c.id)).toEqual(['c', 'a', 'b']);

    const asc = sortTargetList(list, 'hiddenFleet', 'asc', hiddenById);
    // even ascending, the un-spied row 'b' stays last.
    expect(asc.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });

  it('un-spied tail under hiddenFleet falls back to military desc then total desc', () => {
    const list = [
      { id: 'a', militaryScore: 100, totalScore: 1000 }, // no estimate
      { id: 'b', militaryScore: 300, totalScore: 2000 }, // no estimate
      { id: 'c', militaryScore: 300, totalScore: 9000 }, // no estimate
      { id: 'spied', militaryScore: 10, totalScore: 10 },
    ];
    const out = sortTargetList(list, 'hiddenFleet', 'asc', { spied: 5 });
    // spied first (has an estimate), then the unknowns ordered by the canonical
    // tiebreak: military desc, then total desc.
    expect(out.map((c) => c.id)).toEqual(['spied', 'c', 'b', 'a']);
  });

  it('sorts by military score in both directions', () => {
    const list = [
      { id: 'a', militaryScore: 100, totalScore: 1 },
      { id: 'b', militaryScore: 300, totalScore: 1 },
      { id: 'c', militaryScore: 200, totalScore: 1 },
    ];
    expect(sortTargetList(list, 'military', 'desc').map((c) => c.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(sortTargetList(list, 'military', 'asc').map((c) => c.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('sorts by totalRank (1 = top) in both directions', () => {
    const list = [
      { id: 'a', totalRank: 30, militaryScore: 1 },
      { id: 'b', totalRank: 10, militaryScore: 1 },
      { id: 'c', totalRank: 20, militaryScore: 1 },
    ];
    expect(sortTargetList(list, 'totalRank', 'asc').map((c) => c.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(sortTargetList(list, 'totalRank', 'desc').map((c) => c.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('missing values for military/totalRank sink regardless of direction', () => {
    const list = [
      { id: 'a', militaryScore: 100 },
      { id: 'b' }, // unknown military
      { id: 'c', militaryScore: 200 },
    ];
    expect(sortTargetList(list, 'military', 'asc').map((c) => c.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortTargetList(list, 'military', 'desc').map((c) => c.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('defaults dir to desc', () => {
    const list = [
      { id: 'a', militaryScore: 100 },
      { id: 'b', militaryScore: 200 },
    ];
    expect(sortTargetList(list, 'military').map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input list', () => {
    const list = [
      { id: 'a', militaryScore: 100 },
      { id: 'b', militaryScore: 200 },
    ];
    const snapshot = list.map((c) => c.id);
    sortTargetList(list, 'military', 'desc');
    expect(list.map((c) => c.id)).toEqual(snapshot);
  });

  // The v2 fleet-finder axes: `danger` ranks by the D scalar (0..1), `fleet` by
  // the mobile-military ceiling. Both look up a per-player profile in
  // `dangerById`; players with no profile sink to the bottom, either direction
  // (like the un-spied tail under `hiddenFleet`).
  it('sorts by danger via dangerById, descending, profileless rows sinking', () => {
    const list = [
      { id: 'a', militaryScore: 1, totalScore: 1 },
      { id: 'b', militaryScore: 1, totalScore: 1 }, // no profile
      { id: 'c', militaryScore: 1, totalScore: 1 },
    ];
    const dangerById = { a: { danger: 0.3, fleet: 10 }, c: { danger: 0.9, fleet: 20 } };
    // desc: highest danger first, unprofiled 'b' last.
    expect(sortTargetList(list, 'danger', 'desc', {}, dangerById).map((c) => c.id))
      .toEqual(['c', 'a', 'b']);
    // asc: lowest danger first, but unprofiled 'b' still sinks to the bottom.
    expect(sortTargetList(list, 'danger', 'asc', {}, dangerById).map((c) => c.id))
      .toEqual(['a', 'c', 'b']);
  });

  it('sorts by fleet via dangerById, descending, profileless rows sinking', () => {
    const list = [
      { id: 'a', militaryScore: 1, totalScore: 1 },
      { id: 'b', militaryScore: 1, totalScore: 1 }, // no profile
      { id: 'c', militaryScore: 1, totalScore: 1 },
    ];
    const dangerById = { a: { danger: 0.9, fleet: 5000 }, c: { danger: 0.1, fleet: 9000 } };
    expect(sortTargetList(list, 'fleet', 'desc', {}, dangerById).map((c) => c.id))
      .toEqual(['c', 'a', 'b']);
    expect(sortTargetList(list, 'fleet', 'asc', {}, dangerById).map((c) => c.id))
      .toEqual(['a', 'c', 'b']);
  });
});

describe('buildTargetCandidates', () => {
  it('joins the feeds and maps a present-but-missing ships to 0 (feed carries ships)', () => {
    const out = buildTargetCandidates({
      players: { '1': { name: 'Fleeter', status: '', alliance: '9' } },
      total: { '1': { position: 3, score: 5000 } },
      // The military feed CARRIES ships on at least one row (row '2'), so the
      // "present row + absent attribute = 0 ships" read is valid for row '1'.
      military: {
        '1': { position: 10, score: 700 }, // no ships attr → 0
        '2': { position: 11, score: 800, ships: 42 },
      },
    });
    const a = out.find((c) => c.id === '1');
    const b = out.find((c) => c.id === '2');
    expect(a).toMatchObject({
      id: '1',
      name: 'Fleeter',
      totalScore: 5000,
      militaryScore: 700,
      ships: 0, // missing ships mapped via ?? 0
    });
    expect(b?.ships).toBe(42);
  });

  it('carries a destroyed score from the military-destroyed feed', () => {
    const out = buildTargetCandidates({
      players: { '1': { name: 'X', status: '' } },
      military: { '1': { position: 1, score: 100, ships: 3 } },
      destroyed: { '1': { position: 5, score: 987654 } },
    });
    const a = out.find((c) => c.id === '1');
    expect(a?.destroyedScore).toBe(987654);
  });

  it('leaves ships undefined when the whole military feed lacks the attribute', () => {
    // No row carries `ships` → feedHasShips is false → ships is unknown
    // (undefined), NOT a confidently-green 0.
    const out = buildTargetCandidates({
      military: { '1': { position: 1, score: 100 }, '2': { position: 2, score: 50 } },
    });
    expect(out.find((c) => c.id === '1')?.ships).toBeUndefined();
  });
});

describe('matchAllianceMembers', () => {
  const ALLIANCES = {
    500: { name: 'Formoza', tag: 'FMZ' },
    501: { name: 'Formozianie', tag: 'FMZ2' },
    502: { name: 'Wilki', tag: 'WLK' },
  };
  const CANDIDATES = [
    { id: '1', alliance: '500' },
    { id: '2', alliance: '501' },
    { id: '3', alliance: '502' },
    { id: '4' }, // no alliance
  ];

  it('matches on the TAG, case-insensitively', () => {
    const r = matchAllianceMembers(CANDIDATES, ALLIANCES, 'wlk');
    expect([...r.ids]).toEqual(['3']);
    expect([...r.allianceIds]).toEqual(['502']);
    expect(r.labels).toEqual(['WLK · Wilki']);
  });

  it('matches on the NAME as a substring, so several alliances can answer', () => {
    const r = matchAllianceMembers(CANDIDATES, ALLIANCES, 'formoz');
    expect([...r.ids].sort()).toEqual(['1', '2']);
    expect(r.labels).toEqual(['FMZ · Formoza', 'FMZ2 · Formozianie']);
  });

  it('is empty for a blank query — no search, not "everything"', () => {
    const r = matchAllianceMembers(CANDIDATES, ALLIANCES, '   ');
    expect(r.ids.size).toBe(0);
    expect(r.allianceIds.size).toBe(0);
    expect(r.labels).toEqual([]);
  });

  it('reports the matched alliance even when it has no members in the candidate set', () => {
    const r = matchAllianceMembers([{ id: '4' }], ALLIANCES, 'FMZ');
    expect(r.ids.size).toBe(0);
    expect(r.labels.length).toBe(2);
  });

  it('yields nothing when no alliance matches, or when the feed is missing', () => {
    expect(matchAllianceMembers(CANDIDATES, ALLIANCES, 'zzz').ids.size).toBe(0);
    expect(matchAllianceMembers(CANDIDATES, {}, 'FMZ').labels).toEqual([]);
  });
});

describe('playerPlanets', () => {
  it('filters by owner id (string compare), parses coords, sorts g→s→p', () => {
    const universe = [
      { coords: '3:100:5', player: 42 },
      { coords: '1:200:2', player: 42 },
      { coords: '1:50:9', player: 99 }, // other owner
      { coords: '1:200:1', player: 42 },
    ];
    expect(playerPlanets(universe, '42')).toEqual([
      { galaxy: 1, system: 200, position: 1 },
      { galaxy: 1, system: 200, position: 2 },
      { galaxy: 3, system: 100, position: 5 },
    ]);
  });

  it('matches numeric player ids against the string playerId', () => {
    const universe = [{ coords: '1:1:1', player: 7 }];
    expect(playerPlanets(universe, '7')).toEqual([
      { galaxy: 1, system: 1, position: 1 },
    ]);
    expect(playerPlanets(universe, '70')).toEqual([]);
  });

  it('drops malformed coords (wrong arity / non-numeric parts)', () => {
    const universe = [
      { coords: '1:1', player: 1 }, // too few parts
      { coords: '1:1:1:1', player: 1 }, // too many parts
      { coords: 'a:b:c', player: 1 }, // non-numeric
      { coords: '2:3:4', player: 1 }, // good
    ];
    expect(playerPlanets(universe, '1')).toEqual([
      { galaxy: 2, system: 3, position: 4 },
    ]);
  });

  it('skips rows with no owner and tolerates a null/empty input', () => {
    const universe = [
      { coords: '1:1:1' }, // player == null
      { coords: '1:1:2', player: 5 },
      null,
    ];
    expect(playerPlanets(/** @type {any} */ (universe), '5')).toEqual([
      { galaxy: 1, system: 1, position: 2 },
    ]);
    expect(playerPlanets(/** @type {any} */ (null), '5')).toEqual([]);
    expect(playerPlanets(/** @type {any} */ (undefined), '5')).toEqual([]);
  });
});

describe('targetExclusionReason — maxMilitary', () => {
  it('excludes a player whose military score is above a positive maxMilitary', () => {
    expect(
      targetExclusionReason({ id: 'a', militaryScore: 5000 }, { maxMilitary: 1000 }),
    ).toBe('maxMilitary');
  });

  it('keeps a player whose military score is at or below the cap', () => {
    expect(
      targetExclusionReason({ id: 'a', militaryScore: 1000 }, { maxMilitary: 1000 }),
    ).toBeNull();
    expect(
      targetExclusionReason({ id: 'a', militaryScore: 999 }, { maxMilitary: 1000 }),
    ).toBeNull();
  });

  it('treats a 0 / absent maxMilitary as no upper cap', () => {
    expect(
      targetExclusionReason({ id: 'a', militaryScore: 1e9 }, { maxMilitary: 0 }),
    ).toBeNull();
    expect(targetExclusionReason({ id: 'a', militaryScore: 1e9 }, {})).toBeNull();
  });

  it('treats an unknown military score as 0, never above a cap', () => {
    expect(
      targetExclusionReason({ id: 'a' }, { maxMilitary: 1000 }),
    ).toBeNull();
  });
});
