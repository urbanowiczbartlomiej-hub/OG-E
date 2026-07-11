// Unit tests for domain/patrol.js — the territory ("hunting grounds") math:
// the ±N-systems territory (donut-aware), coord membership, the occupant /
// prey filters, and the patrol half of the look plan.
//
// Node env — pure functions over plain data, explicit `nowMs`.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  patrolSystemKeys,
  coordInPatrol,
  patrolDistance,
  patrolOccupants,
  patrolPlayers,
  buildPatrolPlan,
  PATROL_LOOK_WEIGHT,
} from '../../src/domain/patrol.js';

const NOW = 1_700_000_000_000;
const STALE_MS = 24 * 3600 * 1000;

describe('patrolSystemKeys', () => {
  it('spans ±radius around every own body, in that body\'s galaxy', () => {
    const set = patrolSystemKeys(
      [{ galaxy: 1, system: 100 }, { galaxy: 3, system: 50 }],
      2,
      { systems: 499, donutSystem: true },
    );
    for (const k of ['1:98', '1:99', '1:100', '1:101', '1:102', '3:48', '3:52']) {
      expect(set.has(k)).toBe(true);
    }
    expect(set.size).toBe(10);
    expect(set.has('2:100')).toBe(false);
  });

  it('radius 0 (patrol off) → empty set; radius clamps to the max', () => {
    expect(patrolSystemKeys([{ galaxy: 1, system: 5 }], 0).size).toBe(0);
    expect(patrolSystemKeys([{ galaxy: 1, system: 250 }], 9999, { systems: 499 }).size)
      .toBe(101); // clamped to ±50
  });

  it('wraps around the donut; a non-donut server clips at the edges', () => {
    const donut = patrolSystemKeys([{ galaxy: 1, system: 2 }], 3, { systems: 499, donutSystem: true });
    expect(donut.has('1:498')).toBe(true);
    expect(donut.has('1:499')).toBe(true);
    const flat = patrolSystemKeys([{ galaxy: 1, system: 2 }], 3, { systems: 499, donutSystem: false });
    expect(flat.has('1:498')).toBe(false);
    expect(flat.has('1:1')).toBe(true);
    expect(flat.size).toBe(5); // 1..5
  });
});

describe('coordInPatrol / patrolDistance', () => {
  const set = patrolSystemKeys([{ galaxy: 1, system: 10 }], 1);
  it('membership by the coord\'s system', () => {
    expect(coordInPatrol('1:10:5', set)).toBe(true);
    expect(coordInPatrol('1:12:5', set)).toBe(false);
    expect(coordInPatrol('junk', set)).toBe(false);
    expect(coordInPatrol('1:10:5', null)).toBe(false);
  });
  it('distance to the nearest own body, Infinity across galaxies', () => {
    const own = [{ galaxy: 1, system: 10 }];
    expect(patrolDistance({ galaxy: 1, system: 13 }, own)).toBe(3);
    expect(patrolDistance({ galaxy: 2, system: 10 }, own)).toBe(Infinity);
  });
});

describe('patrolOccupants', () => {
  const systems = patrolSystemKeys([{ galaxy: 1, system: 10 }], 1);
  const planets = [
    { coords: '1:9:4', player: 7 },
    { coords: '1:10:8', player: 8 },
    { coords: '1:10:9', player: 99 }, // me
    { coords: '1:20:1', player: 7 },  // outside
    { coords: '1:11:2' },             // no owner
  ];
  it('groups occupied slots per territory system, excluding own slots', () => {
    const occ = patrolOccupants(planets, systems, 99);
    expect(occ['1:9']).toEqual([{ playerId: '7', position: 4 }]);
    expect(occ['1:10']).toEqual([{ playerId: '8', position: 8 }]);
    expect(occ['1:20']).toBeUndefined();
    expect(occ['1:11']).toBeUndefined();
  });
});

describe('patrolPlayers — the prey filters', () => {
  const occ = {
    '1:9': [{ playerId: '1', position: 1 }, { playerId: '2', position: 2 },
      { playerId: '3', position: 3 }, { playerId: '4', position: 4 },
      { playerId: '5', position: 5 }, { playerId: '6', position: 6 }],
  };
  it('drops friend tag, API v/b/a statuses and buddy/alliance/newbie meta; keeps inactives', () => {
    const prey = patrolPlayers(occ, {
      relationships: { 1: 'friend' },
      apiPlayers: { 2: { status: 'v' }, 3: { status: 'b' }, 5: { status: 'i' } },
      meta: { 4: { flags: { allianceMember: true } } },
    });
    // 1 friend, 2 vacation, 3 banned, 4 own alliance → out; 5 inactive stays.
    expect(prey.sort()).toEqual(['5', '6']);
  });
  it('no filters → every occupant', () => {
    expect(patrolPlayers(occ).length).toBe(6);
  });
});

describe('buildPatrolPlan', () => {
  const systems = new Set(['1:9', '1:10', '1:11']);
  const occupants = {
    '1:9': [{ playerId: '7', position: 4 }],
    '1:10': [{ playerId: '8', position: 8 }],
    // 1:11 empty → never proposed
  };

  it('proposes never-seen and stale systems, skips fresh and empty ones', () => {
    const { entries } = buildPatrolPlan({
      systems,
      scans: {
        '1:9': { scannedAt: NOW - STALE_MS - 60_000 }, // stale
        '1:10': { scannedAt: NOW - 60_000 },           // fresh
      },
      occupants,
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: '1:9', worst: 'stale',
      bodies: [{ playerId: '7', position: 4, bodyType: 1, status: 'stale' }],
    });
    expect(entries[0].why).toContain('patrol');
    expect(entries[0].priority).toBeLessThanOrEqual(PATROL_LOOK_WEIGHT);
  });

  it('never-seen ranks above stale-seen', () => {
    const { entries } = buildPatrolPlan({
      systems,
      scans: { '1:9': { scannedAt: NOW - STALE_MS - 60_000 } },
      occupants,
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    expect(entries.map((e) => e.label)).toEqual(['1:10', '1:9']); // none first
    expect(entries[0].worst).toBe('none');
  });
});
