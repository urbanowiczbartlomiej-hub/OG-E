// @ts-check

// Unit tests for the `waves` pure-domain module.
//
// Node env, no DOM, no fake timers — `now` flows in explicitly. The
// burst fixture mirrors the real event-list capture in `odp.html`: a
// 14-expedition burst with returns spread over ~14 s from distinct
// galaxy-4 planets.
//
// v1.3.1 identity model: a wave is identified by its `nextWaveAt`.
// Two scans with `nextWaveAt` within `gapSeconds` of each other are
// the same wave. Origin-set, fleet count, etc. are kept for display
// but no longer participate in identity. See `src/domain/waves.js`
// header for the rationale.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLUSTER_GAP_SECONDS,
  STALE_WAVE_AFTER_SEC,
  computeWaveId,
  clusterWaves,
  reconcileWaves,
  applyRenames,
  applyResets,
  pruneNotifyState,
} from '../../src/domain/waves.js';

/** One real burst from odp.html (return-flight rows). */
const BURST = [
  { fleetId: '141279718', returnAt: 1779913212, origin: '4:467:15' },
  { fleetId: '141279726', returnAt: 1779913216, origin: '4:468:14' },
  { fleetId: '141279723', returnAt: 1779913218, origin: '4:469:15' },
  { fleetId: '141279744', returnAt: 1779913220, origin: '4:470:14' },
  { fleetId: '141279739', returnAt: 1779913222, origin: '4:471:15' },
  { fleetId: '141279750', returnAt: 1779913222, origin: '4:472:15' },
  { fleetId: '141279756', returnAt: 1779913224, origin: '4:473:15' },
  { fleetId: '141279764', returnAt: 1779913226, origin: '4:474:15' },
];

describe('computeWaveId', () => {
  it('is a function of nextWaveAt only', () => {
    expect(computeWaveId(1779913212)).toBe('w_1779913212');
  });

  it('two equal timestamps map to the same id', () => {
    expect(computeWaveId(1779913212)).toBe(computeWaveId(1779913212));
  });

  it('fractional seconds are floored — gist file is plain JSON, no float ids', () => {
    expect(computeWaveId(1779913212.7)).toBe('w_1779913212');
  });
});

describe('clusterWaves', () => {
  it('collapses one tight burst into a single wave', () => {
    const waves = clusterWaves(BURST);
    expect(waves).toHaveLength(1);
    expect(waves[0].fleetCount).toBe(8);
  });

  it('uses the EARLIEST return as nextWaveAt', () => {
    const [wave] = clusterWaves(BURST);
    expect(wave.nextWaveAt).toBe(1779913212);
    expect(wave.id).toBe('w_1779913212');
  });

  it('lists sorted, de-duplicated origins (display-only field)', () => {
    const [wave] = clusterWaves(BURST);
    expect(wave.origins).toEqual([
      '4:467:15', '4:468:14', '4:469:15', '4:470:14',
      '4:471:15', '4:472:15', '4:473:15', '4:474:15',
    ]);
  });

  it('splits a partial send (15-minute gap) into two independent waves', () => {
    const partial = [
      { fleetId: 'a', returnAt: 1000, origin: '1:1:1' },
      { fleetId: 'b', returnAt: 1003, origin: '1:2:1' },
      // ~15 min later
      { fleetId: 'c', returnAt: 1000 + 900, origin: '1:3:1' },
      { fleetId: 'd', returnAt: 1000 + 903, origin: '1:4:1' },
    ];
    const waves = clusterWaves(partial);
    expect(waves).toHaveLength(2);
    expect(waves[0].nextWaveAt).toBe(1000);
    expect(waves[1].nextWaveAt).toBe(1900);
    expect(waves[0].id).not.toBe(waves[1].id);
  });

  it('keeps a single wave when gaps stay within the threshold', () => {
    const slow = [0, 240, 480, 720, 960].map((d, i) => ({
      fleetId: 'f' + i, returnAt: 5000 + d, origin: `2:${i}:1`,
    }));
    expect(clusterWaves(slow)).toHaveLength(1);
  });

  it('honours a custom gapSeconds', () => {
    const two = [
      { fleetId: 'a', returnAt: 0, origin: '1:1:1' },
      { fleetId: 'b', returnAt: 60, origin: '1:2:1' },
    ];
    expect(clusterWaves(two, { gapSeconds: 30 })).toHaveLength(2);
    expect(clusterWaves(two, { gapSeconds: 120 })).toHaveLength(1);
  });

  it('drops entries with a non-finite returnAt', () => {
    const dirty = [
      { fleetId: 'a', returnAt: 1000, origin: '1:1:1' },
      { fleetId: 'b', returnAt: NaN, origin: '1:2:1' },
    ];
    const waves = clusterWaves(dirty);
    expect(waves).toHaveLength(1);
    expect(waves[0].fleetCount).toBe(1);
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

  /** @param {Partial<import('../../src/domain/waves.js').Wave>} w @returns {import('../../src/domain/waves.js').Wave} */
  const wave = (w) => ({
    id: w.id ?? computeWaveId(w.nextWaveAt ?? NOW),
    nextWaveAt: w.nextWaveAt ?? NOW,
    fleetCount: w.fleetCount ?? 1,
    origins: w.origins ?? ['1:1:1'],
    detectedAt: w.detectedAt,
  });

  it('stamps detectedAt on a brand-new wave', () => {
    const current = clusterWaves(BURST);
    const { waves, resetIds, renames } = reconcileWaves([], current, NOW);
    expect(waves).toHaveLength(1);
    expect(waves[0].detectedAt).toBe(NOW);
    expect(resetIds).toEqual([]);
    expect(renames).toEqual({});
  });

  it('keeps an idle wave that vanished from the event list', () => {
    const prev = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    const { waves, resetIds } = reconcileWaves(prev, [], NOW + 100);
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe(prev[0].id);
    expect(resetIds).toEqual([]);
  });

  it('matches two scans of the same wave within tolerance (no drift)', () => {
    const prev = [wave({ nextWaveAt: NOW, detectedAt: NOW - 100 })];
    const cur = [wave({ nextWaveAt: NOW })];
    const { waves, resetIds, renames } = reconcileWaves(prev, cur, NOW + 50);
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe(prev[0].id);
    expect(waves[0].detectedAt).toBe(NOW - 100);
    expect(resetIds).toEqual([]);
    expect(renames).toEqual({});
  });

  it('matches with small drift and emits a rename so notifyState carries', () => {
    // A DOM blink dropped the original earliest fleet for one scan, so
    // cluster now picks the next-earliest return — id drifts by 4 s.
    const prev = [wave({ nextWaveAt: 1000, detectedAt: 900 })];
    const cur = [wave({ nextWaveAt: 1004 })];
    const { waves, renames } = reconcileWaves(prev, cur, 1100);
    expect(waves).toHaveLength(1);
    expect(waves[0].nextWaveAt).toBe(1004);
    expect(waves[0].detectedAt).toBe(900);
    expect(renames).toEqual({ w_1000: 'w_1004' });
  });

  it('treats a wave whose nextWaveAt jumped past gapSeconds as brand-new', () => {
    // The user re-sent: same planets, completely new cycle 16 min later.
    // Under v1.3.1 pure-time identity that's a NEW wave with a new id;
    // the old prev wave hangs around as idle until it goes stale.
    const prev = [wave({ nextWaveAt: 1000, detectedAt: 900 })];
    const cur = [wave({ nextWaveAt: 1000 + 960 })]; // 16 min later
    const { waves, renames, resetIds } = reconcileWaves(prev, cur, 1100);
    expect(waves).toHaveLength(2);
    expect(waves[0].nextWaveAt).toBe(1000);     // prev kept as idle
    expect(waves[1].nextWaveAt).toBe(1960);     // new wave
    expect(renames).toEqual({});
    expect(resetIds).toEqual([]);
  });

  it('drops idle prev waves older than STALE_WAVE_AFTER_SEC', () => {
    // A wave whose return time + the full reminder window has elapsed
    // is dead — all ntfy.sh messages have fired. No point keeping it.
    const ancient = wave({ nextWaveAt: 1000, detectedAt: 900 });
    const { waves } = reconcileWaves([ancient], [], 1000 + STALE_WAVE_AFTER_SEC + 1);
    expect(waves).toHaveLength(0);
  });

  it('keeps an idle prev wave that is past return but inside the stale window', () => {
    const recent = wave({ nextWaveAt: 1000, detectedAt: 900 });
    const { waves } = reconcileWaves([recent], [], 1000 + 1000);
    expect(waves).toHaveLength(1);
  });

  it('returns waves sorted by nextWaveAt', () => {
    const mixed = [
      { fleetId: 'late', returnAt: 9000, origin: '1:9:1' },
      { fleetId: 'early', returnAt: 1000, origin: '1:1:1' },
    ];
    const { waves } = reconcileWaves([], clusterWaves(mixed), NOW);
    expect(waves[0].nextWaveAt).toBeLessThan(waves[1].nextWaveAt);
  });

  it('matches the best (smallest-diff) prev when several are within tolerance', () => {
    // Two prevs at 1000 and 1100; cur at 1090. Tolerance is 300, both
    // match. The closer one (1100) wins.
    const prevs = [
      wave({ nextWaveAt: 1000, detectedAt: 900, id: 'w_1000' }),
      wave({ nextWaveAt: 1100, detectedAt: 1000, id: 'w_1100' }),
    ];
    const cur = [wave({ nextWaveAt: 1090 })];
    const { waves, renames } = reconcileWaves(prevs, cur, 1100);
    // Cur consumes the 1100 prev (closer), 1000 stays idle.
    expect(waves).toHaveLength(2);
    expect(renames).toEqual({ w_1100: 'w_1090' });
  });
});

describe('applyRenames', () => {
  it('moves entries to their new ids', () => {
    const state = { old1: { scheduledMessageIds: ['m1', 'm2'] } };
    const next = applyRenames(state, { old1: 'new1' });
    expect(next).toEqual({ new1: { scheduledMessageIds: ['m1', 'm2'] } });
  });

  it('does not clobber an existing new-id entry', () => {
    const state = {
      old1: { scheduledMessageIds: ['old'] },
      new1: { scheduledMessageIds: ['keep'] },
    };
    const next = applyRenames(state, { old1: 'new1' });
    expect(next.new1).toEqual({ scheduledMessageIds: ['keep'] });
    expect(next.old1).toBeUndefined();
  });

  it('is a no-op for renames whose old id is absent', () => {
    const state = { keep: { scheduledMessageIds: ['m1'] } };
    const next = applyRenames(state, { ghost: 'phantom' });
    expect(next).toEqual(state);
  });
});

describe('applyResets', () => {
  it('drops only the listed ids and leaves others untouched', () => {
    const state = {
      a: { scheduledMessageIds: ['m1', 'm2'] },
      b: { scheduledMessageIds: ['m3'] },
    };
    const next = applyResets(state, ['a']);
    expect(next.a).toBeUndefined();
    expect(next.b).toEqual({ scheduledMessageIds: ['m3'] });
  });

  it('is a no-op for unknown ids', () => {
    const state = { a: { scheduledMessageIds: ['m1'] } };
    expect(applyResets(state, ['ghost'])).toEqual(state);
  });
});

describe('pruneNotifyState', () => {
  it('drops counters for waves no longer present', () => {
    const state = {
      keep: { scheduledMessageIds: ['m1'] },
      drop: { scheduledMessageIds: ['m2'] },
    };
    const waves = [{ id: 'keep', nextWaveAt: 0, fleetCount: 1, origins: [] }];
    const next = pruneNotifyState(state, waves);
    expect(Object.keys(next)).toEqual(['keep']);
  });
});
