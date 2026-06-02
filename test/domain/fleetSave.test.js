// @ts-check

import { describe, it, expect } from 'vitest';
import {
  parseFsOffsets, reconcileFleetSaves, pruneFsNotify, isFleetSaveLeg,
} from '../../src/domain/fleetSave.js';

/**
 * @param {Partial<import('../../src/domain/fleetSave.js').FleetSaveCandidate> & { id: string }} o
 * @returns {import('../../src/domain/fleetSave.js').FleetSaveCandidate}
 */
const cand = (o) => ({
  arrivalAt: 100000,
  shipCount: 150000,
  label: 'Deployment → [4:478:14]',
  ...o,
});

/** Default gate opts: now far before arrival so flight time is long. */
const opts = (over = {}) => ({ threshold: 100000, offsetsSec: [-600, 0, 600], minFlightSec: 600, now: 0, ...over });

describe('parseFsOffsets', () => {
  // Thin signed wrapper over the minutes-first duration grammar (full
  // coverage lives in test/domain/duration.test.js); these just pin the
  // FS-relevant behaviour: signed offsets in seconds, sorted + de-duped.
  it('parses a minutes-first signed list into seconds, de-dupes, sorts', () => {
    expect(parseFsOffsets('-10m, 0m, 10m')).toEqual([-600, 0, 600]);
    expect(parseFsOffsets('10m, 0m, -10m')).toEqual([-600, 0, 600]);
    expect(parseFsOffsets('0m, 0m, 10m, 10m')).toEqual([0, 600]);
  });

  it('keeps negatives (before landing) and mixes units', () => {
    expect(parseFsOffsets('-90s, 0m, 2m')).toEqual([-90, 0, 120]);
  });

  it('yields [] for empty / all-garbage input', () => {
    expect(parseFsOffsets('')).toEqual([]);
    expect(parseFsOffsets('nope')).toEqual([]);
    expect(parseFsOffsets(/** @type {any} */ (undefined))).toEqual([]);
  });
});

describe('isFleetSaveLeg', () => {
  it('treats every RETURN leg as a fleet-save landing', () => {
    for (const m of ['1', '3', '4', '6', '7', '15']) {
      expect(isFleetSaveLeg(m, true)).toBe(true);
    }
  });

  it('treats an OUTBOUND leg as a fleet-save only for one-way missions (4, 7)', () => {
    expect(isFleetSaveLeg('4', false)).toBe(true); // Deployment — fleet stays
    expect(isFleetSaveLeg('7', false)).toBe(true); // Colonisation
  });

  it('skips the OUTBOUND leg of round-trip missions (only the return lands home)', () => {
    for (const m of ['1', '2', '3', '5', '6', '8', '9', '15']) {
      expect(isFleetSaveLeg(m, false)).toBe(false);
    }
  });
});

describe('reconcileFleetSaves', () => {
  it('classifies a brand-new leg at or above the threshold', () => {
    const out = reconcileFleetSaves(
      [],
      [cand({ id: 'a', shipCount: 100000 }), cand({ id: 'b', shipCount: 99999 })],
      opts(),
    );
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('expands offsets to absolute fire times anchored at arrival', () => {
    const [e] = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 100000 })], opts());
    expect(e).toMatchObject({
      id: 'a',
      arrivalAt: 100000,
      shipCount: 150000,
      label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600],
      fireAts: [99400, 100000, 100600],
    });
  });

  it('rejects a NEW short-flight leg (flight time below minFlightSec)', () => {
    // arrival in 5 min, gate is 10 min → a planet⇄moon hop, not a save.
    const out = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 300 })], opts({ now: 0, minFlightSec: 600 }));
    expect(out).toEqual([]);
  });

  it('accepts a NEW long-flight leg (flight time at/above minFlightSec)', () => {
    const out = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 600 })], opts({ now: 0, minFlightSec: 600 }));
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('LOCKS an already-classified save: keeps it even when now-short, never declassifies', () => {
    // The crucial case: a 6h save observed 2 min before landing. The gate
    // would now reject it (flight time = 120 s < 600 s), but it is already
    // known, so it must be carried forward (so its ntfy is NOT swept).
    const prev = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 21600 })], opts({ now: 0 }));
    expect(prev.map((e) => e.id)).toEqual(['a']);
    const kept = reconcileFleetSaves(prev, [cand({ id: 'a', arrivalAt: 21600 })], opts({ now: 21480 }));
    expect(kept.map((e) => e.id)).toEqual(['a']);
  });

  it('does NOT lock a leg that was never classified (below threshold stays out)', () => {
    const prev = reconcileFleetSaves([], [cand({ id: 'a', shipCount: 50000 })], opts());
    expect(prev).toEqual([]);
    const again = reconcileFleetSaves(prev, [cand({ id: 'a', shipCount: 50000 })], opts({ now: 99000 }));
    expect(again).toEqual([]);
  });

  it('reschedules a locked save whose arrival moved (redirect), refreshing fireAts', () => {
    const prev = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 100000 })], opts());
    const moved = reconcileFleetSaves(prev, [cand({ id: 'a', arrivalAt: 100500 })], opts());
    expect(moved[0]).toMatchObject({ id: 'a', arrivalAt: 100500, fireAts: [99900, 100500, 101100] });
  });

  it('drops a save whose leg vanished (landed / recalled)', () => {
    const prev = reconcileFleetSaves([], [cand({ id: 'a' })], opts());
    expect(reconcileFleetSaves(prev, [], opts())).toEqual([]);
  });

  it('minFlightSec <= 0 disables the flight-time gate', () => {
    const out = reconcileFleetSaves([], [cand({ id: 'a', arrivalAt: 10 })], opts({ now: 0, minFlightSec: 0 }));
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('skips candidates with a non-finite arrival or ship count', () => {
    const out = reconcileFleetSaves(
      [],
      [cand({ id: 'a', arrivalAt: NaN }), cand({ id: 'b', shipCount: NaN })],
      opts({ threshold: 1 }),
    );
    expect(out).toEqual([]);
  });
});

describe('pruneFsNotify', () => {
  it('keeps only bookkeeping whose id is still live', () => {
    const notify = { a: { scheduledMessageIds: ['m1'] }, b: { scheduledMessageIds: ['m2'] } };
    const [live] = reconcileFleetSaves([], [cand({ id: 'a' })], opts());
    const pruned = pruneFsNotify(notify, [live]);
    expect(pruned).toEqual({ a: { scheduledMessageIds: ['m1'] } });
  });
});
