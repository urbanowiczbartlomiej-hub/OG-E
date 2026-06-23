// @ts-check

// Unit tests for the `waves` pure-domain module.
//
// Node env, no DOM, no fake timers — `now` flows in explicitly. The
// burst fixture mirrors the real event-list capture in `odp.html`: an
// 8-expedition burst with returns spread over ~14 s from distinct
// galaxy-4 planets.
//
// v1.3.2 identity model: a wave is identified by the SET of return-
// time epoch seconds it contains. Two scans match iff their
// `returnAts` sets overlap by ≥1. The `id` field is stamped once at
// brand-new detection (`'w_' + min returnAt at that moment`) and never
// re-derived. See `src/domain/waves.js` header for the rationale.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLUSTER_GAP_SECONDS,
  CLEANUP_GRACE_SEC,
  clusterWaves,
  reconcileWaves,
  pruneNotifyState,
} from '../../src/domain/waves.js';

/** One real burst from odp.html (return-flight rows). */
const BURST = [
  { returnAt: 1779913212, origin: '4:467:15' },
  { returnAt: 1779913216, origin: '4:468:14' },
  { returnAt: 1779913218, origin: '4:469:15' },
  { returnAt: 1779913220, origin: '4:470:14' },
  { returnAt: 1779913222, origin: '4:471:15' },
  { returnAt: 1779913223, origin: '4:472:15' }, // shifted +1s so no collision with prev
  { returnAt: 1779913224, origin: '4:473:15' },
  { returnAt: 1779913226, origin: '4:474:15' },
];

describe('clusterWaves', () => {
  it('collapses one tight burst into a single candidate', () => {
    const cands = clusterWaves(BURST);
    expect(cands).toHaveLength(1);
    expect(cands[0].fleetCount).toBe(8);
  });

  it('candidates have no id — id is stamped only by reconcileWaves', () => {
    const cands = clusterWaves(BURST);
    expect(/** @type {any} */ (cands[0]).id).toBeUndefined();
  });

  it('uses the EARLIEST return as nextWaveAt', () => {
    const [c] = clusterWaves(BURST);
    expect(c.nextWaveAt).toBe(1779913212);
  });

  it('collects sorted unique returnAts', () => {
    const [c] = clusterWaves(BURST);
    expect(c.returnAts).toEqual([
      1779913212, 1779913216, 1779913218, 1779913220,
      1779913222, 1779913223, 1779913224, 1779913226,
    ]);
  });

  it('deduplicates returnAts when two fleets share an epoch second; fleetCount tracks the true count', () => {
    const collision = [
      { returnAt: 1000, origin: '1:1:1' },
      { returnAt: 1000, origin: '1:2:1' }, // same second, different planet
      { returnAt: 1004, origin: '1:3:1' },
    ];
    const [c] = clusterWaves(collision);
    expect(c.returnAts).toEqual([1000, 1004]); // set semantics
    expect(c.fleetCount).toBe(3);              // true count preserved
  });

  it('lists sorted, de-duplicated origins (display-only field)', () => {
    const [c] = clusterWaves(BURST);
    expect(c.origins).toEqual([
      '4:467:15', '4:468:14', '4:469:15', '4:470:14',
      '4:471:15', '4:472:15', '4:473:15', '4:474:15',
    ]);
  });

  it('splits a partial send (15-minute gap) into two candidates', () => {
    const partial = [
      { returnAt: 1000, origin: '1:1:1' },
      { returnAt: 1003, origin: '1:2:1' },
      // ~15 min later
      { returnAt: 1000 + 900, origin: '1:3:1' },
      { returnAt: 1000 + 903, origin: '1:4:1' },
    ];
    const cands = clusterWaves(partial);
    expect(cands).toHaveLength(2);
    expect(cands[0].nextWaveAt).toBe(1000);
    expect(cands[1].nextWaveAt).toBe(1900);
  });

  it('keeps a single candidate when gaps stay within the threshold', () => {
    const slow = [0, 240, 480, 720, 960].map((d, i) => ({
      returnAt: 5000 + d, origin: `2:${i}:1`,
    }));
    expect(clusterWaves(slow)).toHaveLength(1);
  });

  it('honours a custom gapSeconds', () => {
    const two = [
      { returnAt: 0, origin: '1:1:1' },
      { returnAt: 60, origin: '1:2:1' },
    ];
    expect(clusterWaves(two, { gapSeconds: 30 })).toHaveLength(2);
    expect(clusterWaves(two, { gapSeconds: 120 })).toHaveLength(1);
  });

  it('drops entries with a non-finite returnAt', () => {
    const dirty = [
      { returnAt: 1000, origin: '1:1:1' },
      { returnAt: NaN, origin: '1:2:1' },
    ];
    const cands = clusterWaves(dirty);
    expect(cands).toHaveLength(1);
    expect(cands[0].fleetCount).toBe(1);
  });

  it('exposes the default gap as a documented constant', () => {
    expect(DEFAULT_CLUSTER_GAP_SECONDS).toBe(300);
  });

  it('does not mutate its input', () => {
    const input = BURST.slice();
    const snapshot = JSON.stringify(input);
    clusterWaves(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('reconcileWaves', () => {
  const NOW = 1779913000;

  /** @param {Partial<import('../../src/domain/waves.js').Wave>} w
   *  @returns {import('../../src/domain/waves.js').Wave} */
  const wave = (w) => ({
    id: w.id ?? 'w_' + (w.returnAts?.[0] ?? 0),
    nextWaveAt: w.nextWaveAt ?? NOW + 5400,
    fleetCount: w.fleetCount ?? (w.returnAts?.length ?? 1),
    returnAts: w.returnAts ?? [NOW + 5400],
    origins: w.origins ?? ['1:1:1'],
    detectedAt: w.detectedAt,
  });

  it('stamps brand-new id from min returnAt and sets detectedAt = now', () => {
    const cands = clusterWaves(BURST);
    const { waves, droppedIds, brandNewDetected } = reconcileWaves([], cands, NOW);
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe('w_1779913212');         // smallest return-time
    expect(waves[0].detectedAt).toBe(NOW);
    expect(droppedIds).toEqual([]);
    expect(brandNewDetected).toBe(true);
  });

  it('matches across scans by return-time overlap and KEEPS the original id', () => {
    // First scan stamps the id. Second scan has the same fleets minus
    // a couple that landed — overlap is still strong, so the id is
    // carried unchanged.
    const first = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    const drained = BURST.slice(2); // first two landed
    const { waves, droppedIds, brandNewDetected } = reconcileWaves(
      first, clusterWaves(drained), NOW + 60,
    );
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe(first[0].id);            // identity carried
    expect(waves[0].fleetCount).toBe(6);
    expect(waves[0].detectedAt).toBe(NOW);            // detectedAt carried
    expect(droppedIds).toEqual([]);
    expect(brandNewDetected).toBe(false);
  });

  it('id does NOT shift when the smallest live return lands and disappears', () => {
    // The wave is born with min returnAt 1779913212. That one lands first,
    // so the smallest LIVE return becomes 1779913216. The wave's id must
    // remain w_1779913212 (stamped at birth) — overlap matching is what
    // ties identity, not min(returnAts) on every scan.
    const first = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    const withoutSmallest = BURST.filter((e) => e.returnAt !== 1779913212);
    const { waves } = reconcileWaves(first, clusterWaves(withoutSmallest), NOW + 60);
    expect(waves[0].id).toBe('w_1779913212');
  });

  it('re-send (zero overlap) is detected as a brand-new wave', () => {
    const first = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    // New burst — completely fresh return-times 1.5 h later.
    const resend = BURST.map((e) => ({
      returnAt: e.returnAt + 5400,                    // disjoint pool
      origin: e.origin,
    }));
    const { waves, brandNewDetected } = reconcileWaves(
      first, clusterWaves(resend), NOW + 5400,
    );
    expect(brandNewDetected).toBe(true);
    expect(waves.map((w) => w.id)).toEqual(['w_' + (1779913212 + 5400)]);
  });

  it('cleanup: brand-new TOMBSTONES (does not drop) matched waves whose first alarmClock is past or imminent', () => {
    // Old wave has nextWaveAt = now - 5s (first alarmClock already fired
    // a few seconds ago, remaining ones queued at +10/20/30/40/50 min).
    // Player re-sends → brand-new appears → old wave is tombstoned, NOT
    // removed: its fleets are still in flight, so removing it would let
    // the next scan re-cluster the same returns into a brand-new wave.
    const oldWave = wave({
      id: 'w_old', returnAts: [NOW + 10, NOW + 12], nextWaveAt: NOW - 5,
    });
    const oldStillVisible = [
      { returnAt: NOW + 10, origin: '1:1:1' },
      { returnAt: NOW + 12, origin: '1:2:1' },
    ];
    const resend = [
      { returnAt: NOW + 5400, origin: '1:1:1' },
      { returnAt: NOW + 5402, origin: '1:2:1' },
    ];
    const cands = clusterWaves([...oldStillVisible, ...resend]);
    const { waves, droppedIds, brandNewDetected } = reconcileWaves(
      [oldWave], cands, NOW,
    );
    expect(brandNewDetected).toBe(true);
    // Old wave is NOT dropped — it is tombstoned and kept in the set so
    // the caller (liveForNtfy = waves.filter(!cancelled)) sweeps its
    // queued messages while it can never be re-detected as brand-new.
    expect(droppedIds).toEqual([]);
    const old = waves.find((w) => w.id === 'w_old');
    expect(old).toBeDefined();
    expect(old?.cancelled).toBe(true);
    // Brand-new wave is present and live (not cancelled).
    const fresh = waves.find((w) => w.id === 'w_' + (NOW + 5400));
    expect(fresh).toBeDefined();
    expect(fresh?.cancelled).toBeUndefined();
  });

  it('cleanup tombstone survives the next scan — a partially-landed swept wave is NOT resurrected', () => {
    // The bug this guards: cleanup used to DROP the near-term wave. But
    // its fleets are still in flight, so the next scan re-clustered the
    // same return-times, found no matching prev wave, and stamped them
    // brand-new — queuing a fresh six-alarmClock schedule for a wave the
    // player had already re-sent past. Tombstoning keeps the wave in the
    // set so overlap-matching carries `cancelled` forward instead.
    const oldWave = wave({
      id: 'w_old',
      returnAts: [NOW + 10, NOW + 200, NOW + 260],
      nextWaveAt: NOW + 10,
    });
    const oldVisible1 = [
      { returnAt: NOW + 10, origin: '1:1:1' },
      { returnAt: NOW + 200, origin: '1:2:1' },
      { returnAt: NOW + 260, origin: '1:3:1' },
    ];
    const resend = [{ returnAt: NOW + 5400, origin: '1:1:1' }];

    // Scan 1: re-send detected → old wave tombstoned, kept in the set.
    const scan1 = reconcileWaves(
      [oldWave], clusterWaves([...oldVisible1, ...resend]), NOW,
    ).waves;
    expect(scan1.find((w) => w.id === 'w_old')?.cancelled).toBe(true);

    // Scan 2: NOW+10 fleet landed; NOW+200 and NOW+260 still in flight.
    const oldVisible2 = [
      { returnAt: NOW + 200, origin: '1:2:1' },
      { returnAt: NOW + 260, origin: '1:3:1' },
    ];
    const { waves, brandNewDetected } = reconcileWaves(
      scan1, clusterWaves([...oldVisible2, ...resend]), NOW + 15,
    );
    // The still-flying remainder matches w_old (overlap) — NOT brand-new.
    expect(brandNewDetected).toBe(false);
    const old = waves.find((w) => w.id === 'w_old');
    expect(old).toBeDefined();
    expect(old?.cancelled).toBe(true);
    // Only the genuine re-send wave is live; no resurrected schedule.
    expect(waves.filter((w) => w.cancelled !== true).map((w) => w.id))
      .toEqual(['w_' + (NOW + 5400)]);
  });

  it('cleanup: matched wave whose first alarmClock is still > 60s away is KEPT', () => {
    const oldReturn = NOW + 300;
    const oldWave = wave({
      id: 'w_old', returnAts: [oldReturn], nextWaveAt: oldReturn,
    });
    const oldStillVisible = [{ returnAt: oldReturn, origin: '1:1:1' }];
    const resend = [{ returnAt: NOW + 5400, origin: '1:1:1' }];
    const { waves, droppedIds } = reconcileWaves(
      [oldWave], clusterWaves([...oldStillVisible, ...resend]), NOW,
    );
    // Both kept — old still in flight (matched, id 'w_old'), new is
    // brand-new (stamped from its smallest return-time). Cleanup did
    // NOT sweep old because nextWaveAt > now + 60s.
    expect(waves.map((w) => w.id).sort()).toEqual(['w_' + (NOW + 5400), 'w_old']);
    expect(droppedIds).toEqual([]);
  });

  it('unmatched prev waves are dropped — landed → droppedIds carries them for cancellation', () => {
    const oldWave = wave({
      id: 'w_old', returnAts: [NOW + 10, NOW + 12], nextWaveAt: NOW - 10,
    });
    // All returns landed. Current observation is a brand-new wave.
    const resend = [{ returnAt: NOW + 5400, origin: '1:1:1' }];
    const { waves, droppedIds } = reconcileWaves(
      [oldWave], clusterWaves(resend), NOW,
    );
    expect(waves.map((w) => w.id)).toEqual(['w_' + (NOW + 5400)]);
    expect(droppedIds).toEqual(['w_old']);
  });

  it('empty current — every prev becomes droppedIds (no overlap possible)', () => {
    const oldWave = wave({
      id: 'w_old', returnAts: [NOW + 1000], nextWaveAt: NOW + 1000,
    });
    const { waves, droppedIds } = reconcileWaves([oldWave], [], NOW);
    expect(waves).toEqual([]);
    expect(droppedIds).toEqual(['w_old']);
  });

  it('returns waves sorted by nextWaveAt', () => {
    const mixed = [
      { returnAt: 9000, origin: '1:9:1' },
      { returnAt: 1000, origin: '1:1:1' },
    ];
    const { waves } = reconcileWaves([], clusterWaves(mixed), NOW);
    expect(waves[0].nextWaveAt).toBeLessThan(waves[1].nextWaveAt);
  });

  it('long page-reload gap: same returns, big nextWaveAt drift — still SAME wave', () => {
    // The bug v1.3.1 had: between snapshots, nextWaveAt drifted past
    // the 300 s tolerance (e.g. last fleet about to land 15 min after
    // gist was last written). Pure-time identity flipped to brand-new
    // and stacked a second schedule. Under return-time-set identity
    // the overlap (one shared timestamp is enough) holds → SAME wave.
    const prev = wave({
      id: 'w_orig', returnAts: [NOW, NOW + 5, NOW + 1200], nextWaveAt: NOW,
      detectedAt: NOW - 60,
    });
    // Only the late expedition still in flight, returning 20 minutes
    // later than the original `nextWaveAt`. Two earlier returns
    // already landed during the reload window.
    const tailing = [{ returnAt: NOW + 1200, origin: '1:1:1' }];
    const { waves, brandNewDetected } = reconcileWaves(
      [prev], clusterWaves(tailing), NOW,
    );
    expect(brandNewDetected).toBe(false);
    expect(waves[0].id).toBe('w_orig');
    expect(waves[0].detectedAt).toBe(NOW - 60);
  });

  it('CLEANUP_GRACE_SEC is 60 — first-alarmClock window', () => {
    expect(CLEANUP_GRACE_SEC).toBe(60);
  });

  it('cancelled flag carries forward on overlap match', () => {
    // Dashboard tombstoned a wave. The next reconcile (game-side, after
    // the user clicked × in the dashboard) must keep `cancelled: true`
    // so syncAlarmClockWaves doesn't reschedule it.
    const prev = wave({
      id: 'w_orig', returnAts: [NOW + 300, NOW + 350], nextWaveAt: NOW + 300,
    });
    /** @type {import('../../src/domain/waves.js').Wave} */
    const prevCancelled = { ...prev, cancelled: true };
    const stillVisible = [
      { returnAt: NOW + 300, origin: '1:1:1' },
      { returnAt: NOW + 350, origin: '1:1:1' },
    ];
    const { waves } = reconcileWaves(
      [prevCancelled], clusterWaves(stillVisible), NOW,
    );
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe('w_orig');
    expect(waves[0].cancelled).toBe(true);
  });

  it('brand-new wave never starts with cancelled set', () => {
    const cands = clusterWaves(BURST);
    const { waves } = reconcileWaves([], cands, NOW);
    expect(waves[0].cancelled).toBeUndefined();
  });

  it('re-send from same planets after cancel: new id, no cancelled flag', () => {
    // After the user cancels in the Dashboard, the wave eventually
    // lands (returns disappear from the eventList). A fresh re-send
    // from the same planets gets a fresh id; the cancelled tombstone
    // is not inherited.
    const prevCancelled = /** @type {import('../../src/domain/waves.js').Wave} */ ({
      ...wave({ id: 'w_old', returnAts: [NOW + 10], nextWaveAt: NOW + 10 }),
      cancelled: true,
    });
    const resend = [{ returnAt: NOW + 5400, origin: '1:1:1' }];
    const { waves, droppedIds } = reconcileWaves(
      [prevCancelled], clusterWaves(resend), NOW,
    );
    expect(droppedIds).toEqual(['w_old']);
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe('w_' + (NOW + 5400));
    expect(waves[0].cancelled).toBeUndefined();
  });
});

describe('pruneNotifyState', () => {
  it('drops counters for waves no longer present', () => {
    const state = {
      keep: { scheduledMessageIds: ['m1'] },
      drop: { scheduledMessageIds: ['m2'] },
    };
    const waves = [{
      id: 'keep', nextWaveAt: 0, fleetCount: 1, returnAts: [0], origins: [],
    }];
    const next = pruneNotifyState(state, waves);
    expect(Object.keys(next)).toEqual(['keep']);
  });
});
