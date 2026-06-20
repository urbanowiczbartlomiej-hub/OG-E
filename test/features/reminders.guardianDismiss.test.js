// @vitest-environment happy-dom
//
// The durable, self-expiring guardian DISMISS + ACK suppression stores.
// Both are localStorage-backed per-universe maps that share the `expiresAt`
// prune shape. Sibling of `./reminders.fleetSaveCancel.test.js`.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readGuardianDismiss,
  addGuardianDismiss,
  guardianDismissedLandings,
  addGuardianAck,
  guardianAckedLandings,
} from '../../src/features/reminders/guardianDismiss.js';

const U = 's1';

beforeEach(() => localStorage.clear());

describe('readGuardianDismiss', () => {
  it('returns {} for a missing universe', () => {
    expect(readGuardianDismiss('nope')).toEqual({});
  });

  it('coerces a non-object (array / scalar) stored value to {}', () => {
    localStorage.setItem('oge_guardianDismiss_s1', JSON.stringify([1, 2, 3]));
    expect(readGuardianDismiss(U)).toEqual({});
    localStorage.setItem('oge_guardianDismiss_s1', JSON.stringify('whoops'));
    expect(readGuardianDismiss(U)).toEqual({});
  });
});

describe('addGuardianDismiss / guardianDismissedLandings', () => {
  it('add-then-read round-trips under the per-universe key', () => {
    addGuardianDismiss(U, 'p:1:2:3', 1000, 5000, 100);
    expect(readGuardianDismiss(U)).toEqual({ 'p:1:2:3': { landedAt: 1000, expiresAt: 5000 } });
    // Listing projects the record down to `{ bodyKey: landedAt }`.
    expect(guardianDismissedLandings(U, 100)).toEqual({ 'p:1:2:3': 1000 });
  });

  it('re-adding the same bodyKey dedups (no duplicate), updates landedAt, keeps the LATER expiry', () => {
    addGuardianDismiss(U, 'b', 1000, 5000, 100);
    addGuardianDismiss(U, 'b', 2000, 4000, 100); // newer landing, EARLIER expiry
    const stored = readGuardianDismiss(U);
    expect(Object.keys(stored)).toEqual(['b']); // single entry, not duplicated
    expect(stored.b.landedAt).toBe(2000); // landedAt overwritten
    expect(stored.b.expiresAt).toBe(5000); // Math.max keeps the later expiry
  });

  it('re-adding with a LATER expiry advances expiresAt', () => {
    addGuardianDismiss(U, 'b', 1000, 4000, 100);
    addGuardianDismiss(U, 'b', 1000, 9000, 100);
    expect(readGuardianDismiss(U).b.expiresAt).toBe(9000);
  });

  it('prunes already-expired records in the same add pass', () => {
    addGuardianDismiss(U, 'old', 10, 50, 1); // expires at 50
    addGuardianDismiss(U, 'fresh', 200, 5000, 100); // now=100 > 50 → 'old' pruned
    const stored = readGuardianDismiss(U);
    expect(stored.old).toBeUndefined();
    expect(stored.fresh).toEqual({ landedAt: 200, expiresAt: 5000 });
  });

  it('guardianDismissedLandings drops expired entries and self-prunes them back to storage', () => {
    addGuardianDismiss(U, 'live', 100, 5000, 10);
    addGuardianDismiss(U, 'dead', 100, 1000, 10);
    // now=2000: dead (expiresAt 1000) is gone, live (5000) survives.
    expect(guardianDismissedLandings(U, 2000)).toEqual({ live: 100 });
    expect(readGuardianDismiss(U).dead).toBeUndefined(); // pruned back to storage
    expect(readGuardianDismiss(U).live).toBeDefined();
  });

  it('expiry is exclusive at now (expiresAt === now is pruned)', () => {
    addGuardianDismiss(U, 'edge', 100, 1000, 10);
    expect(guardianDismissedLandings(U, 1000)).toEqual({}); // 1000 > 1000 is false → dropped
  });

  it('removes the storage key entirely once the map empties', () => {
    addGuardianDismiss(U, 'only', 100, 1000, 10);
    expect(localStorage.getItem('oge_guardianDismiss_s1')).not.toBeNull();
    guardianDismissedLandings(U, 2000); // 'only' expires → map empties → key removed
    expect(localStorage.getItem('oge_guardianDismiss_s1')).toBeNull();
    expect(guardianDismissedLandings(U, 2000)).toEqual({});
  });
});

describe('addGuardianAck / guardianAckedLandings', () => {
  it('add-then-read round-trips under the distinct ack key with the ackedAt field', () => {
    addGuardianAck(U, 'b', 1500, 6000, 100);
    expect(localStorage.getItem('oge_guardianAck_s1')).not.toBeNull();
    expect(guardianAckedLandings(U, 100)).toEqual({ b: 1500 });
  });

  it('dedups by bodyKey, overwrites ackedAt, and keeps the later expiry', () => {
    addGuardianAck(U, 'b', 1500, 6000, 100);
    addGuardianAck(U, 'b', 3000, 5000, 100); // newer ack, earlier expiry
    expect(guardianAckedLandings(U, 100)).toEqual({ b: 3000 }); // ackedAt advanced
    expect(guardianAckedLandings(U, 5500)).toEqual({ b: 3000 }); // still live (max expiry 6000 > 5500)
  });

  it('prunes expired acks on list and self-cleans storage', () => {
    addGuardianAck(U, 'live', 100, 5000, 10);
    addGuardianAck(U, 'dead', 100, 1000, 10);
    expect(guardianAckedLandings(U, 2000)).toEqual({ live: 100 });
    expect(localStorage.getItem('oge_guardianAck_s1')).not.toBeNull(); // 'live' still there
  });
});

describe('dismiss and ack are independent stores', () => {
  it('writing one does not leak into the other (distinct keys, distinct projections)', () => {
    addGuardianDismiss(U, 'shared', 1000, 9000, 100);
    addGuardianAck(U, 'shared', 2000, 9000, 100);
    // Same bodyKey, different stores → different projected timestamps.
    expect(guardianDismissedLandings(U, 100)).toEqual({ shared: 1000 });
    expect(guardianAckedLandings(U, 100)).toEqual({ shared: 2000 });
    // Distinct backing keys.
    expect(localStorage.getItem('oge_guardianDismiss_s1')).not.toBeNull();
    expect(localStorage.getItem('oge_guardianAck_s1')).not.toBeNull();
  });

  it('keeps universes isolated by id', () => {
    addGuardianDismiss('s1', 'a', 1000, 9000, 100);
    addGuardianDismiss('s2', 'b', 2000, 9000, 100);
    expect(guardianDismissedLandings('s1', 100)).toEqual({ a: 1000 });
    expect(guardianDismissedLandings('s2', 100)).toEqual({ b: 2000 });
  });
});
