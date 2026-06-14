// @vitest-environment happy-dom
//
// The durable, self-expiring fleet-save slot-suppression store. Pure folds
// (merge / prune) plus the localStorage-backed read/write/add path.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readFleetSaveCancel, writeFleetSaveCancel, pruneFleetSaveCancel, mergeFleetSaveCancel, addFleetSaveCancel, fleetSaveCancelOffsets,
} from '../../src/features/reminders/fleetSaveCancel.js';

const U = 's1';

beforeEach(() => localStorage.clear());

describe('mergeFleetSaveCancel (pure)', () => {
  it('adds a new record', () => {
    expect(mergeFleetSaveCancel({}, 'a', [-60, 0], 500)).toEqual({ a: { offsets: [-60, 0], expiresAt: 500 } });
  });

  it('unions offsets and keeps the later expiry', () => {
    const m = mergeFleetSaveCancel({ a: { offsets: [-60], expiresAt: 500 } }, 'a', [-60, 0, 600], 400);
    expect(m.a.offsets).toEqual([-60, 0, 600]); // -60 not duplicated
    expect(m.a.expiresAt).toBe(500); // later of 500 / 400
  });
});

describe('pruneFleetSaveCancel (pure)', () => {
  it('drops records at or before now, keeps the rest', () => {
    const map = { a: { offsets: [0], expiresAt: 100 }, b: { offsets: [0], expiresAt: 200 } };
    expect(pruneFleetSaveCancel(map, 150)).toEqual({ b: { offsets: [0], expiresAt: 200 } });
  });
});

describe('read / write / add (localStorage)', () => {
  it('round-trips through localStorage and removes the key when empty', () => {
    writeFleetSaveCancel(U, { a: { offsets: [-60], expiresAt: 999 } });
    expect(readFleetSaveCancel(U)).toEqual({ a: { offsets: [-60], expiresAt: 999 } });
    writeFleetSaveCancel(U, {});
    expect(localStorage.getItem('oge_fsCancel_s1')).toBeNull();
    expect(readFleetSaveCancel(U)).toEqual({});
  });

  it('addFleetSaveCancel persists, unions, and prunes expired in one pass', () => {
    writeFleetSaveCancel(U, { old: { offsets: [0], expiresAt: 50 } }); // already expired at now=100
    addFleetSaveCancel(U, 'a', [-60], 1000, 100);
    addFleetSaveCancel(U, 'a', [0, 600], 1200, 100);
    const stored = readFleetSaveCancel(U);
    expect(stored.old).toBeUndefined(); // pruned
    expect(stored.a.offsets).toEqual([-60, 0, 600]);
    expect(stored.a.expiresAt).toBe(1200);
  });

  it('fleetSaveCancelOffsets returns live offsets and self-prunes the store', () => {
    writeFleetSaveCancel(U, {
      live: { offsets: [-60, 0], expiresAt: 1000 },
      dead: { offsets: [0], expiresAt: 100 },
    });
    expect(fleetSaveCancelOffsets(U, 500)).toEqual({ live: [-60, 0] });
    expect(readFleetSaveCancel(U).dead).toBeUndefined(); // pruned back to storage
  });
});
