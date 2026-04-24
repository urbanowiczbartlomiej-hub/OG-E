// @ts-check

// Unit tests for the `positions` pure-domain module.
//
// Pure functions, so no DOM and no fake timers — these run in plain
// Node and never touch happy-dom. Covers parsing, ring-distance, and
// galaxy ordering.

import { describe, it, expect } from 'vitest';
import {
  parsePositions,
  sysDist,
  buildGalaxyOrder,
} from '../../src/domain/positions.js';
import { COL_MAX_SYSTEM, COL_MAX_GALAXY } from '../../src/domain/rules.js';

describe('parsePositions', () => {
  it('parses a single position', () => {
    expect(parsePositions('8')).toEqual([8]);
  });

  it('parses a comma-separated list, preserving order', () => {
    expect(parsePositions('8,9,10')).toEqual([8, 9, 10]);
  });

  it('expands an ascending range', () => {
    expect(parsePositions('8-10')).toEqual([8, 9, 10]);
  });

  it('expands a reversed range by sorting endpoints', () => {
    expect(parsePositions('10-8')).toEqual([8, 9, 10]);
  });

  it('mixes singletons and ranges in original order', () => {
    expect(parsePositions('8,10-12,15')).toEqual([8, 10, 11, 12, 15]);
  });

  it('tolerates whitespace around segments and endpoints', () => {
    expect(parsePositions(' 8 , 10-12 ')).toEqual([8, 10, 11, 12]);
  });

  it('dedupes repeated positions, keeping the first occurrence', () => {
    expect(parsePositions('8,10,8,9')).toEqual([8, 10, 9]);
  });

  it('drops values outside the valid position range', () => {
    expect(parsePositions('0,8,16')).toEqual([8]);
  });

  it('returns [] for the empty string', () => {
    expect(parsePositions('')).toEqual([]);
  });

  it('returns [] for pure whitespace', () => {
    expect(parsePositions('   ')).toEqual([]);
  });

  it('skips malformed segments silently, keeping valid ones', () => {
    expect(parsePositions('8,abc,10,-,5')).toEqual([8, 10, 5]);
  });

  it('clips ranges that straddle the valid bounds', () => {
    // "12-20" contains 12..15 (valid) and 16..20 (invalid and dropped).
    expect(parsePositions('12-20')).toEqual([12, 13, 14, 15]);
  });
});

describe('sysDist', () => {
  it('returns 0 for equal systems', () => {
    expect(sysDist(50, 50)).toBe(0);
  });

  it('returns the direct difference when shorter than the wrap arc', () => {
    expect(sysDist(10, 20)).toBe(10);
  });

  it('wraps across the 499 / 1 boundary', () => {
    expect(sysDist(2, 498, 499)).toBe(3);
  });

  it('treats system 1 and system 499 as one step apart', () => {
    expect(sysDist(1, 499, 499)).toBe(1);
  });

  it('is symmetric', () => {
    expect(sysDist(10, 400)).toBe(sysDist(400, 10));
  });

  it('returns the half-ring distance at the antipode (maxSystem=499)', () => {
    // max arc distance on a 499-system ring is floor(499 / 2) = 249.
    expect(sysDist(1, 250, 499)).toBe(249);
  });

  it('honours a custom maxSystem override', () => {
    // On a 100-system ring, 1 and 99 are 2 hops apart via the wrap (1→100→99),
    // versus 98 hops directly. sysDist picks the smaller.
    expect(sysDist(1, 99, 100)).toBe(2);
  });

  it('defaults maxSystem to COL_MAX_SYSTEM', () => {
    expect(sysDist(50, 60)).toBe(sysDist(50, 60, COL_MAX_SYSTEM));
  });
});

describe('buildGalaxyOrder', () => {
  it('produces the standard outward-expanding order for an interior galaxy', () => {
    expect(buildGalaxyOrder(4, 7)).toEqual([4, 5, 3, 6, 2, 7, 1]);
  });

  it('wraps modularly at the galaxy-1 edge', () => {
    expect(buildGalaxyOrder(1, 7)).toEqual([1, 2, 7, 3, 6, 4, 5]);
  });

  it('wraps modularly at the galaxy-7 edge', () => {
    expect(buildGalaxyOrder(7, 7)).toEqual([7, 1, 6, 2, 5, 3, 4]);
  });

  it('handles a tiny universe (maxGalaxy=3)', () => {
    expect(buildGalaxyOrder(1, 3)).toEqual([1, 2, 3]);
  });

  it('defaults maxGalaxy to COL_MAX_GALAXY (7 galaxies in result)', () => {
    const order = buildGalaxyOrder(3);
    expect(order.length).toBe(COL_MAX_GALAXY);
    expect(order[0]).toBe(3);
  });

  it('satisfies its invariants for every valid home galaxy', () => {
    for (let home = 1; home <= COL_MAX_GALAXY; home++) {
      const order = buildGalaxyOrder(home, COL_MAX_GALAXY);
      expect(order.length).toBe(COL_MAX_GALAXY);
      expect(order[0]).toBe(home);
      expect(new Set(order).size).toBe(order.length);
      for (const g of order) {
        expect(g).toBeGreaterThanOrEqual(1);
        expect(g).toBeLessThanOrEqual(COL_MAX_GALAXY);
      }
    }
  });
});
