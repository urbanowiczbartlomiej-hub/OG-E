// @ts-check

// Pure-command folding for the reload-safe pending-intent queue. The
// localStorage read/write side (readPending/writePending/pushPending) is
// thin over safeLS and exercised in the browser; here we lock the pure
// fold + last-intent helpers.

import { describe, it, expect } from 'vitest';
import {
  applyAdhocCmds, applyWaveCmds, lastAdhocIntent, lastWaveIntent,
} from '../../src/features/reminders/pending.js';

/** @typedef {import('../../src/features/reminders/pending.js').PendingCommand} PendingCommand */

/** @param {string} id @param {Partial<import('../../src/domain/adhoc.js').AdhocReminder>} [o] */
const entry = (id, o = {}) => ({ id, arrivalAt: 2000, label: 'x', ...o });

/** @param {PendingCommand[]} cmds @returns {PendingCommand[]} */
const cmds = (cmds) => cmds;

/** @param {string} id @param {boolean} [cancelled] */
const w = (id, cancelled) => ({
  id, nextWaveAt: 1, fleetCount: 1, returnAts: [1], origins: [],
  ...(cancelled ? { cancelled: true } : {}),
});

describe('applyAdhocCmds', () => {
  it('arm appends a new entry', () => {
    expect(applyAdhocCmds([], cmds([{ kind: 'arm', entry: entry('a') }]))).toEqual([entry('a')]);
  });

  it('arm replaces an existing entry with the same id (re-arm)', () => {
    const before = [entry('a', { arrivalAt: 2000 })];
    const after = applyAdhocCmds(before, cmds([{ kind: 'arm', entry: entry('a', { arrivalAt: 3000 }) }]));
    expect(after).toHaveLength(1);
    expect(after[0].arrivalAt).toBe(3000);
  });

  it('disarm removes by id', () => {
    expect(applyAdhocCmds([entry('a'), entry('b')], cmds([{ kind: 'disarm', id: 'a' }])))
      .toEqual([entry('b')]);
  });

  it('applies a sequence in order (arm then disarm cancels out)', () => {
    expect(applyAdhocCmds([], cmds([
      { kind: 'arm', entry: entry('a') },
      { kind: 'disarm', id: 'a' },
    ]))).toEqual([]);
  });
});

describe('applyWaveCmds', () => {
  it('cancelWave tombstones the matching wave', () => {
    const [out] = applyWaveCmds([w('w1')], cmds([{ kind: 'cancelWave', waveId: 'w1' }]));
    expect(out.cancelled).toBe(true);
  });

  it('resendWave lifts the tombstone', () => {
    const [out] = applyWaveCmds([w('w1', true)], cmds([{ kind: 'resendWave', waveId: 'w1' }]));
    expect(out.cancelled).toBe(false);
  });

  it('leaves other waves untouched', () => {
    const out = applyWaveCmds([w('w1'), w('w2')], cmds([{ kind: 'cancelWave', waveId: 'w1' }]));
    expect(out[1].cancelled).toBeUndefined();
  });
});

describe('lastAdhocIntent / lastWaveIntent', () => {
  it('returns the latest intent for an id, ignoring others', () => {
    const list = cmds([
      { kind: 'arm', entry: entry('a') },
      { kind: 'arm', entry: entry('b') },
      { kind: 'disarm', id: 'a' },
    ]);
    expect(lastAdhocIntent(list, 'a')).toBe('disarm');
    expect(lastAdhocIntent(list, 'b')).toBe('arm');
    expect(lastAdhocIntent(list, 'c')).toBeNull();
  });

  it('tracks the latest wave intent', () => {
    const list = cmds([
      { kind: 'cancelWave', waveId: 'w1' },
      { kind: 'resendWave', waveId: 'w1' },
    ]);
    expect(lastWaveIntent(list, 'w1')).toBe('resendWave');
    expect(lastWaveIntent(list, 'w2')).toBeNull();
  });
});
