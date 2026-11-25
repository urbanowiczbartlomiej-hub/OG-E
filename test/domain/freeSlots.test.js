// @ts-check

// Unit tests for domain/freeSlots — the dashboard's free-slot outlook. Pure:
// no DOM, no storage; `now` is a fixed local wall-clock time so the 03:00
// cleanup buckets are deterministic in any timezone.

import { describe, it, expect } from 'vitest';
import { freeSlotOutlook, nextCleanups } from '../../src/domain/freeSlots.js';
import {
  DEC_SENT,
  DEC_MINE,
  DEC_ABANDONED,
  DEC_TAKEN,
  DEC_RESERVED,
} from '../../src/domain/colonizeDecisions.js';

const H = 3_600_000;
/** 2026-11-25 21:00 local. */
const NOW = new Date(2026, 10, 25, 21, 0).getTime();
const at = (/** @type {number} */ d, /** @type {number} */ h) => new Date(2026, 10, d, h, 0).getTime();

/** @param {Partial<Parameters<typeof freeSlotOutlook>[0]>} over */
const run = (over = {}) => freeSlotOutlook({
  occupied: [],
  galaxies: 2,
  systems: 5,
  targets: [8],
  decisions: {},
  scans: {},
  now: NOW,
  ...over,
});

describe('nextCleanups', () => {
  it('is the next 03:00 and the one a day later', () => {
    expect(nextCleanups(NOW)).toEqual({ nextAt: at(26, 3), afterAt: at(27, 3) });
  });

  it('after midnight, the next cleanup is the same morning', () => {
    expect(nextCleanups(at(26, 1)).nextAt).toBe(at(26, 3));
  });

  it('exactly at 03:00, that cleanup has already run', () => {
    expect(nextCleanups(at(26, 3)).nextAt).toBe(at(27, 3));
  });
});

describe('freeSlotOutlook — free now', () => {
  it('counts every target slot the API does not list, per galaxy', () => {
    const o = run({ occupied: ['1:1:8', '2:5:8', '1:2:7'] });
    expect(o.rows.map((r) => r.free)).toEqual([4, 4]);
    expect(o.free).toBe(8);
  });

  it('counts each target position separately', () => {
    expect(run({ targets: [7, 8] }).free).toBe(20);
  });

  it('subtracts slots the decision log blocks (sent, mine, taken, reserved, abandoned on hold)', () => {
    const o = run({
      decisions: {
        '1:1:8': { s: DEC_SENT, ts: NOW - H, aa: NOW + H },
        '1:2:8': { s: DEC_MINE, ts: NOW - H },
        '1:3:8': { s: DEC_TAKEN, ts: NOW - H },
        '1:4:8': { s: DEC_RESERVED, ts: NOW - H, aa: NOW + H },
        '1:5:8': { s: DEC_ABANDONED, ts: NOW - 2 * H },
      },
    });
    expect(o.rows[0].free).toBe(0);
    expect(o.rows[1].free).toBe(5);
  });

  it('adds back our abandoned slot the stale API still lists once its hold has passed', () => {
    const o = run({
      occupied: ['1:1:8', '1:2:8'],
      decisions: { '1:1:8': { s: DEC_ABANDONED, ts: NOW - 50 * H } },
    });
    expect(o.rows[0].free).toBe(4); // 1:1:8 freed, 1:2:8 still someone's
  });

  it('subtracts a slot a stored scan saw not empty', () => {
    const o = run({ scans: { '2:2': { positions: { 8: { status: 'occupied' }, 7: { status: 'occupied' } } } } });
    expect(o.rows[1].free).toBe(4);
  });

  it('ignores a scan that saw the slot empty', () => {
    expect(run({ scans: { '2:2': { positions: { 8: { status: 'empty' } } } } }).free).toBe(10);
  });
});

describe('freeSlotOutlook — releases at the next two cleanups', () => {
  it('buckets abandoned slots on hold by the cleanup that frees them', () => {
    const o = run({
      decisions: {
        '1:1:8': { s: DEC_ABANDONED, ts: at(25, 1) }, // +24h = 26 01:00 → 26 03:00
        '1:2:8': { s: DEC_ABANDONED, ts: at(25, 19) }, // +24h = 26 19:00 → 27 03:00
        '2:3:8': { s: DEC_ABANDONED, ts: at(25, 2) }, // → 26 03:00
      },
    });
    expect(o.rows[0]).toMatchObject({ next: 1, after: 1 });
    expect(o.rows[1]).toMatchObject({ next: 1, after: 0 });
    expect(o).toMatchObject({ next: 2, after: 1, nextAt: at(26, 3), afterAt: at(27, 3) });
  });

  it('skips releases already passed, non-target positions and other decision kinds', () => {
    const o = run({
      decisions: {
        '1:1:8': { s: DEC_ABANDONED, ts: at(23, 10) }, // freed 25 03:00 — already free
        '1:2:7': { s: DEC_ABANDONED, ts: at(25, 1) }, // not a target position
        '1:3:8': { s: DEC_TAKEN, ts: at(25, 1) },
        '9:1:8': { s: DEC_ABANDONED, ts: at(25, 1) }, // galaxy outside the grid
      },
    });
    expect(o.next + o.after).toBe(0);
  });
});
