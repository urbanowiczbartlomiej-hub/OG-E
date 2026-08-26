// Unit tests for domain/cpRanges — the run-length index over OGame planet
// cp-ids that lets the content script answer "already recorded?" without
// hydrating the whole colony history.
//
// The axiom under test is the UNDER-REPORT invariant: a malformed, truncated or
// foreign payload must answer "not known" (a slow page-load, nothing lost) and
// must NEVER answer "known" (a silently dropped observation). Most cases below
// exist to pin that direction rather than the happy path.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { encodeCpRanges, decodeCpRanges, cpRangesHas } from '../../src/domain/cpRanges.js';

describe('encodeCpRanges / decodeCpRanges', () => {
  it('round-trips an empty set', () => {
    expect(encodeCpRanges([])).toEqual([]);
    expect(decodeCpRanges([])).toEqual([]);
  });

  it('encodes one id as an absolute start plus length 1', () => {
    expect(encodeCpRanges([500])).toEqual([500, 1]);
    expect(decodeCpRanges([500, 1])).toEqual([[500, 500]]);
  });

  it('collapses a consecutive run into ONE pair — the whole point of the format', () => {
    // 33 consecutive colonizations are one run, not 33 entries.
    const cps = Array.from({ length: 33 }, (_, i) => 1000 + i);
    expect(encodeCpRanges(cps)).toEqual([1000, 33]);
    expect(decodeCpRanges([1000, 33])).toEqual([[1000, 1032]]);
  });

  it('encodes later runs as a GAP from the previous end, never as an absolute', () => {
    // Runs 10-12 and 20-21: second start is 20, i.e. previous end 12 + gap 8.
    expect(encodeCpRanges([10, 11, 12, 20, 21])).toEqual([10, 3, 8, 2]);
    expect(decodeCpRanges([10, 3, 8, 2])).toEqual([[10, 12], [20, 21]]);
  });

  it('normalises unsorted input and duplicates', () => {
    expect(encodeCpRanges([21, 10, 12, 20, 11, 10, 21])).toEqual([10, 3, 8, 2]);
  });

  it('drops values that cannot be cp-ids rather than encoding them', () => {
    // A non-integer or negative slipping in would corrupt every delta AFTER it,
    // so it is discarded at the door.
    expect(encodeCpRanges([5, 6, 7, -1, 2.5, Number.NaN, 20])).toEqual([5, 3, 13, 1]);
  });

  it('adjacent runs merge — a gap of 1 can never appear in the output', () => {
    const flat = encodeCpRanges([1, 2, 3, 4, 5]);
    expect(flat).toEqual([1, 5]);
    // Every gap (every even index above 0) must be ≥ 2 by construction.
    const gaps = flat.filter((_, i) => i > 0 && i % 2 === 0);
    expect(gaps.every((g) => g >= 2)).toBe(true);
  });

  it('handles cp 0 (absolute first start, not mistaken for "no run yet")', () => {
    expect(encodeCpRanges([0, 1])).toEqual([0, 2]);
    expect(cpRangesHas([0, 2], 0)).toBe(true);
  });
});

describe('cpRangesHas', () => {
  const flat = encodeCpRanges([10, 11, 12, 20, 21, 100]);

  it('finds every encoded id', () => {
    for (const cp of [10, 11, 12, 20, 21, 100]) expect(cpRangesHas(flat, cp)).toBe(true);
  });

  it('rejects ids in the gaps, below the first run and above the last', () => {
    for (const cp of [9, 13, 19, 22, 99, 101, 0]) expect(cpRangesHas(flat, cp)).toBe(false);
  });

  it('agrees with a plain Set across a dense sweep', () => {
    // Cheap exhaustive cross-check — the encoding is only useful if it is
    // exactly equivalent to the set it replaces.
    const cps = [3, 4, 5, 9, 40, 41, 42, 43, 77];
    const known = new Set(cps);
    const enc = encodeCpRanges(cps);
    for (let cp = 0; cp <= 100; cp++) expect(cpRangesHas(enc, cp)).toBe(known.has(cp));
  });

  // ── the under-report invariant ────────────────────────────────────────────
  it('answers NO for payloads that are not arrays at all', () => {
    for (const bad of [null, undefined, 0, 'x', {}, new Set([10]), new Map()]) {
      expect(cpRangesHas(/** @type {any} */ (bad), 10)).toBe(false);
    }
  });

  it('answers NO for a non-integer needle', () => {
    expect(cpRangesHas(flat, 10.5)).toBe(false);
    expect(cpRangesHas(flat, Number.NaN)).toBe(false);
  });

  it('stops at the first malformed pair instead of resyncing on later ones', () => {
    // 10-12 decodes, then garbage. Ids that would live in the CORRUPT tail must
    // read as unknown — resyncing past bad data could shift every later delta
    // and report a cp we have never actually seen.
    const corrupt = [10, 3, 'x', 2, 8, 2];
    expect(cpRangesHas(/** @type {any} */ (corrupt), 11)).toBe(true);
    expect(cpRangesHas(/** @type {any} */ (corrupt), 20)).toBe(false);
    expect(decodeCpRanges(/** @type {any} */ (corrupt))).toEqual([[10, 12]]);
  });

  it('treats a zero or negative run length as corruption', () => {
    expect(cpRangesHas([10, 0], 10)).toBe(false);
    expect(cpRangesHas([10, -3], 10)).toBe(false);
  });

  it('ignores a trailing odd element (a truncated write)', () => {
    // A half-written payload must not be read as a run of unknown length.
    expect(cpRangesHas([10, 3, 8], 11)).toBe(true);
    expect(cpRangesHas([10, 3, 8], 20)).toBe(false);
  });

  it('answers NO for an array of the WRONG shape — e.g. history rows', () => {
    // Real failure mode: a shared/mocked storage stub handing back some other
    // key's array. Objects must never be walked as deltas.
    const rows = [{ cp: 10, fields: 100 }, { cp: 11, fields: 120 }];
    expect(cpRangesHas(/** @type {any} */ (rows), 10)).toBe(false);
  });
});

describe('the property that makes the format worth having', () => {
  it('is far smaller than the id list when colonizations are consecutive', () => {
    // Mirrors real data (s163-pl: 1474 ids → 296 runs): a colonize-heavy
    // account lands long unbroken runs because OGame's cp counter is global and
    // monotonic. 300 ids in 3 runs must cost 3 pairs, not 300 numbers.
    const cps = [
      ...Array.from({ length: 100 }, (_, i) => 1000 + i),
      ...Array.from({ length: 100 }, (_, i) => 5000 + i),
      ...Array.from({ length: 100 }, (_, i) => 9000 + i),
    ];
    const flat = encodeCpRanges(cps);
    expect(flat).toHaveLength(6);
    expect(JSON.stringify(flat).length).toBeLessThan(JSON.stringify(cps).length / 10);
    // …and it is still exactly equivalent.
    expect(cps.every((cp) => cpRangesHas(flat, cp))).toBe(true);
    expect(cpRangesHas(flat, 1100)).toBe(false);
  });
});
