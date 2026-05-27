// @ts-check

// Unit tests for the `waves` pure-domain module.
//
// Node env, no DOM, no fake timers — `now` flows in explicitly. The
// fixture mirrors the real event-list capture in `odp.html`: a single
// 14-expedition burst whose return-flight rows land 1779913212..1779913226
// (a ~14 s spread), each from a distinct origin in galaxy 4.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLUSTER_GAP_SECONDS,
  computeWaveId,
  clusterWaves,
  reconcileWaves,
  applyResets,
  pruneNotifyState,
  withinAllowedHours,
} from '../../src/domain/waves.js';

/** One real burst from odp.html (return-flight rows), origin coords g:s:p. */
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
  it('is order-independent (sorts origins)', () => {
    expect(computeWaveId(['4:468:14', '4:467:15'])).toBe(
      computeWaveId(['4:467:15', '4:468:14']),
    );
  });

  it('de-duplicates repeated origins', () => {
    expect(computeWaveId(['4:467:15', '4:467:15'])).toBe('w_4-467-15');
  });

  it('replaces colons and joins with double underscore', () => {
    expect(computeWaveId(['4:467:15', '4:468:14'])).toBe('w_4-467-15__4-468-14');
  });

  it('falls back to fleet ids when no origins are present', () => {
    expect(computeWaveId([], ['b', 'a'])).toBe('wf_a__b');
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
  });

  it('lists sorted, de-duplicated origins', () => {
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
  });

  it('keeps a single wave when gaps stay within the threshold', () => {
    // Five entries each 4 minutes apart: every consecutive gap (240s) is
    // under the 300s default, so a slow-but-continuous send is one wave.
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

  it('drops entries with a non-finite returnAt without poisoning the cluster', () => {
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

  it('stamps detectedAt on a brand-new wave', () => {
    const current = clusterWaves(BURST);
    const { waves, resetIds } = reconcileWaves([], current, NOW);
    expect(waves).toHaveLength(1);
    expect(waves[0].detectedAt).toBe(NOW);
    expect(resetIds).toEqual([]);
  });

  it('keeps an idle wave that vanished from the event list', () => {
    // Fleet landed and is idle → its return row is gone, current is empty.
    const prev = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    const { waves, resetIds } = reconcileWaves(prev, [], NOW + 100);
    expect(waves).toHaveLength(1);
    expect(waves[0].id).toBe(prev[0].id);
    expect(resetIds).toEqual([]);
  });

  it('detects a re-send (same origins, later return) and flags a reset', () => {
    const prev = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    // Same planets, returns pushed ~16 minutes into the future.
    const resent = clusterWaves(BURST.map((e) => ({ ...e, returnAt: e.returnAt + 1000 })));
    const { waves, resetIds } = reconcileWaves(prev, resent, NOW + 1000);
    expect(waves).toHaveLength(1);
    expect(waves[0].nextWaveAt).toBe(1779913212 + 1000);
    expect(waves[0].detectedAt).toBe(NOW + 1000);
    expect(resetIds).toEqual([prev[0].id]);
  });

  it('preserves detectedAt for an in-flight wave seen again unchanged', () => {
    const prev = reconcileWaves([], clusterWaves(BURST), NOW).waves;
    const { waves, resetIds } = reconcileWaves(prev, clusterWaves(BURST), NOW + 50);
    expect(waves[0].detectedAt).toBe(NOW);
    expect(resetIds).toEqual([]);
  });

  it('tracks two partial waves independently', () => {
    const waveA = [
      { fleetId: 'a', returnAt: 1000, origin: '1:1:1' },
      { fleetId: 'b', returnAt: 1003, origin: '1:2:1' },
    ];
    const waveB = [
      { fleetId: 'c', returnAt: 1900, origin: '1:3:1' },
      { fleetId: 'd', returnAt: 1903, origin: '1:4:1' },
    ];
    const prev = reconcileWaves([], clusterWaves([...waveA, ...waveB]), NOW).waves;
    expect(prev).toHaveLength(2);
    // Wave A re-sent (later), wave B still in flight unchanged.
    const resentA = waveA.map((e) => ({ ...e, returnAt: e.returnAt + 5000 }));
    const current = clusterWaves([...resentA, ...waveB]);
    const { waves, resetIds } = reconcileWaves(prev, current, NOW + 5000);
    expect(waves).toHaveLength(2);
    expect(resetIds).toHaveLength(1);
  });

  it('returns waves sorted by nextWaveAt', () => {
    const mixed = [
      { fleetId: 'late', returnAt: 9000, origin: '1:9:1' },
      { fleetId: 'early', returnAt: 1000, origin: '1:1:1' },
    ];
    const { waves } = reconcileWaves([], clusterWaves(mixed), NOW);
    expect(waves[0].nextWaveAt).toBeLessThan(waves[1].nextWaveAt);
  });
});

describe('applyResets', () => {
  it('zeroes only the listed ids and leaves others untouched', () => {
    const state = {
      a: { notifyCount: 3, lastNotifiedAt: 100 },
      b: { notifyCount: 5, lastNotifiedAt: 200 },
    };
    const next = applyResets(state, ['a']);
    expect(next.a).toEqual({ notifyCount: 0, lastNotifiedAt: null });
    expect(next.b).toEqual({ notifyCount: 5, lastNotifiedAt: 200 });
  });

  it('does not mutate the input', () => {
    const state = { a: { notifyCount: 3, lastNotifiedAt: 100 } };
    applyResets(state, ['a']);
    expect(state.a.notifyCount).toBe(3);
  });
});

describe('pruneNotifyState', () => {
  it('drops counters for waves no longer present', () => {
    const state = {
      keep: { notifyCount: 1, lastNotifiedAt: 10 },
      drop: { notifyCount: 2, lastNotifiedAt: 20 },
    };
    const waves = [{ id: 'keep', nextWaveAt: 0, fleetCount: 1, origins: [] }];
    const next = pruneNotifyState(state, waves);
    expect(Object.keys(next)).toEqual(['keep']);
  });
});

describe('withinAllowedHours', () => {
  /** @param {number} h @param {number} [m] @returns {number} */
  const at = (h, m = 0) => h * 60 + m;

  it('treats start === end as no restriction', () => {
    expect(withinAllowedHours(at(3), '00:00', '00:00')).toBe(true);
  });

  it('handles a normal daytime window', () => {
    expect(withinAllowedHours(at(7, 59), '08:00', '23:00')).toBe(false);
    expect(withinAllowedHours(at(8, 0), '08:00', '23:00')).toBe(true);
    expect(withinAllowedHours(at(22, 59), '08:00', '23:00')).toBe(true);
    expect(withinAllowedHours(at(23, 0), '08:00', '23:00')).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(withinAllowedHours(at(23), '22:00', '06:00')).toBe(true);
    expect(withinAllowedHours(at(2), '22:00', '06:00')).toBe(true);
    expect(withinAllowedHours(at(6), '22:00', '06:00')).toBe(false);
    expect(withinAllowedHours(at(12), '22:00', '06:00')).toBe(false);
  });
});
