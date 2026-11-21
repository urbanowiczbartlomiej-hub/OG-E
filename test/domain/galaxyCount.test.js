// The server's galaxy count drives "neighbouring galaxy" order. Regression:
// with the old fixed 7, galaxy 7 on a 9-galaxy server named galaxy 1 its
// neighbour (a 7-galaxy wrap) — three hops away in reality.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { galaxyCountOf, COL_MAX_GALAXY } from '../../src/domain/rules.js';
import { buildGalaxyOrder } from '../../src/domain/positions.js';
import { findNextColonizeTarget } from '../../src/features/sendColony/pure.js';

describe('galaxyCountOf', () => {
  it('uses the server count, falls back to the old default only when unknown', () => {
    expect(galaxyCountOf({ galaxies: 9 })).toBe(9);
    expect(galaxyCountOf({})).toBe(COL_MAX_GALAXY);
    expect(galaxyCountOf(null)).toBe(COL_MAX_GALAXY);
    expect(galaxyCountOf({ galaxies: 0 })).toBe(COL_MAX_GALAXY);
  });
});

describe('neighbour order on a 9-galaxy donut', () => {
  it('galaxy 7 neighbours are 8 and 6, galaxy 1 is not next', () => {
    const order = buildGalaxyOrder(7, 9);
    expect(order.slice(0, 3)).toEqual([7, 8, 6]);
    expect(order.indexOf(1)).toBeGreaterThan(2);
  });

  it('"other galaxies first" from galaxy 7 proposes galaxy 8, not 1', () => {
    const empty = { positions: { 8: { status: 'empty' } } };
    /** @type {any} */
    const scans = { '1:1': empty, '8:1': empty };
    const target = findNextColonizeTarget(scans, [], { galaxy: 7, system: 100 }, [8], true, 0, true, null, null, null, 9);
    expect(target?.galaxy).toBe(8);
  });
});
