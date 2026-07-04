// @ts-check

// Unit tests for domain/activityObs — the pure append rules of the per-body
// galaxy-activity ring: the self-induced-probe discount, same-interaction
// dedup, negative-evidence throttle, out-of-order guard, and ring cap. All pure
// over plain {t (epoch SECONDS), m} observations; nothing reads Date.now().

import { describe, it, expect } from 'vitest';
import {
  interactionInterval,
  isSelfInduced,
  appendActivityObs,
  ACTIVITY_RING_CAP,
  NONE_REPEAT_MS,
  FRESH_BAND_S,
} from '../../src/domain/activityObs.js';

const T = 1_700_000_000; // epoch SECONDS base

describe('interactionInterval', () => {
  it('the fresh dot (m=0) means "somewhere in the last 15 min"', () => {
    expect(interactionInterval({ t: T, m: 0 })).toEqual({ lo: T - FRESH_BAND_S, hi: T });
  });
  it('an exact minute marker pins the interaction to that minute (±60 s)', () => {
    expect(interactionInterval({ t: T, m: 42 })).toEqual({ lo: T - 42 * 60 - 60, hi: T - 42 * 60 });
  });
});

describe('isSelfInduced', () => {
  it('is false without a recorded probe send, or for a "no marker" reading', () => {
    expect(isSelfInduced({ t: T, m: 0 }, undefined)).toBe(false);
    expect(isSelfInduced({ t: T, m: 0 }, 0)).toBe(false);
    expect(isSelfInduced({ t: T, m: -1 }, T * 1000)).toBe(false);
  });
  it('is true when the implied interaction matches a probe we sent', () => {
    // Probe sent right at the observation time → the fresh-dot interval overlaps
    // the [send-2min, send+45min] self window.
    expect(isSelfInduced({ t: T, m: 0 }, T * 1000)).toBe(true);
    // Exact-minute reading 30 min old, probe sent ~30 min ago → still ours.
    expect(isSelfInduced({ t: T, m: 30 }, (T - 30 * 60) * 1000)).toBe(true);
  });
  it('is false when the probe was long before the interaction', () => {
    expect(isSelfInduced({ t: T, m: 0 }, (T - 10 * 3600) * 1000)).toBe(false);
  });
});

describe('appendActivityObs — validation', () => {
  it('rejects a non-finite time or an out-of-range marker', () => {
    expect(appendActivityObs([], { t: NaN, m: 0 })).toBeNull();
    expect(appendActivityObs([], { t: T, m: 99 })).toBeNull();
    expect(appendActivityObs([], { t: T, m: -2 })).toBeNull();
  });
  it('appends a valid positive marker to an empty ring', () => {
    expect(appendActivityObs(undefined, { t: T, m: 0 })).toEqual([{ t: T, m: 0 }]);
  });
});

describe('appendActivityObs — self-induced discount', () => {
  it('drops a marker our own probe lit (returns null → no store write)', () => {
    expect(appendActivityObs([], { t: T, m: 0 }, { sentAtMs: T * 1000 })).toBeNull();
  });
  it('keeps a marker unrelated to our probes', () => {
    const ring = appendActivityObs([], { t: T, m: 0 }, { sentAtMs: (T - 10 * 3600) * 1000 });
    expect(ring).toEqual([{ t: T, m: 0 }]);
  });
});

describe('appendActivityObs — same-interaction dedup', () => {
  it('drops a re-observation of the same interaction (overlapping intervals)', () => {
    const ring = [{ t: T, m: 0 }];
    // 100 s later, still the same <15-min interaction → intervals overlap → drop.
    expect(appendActivityObs(ring, { t: T + 100, m: 0 })).toBeNull();
  });
  it('keeps a genuinely later, non-overlapping interaction', () => {
    const ring = [{ t: T, m: 0 }];
    const next = appendActivityObs(ring, { t: T + 2000, m: 0 });
    expect(next).toEqual([{ t: T, m: 0 }, { t: T + 2000, m: 0 }]);
  });
});

describe('appendActivityObs — negative-evidence throttle', () => {
  it('keeps a "no marker" look, but drops a repeat within 30 min', () => {
    const first = appendActivityObs([], { t: T, m: -1 });
    expect(first).toEqual([{ t: T, m: -1 }]);
    const soon = appendActivityObs([{ t: T, m: -1 }], { t: T + Math.floor(NONE_REPEAT_MS / 1000 / 2), m: -1 });
    expect(soon).toBeNull();
  });
  it('keeps a "no marker" look after the throttle window', () => {
    const first = [{ t: T, m: -1 }];
    const later = appendActivityObs(first, { t: T + Math.floor(NONE_REPEAT_MS / 1000) + 60, m: -1 });
    expect(later).toEqual([{ t: T, m: -1 }, { t: T + Math.floor(NONE_REPEAT_MS / 1000) + 60, m: -1 }]);
  });
});

describe('appendActivityObs — ordering + cap', () => {
  it('never appends an observation older than the newest kept one', () => {
    expect(appendActivityObs([{ t: T, m: 0 }], { t: T - 100, m: 0 })).toBeNull();
  });
  it('caps the ring at ACTIVITY_RING_CAP, keeping the newest', () => {
    /** @type {import('../../src/domain/activityObs.js').ActivityObs[]} */
    let ring = [];
    const N = ACTIVITY_RING_CAP + 5;
    for (let i = 0; i < N; i++) {
      const next = appendActivityObs(ring, { t: T + i * 2000, m: 0 });
      expect(next).not.toBeNull();
      ring = /** @type {import('../../src/domain/activityObs.js').ActivityObs[]} */ (next);
    }
    expect(ring).toHaveLength(ACTIVITY_RING_CAP);
    expect(ring[ring.length - 1].t).toBe(T + (N - 1) * 2000);
  });
});
