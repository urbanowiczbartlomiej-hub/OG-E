// Unit tests for the pure free-streak analyzer. The function takes
// galaxy scans + selector options and returns runs of matching
// systems per galaxy; tests cover the streak math, wrap-around at
// galaxy edges, "missing system breaks the run" strictness, status
// other than the default, and degenerate inputs.
//
// All test cases use a small galaxyMax (e.g. 10) so the fixture
// stays readable — the real universe constant (499) does not change
// the algorithm's behaviour, only the search range.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { findLongestStreaks } from '../../src/domain/freeStreak.js';

/**
 * Build a `GalaxyScans` fixture out of a compact `[galaxy, system,
 * status]` triple list. Every system gets `scannedAt: 1`; positions
 * are populated only at `position` slots that need a status.
 *
 * @param {Array<[number, number, import('../../src/domain/scans.js').PositionStatus | null]>} rows
 * @param {number} [position]  Slot to write the status into. Default 15.
 * @returns {import('../../src/state/scans.js').GalaxyScans}
 */
const buildScans = (rows, position = 15) => {
  /** @type {any} */
  const out = {};
  for (const [g, s, status] of rows) {
    const key = `${g}:${s}`;
    if (!out[key]) out[key] = { scannedAt: 1, positions: {} };
    if (status !== null) {
      out[key].positions[position] = { status };
    }
  }
  return out;
};

describe('findLongestStreaks', () => {
  it('returns an empty list on empty scans', () => {
    expect(findLongestStreaks({}, { position: 15 })).toEqual([]);
  });

  it('returns an empty list when no system matches the requested status', () => {
    const scans = buildScans([
      [4, 30, 'occupied'],
      [4, 31, 'inactive'],
      [5, 10, 'mine'],
    ]);
    expect(findLongestStreaks(scans, { position: 15 })).toEqual([]);
  });

  it('finds a single-system run', () => {
    const scans = buildScans([[4, 5, 'empty']]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 5, end: 5, length: 1 },
    ]);
  });

  it('finds a contiguous run of length N', () => {
    const scans = buildScans([
      [4, 1, 'empty'],
      [4, 2, 'empty'],
      [4, 3, 'empty'],
      [4, 4, 'occupied'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 1, end: 3, length: 3 },
    ]);
  });

  it('treats an unscanned system as a break in the run', () => {
    // Systems 1, 2 confirmed empty; 3 never scanned; 4, 5, 6 confirmed
    // empty. The unscanned 3 must break the run — only confirmed
    // matches contribute.
    const scans = buildScans([
      [4, 1, 'empty'],
      [4, 2, 'empty'],
      // 4:3 absent — never scanned
      [4, 4, 'empty'],
      [4, 5, 'empty'],
      [4, 6, 'empty'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 4, end: 6, length: 3 },
    ]);
  });

  it('treats a scanned-but-non-matching system as a break in the run', () => {
    const scans = buildScans([
      [4, 1, 'empty'],
      [4, 2, 'empty'],
      [4, 3, 'occupied'], // ← non-matching status breaks the run
      [4, 4, 'empty'],
      [4, 5, 'empty'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      // Tie between length-2 runs at start 1 and at start 4 — the
      // sort is stable by galaxy ascending, but within a single
      // galaxy only the longest run is reported. Both candidates are
      // length 2; the function keeps the FIRST one encountered.
      { galaxy: 4, start: 1, end: 2, length: 2 },
    ]);
  });

  it('captures a run that wraps around the galaxy boundary', () => {
    // Universe of 10. Matches at {9, 10, 1, 2, 3} — one length-5
    // run spanning the 10→1 boundary, not two fragments.
    const scans = buildScans([
      [4, 1, 'empty'],
      [4, 2, 'empty'],
      [4, 3, 'empty'],
      [4, 9, 'empty'],
      [4, 10, 'empty'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 9, end: 3, length: 5 },
    ]);
  });

  it('handles a full-galaxy match (every system is empty)', () => {
    const rows = /** @type {Array<[number, number, import('../../src/domain/scans.js').PositionStatus | null]>} */ (
      []
    );
    for (let s = 1; s <= 10; s++) rows.push([4, s, 'empty']);
    const scans = buildScans(rows);
    const result = findLongestStreaks(scans, { position: 15, galaxyMax: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ galaxy: 4, length: 10 });
    // The start position is whichever system the walk hit first
    // (system 1, since we iterate ascending). End wraps to 10.
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(10);
  });

  it('reports each galaxy independently with the per-galaxy longest run', () => {
    const scans = buildScans([
      // Galaxy 4: one run of length 3
      [4, 1, 'empty'],
      [4, 2, 'empty'],
      [4, 3, 'empty'],
      // Galaxy 5: one run of length 2
      [5, 7, 'empty'],
      [5, 8, 'empty'],
      // Galaxy 6: two runs (length 1 and length 4) — only the longer
      // wins for the galaxy entry
      [6, 1, 'empty'],
      [6, 5, 'empty'],
      [6, 6, 'empty'],
      [6, 7, 'empty'],
      [6, 8, 'empty'],
    ]);
    const result = findLongestStreaks(scans, { position: 15, galaxyMax: 10 });
    // Sorted by length descending; galaxy 6 wins (4), then 4 (3), then 5 (2).
    expect(result).toEqual([
      { galaxy: 6, start: 5, end: 8, length: 4 },
      { galaxy: 4, start: 1, end: 3, length: 3 },
      { galaxy: 5, start: 7, end: 8, length: 2 },
    ]);
  });

  it('respects the status parameter (finds inactive runs)', () => {
    const scans = buildScans([
      [4, 1, 'inactive'],
      [4, 2, 'inactive'],
      [4, 3, 'inactive'],
      [4, 4, 'empty'], // breaks the inactive run
      [4, 5, 'inactive'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, status: 'inactive', galaxyMax: 10 }))
      .toEqual([{ galaxy: 4, start: 1, end: 3, length: 3 }]);
  });

  it('respects the position parameter (slot other than 15)', () => {
    // Position 8 empty at 4:1, 4:2; position 15 empty at 4:5, 4:6.
    // Query for position 8 only — must ignore the 15 hits.
    /** @type {any} */
    const scans = {
      '4:1': { scannedAt: 1, positions: { 8:  { status: 'empty'    } } },
      '4:2': { scannedAt: 1, positions: { 8:  { status: 'empty'    } } },
      '4:5': { scannedAt: 1, positions: { 15: { status: 'empty'    } } },
      '4:6': { scannedAt: 1, positions: { 15: { status: 'empty'    } } },
    };
    expect(findLongestStreaks(scans, { position: 8, galaxyMax: 10 }))
      .toEqual([{ galaxy: 4, start: 1, end: 2, length: 2 }]);
  });

  it('breaks ties by galaxy ascending when two galaxies have the same best length', () => {
    const scans = buildScans([
      [5, 1, 'empty'],
      [5, 2, 'empty'],
      [3, 1, 'empty'],
      [3, 2, 'empty'],
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 3, start: 1, end: 2, length: 2 },
      { galaxy: 5, start: 1, end: 2, length: 2 },
    ]);
  });

  it('skips malformed scan keys without throwing', () => {
    /** @type {any} */
    const scans = {
      '4:1': { scannedAt: 1, positions: { 15: { status: 'empty' } } },
      ':30': { scannedAt: 1, positions: { 15: { status: 'empty' } } }, // no galaxy
      '5:':  { scannedAt: 1, positions: { 15: { status: 'empty' } } }, // no system
      'abc': { scannedAt: 1, positions: { 15: { status: 'empty' } } }, // no colon
    };
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 1, end: 1, length: 1 },
    ]);
  });

  it('skips system numbers outside the 1..galaxyMax range', () => {
    const scans = buildScans([
      [4, 1, 'empty'],
      [4, 11, 'empty'], // > galaxyMax=10
      [4, 0, 'empty'],  // < 1
    ]);
    expect(findLongestStreaks(scans, { position: 15, galaxyMax: 10 })).toEqual([
      { galaxy: 4, start: 1, end: 1, length: 1 },
    ]);
  });
});
