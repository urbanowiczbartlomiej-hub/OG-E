// Unit tests for the histogram domain helpers.
//
// All inputs are plain objects / Sets / arrays — no DOM, no chrome.storage,
// no timers. Each helper is shape-in / shape-out so tests stay one-input,
// one-expectation.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  STATUS_PRIORITY,
  parseTargetPositions,
  bestStatusInSystem,
  computeFieldStats,
  buildFieldBuckets,
  collectGalaxyStats,
} from '../../src/domain/histogram.js';

describe('STATUS_PRIORITY', () => {
  it('lists every v5 PositionStatus exactly once', () => {
    // 11-status enum from src/domain/scans.js (`reserved` added with
    // 4.9.2 parity port — slot reserved for planet-move).
    const expected = [
      'empty', 'empty_sent', 'abandoned', 'reserved', 'long_inactive',
      'inactive', 'vacation', 'banned', 'mine', 'admin', 'occupied',
    ];
    expect([...STATUS_PRIORITY].sort()).toEqual([...expected].sort());
    expect(new Set(STATUS_PRIORITY).size).toBe(STATUS_PRIORITY.length);
  });

  it('starts with the actionable empty/empty_sent/abandoned cluster', () => {
    // First three positions encode the "user cares most" hierarchy.
    expect(STATUS_PRIORITY.slice(0, 3)).toEqual([
      'empty', 'empty_sent', 'abandoned',
    ]);
  });
});

describe('parseTargetPositions', () => {
  it('returns a Set of valid 1..15 positions', () => {
    expect(parseTargetPositions('8')).toEqual(new Set([8]));
    expect(parseTargetPositions('8,10-12,15'))
      .toEqual(new Set([8, 10, 11, 12, 15]));
  });

  it('returns an empty Set on empty / nonsense input', () => {
    expect(parseTargetPositions('')).toEqual(new Set());
    expect(parseTargetPositions('abc')).toEqual(new Set());
    expect(parseTargetPositions('0,16,99')).toEqual(new Set());
  });

  it('dedupes repeats', () => {
    expect(parseTargetPositions('8,8,9')).toEqual(new Set([8, 9]));
  });
});

describe('bestStatusInSystem', () => {
  it('returns null when positions is null/undefined/empty', () => {
    const targets = new Set([8]);
    expect(bestStatusInSystem(null, targets)).toBeNull();
    expect(bestStatusInSystem(undefined, targets)).toBeNull();
    expect(bestStatusInSystem({}, targets)).toBeNull();
  });

  it('returns null when no target position has any data', () => {
    // Position 4 has data but it isn't a target.
    const positions = { 4: { status: /** @type {const} */ ('empty') } };
    expect(bestStatusInSystem(positions, new Set([8]))).toBeNull();
  });

  it('picks the highest-priority status across target positions', () => {
    // Position 8 has 'empty' (top priority), position 9 has 'occupied'
    // (bottom). Empty wins regardless of object iteration order.
    const positions = {
      8: { status: /** @type {const} */ ('empty') },
      9: { status: /** @type {const} */ ('occupied') },
    };
    const result = bestStatusInSystem(positions, new Set([8, 9]));
    expect(result).toBe('empty');
  });

  it('skips positions outside the target set even if they outrank', () => {
    // Position 4 has 'empty' but isn't targeted — only target is 9 with
    // 'occupied', so that's the answer.
    const positions = {
      4: { status: /** @type {const} */ ('empty') },
      9: { status: /** @type {const} */ ('occupied') },
    };
    const result = bestStatusInSystem(positions, new Set([9]));
    expect(result).toBe('occupied');
  });

  it('honors a custom priority order when provided', () => {
    const positions = {
      8: { status: /** @type {const} */ ('empty') },
      9: { status: /** @type {const} */ ('mine') },
    };
    // Custom priority: 'mine' first.
    const result = bestStatusInSystem(positions, new Set([8, 9]), ['mine', 'empty']);
    expect(result).toBe('mine');
  });

  it('returns null when target positions hold only unknown statuses', () => {
    // Use a clearly-bogus status that is NOT in STATUS_PRIORITY.
    // (`reserved` used to play this role but landed in the priority
    // list with the 4.9.2 parity port.)
    const positions = {
      8: { status: /** @type {any} */ ('totally_made_up') },
    };
    expect(bestStatusInSystem(positions, new Set([8]))).toBeNull();
  });
});

describe('computeFieldStats', () => {
  it('returns all-zero stats for empty input', () => {
    expect(computeFieldStats([])).toEqual({
      count: 0, min: 0, max: 0, avg: 0, median: 0,
    });
  });

  /** @param {number} fields */
  const mkEntry = (fields) => ({
    cp: fields, fields, coords: '[1:1:8]', position: 8, timestamp: 0,
  });

  it('handles a single entry', () => {
    expect(computeFieldStats([mkEntry(200)])).toEqual({
      count: 1, min: 200, max: 200, avg: 200, median: 200,
    });
  });

  it('computes min/max/avg/median for an odd-sized list', () => {
    const entries = [mkEntry(100), mkEntry(200), mkEntry(300)];
    expect(computeFieldStats(entries)).toEqual({
      count: 3, min: 100, max: 300, avg: 200, median: 200,
    });
  });

  it('computes the average of the two middle values for an even-sized list', () => {
    const entries = [mkEntry(100), mkEntry(200), mkEntry(300), mkEntry(400)];
    expect(computeFieldStats(entries)).toEqual({
      count: 4, min: 100, max: 400, avg: 250, median: 250,
    });
  });

  it('rounds avg / median to nearest integer', () => {
    // 100, 101, 103 → avg 101.33 → 101; median odd → 101.
    expect(computeFieldStats([mkEntry(100), mkEntry(101), mkEntry(103)]))
      .toMatchObject({ avg: 101, median: 101 });
    // Even median that needs rounding: (100 + 103)/2 = 101.5 → 102.
    expect(computeFieldStats([mkEntry(100), mkEntry(103)]))
      .toMatchObject({ median: 102 });
  });
});

describe('buildFieldBuckets', () => {
  /**
   * @param {number} fields
   * @param {number} [cp]
   */
  const mkEntry = (fields, cp = fields) => ({
    cp, fields, coords: '[1:1:8]', position: 8, timestamp: 0,
  });

  it('returns an empty Map for empty input', () => {
    expect(buildFieldBuckets([]).size).toBe(0);
  });

  it('groups entries by `fields` and counts each bucket', () => {
    const entries = [mkEntry(200), mkEntry(200), mkEntry(300), mkEntry(200), mkEntry(300)];
    const buckets = buildFieldBuckets(entries);
    expect(buckets.get(200)).toBe(3);
    expect(buckets.get(300)).toBe(2);
    expect(buckets.size).toBe(2);
  });

  it('iterates buckets in ascending fields order', () => {
    // Insertion order is 300 → 100 → 200 — but iteration must be 100, 200, 300.
    const buckets = buildFieldBuckets([mkEntry(300, 1), mkEntry(100, 2), mkEntry(200, 3)]);
    expect([...buckets.keys()]).toEqual([100, 200, 300]);
  });
});

describe('collectGalaxyStats', () => {
  /**
   * Build a minimal SystemScan for tests. The positions parameter is
   * loose-typed (status as `string`) and cast through `unknown` to
   * SystemScan so individual cases can include unknown statuses
   * (anything not in v5's PositionStatus enum) without per-test casts.
   *
   * @param {Record<number, { status: string }>} positions
   * @returns {import('../../src/state/scans.js').SystemScan}
   */
  const sys = (positions) =>
    /** @type {import('../../src/state/scans.js').SystemScan} */ (
      /** @type {unknown} */ ({ scannedAt: 0, positions })
    );

  it('returns zero global / empty byGalaxy for empty input', () => {
    const { global, byGalaxy } = collectGalaxyStats({}, new Set([8]));
    expect(global.total).toBe(0);
    for (const s of STATUS_PRIORITY) expect(global[s]).toBe(0);
    expect(byGalaxy).toEqual({});
  });

  it('counts per-status and per-galaxy for the target positions only', () => {
    const scans = {
      '4:30': sys({
        8: { status: 'empty' },
        9: { status: 'occupied' },   // not in targets — must be ignored
      }),
      '4:31': sys({
        8: { status: 'empty_sent' },
      }),
      '5:10': sys({
        8: { status: 'occupied' },
      }),
    };
    const { global, byGalaxy } = collectGalaxyStats(scans, new Set([8]));

    expect(global.total).toBe(3);
    expect(global.empty).toBe(1);
    expect(global.empty_sent).toBe(1);
    expect(global.occupied).toBe(1);

    expect(byGalaxy[4].total).toBe(2);
    expect(byGalaxy[4].empty).toBe(1);
    expect(byGalaxy[4].empty_sent).toBe(1);

    expect(byGalaxy[5].total).toBe(1);
    expect(byGalaxy[5].occupied).toBe(1);
  });

  it('skips systems with missing positions and malformed keys', () => {
    const scans = {
      '4:30': sys({ 8: { status: 'empty' } }),
      '4:31': /** @type {any} */ ({ scannedAt: 0 }),         // no positions
      '4:32': /** @type {any} */ (null),                      // null entry
      'bad-key': sys({ 8: { status: 'empty' } }),             // no ':' → NaN galaxy
    };
    const { global, byGalaxy } = collectGalaxyStats(scans, new Set([8]));
    expect(global.total).toBe(1);
    expect(byGalaxy[4].total).toBe(1);
    expect(Object.keys(byGalaxy)).toEqual(['4']);
  });

  it('counts unknown statuses toward total but not toward any bucket', () => {
    const scans = {
      '1:1': sys({ 8: { status: /** @type {any} */ ('totally_made_up') } }),
    };
    const { global } = collectGalaxyStats(scans, new Set([8]));
    expect(global.total).toBe(1);
    for (const s of STATUS_PRIORITY) expect(global[s]).toBe(0);
  });

  it('treats missing target position in a system as no-data (not a count)', () => {
    const scans = {
      '1:1': sys({ 9: { status: 'empty' } }),  // pos 8 absent
    };
    const { global, byGalaxy } = collectGalaxyStats(scans, new Set([8]));
    expect(global.total).toBe(0);
    // No target position seen in galaxy 1 → byGalaxy entry exists but
    // is all-zero (we created it on first system iteration).
    expect(byGalaxy[1].total).toBe(0);
  });
});
