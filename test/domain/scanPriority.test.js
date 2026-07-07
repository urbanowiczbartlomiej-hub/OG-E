// @ts-check

// Unit tests for domain/scanPriority — the pure scan-plan ranking shared by the
// dashboard "suggested scan order" strip and the in-game Spy FAB. All pure over
// plain data with an explicit `nowMs`; nothing reads Date.now(). Local-hour math
// (windowBonus) is DERIVED from the fixed nowMs the same way the module does, so
// the suite stays timezone-robust.

import { describe, it, expect } from 'vitest';
import {
  dangerWeight,
  stalenessWeight,
  windowBonus,
  staleMsFor,
  buildScanPlan,
  WINDOW_BONUS,
} from '../../src/domain/scanPriority.js';
import { SPY_STALE_MS } from '../../src/domain/spyScan.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 3600 * 1000;
/** Epoch SECONDS for a report taken `ageMs` before NOW. @param {number} ageMs */
const tsSecAgo = (ageMs) => Math.floor((NOW - ageMs) / 1000);

describe('dangerWeight', () => {
  it('floors at 0.3 for D=0 and reaches 1.0 for D=100', () => {
    expect(dangerWeight(0)).toBeCloseTo(0.3, 10);
    expect(dangerWeight(100)).toBeCloseTo(1.0, 10);
    expect(dangerWeight(50)).toBeCloseTo(0.65, 10);
  });
  it('unknown D sits mid-scale (treated as 50) and clamps out-of-range', () => {
    expect(dangerWeight(undefined)).toBeCloseTo(0.65, 10);
    expect(dangerWeight(NaN)).toBeCloseTo(0.65, 10);
    expect(dangerWeight(200)).toBeCloseTo(1.0, 10); // clamped to 100
    expect(dangerWeight(-5)).toBeCloseTo(0.3, 10); // clamped to 0
  });
});

describe('stalenessWeight', () => {
  it('never-scanned outranks rescan outranks stale; fresh is excluded (0)', () => {
    expect(stalenessWeight('none', 0, SPY_STALE_MS)).toBe(1.0);
    expect(stalenessWeight('rescan', 0, SPY_STALE_MS)).toBe(0.9);
    expect(stalenessWeight('fresh', 0, SPY_STALE_MS)).toBe(0);
  });
  it('stale ramps from 0.3 with age beyond the threshold, capped at 0.9', () => {
    // exactly at threshold (ageMs == staleMs) → over = 0 → base 0.3
    expect(stalenessWeight('stale', SPY_STALE_MS, SPY_STALE_MS)).toBeCloseTo(0.3, 10);
    // one full staleMs beyond → over = 1 → 0.3 + 0.2 = 0.5
    expect(stalenessWeight('stale', 2 * SPY_STALE_MS, SPY_STALE_MS)).toBeCloseTo(0.5, 10);
    // far beyond → capped at 0.9
    expect(stalenessWeight('stale', 20 * SPY_STALE_MS, SPY_STALE_MS)).toBe(0.9);
  });
});

describe('staleMsFor', () => {
  it('uses the configured re-scan hours; no cadence falls back to the 7-day default', () => {
    expect(staleMsFor({ rescanHours: 12 })).toBe(12 * 3600 * 1000);
    expect(staleMsFor({ rescanHours: 48, galaxyHours: 24 })).toBe(48 * 3600 * 1000);
    expect(staleMsFor(undefined)).toBe(SPY_STALE_MS);
  });
});

describe('windowBonus', () => {
  /** An ActivitySummary carrying just what windowBonus reads. */
  const act = (/** @type {string} */ gate, /** @type {{startH:number,endH:number}|undefined} */ peak) =>
    /** @type {any} */ ({ gate, peak });

  it('is 1 without an activity summary or peak', () => {
    expect(windowBonus(NOW, undefined)).toBe(1);
    expect(windowBonus(NOW, act('pattern', undefined))).toBe(1);
  });

  it('is 1 when the gate is below pattern even if a peak is present', () => {
    const h = new Date(NOW).getHours();
    expect(windowBonus(NOW, act('hint', { startH: h, endH: h }))).toBe(1);
    expect(windowBonus(NOW, act('none', { startH: h, endH: h }))).toBe(1);
  });

  it('applies the bonus when NOW falls inside the peak window (≥ pattern)', () => {
    const h = new Date(NOW).getHours();
    expect(windowBonus(NOW, act('pattern', { startH: h, endH: h }))).toBe(WINDOW_BONUS);
    expect(windowBonus(NOW, act('strong', { startH: h, endH: h }))).toBe(WINDOW_BONUS);
  });

  it('is 1 when NOW is outside the peak window', () => {
    const h = new Date(NOW).getHours();
    const other = (h + 6) % 24;
    expect(windowBonus(NOW, act('pattern', { startH: other, endH: other }))).toBe(1);
  });

  it('handles a wrapping window (start > end, e.g. evening→night)', () => {
    const h = new Date(NOW).getHours();
    // A window from h-1 wrapping to h+1 that crosses midnight only if h is 0/23,
    // but the wrap branch (start > end) is what we exercise: put start after end
    // with h inside the wrapped span.
    const startH = (h + 23) % 24; // h-1
    const endH = (h + 1) % 24; // h+1
    // If this didn't wrap (startH <= endH) the non-wrap branch still contains h;
    // when it wraps (h near 0) the wrap branch must also contain h.
    expect(windowBonus(NOW, act('pattern', { startH, endH }))).toBe(WINDOW_BONUS);
  });
});

describe('buildScanPlan — ranking', () => {
  const twoPlanets = [
    { coords: '1:2:3', player: 42 },
    { coords: '1:2:8', player: 42 },
  ];

  it('excludes fresh planets and returns nothing when all are fresh', () => {
    const { entries } = buildScanPlan({
      players: ['42'],
      universePlanets: twoPlanets,
      spiedByPlayer: { 42: { '1:2:3': tsSecAgo(60_000), '1:2:8': tsSecAgo(60_000) } },
      nowMs: NOW,
    });
    expect(entries).toEqual([]);
  });

  it('ranks a higher-danger player ahead of a lower-danger one (both never-scanned)', () => {
    const { entries } = buildScanPlan({
      players: ['10', '80'],
      universePlanets: [
        { coords: '1:1:1', player: 10 },
        { coords: '2:2:2', player: 80 },
      ],
      spiedByPlayer: {},
      nowMs: NOW,
      dangerByPlayer: { 10: 10, 80: 80 },
    });
    expect(entries[0].playerId).toBe('80');
    expect(entries[1].playerId).toBe('10');
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority);
  });

  it('never-scanned outranks stale for the same player', () => {
    const { entries } = buildScanPlan({
      players: ['42'],
      universePlanets: twoPlanets,
      // 1:2:8 has a stale report; 1:2:3 was never scanned.
      spiedByPlayer: { 42: { '1:2:8': tsSecAgo(SPY_STALE_MS + DAY_MS) } },
      nowMs: NOW,
    });
    expect(entries[0].position).toBe(3); // never-scanned first
    expect(entries[0].status).toBe('none');
    expect(entries[1].position).toBe(8);
    expect(entries[1].status).toBe('stale');
  });

  it('skips coords already sent this session', () => {
    const { entries } = buildScanPlan({
      players: ['42'],
      universePlanets: twoPlanets,
      spiedByPlayer: {},
      nowMs: NOW,
      sentCoords: new Set(['1:2:3']),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].position).toBe(8);
  });

  it('the activity-window bonus lifts an in-window target above an equal-danger one', () => {
    const h = new Date(NOW).getHours();
    const activeNow = /** @type {any} */ ({ gate: 'pattern', peak: { startH: h, endH: h } });
    const { entries } = buildScanPlan({
      players: ['100', '200'],
      universePlanets: [
        { coords: '1:1:1', player: 100 },
        { coords: '2:2:2', player: 200 },
      ],
      spiedByPlayer: {},
      nowMs: NOW,
      dangerByPlayer: { 100: 50, 200: 50 }, // equal danger
      activityByPlayer: { 200: activeNow }, // only 200 is in its active window
    });
    expect(entries[0].playerId).toBe('200');
    expect(entries[0].why).toContain('good moment');
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority);
  });

  it('deterministic tiebreak on equal priority: watch-list order then g:s:p', () => {
    const { entries } = buildScanPlan({
      // Player 2 listed before player 1 (watch order ≠ numeric order); both
      // un-spied, unknown danger → equal priority, so watch order decides.
      players: ['2', '1'],
      universePlanets: [
        { coords: '1:1:9', player: 2 },
        { coords: '1:1:1', player: 2 },
        { coords: '1:1:1', player: 1 },
      ],
      spiedByPlayer: {},
      nowMs: NOW,
    });
    // Player 2 before 1 (watch order); within 2, position 1 before 9 (g:s:p).
    expect(entries.map((e) => `${e.playerId}:${e.position}`)).toEqual(['2:1', '2:9', '1:1']);
  });

  it('carries a wording-safe reason per entry', () => {
    const { entries } = buildScanPlan({
      players: ['42'],
      universePlanets: [{ coords: '1:2:3', player: 42 }],
      spiedByPlayer: {},
      nowMs: NOW,
      dangerByPlayer: { 42: 70 },
    });
    expect(entries[0].why).toContain('never scanned');
    expect(entries[0].why).toContain('D 70');
    // No queue/scheduling language leaks into the reason.
    expect(entries[0].why).not.toMatch(/queue|scheduled|due/i);
  });
});
