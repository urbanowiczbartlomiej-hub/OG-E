// @ts-check

// Unit tests for domain/waves — pure, no DOM, no mocks, no fake timers
// (every function takes `now` explicitly).
//
// The model under test (see the module header): a wave's membership is the
// set of event-row ids, a wave is PROVISIONAL until its membership settles
// and SEALED afterwards, and its anchor is the first mission's return,
// frozen for life. Most of these cases are the measured failure modes of
// the previous, time-set-based model.

import { describe, it, expect } from 'vitest';
import {
  clusterWaves,
  reconcileWaves,
  pruneNotifyState,
  isWaveCommitted,
  DEFAULT_CLUSTER_GAP_SECONDS,
  DEFAULT_SETTLE_SECONDS,
  PROVISIONAL_JOIN_SECONDS,
  CLEANUP_GRACE_SEC,
} from '../../src/domain/waves.js';

/** Base epoch for readable offsets. */
const T = 1_800_000_000;

let seq = 0;
/**
 * One observed expedition return row.
 * @param {number} returnAt
 * @param {{ id?: string, origin?: string }} [o]
 */
const ret = (returnAt, o = {}) => ({
  id: o.id ?? `eventRow-${++seq}`,
  returnAt,
  origin: o.origin ?? '1:1:1',
});

/**
 * Drive a sequence of scans through the reconcile, carrying the wave set
 * forward exactly as the producer does.
 * @param {Array<[ReturnType<typeof ret>[], number]>} scans
 */
const drive = (scans) => {
  /** @type {import('../../src/domain/waves.js').Wave[]} */
  let waves = [];
  let last = /** @type {ReturnType<typeof reconcileWaves>} */ (
    { waves: [], droppedIds: [], brandNewDetected: false }
  );
  for (const [entries, now] of scans) {
    last = reconcileWaves(waves, entries, now);
    waves = last.waves;
  }
  return last;
};

/** A scan far enough past the last membership change to seal. */
const SEAL_AFTER = DEFAULT_SETTLE_SECONDS + 1;

describe('clusterWaves', () => {
  it('collapses one tight burst into a single candidate', () => {
    const out = clusterWaves([ret(T), ret(T + 60), ret(T + 120)]);
    expect(out).toHaveLength(1);
    expect(out[0].fleetCount).toBe(3);
  });

  it('carries the member row ids', () => {
    const out = clusterWaves([ret(T, { id: 'eventRow-7' }), ret(T + 60, { id: 'eventRow-8' })]);
    expect(out[0].memberIds).toEqual(['eventRow-7', 'eventRow-8']);
  });

  it('uses the EARLIEST return as nextWaveAt', () => {
    const out = clusterWaves([ret(T + 120), ret(T), ret(T + 60)]);
    expect(out[0].nextWaveAt).toBe(T);
  });

  it('deduplicates returnAts when two fleets share a second; fleetCount keeps the count', () => {
    const out = clusterWaves([ret(T), ret(T)]);
    expect(out[0].returnAts).toEqual([T]);
    expect(out[0].fleetCount).toBe(2);
  });

  it('lists sorted, de-duplicated origins (display-only)', () => {
    const out = clusterWaves([
      ret(T, { origin: '2:2:2' }), ret(T + 10, { origin: '1:1:1' }), ret(T + 20, { origin: '2:2:2' }),
    ]);
    expect(out[0].origins).toEqual(['1:1:1', '2:2:2']);
  });

  it('splits on a gap wider than the threshold — it is a CHAIN, not a window', () => {
    // Consecutive gaps of 240 s chain into ONE wave spanning 16 minutes,
    // even though the threshold is 300 s. That transitivity is why the
    // threshold stays small (see the constant's doc comment).
    const chained = clusterWaves(
      Array.from({ length: 5 }, (_, i) => ret(T + i * 240)));
    expect(chained).toHaveLength(1);
    // The same span as a single jump splits.
    expect(clusterWaves([ret(T), ret(T + 960)])).toHaveLength(2);
  });

  it('honours a custom gapSeconds', () => {
    const entries = [ret(T), ret(T + 600)];
    expect(clusterWaves(entries, { gapSeconds: 300 })).toHaveLength(2);
    expect(clusterWaves(entries, { gapSeconds: 900 })).toHaveLength(1);
  });

  it('drops entries with a non-finite returnAt', () => {
    expect(clusterWaves([ret(T), { id: 'x', returnAt: NaN, origin: '' }])).toHaveLength(1);
  });

  it('does not mutate its input', () => {
    const entries = [ret(T + 60), ret(T)];
    const copy = entries.map((e) => ({ ...e }));
    clusterWaves(entries);
    expect(entries).toEqual(copy);
  });

  it('exposes the documented constants', () => {
    expect(DEFAULT_CLUSTER_GAP_SECONDS).toBe(300);
    expect(DEFAULT_SETTLE_SECONDS).toBe(180);
    expect(PROVISIONAL_JOIN_SECONDS).toBe(900);
    expect(CLEANUP_GRACE_SEC).toBe(60);
  });
});

describe('reconcileWaves — identity by member row id', () => {
  it('stamps a brand-new wave from the earliest return and sets detectedAt', () => {
    const r = reconcileWaves([], [ret(T), ret(T + 60)], T - 3600);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].id).toBe('w_' + T);
    expect(r.waves[0].detectedAt).toBe(T - 3600);
    expect(r.brandNewDetected).toBe(true);
  });

  it('keeps the id across scans while any member is still in flight', () => {
    const a = ret(T);
    const b = ret(T + 60);
    const r = drive([[[a, b], T - 3600], [[a, b], T - 3600 + SEAL_AFTER], [[b], T + 10]]);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].id).toBe('w_' + T);
    expect(r.waves[0].fleetCount).toBe(1);
  });

  it('drops a wave once its last member has landed', () => {
    const a = ret(T);
    const r = drive([[[a], T - 3600], [[], T + 10]]);
    expect(r.waves).toEqual([]);
    expect(r.droppedIds).toEqual(['w_' + T]);
  });

  it('a re-send is a brand-new wave', () => {
    const first = ret(T);
    const r = drive([
      [[first], T - 3600],
      [[first], T - 3600 + SEAL_AFTER],
      [[first, ret(T + 7200)], T - 3000],
    ]);
    expect(r.waves).toHaveLength(2);
    expect(r.brandNewDetected).toBe(true);
  });

  it('ignores a duplicated row id — one fleet can never sit in two waves', () => {
    const dup = ret(T);
    const r = reconcileWaves([], [dup, { ...dup, returnAt: T + 5000 }], T - 3600);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].fleetCount).toBe(1);
  });

  it('returns waves sorted by nextWaveAt', () => {
    const r = reconcileWaves([], [ret(T + 7200), ret(T)], T - 3600);
    expect(r.waves.map((w) => w.nextWaveAt)).toEqual([T, T + 7200]);
  });
});

describe('reconcileWaves — the return-speed outcome (the bug this model exists for)', () => {
  // An expedition can come home minutes earlier or later than planned: the
  // row's data-arrival-time jumps at the end of the hold. Under the old
  // time-set identity that member shared no timestamp with its own wave
  // and was re-detected as a brand-new one, permanently — a full duplicate
  // reminder series per affected expedition.

  it('a member that jumps 12 minutes early stays in its SEALED wave', () => {
    const shifting = ret(T);
    const rest = [ret(T + 60), ret(T + 120)];
    const after = [{ ...shifting, returnAt: T - 720 }, ...rest];
    const r = drive([
      [[shifting, ...rest], T - 3600],
      [[shifting, ...rest], T - 3600 + SEAL_AFTER],
      [after, T - 1800],
    ]);
    expect(r.waves).toHaveLength(1);
    expect(r.brandNewDetected).toBe(false);
    expect(r.droppedIds).toEqual([]);
    expect(r.waves[0].fleetCount).toBe(3);
  });

  it('the jump does NOT move the anchor', () => {
    const shifting = ret(T);
    const rest = [ret(T + 60)];
    const r = drive([
      [[shifting, ...rest], T - 3600],
      [[shifting, ...rest], T - 3600 + SEAL_AFTER],
      [[{ ...shifting, returnAt: T - 720 }, ...rest], T - 1800],
    ]);
    expect(r.waves[0].anchorAt).toBe(T);
    // …while the observed earliest return does follow it.
    expect(r.waves[0].nextWaveAt).toBe(T - 720);
  });

  it('a member recalled out of the middle does not split the wave', () => {
    const [a, b, c] = [ret(T), ret(T + 280), ret(T + 560)];
    const r = drive([
      [[a, b, c], T - 3600],
      [[a, b, c], T - 3600 + SEAL_AFTER],
      [[a, c], T - 1800], // b recalled; the hole is now 560 s wide
    ]);
    expect(r.waves).toHaveLength(1);
    expect(r.brandNewDetected).toBe(false);
  });
});

describe('reconcileWaves — provisional vs sealed', () => {
  it('a fresh wave is provisional; it seals once membership settles', () => {
    const a = ret(T);
    const first = reconcileWaves([], [a], T - 3600);
    expect(isWaveCommitted(first.waves[0])).toBe(false);
    const later = reconcileWaves(first.waves, [a], T - 3600 + SEAL_AFTER);
    expect(isWaveCommitted(later.waves[0])).toBe(true);
    expect(later.waves[0].committedAt).toBe(T - 3600 + SEAL_AFTER);
  });

  it('a new member restarts the settle clock', () => {
    const a = ret(T);
    const b = ret(T + 60);
    const r1 = reconcileWaves([], [a], T - 3600);
    // Almost settled — then a second expedition is sent.
    const r2 = reconcileWaves(r1.waves, [a, b], T - 3600 + DEFAULT_SETTLE_SECONDS - 1);
    expect(isWaveCommitted(r2.waves[0])).toBe(false);
    const r3 = reconcileWaves(r2.waves, [a, b], T - 3600 + DEFAULT_SETTLE_SECONDS + 10);
    expect(isWaveCommitted(r3.waves[0])).toBe(false);
    const r4 = reconcileWaves(r2.waves, [a, b], T - 3600 + 2 * DEFAULT_SETTLE_SECONDS);
    expect(isWaveCommitted(r4.waves[0])).toBe(true);
  });

  it('seals immediately when the anchor is too close to wait', () => {
    // Late login: the wave is already coming home. Waiting out the settle
    // window would cost the first reminder.
    const r = reconcileWaves([], [ret(T)], T - 30);
    expect(isWaveCommitted(r.waves[0])).toBe(true);
  });

  it('a SEALED wave never takes a new member — the next send is its own wave', () => {
    const a = ret(T);
    const r = drive([
      [[a], T - 3600],
      [[a], T - 3600 + SEAL_AFTER],
      [[a, ret(T + 120)], T - 3600 + SEAL_AFTER + 10],
    ]);
    expect(r.waves).toHaveLength(2);
    expect(isWaveCommitted(r.waves[0])).toBe(true);
  });
});

describe('reconcileWaves — a send spread over minutes', () => {
  // Sending a wave reloads the page per expedition, so each send is its own
  // scan and a wave is observed half-built. Nothing may be scheduled while
  // that is still true: every ntfy POST counts against the daily budget and
  // a cancellation refunds nothing.

  it('a mission outside the chain gap is fused back into the open wave', () => {
    const a = ret(T);
    const b = ret(T + 420); // 7 min — beyond the 300 s chain gap
    const r = drive([[[a], T - 3600], [[a, b], T - 3590]]);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].fleetCount).toBe(2);
    expect(r.waves[0].anchorAt).toBe(T);
  });

  it('a fused cluster is not reported as a brand-new send', () => {
    const a = ret(T);
    const r = drive([[[a], T - 3600], [[a, ret(T + 420)], T - 3590]]);
    expect(r.brandNewDetected).toBe(false);
  });

  it('fusing is stable — the next scan does not re-split or duplicate ids', () => {
    const a = ret(T);
    const b = ret(T + 480);
    const r = drive([
      [[a], T - 3600], [[a, b], T - 3590], [[a, b], T - 3580], [[a, b], T - 3000],
    ]);
    expect(r.waves).toHaveLength(1);
    expect(new Set(r.waves.map((w) => w.id)).size).toBe(1);
    expect(isWaveCommitted(r.waves[0])).toBe(true);
  });

  it('a full 15-expedition send converges on ONE wave', () => {
    const sent = Array.from({ length: 15 }, (_, i) => ret(T + i * 20 + ((i % 5) - 2) * 120));
    /** @type {Array<[ReturnType<typeof ret>[], number]>} */
    const scans = sent.map((_, i) => [sent.slice(0, i + 1), T - 3600 + i * 20]);
    scans.push([sent, T - 3000]);
    const r = drive(scans);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].fleetCount).toBe(15);
    expect(isWaveCommitted(r.waves[0])).toBe(true);
  });

  it('does NOT fuse two genuinely separate sends', () => {
    const first = [ret(T), ret(T + 120)];
    const second = [ret(T + 5400), ret(T + 5520)];
    const r = drive([
      [first, T - 3600],
      [first, T - 3600 + SEAL_AFTER],
      [[...first, ...second], T - 3000],
    ]);
    expect(r.waves).toHaveLength(2);
    expect(r.waves.map((w) => w.anchorAt)).toEqual([T, T + 5400]);
  });

  it('the anchor stays on the FIRST mission sent, even when a later one returns earlier', () => {
    // The reminder cues replaying the same send order at the same spacing,
    // so it belongs on the start of that sequence — not on whichever fleet
    // happens to touch down first.
    const first = ret(T);
    const earlier = ret(T - 240);
    const r = drive([[[first], T - 3600], [[first, earlier], T - 3590], [[first, earlier], T - 3000]]);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].anchorAt).toBe(T);
    expect(r.waves[0].nextWaveAt).toBe(T - 240);
  });
});

describe('reconcileWaves — brand-new cleanup', () => {
  it('tombstones (does not drop) an older wave whose first alarm is imminent', () => {
    const old = ret(T);
    const r = drive([
      [[old], T - 3600],
      [[old], T - 3600 + SEAL_AFTER],
      [[old, ret(T + 7200)], T - 30], // re-send while the old wave lands
    ]);
    const tomb = r.waves.find((w) => w.id === 'w_' + T);
    expect(tomb?.cancelled).toBe(true);
    expect(r.droppedIds).not.toContain('w_' + T);
  });

  it('leaves an older wave alone when its first alarm is still far off', () => {
    const old = ret(T);
    const r = drive([
      [[old], T - 3600],
      [[old], T - 3600 + SEAL_AFTER],
      [[old, ret(T + 7200)], T - 3000],
    ]);
    expect(r.waves.find((w) => w.id === 'w_' + T)?.cancelled).toBeUndefined();
  });

  it('the tombstone survives later scans — a swept wave is not resurrected', () => {
    const old = ret(T);
    const fresh = ret(T + 7200);
    const r = drive([
      [[old], T - 3600],
      [[old], T - 3600 + SEAL_AFTER],
      [[old, fresh], T - 30],
      [[old, fresh], T - 10],
    ]);
    expect(r.waves.find((w) => w.id === 'w_' + T)?.cancelled).toBe(true);
  });

  it('a brand-new wave never starts cancelled', () => {
    const r = reconcileWaves([], [ret(T)], T - 3600);
    expect(r.waves[0].cancelled).toBeUndefined();
  });

  it('a user tombstone carries forward across scans', () => {
    const a = ret(T);
    const r1 = reconcileWaves([], [a], T - 3600);
    const cancelled = r1.waves.map((w) => ({ ...w, cancelled: true }));
    const r2 = reconcileWaves(cancelled, [a], T - 3000);
    expect(r2.waves[0].cancelled).toBe(true);
  });
});

describe('reconcileWaves — upgrade from the time-set model', () => {
  it('adopts a stored wave that has no memberIds, without re-scheduling it', () => {
    /** @type {any} */
    const legacy = {
      id: 'w_legacy', nextWaveAt: T, fleetCount: 2,
      returnAts: [T, T + 60], origins: ['1:1:1'], detectedAt: T - 3600,
    };
    const a = ret(T);
    const b = ret(T + 60);
    const r = reconcileWaves([legacy], [a, b], T - 1800);
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].id).toBe('w_legacy');
    expect(r.waves[0].memberIds).toEqual([a.id, b.id].sort());
    // Sealed on adoption: it was already scheduled under the old rules, so
    // re-opening it would hand it a second series on the upgrade.
    expect(isWaveCommitted(r.waves[0])).toBe(true);
    expect(r.brandNewDetected).toBe(false);
    expect(r.droppedIds).toEqual([]);
  });

  it('keeps the legacy anchor so the queued slot times do not move', () => {
    /** @type {any} */
    const legacy = {
      id: 'w_legacy', nextWaveAt: T, fleetCount: 1,
      returnAts: [T], origins: [], detectedAt: T - 3600,
    };
    const r = reconcileWaves([legacy], [ret(T)], T - 1800);
    expect(r.waves[0].anchorAt).toBe(T);
  });
});

describe('pruneNotifyState', () => {
  it('drops counters for waves no longer present', () => {
    const state = { w_a: { baseAt: 1 }, w_b: { baseAt: 2 } };
    /** @type {any} */
    const waves = [{ id: 'w_a' }];
    expect(pruneNotifyState(state, waves)).toEqual({ w_a: { baseAt: 1 } });
  });

  it('does not mutate the input', () => {
    const state = { w_a: { baseAt: 1 } };
    pruneNotifyState(state, []);
    expect(state).toEqual({ w_a: { baseAt: 1 } });
  });
});
