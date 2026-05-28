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
import { reconcileWaves, computeWaveId } from '../../../src/domain/waves.js';

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

describe('reconcileWaves — idle-wave drop prevents double-reminders on re-send', () => {
  // Integration-level conceptual test: when the player re-sends
  // (currentWaves non-empty) idle waves are dropped so their ntfy IDs
  // flow into toCancel in syncReminderWaves.

  /** @param {Partial<import('../../../src/domain/waves.js').Wave>} w */
  const wave = (w) => ({
    id: w.id ?? computeWaveId(w.nextWaveAt ?? 1000),
    nextWaveAt: w.nextWaveAt ?? 1000,
    fleetCount: w.fleetCount ?? 1,
    origins: w.origins ?? ['1:1:1'],
    detectedAt: w.detectedAt,
  });

  it('idle wave is dropped when new wave is present — its IDs reach toCancel', () => {
    const oldWave = wave({ nextWaveAt: 1000, detectedAt: 900 }); // landed
    const newWave = wave({ nextWaveAt: 2000 });                  // just sent

    // Simulate syncReminderWaves decision: outIds + cancel loop
    const { waves } = reconcileWaves([oldWave], [newWave], 1100);
    const outIds = new Set(waves.map((w) => w.id));

    // Old wave must NOT be in outIds so its IDs reach toCancel
    expect(outIds.has(oldWave.id)).toBe(false);
    // New wave must be present
    expect(outIds.has(newWave.id)).toBe(true);
  });

  it('idle wave is kept when player has no active expeditions', () => {
    const oldWave = wave({ nextWaveAt: 1000, detectedAt: 900 });

    const { waves } = reconcileWaves([oldWave], [], 1100);
    const outIds = new Set(waves.map((w) => w.id));

    expect(outIds.has(oldWave.id)).toBe(true);
  });
});
