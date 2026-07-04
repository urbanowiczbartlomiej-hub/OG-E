// Unit tests for the pure Trader "come back at HH:MM" clock helpers.
//
// @ts-check

import { describe, it, expect } from 'vitest';

import { nextDailyOccurrence } from '../../src/domain/traderClock.js';

describe('nextDailyOccurrence', () => {
  it('returns today when the time is still ahead', () => {
    const now = new Date('2026-06-18T10:00:00');
    const ms = nextDailyOccurrence(now, { hours: 12, minutes: 0 });
    expect(new Date(ms).toISOString()).toBe(new Date('2026-06-18T12:00:00').toISOString());
  });

  it('rolls to tomorrow when the time has already passed', () => {
    const now = new Date('2026-06-18T14:00:00');
    const ms = nextDailyOccurrence(now, { hours: 12, minutes: 0 });
    expect(new Date(ms).toISOString()).toBe(new Date('2026-06-19T12:00:00').toISOString());
  });

  it('treats the exact current minute as already passed (rolls forward)', () => {
    const now = new Date('2026-06-18T12:00:00');
    const ms = nextDailyOccurrence(now, { hours: 12, minutes: 0 });
    expect(new Date(ms).toISOString()).toBe(new Date('2026-06-19T12:00:00').toISOString());
  });
});
