// Unit tests for the pure target-finder predicate, ranking, and the
// universe-occupancy planet enumerator.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  sortTargetList,
  playerPlanets,
  targetExclusionReason,
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
