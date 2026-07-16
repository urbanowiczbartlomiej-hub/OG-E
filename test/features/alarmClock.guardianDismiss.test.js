// @vitest-environment happy-dom
//
// The durable, self-expiring guardian ACK (snooze) store — a
// localStorage-backed per-universe map with the `expiresAt` prune shape.
// Sibling of `./alarmClock.fleetSaveCancel.test.js`. (The DISMISS store that
// used to live alongside it is gone since 1.51.2 — a dismiss is a synced
// tombstone in state/fleetReminders.js; see that module's tests.)
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addGuardianAck,
  guardianAckedLandings,
} from '../../src/features/alarmClock/guardianDismiss.js';

const U = 's1';

beforeEach(() => localStorage.clear());

describe('addGuardianAck / guardianAckedLandings', () => {
  it('returns {} for a missing universe', () => {
    expect(guardianAckedLandings('nope', 100)).toEqual({});
  });

  it('coerces a non-object (array / scalar) stored value to {}', () => {
    localStorage.setItem('oge_guardianAck_s1', JSON.stringify([1, 2, 3]));
    expect(guardianAckedLandings(U, 100)).toEqual({});
    localStorage.setItem('oge_guardianAck_s1', JSON.stringify('whoops'));
    expect(guardianAckedLandings(U, 100)).toEqual({});
  });

  it('add-then-read round-trips under the per-universe key with the ackedAt field', () => {
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

  it('prunes already-expired records in the same add pass', () => {
    addGuardianAck(U, 'old', 10, 50, 1); // expires at 50
    addGuardianAck(U, 'fresh', 200, 5000, 100); // now=100 > 50 → 'old' pruned
    expect(guardianAckedLandings(U, 100)).toEqual({ fresh: 200 });
  });

  it('drops expired entries on list and self-prunes them back to storage', () => {
    addGuardianAck(U, 'live', 100, 5000, 10);
    addGuardianAck(U, 'dead', 100, 1000, 10);
    // now=2000: dead (expiresAt 1000) is gone, live (5000) survives.
    expect(guardianAckedLandings(U, 2000)).toEqual({ live: 100 });
    expect(localStorage.getItem('oge_guardianAck_s1')).not.toBeNull(); // 'live' still there
  });

  it('expiry is exclusive at now (expiresAt === now is pruned)', () => {
    addGuardianAck(U, 'edge', 100, 1000, 10);
    expect(guardianAckedLandings(U, 1000)).toEqual({}); // 1000 > 1000 is false → dropped
  });

  it('removes the storage key entirely once the map empties', () => {
    addGuardianAck(U, 'only', 100, 1000, 10);
    expect(localStorage.getItem('oge_guardianAck_s1')).not.toBeNull();
    guardianAckedLandings(U, 2000); // 'only' expires → map empties → key removed
    expect(localStorage.getItem('oge_guardianAck_s1')).toBeNull();
  });

  it('keeps universes isolated by id', () => {
    addGuardianAck('s1', 'a', 1000, 9000, 100);
    addGuardianAck('s2', 'b', 2000, 9000, 100);
    expect(guardianAckedLandings('s1', 100)).toEqual({ a: 1000 });
    expect(guardianAckedLandings('s2', 100)).toEqual({ b: 2000 });
  });
});
