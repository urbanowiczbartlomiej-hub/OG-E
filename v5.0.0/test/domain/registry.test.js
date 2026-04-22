// @ts-check

// Unit tests for the `registry` pure-domain module.
//
// Pure functions, plain Node — no DOM, no fake timers for the bulk of
// the tests. The only timer wrangling is the pair of "default now"
// cases at the end of pruneRegistry / findConflict, which assert that
// the production default of `Date.now()` is actually what gets applied
// when the caller omits the argument.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pruneRegistry,
  dedupeEntry,
  findConflict,
} from '../../src/domain/registry.js';

/**
 * Build a RegistryEntry without spelling out the object shape at every
 * call site. Keeps fixtures compact and the intent readable.
 *
 * @param {string} coords
 * @param {number} sentAt
 * @param {number} arrivalAt
 * @returns {import('../../src/domain/registry.js').RegistryEntry}
 */
// @ts-expect-error — fixture helper keeps tests terse; template-literal
// coord type doesn't narrow from arbitrary string input.
const entry = (coords, sentAt, arrivalAt) => ({ coords, sentAt, arrivalAt });

describe('pruneRegistry', () => {
  it('returns an empty array for empty input', () => {
    expect(pruneRegistry([], 1000)).toEqual([]);
  });

  it('keeps every pending entry when all arrivals are in the future', () => {
    const reg = [
      entry('1:2:3', 100, 5000),
      entry('1:2:4', 200, 6000),
    ];
    expect(pruneRegistry(reg, 1000)).toEqual(reg);
  });

  it('drops every entry when all have already arrived', () => {
    const reg = [
      entry('1:2:3', 100, 500),
      entry('1:2:4', 200, 900),
    ];
    expect(pruneRegistry(reg, 1000)).toEqual([]);
  });

  it('keeps only the pending entries from a mixed registry', () => {
    const reg = [
      entry('1:2:3', 100, 500),    // arrived before 1000
      entry('1:2:4', 150, 2000),   // still pending
      entry('1:2:5', 200, 900),    // arrived before 1000
      entry('1:2:6', 300, 3000),   // still pending
    ];
    expect(pruneRegistry(reg, 1000)).toEqual([
      entry('1:2:4', 150, 2000),
      entry('1:2:6', 300, 3000),
    ]);
  });

  it('always drops entries with arrivalAt === 0 (unparseable duration)', () => {
    const reg = [
      entry('1:2:3', 100, 0),
      entry('1:2:4', 200, 0),
      entry('1:2:5', 300, 5000),
    ];
    expect(pruneRegistry(reg, 1000)).toEqual([entry('1:2:5', 300, 5000)]);
  });

  it('treats arrivalAt === now as already-arrived (strict >)', () => {
    // Boundary: exactly `now` means the fleet lands right this instant;
    // it no longer blocks future sends, so it is pruned.
    const reg = [entry('1:2:3', 100, 1000)];
    expect(pruneRegistry(reg, 1000)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const reg = [
      entry('1:2:3', 100, 500),
      entry('1:2:4', 200, 5000),
    ];
    const snapshot = reg.map((r) => ({ ...r }));
    pruneRegistry(reg, 1000);
    expect(reg).toEqual(snapshot);
  });

  it('defaults `now` to Date.now() when omitted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-21T12:00:00Z'));
      const fixedNow = Date.now();
      const reg = [
        entry('1:2:3', 0, fixedNow - 1),   // just arrived
        entry('1:2:4', 0, fixedNow + 10),  // still pending
      ];
      expect(pruneRegistry(reg)).toEqual([entry('1:2:4', 0, fixedNow + 10)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dedupeEntry', () => {
  it('appends the candidate when the registry is empty', () => {
    const candidate = entry('1:2:3', 1000, 60000);
    expect(dedupeEntry([], candidate)).toEqual([candidate]);
  });

  it('returns reg unchanged when a byte-identical entry exists', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    const candidate = entry('1:2:3', 1000, 60000);
    expect(dedupeEntry(reg, candidate)).toBe(reg);
  });

  it('returns reg unchanged when coords match and sentAt is within default tolerance', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    // 1500ms apart, same coords — inside the 2000ms window.
    const candidate = entry('1:2:3', 2500, 61500);
    expect(dedupeEntry(reg, candidate)).toBe(reg);
  });

  it('treats a sentAt delta exactly equal to tolerance as a duplicate (<= inclusive)', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    const candidate = entry('1:2:3', 3000, 62000); // 2000ms apart
    expect(dedupeEntry(reg, candidate)).toBe(reg);
  });

  it('appends when coords match but sentAt is just outside the default tolerance', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    const candidate = entry('1:2:3', 3001, 62001); // 2001ms apart
    const result = dedupeEntry(reg, candidate);
    expect(result).toEqual([...reg, candidate]);
    expect(result).not.toBe(reg);
  });

  it('appends when sentAt matches but coords differ', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    const candidate = entry('1:2:4', 1000, 60000);
    expect(dedupeEntry(reg, candidate)).toEqual([...reg, candidate]);
  });

  it('honours a zero-tolerance override: identical sentAt blocks, 1ms apart does not', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    // Same sentAt → still a dup even at tolerance 0.
    expect(dedupeEntry(reg, entry('1:2:3', 1000, 60000), 0)).toBe(reg);
    // 1ms apart → no longer a dup with zero tolerance.
    const near = entry('1:2:3', 1001, 60001);
    expect(dedupeEntry(reg, near, 0)).toEqual([...reg, near]);
  });

  it('honours a wide custom tolerance', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    // 30s apart — well outside default, inside a 60s override.
    const candidate = entry('1:2:3', 31000, 91000);
    expect(dedupeEntry(reg, candidate, 60000)).toBe(reg);
  });

  it('does not mutate the input array on either branch', () => {
    const reg = [entry('1:2:3', 1000, 60000)];
    const snapshot = reg.map((r) => ({ ...r }));

    // Duplicate path: reg returned as-is, still shouldn't be touched.
    dedupeEntry(reg, entry('1:2:3', 1500, 60500));
    expect(reg).toEqual(snapshot);

    // Append path: a new array comes back; the original stays put.
    dedupeEntry(reg, entry('9:9:9', 99999, 999999));
    expect(reg).toEqual(snapshot);
  });
});

describe('findConflict', () => {
  it('returns null for an empty registry', () => {
    expect(findConflict([], 10_000, 1000, 0)).toBeNull();
  });

  it('flags an entry arriving at exactly the candidate time (gap 0)', () => {
    const reg = [entry('1:2:3', 0, 10_000)];
    // gap = 0, 0 < 1000 → conflict.
    expect(findConflict(reg, 10_000, 1000, 0)).toBe(reg[0]);
  });

  it('does NOT flag an entry exactly minGapMs away (strict <)', () => {
    const reg = [entry('1:2:3', 0, 11_000)];
    // gap = 1000, 1000 is NOT < 1000.
    expect(findConflict(reg, 10_000, 1000, 0)).toBeNull();
  });

  it('flags an entry 1ms inside the window', () => {
    const reg = [entry('1:2:3', 0, 10_999)];
    // gap = 999, 999 < 1000 → conflict.
    expect(findConflict(reg, 10_000, 1000, 0)).toBe(reg[0]);
  });

  it('does not flag an entry 1ms outside the window', () => {
    const reg = [entry('1:2:3', 0, 11_001)];
    // gap = 1001, 1001 is NOT < 1000.
    expect(findConflict(reg, 10_000, 1000, 0)).toBeNull();
  });

  it('returns the first conflicting entry in iteration order', () => {
    const reg = [
      entry('1:2:3', 0, 10_500), // conflicts (gap 500)
      entry('1:2:4', 0, 10_100), // would also conflict (gap 100), but comes later
    ];
    expect(findConflict(reg, 10_000, 1000, 0)).toBe(reg[0]);
  });

  it('skips expired entries (arrivalAt <= now) even if their arrival sits inside the window', () => {
    // `now` = 20_000. Both entries "conflict" by raw gap with candidate
    // at 19_500, but both have already arrived — expired entries never
    // conflict with a future landing.
    const reg = [
      entry('1:2:3', 0, 19_600), // arrived (19_600 <= 20_000)
      entry('1:2:4', 0, 20_000), // arrived exactly at now — still expired
    ];
    expect(findConflict(reg, 19_500, 1000, 20_000)).toBeNull();
  });

  it('walks past expired entries to find a pending conflict', () => {
    const reg = [
      entry('1:2:3', 0, 5_000),   // expired relative to now=20_000
      entry('1:2:4', 0, 20_300),  // pending, gap 200 < 1000 → conflict
    ];
    expect(findConflict(reg, 20_500, 1000, 20_000)).toBe(reg[1]);
  });

  it('returns null when candidateArrivalAt is 0 (unparseable duration)', () => {
    const reg = [entry('1:2:3', 0, 10_000)];
    // Even if the registry has plausibly-close entries, we cannot
    // compute a meaningful gap without a real candidate arrival — the
    // safe answer is "no conflict".
    expect(findConflict(reg, 0, 1000, 0)).toBeNull();
  });

  it('defaults `now` to Date.now() when omitted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-21T12:00:00Z'));
      const fixedNow = Date.now();
      const reg = [
        entry('1:2:3', 0, fixedNow - 1),     // expired under default now
        entry('1:2:4', 0, fixedNow + 10_000),
      ];
      // Candidate lands 300ms after the pending entry → gap 300 <
      // minGap 1000 → the pending entry is the conflict. The expired
      // entry is silently skipped.
      expect(findConflict(reg, fixedNow + 10_300, 1000)).toBe(reg[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
