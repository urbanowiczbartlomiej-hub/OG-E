// @vitest-environment happy-dom
//
// The durable, self-expiring fleet-save slot-suppression store. Pure folds
// (merge / prune) plus the localStorage-backed read/write/add path.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readFsCancel, writeFsCancel, pruneFsCancel, mergeFsCancel, addFsCancel, fsCancelOffsets,
} from '../../src/features/reminders/fsCancel.js';

const U = 's1';

beforeEach(() => localStorage.clear());

describe('mergeFsCancel (pure)', () => {
  it('adds a new record', () => {
    expect(mergeFsCancel({}, 'a', [-60, 0], 500)).toEqual({ a: { offsets: [-60, 0], expiresAt: 500 } });
  });

  it('unions offsets and keeps the later expiry', () => {
    const m = mergeFsCancel({ a: { offsets: [-60], expiresAt: 500 } }, 'a', [-60, 0, 600], 400);
    expect(m.a.offsets).toEqual([-60, 0, 600]); // -60 not duplicated
    expect(m.a.expiresAt).toBe(500); // later of 500 / 400
  });
});

describe('pruneFsCancel (pure)', () => {
  it('drops records at or before now, keeps the rest', () => {
    const map = { a: { offsets: [0], expiresAt: 100 }, b: { offsets: [0], expiresAt: 200 } };
    expect(pruneFsCancel(map, 150)).toEqual({ b: { offsets: [0], expiresAt: 200 } });
  });
});

describe('read / write / add (localStorage)', () => {
  it('round-trips through localStorage and removes the key when empty', () => {
    writeFsCancel(U, { a: { offsets: [-60], expiresAt: 999 } });
    expect(readFsCancel(U)).toEqual({ a: { offsets: [-60], expiresAt: 999 } });
    writeFsCancel(U, {});
    expect(localStorage.getItem('oge_fsCancel_s1')).toBeNull();
    expect(readFsCancel(U)).toEqual({});
  });

  it('addFsCancel persists, unions, and prunes expired in one pass', () => {
    writeFsCancel(U, { old: { offsets: [0], expiresAt: 50 } }); // already expired at now=100
    addFsCancel(U, 'a', [-60], 1000, 100);
    addFsCancel(U, 'a', [0, 600], 1200, 100);
    const stored = readFsCancel(U);
    expect(stored.old).toBeUndefined(); // pruned
    expect(stored.a.offsets).toEqual([-60, 0, 600]);
    expect(stored.a.expiresAt).toBe(1200);
  });

  it('fsCancelOffsets returns live offsets and self-prunes the store', () => {
    writeFsCancel(U, {
      live: { offsets: [-60, 0], expiresAt: 1000 },
      dead: { offsets: [0], expiresAt: 100 },
    });
    expect(fsCancelOffsets(U, 500)).toEqual({ live: [-60, 0] });
    expect(readFsCancel(U).dead).toBeUndefined(); // pruned back to storage
  });
});
