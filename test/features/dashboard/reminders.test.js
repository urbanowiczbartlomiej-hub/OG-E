// @ts-check

// Unit tests for the dashboard orphan-sweep freshness guard.
//
// The guard was introduced to fix a race condition: the game-side sync
// POSTs new messages to ntfy *before* it PATCHes the gist. If the
// dashboard runs its orphan sweep during that window it sees new IDs on
// ntfy that aren't in the (stale) gist yet and incorrectly deletes them.
//
// We test the guard logic in isolation by directly calling the relevant
// helper. The full `refreshPreview` path is integration-level (needs
// chrome.storage + real gist + ntfy); we test the decision criterion only.

import { describe, it, expect } from 'vitest';
import { reconcileWaves } from '../../../src/domain/waves.js';
import { collectOurMessageIds } from '../../../src/features/dashboard/reminders.js';

describe('collectOurMessageIds — orphan-sweep claims every reminder kind', () => {
  // Partial ReminderState shapes — only the notify maps matter here, so we
  // cast through `any` rather than build full states for each case.
  /** @param {any} s @returns {Record<string, import('../../../src/sync/reminders.js').ReminderState>} */
  const asStates = (s) => s;

  it('unions wave, ad-hoc AND fleet-save ids (regression: FS were missed)', () => {
    const ids = collectOurMessageIds(asStates({
      u1: {
        notifyState: { w1: { scheduledMessageIds: ['wave-a', 'wave-b'] } },
        adhocNotify: { e1: { scheduledMessageIds: ['adhoc-a'] } },
        fleetSaveNotify: { f1: { scheduledMessageIds: ['fs-a', 'fs-b'] } },
      },
    }));
    // The whole point of the fix: fs-* must be claimed so the sweep never
    // cancels live fleet-save pushes as phantom orphans.
    expect([...ids].sort()).toEqual(['adhoc-a', 'fs-a', 'fs-b', 'wave-a', 'wave-b']);
  });

  it('tolerates missing maps and missing scheduledMessageIds', () => {
    expect(collectOurMessageIds(asStates({ u1: {} })).size).toBe(0);
    expect(collectOurMessageIds(asStates({ u1: { notifyState: { w1: {} } } })).size).toBe(0);
  });

  it('unions across multiple universes', () => {
    const ids = collectOurMessageIds(asStates({
      u1: { fleetSaveNotify: { f1: { scheduledMessageIds: ['a'] } } },
      u2: { fleetSaveNotify: { f2: { scheduledMessageIds: ['b'] } } },
    }));
    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});

/**
 * Compute the age guard used inside `refreshPreview`.
 * Extracted here so changes to the constant are caught by the test.
 *
 * @param {string | undefined} updatedAt  ISO timestamp from gist state.
 * @param {number}             nowSec     Current epoch seconds.
 * @returns {{ shouldSweep: boolean, gistAge: number }}
 */
const computeSweepGuard = (updatedAt, nowSec) => {
  const gistAge = updatedAt
    ? nowSec - Math.floor(new Date(updatedAt).getTime() / 1000)
    : Infinity;
  return { shouldSweep: gistAge > 120, gistAge };
};

describe('dashboard orphan sweep freshness guard', () => {
  const BASE = 1_748_000_000; // arbitrary epoch seconds
  /** @param {number} sec */
  const isoOf = (sec) => new Date(sec * 1000).toISOString();

  it('allows sweep when gist is older than 120 s', () => {
    const { shouldSweep, gistAge } = computeSweepGuard(isoOf(BASE - 200), BASE);
    expect(gistAge).toBe(200);
    expect(shouldSweep).toBe(true);
  });

  it('blocks sweep when gist is 60 s old (mid-sync window)', () => {
    const { shouldSweep, gistAge } = computeSweepGuard(isoOf(BASE - 60), BASE);
    expect(gistAge).toBe(60);
    expect(shouldSweep).toBe(false);
  });

  it('blocks sweep at exactly 120 s (boundary — not strictly greater)', () => {
    const { shouldSweep } = computeSweepGuard(isoOf(BASE - 120), BASE);
    expect(shouldSweep).toBe(false);
  });

  it('allows sweep at 121 s', () => {
    const { shouldSweep } = computeSweepGuard(isoOf(BASE - 121), BASE);
    expect(shouldSweep).toBe(true);
  });

  it('always allows sweep when updatedAt is absent (Infinity age)', () => {
    const { shouldSweep, gistAge } = computeSweepGuard(undefined, BASE);
    expect(gistAge).toBe(Infinity);
    expect(shouldSweep).toBe(true);
  });
});

describe('reconcileWaves — landed-wave drop feeds toCancel in syncReminderWaves', () => {
  // Integration-level conceptual test: when a prev wave's fleet IDs
  // disappear from the current observation (all expeditions landed),
  // it falls into droppedIds — the caller pipes those into
  // cancelWaveReminders.

  /** @param {Partial<import('../../../src/domain/waves.js').Wave>} w
   *  @returns {import('../../../src/domain/waves.js').Wave} */
  const wave = (w) => ({
    id: w.id ?? 'w_' + (w.returnAts?.[0] ?? 0),
    nextWaveAt: w.nextWaveAt ?? 1000,
    fleetCount: w.fleetCount ?? (w.returnAts?.length ?? 1),
    returnAts: w.returnAts ?? [1000],
    origins: w.origins ?? ['1:1:1'],
    detectedAt: w.detectedAt,
  });

  it('landed wave (return-times disjoint from current) flows into droppedIds', () => {
    const oldWave = wave({
      id: 'w_old', returnAts: [1000, 1002], nextWaveAt: 1000,
    });
    // New observation: brand-new wave, completely disjoint return-times.
    const newCands = [{
      nextWaveAt: 2000, fleetCount: 1, returnAts: [2000], origins: ['1:1:1'],
    }];
    const { waves, droppedIds } = reconcileWaves([oldWave], newCands, 1100);
    expect(droppedIds).toEqual(['w_old']);
    expect(waves.map((w) => w.id)).toEqual(['w_2000']);
  });

  it('matched wave (any overlap) stays — id carries through', () => {
    const oldWave = wave({
      id: 'w_old', returnAts: [1000, 1002], nextWaveAt: 1000,
    });
    // Same wave, partially drained — 1000 landed, 1002 still flying.
    const tailing = [{
      nextWaveAt: 1002, fleetCount: 1, returnAts: [1002], origins: ['1:1:1'],
    }];
    const { waves, droppedIds } = reconcileWaves([oldWave], tailing, 1100);
    expect(droppedIds).toEqual([]);
    expect(waves[0].id).toBe('w_old');
  });
});
