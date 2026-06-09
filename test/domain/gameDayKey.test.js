// @ts-check

import { describe, it, expect } from 'vitest';
import { gameDayKey } from '../../src/domain/gameDayKey.js';

describe('gameDayKey', () => {
  it('returns the calendar date when time is at exactly 14:00', () => {
    expect(gameDayKey(new Date('2026-06-09T14:00:00'))).toBe('2026-06-09');
  });

  it('returns the calendar date when time is after 14:00', () => {
    expect(gameDayKey(new Date('2026-06-09T20:30:00'))).toBe('2026-06-09');
  });

  it('returns yesterday when time is before 14:00', () => {
    expect(gameDayKey(new Date('2026-06-09T13:59:59'))).toBe('2026-06-08');
  });

  it('returns yesterday when time is at midnight', () => {
    expect(gameDayKey(new Date('2026-06-09T00:00:00'))).toBe('2026-06-08');
  });

  it('pads month and day with leading zeros', () => {
    expect(gameDayKey(new Date('2026-01-05T15:00:00'))).toBe('2026-01-05');
  });

  it('crosses month boundary before 14:00', () => {
    // 2026-07-01 at 10:00 → game day is still 2026-06-30
    expect(gameDayKey(new Date('2026-07-01T10:00:00'))).toBe('2026-06-30');
  });

  it('crosses year boundary before 14:00', () => {
    // 2027-01-01 at 00:00 → game day is still 2026-12-31
    expect(gameDayKey(new Date('2027-01-01T00:00:00'))).toBe('2026-12-31');
  });
});
