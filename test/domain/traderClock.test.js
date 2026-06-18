// Unit tests for the pure Trader "come back at HH:MM" clock helpers.
//
// @ts-check

import { describe, it, expect } from 'vitest';

import { parseClockTime, nextDailyOccurrence } from '../../src/domain/traderClock.js';

describe('parseClockTime', () => {
  it('extracts HH:MM from the localised "come back at" overlay text', () => {
    expect(parseClockTime('Obecnie nie ma ofert. Wróć o godz. 12:00.')).toEqual({
      hours: 12,
      minutes: 0,
    });
    expect(parseClockTime('No offers now. Come back at 9:05.')).toEqual({
      hours: 9,
      minutes: 5,
    });
  });

  it('accepts the full 24-hour range', () => {
    expect(parseClockTime('00:00')).toEqual({ hours: 0, minutes: 0 });
    expect(parseClockTime('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects out-of-range and non-time inputs', () => {
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('19:60')).toBeNull();
    expect(parseClockTime('no time here')).toBeNull();
    expect(parseClockTime('')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
    expect(parseClockTime(undefined)).toBeNull();
  });

  it('does not read a price/number run as a time', () => {
    // "13.500" has no colon; "1.234.567" likewise — neither should parse.
    expect(parseClockTime('Koszt: 13.500 Antymaterii')).toBeNull();
  });
});

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
