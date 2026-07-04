// @ts-check

// Unit tests for domain/dangerJoin — the ONE recipe that turns the API cache
// (+ spy reports) into per-player DangerProfiles, shared by the dashboard and
// the in-game scan planner so both compute D identically. The deep scoring is
// tested in dangerScore/threatModel; here we test the JOIN's own contract: the
// planets+moons coverage denominator, ownMilitary extraction, and that it
// delegates to buildDangerProfiles (a populated Map) without throwing.

import { describe, it, expect } from 'vitest';
import { joinDangerProfiles } from '../../src/domain/dangerJoin.js';

/** A minimal API cache with two occupied players + our own military row. */
const cache = () => ({
  universe: {
    planets: [
      { coords: '1:1:1', player: 42, hasMoon: true },
      { coords: '1:1:2', player: 42 },
      { coords: '2:2:2', player: 7 },
    ],
  },
  military: {
    ranks: {
      42: { score: 100000, ships: 500 },
      7: { score: 50000, ships: 200 },
      99: { score: 1000000, ships: 5000 },
    },
  },
});

describe('joinDangerProfiles', () => {
  it('counts spiable BODIES = planets + moons in the coverage denominator', () => {
    const { planetCountByPlayer } = joinDangerProfiles({ apiCache: cache(), ownId: '99' });
    // 42 has two planets, one with a moon → 3 bodies; 7 has one planet.
    expect(planetCountByPlayer['42']).toBe(3);
    expect(planetCountByPlayer['7']).toBe(1);
  });

  it('extracts ownMilitary from the military feed by our id', () => {
    const { ownMilitary } = joinDangerProfiles({ apiCache: cache(), ownId: '99' });
    expect(ownMilitary).toBe(1000000);
  });

  it('ownMilitary is undefined when our id is absent from the feed', () => {
    const { ownMilitary } = joinDangerProfiles({ apiCache: cache(), ownId: '12345' });
    expect(ownMilitary).toBeUndefined();
  });

  it('delegates to buildDangerProfiles: a populated Map keyed by player id', () => {
    const { dangerProfiles } = joinDangerProfiles({ apiCache: cache(), ownId: '99' });
    expect(dangerProfiles).toBeInstanceOf(Map);
    const p = dangerProfiles.get(42);
    expect(p).toBeDefined();
    expect(typeof p?.danger).toBe('number');
    expect(p?.danger).toBeGreaterThanOrEqual(0);
    expect(p?.danger).toBeLessThanOrEqual(1);
  });

  it('tolerates an empty cache without throwing', () => {
    const out = joinDangerProfiles({ apiCache: {}, ownId: undefined });
    expect(out.planetCountByPlayer).toEqual({});
    expect(out.ownMilitary).toBeUndefined();
    expect(out.dangerProfiles).toBeInstanceOf(Map);
  });

  it('accepts a spy-report bucket for the refinement path without throwing', () => {
    const targetReports = {
      42: {
        '1:1:1:1': {
          latest: {
            galaxy: 1, system: 1, position: 1, planetType: 1,
            timestamp: 1_700_000_000, defenseValue: 20000, fleetValue: 0,
          },
          history: [],
        },
      },
    };
    const { dangerProfiles } = joinDangerProfiles({ apiCache: cache(), targetReports, ownId: '99' });
    expect(dangerProfiles.get(42)).toBeDefined();
  });
});
