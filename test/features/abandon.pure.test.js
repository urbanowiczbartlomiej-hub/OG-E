// Unit tests for the colony-landing pure core (no DOM, no timers).
//
// @ts-check

import { describe, it, expect } from 'vitest';

import {
  LANDING_WINDOW_S,
  LANDING_GRACE_S,
  deriveLanding,
  nextLandingTickMs,
  formatLandingCountdown,
  landingProgress,
} from '../../src/features/abandon/pure.js';

/** A fixed "now" in epoch ms, and the matching epoch-seconds base. */
const NOW = 1_700_000_000_000;
const SEC = NOW / 1000;
/** Arrival `s` seconds from NOW, in epoch SECONDS. @param {number} s */
const at = (s) => SEC + s;

/**
 * @param {Partial<Parameters<typeof deriveLanding>[0]>} [over]
 * @returns {Parameters<typeof deriveLanding>[0]}
 */
const input = (over = {}) => ({
  domArrivals: null,
  cachedArrival: 0,
  latchedArrival: 0,
  pageBornMs: NOW - 300_000, // page opened 5 min ago by default
  nowMs: NOW,
  ...over,
});

describe('abandon/pure — deriveLanding', () => {
  it('is idle when the nearest arrival is beyond the window', () => {
    const r = deriveLanding(input({ domArrivals: [at(120)] }));
    expect(r.phase).toBe('idle');
    expect(r.arrivalAt).toBe(at(120));
    expect(r.latch).toBe(0);
  });

  it('arms landing once the arrival is within the window', () => {
    const r = deriveLanding(input({ domArrivals: [at(45)] }));
    expect(r.phase).toBe('landing');
    expect(r.arrivalAt).toBe(at(45));
  });

  it('arms landing exactly at the window edge', () => {
    const r = deriveLanding(input({ domArrivals: [at(LANDING_WINDOW_S)] }));
    expect(r.phase).toBe('landing');
  });

  it('picks the NEAREST upcoming arrival among several', () => {
    const r = deriveLanding(input({ domArrivals: [at(50), at(20), at(80)] }));
    expect(r.arrivalAt).toBe(at(20));
    expect(r.phase).toBe('landing');
  });

  it('latches an arrival that landed WHILE this page was open (grace → landing)', () => {
    // Landed 1 s ago (< grace) → still "landing", now latched.
    const r = deriveLanding(input({ domArrivals: [at(-1)] }));
    expect(r.latch).toBe(at(-1));
    expect(r.phase).toBe('landing');
    expect(r.arrivalAt).toBe(at(-1));
  });

  it('flips to refresh once the landed arrival is past the grace window', () => {
    const r = deriveLanding(input({ domArrivals: [at(-(LANDING_GRACE_S + 1))] }));
    expect(r.phase).toBe('refresh');
    expect(r.latch).toBe(at(-(LANDING_GRACE_S + 1)));
  });

  it('never latches an arrival older than the page (page born after it)', () => {
    // Arrival 5 s ago, but the page was born only 2 s ago → not ours.
    const r = deriveLanding(input({ domArrivals: [at(-5)], pageBornMs: NOW - 2_000 }));
    expect(r.latch).toBe(0);
    expect(r.phase).toBe('idle');
  });

  it('keeps a latch passed back in even after the leg disappears', () => {
    // domArrivals empty (leg gone from the list) but the latch persists.
    const r = deriveLanding(input({ domArrivals: [], latchedArrival: at(-(LANDING_GRACE_S + 1)) }));
    expect(r.phase).toBe('refresh');
    expect(r.arrivalAt).toBe(at(-(LANDING_GRACE_S + 1)));
  });

  it('falls back to the cache when the live list is unreadable (null)', () => {
    const r = deriveLanding(input({ domArrivals: null, cachedArrival: at(30) }));
    expect(r.phase).toBe('landing');
    expect(r.arrivalAt).toBe(at(30));
    // Cache already holds it → no rewrite.
    expect(r.cacheWrite).toBeNull();
  });

  it('writes the nearest upcoming arrival to the cache when it differs', () => {
    const r = deriveLanding(input({ domArrivals: [at(40)], cachedArrival: 0 }));
    expect(r.cacheWrite).toBe(at(40));
  });

  it('clears the cache (0) when a readable list shows nothing upcoming', () => {
    const r = deriveLanding(input({ domArrivals: [], cachedArrival: at(30) }));
    expect(r.phase).toBe('idle');
    expect(r.arrivalAt).toBe(0);
    expect(r.cacheWrite).toBe(0);
  });

  it('does not rewrite the cache when the upcoming arrival already matches', () => {
    const r = deriveLanding(input({ domArrivals: [at(120)], cachedArrival: at(120) }));
    expect(r.cacheWrite).toBeNull();
  });
});

describe('abandon/pure — nextLandingTickMs', () => {
  it('ticks at 1 Hz while landing', () => {
    expect(nextLandingTickMs('landing', at(30), NOW)).toBe(1000);
  });

  it('needs no timer for refresh or an empty board', () => {
    expect(nextLandingTickMs('refresh', at(-3), NOW)).toBe(0);
    expect(nextLandingTickMs('idle', 0, NOW)).toBe(0);
  });

  it('wakes near the window boundary but no rarer than the idle cap', () => {
    // Arrival 2 min out → boundary is 60 s away, capped to the 30 s recheck.
    expect(nextLandingTickMs('idle', at(120), NOW)).toBe(30_000);
    // Arrival just outside the window → wake in ~1 s (floored at 1 s).
    expect(nextLandingTickMs('idle', at(61), NOW)).toBe(1000);
  });
});

describe('abandon/pure — formatLandingCountdown', () => {
  it('formats remaining time as m:ss', () => {
    expect(formatLandingCountdown(at(45), NOW)).toBe('0:45');
    expect(formatLandingCountdown(at(90), NOW)).toBe('1:30');
  });

  it('clamps a past arrival to 0:00', () => {
    expect(formatLandingCountdown(at(-5), NOW)).toBe('0:00');
  });
});

describe('abandon/pure — landingProgress', () => {
  it('is 0 at the window edge and 1 at arrival', () => {
    expect(landingProgress(at(LANDING_WINDOW_S), NOW)).toBe(0);
    expect(landingProgress(at(0), NOW)).toBe(1);
  });

  it('fills proportionally through the window', () => {
    expect(landingProgress(at(30), NOW)).toBeCloseTo(0.5, 5);
  });

  it('clamps both ends (before the window / after arrival)', () => {
    expect(landingProgress(at(90), NOW)).toBe(0); // 90 s out — before the window
    expect(landingProgress(at(-10), NOW)).toBe(1); // already landed
  });
});
