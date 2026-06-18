// @ts-check

import { describe, it, expect } from 'vitest';
import { parseDuration, parseDurationList, formatDuration, humanizeOffset, humanizeArrivalOffset, humanizeReturnOffset, humanizeOffsetShort, humanizeReturnOffsetShort, summarizeSchedule } from '../../src/domain/duration.js';

describe('parseDuration', () => {
  it('treats a bare number as minutes', () => {
    expect(parseDuration('30')).toBe(1800);
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('1')).toBe(60);
  });

  it('honours an explicit s/m/h suffix (any case)', () => {
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('10M')).toBe(600);
    expect(parseDuration('1H')).toBe(3600);
  });

  it('accepts decimals and a leading sign', () => {
    expect(parseDuration('1.5m')).toBe(90);
    expect(parseDuration('+5m')).toBe(300);
    expect(parseDuration('-10m')).toBe(-600);
    expect(parseDuration('0.5h')).toBe(1800);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration('  10m ')).toBe(600);
  });

  it('returns null for anything that is not a single token', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('10x')).toBeNull();
    expect(parseDuration('10m20s')).toBeNull();
    expect(parseDuration('10 20')).toBeNull();
    expect(parseDuration('standard')).toBeNull();
  });

  it('scales the day unit (added for Galaxy-Scan rescan fields)', () => {
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('5d')).toBe(5 * 86400);
    expect(parseDuration('0.5d')).toBe(43200);
    expect(parseDuration('2D')).toBe(2 * 86400); // case-insensitive
  });
});

describe('parseDurationList', () => {
  it('parses a minutes-first list, de-dupes, sorts ascending', () => {
    expect(parseDurationList('0m, 10m, 30m, 60m')).toEqual([0, 600, 1800, 3600]);
    expect(parseDurationList('60m, 0m, 10m')).toEqual([0, 600, 3600]);
    expect(parseDurationList('10m, 10m, 0m')).toEqual([0, 600]);
  });

  it('treats bare numbers as minutes', () => {
    expect(parseDurationList('0, 10, 30, 60')).toEqual([0, 600, 1800, 3600]);
  });

  it('drops negatives unless signed', () => {
    expect(parseDurationList('-10m, 0m, 10m')).toEqual([0, 600]);
    expect(parseDurationList('-10m, 0m, 10m', { signed: true })).toEqual([-600, 0, 600]);
  });

  it('tolerates spaces, a leading +, and a trailing comma', () => {
    expect(parseDurationList('  10m , +30m , 0m ,')).toEqual([0, 600, 1800]);
  });

  it('skips garbage tokens and yields [] for an all-invalid string', () => {
    expect(parseDurationList('10m, oops, 30m')).toEqual([600, 1800]);
    expect(parseDurationList('standard')).toEqual([]);
    expect(parseDurationList('')).toEqual([]);
    expect(parseDurationList(/** @type {any} */ (null))).toEqual([]);
  });

  it('mixes units in one list', () => {
    expect(parseDurationList('90s, 2m, 1h')).toEqual([90, 120, 3600]);
  });
});

describe('formatDuration', () => {
  it('renders whole minutes as Nm, sub-minute as Ns', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3600)).toBe('60m');
    expect(formatDuration(90)).toBe('90s');
    expect(formatDuration(45)).toBe('45s');
  });

  it('keeps the sign', () => {
    expect(formatDuration(-600)).toBe('-10m');
    expect(formatDuration(-90)).toBe('-90s');
  });

  it('round-trips through parseDuration', () => {
    for (const sec of [0, 60, 90, 600, 1800, 3600, -600]) {
      expect(parseDuration(formatDuration(sec))).toBe(sec);
    }
  });
});

describe('humanizeOffset', () => {
  it('renders before / at / after landing', () => {
    expect(humanizeOffset(-600)).toBe('10 min before landing');
    expect(humanizeOffset(0)).toBe('landing now');
    expect(humanizeOffset(900)).toBe('15 min after landing');
  });

  it('rounds magnitude to the nearest whole minute', () => {
    expect(humanizeOffset(-90)).toBe('2 min before landing');
    expect(humanizeOffset(30)).toBe('1 min after landing');
  });

  it('treats non-finite input as zero', () => {
    expect(humanizeOffset(NaN)).toBe('landing now');
    expect(humanizeOffset(/** @type {number} */ (/** @type {unknown} */ (undefined)))).toBe('landing now');
  });
});

describe('humanizeArrivalOffset', () => {
  it('renders before / at / after arrival', () => {
    expect(humanizeArrivalOffset(-600)).toBe('10 min before arrival');
    expect(humanizeArrivalOffset(0)).toBe('at arrival');
    expect(humanizeArrivalOffset(900)).toBe('15 min after arrival');
  });

  it('rounds magnitude to the nearest whole minute', () => {
    expect(humanizeArrivalOffset(-90)).toBe('2 min before arrival');
    expect(humanizeArrivalOffset(30)).toBe('1 min after arrival');
  });

  it('treats non-finite input as zero', () => {
    expect(humanizeArrivalOffset(NaN)).toBe('at arrival');
  });
});

describe('humanizeReturnOffset', () => {
  it('renders "when the wave returns" for zero (and non-positive)', () => {
    expect(humanizeReturnOffset(0)).toBe('when the wave returns');
    expect(humanizeReturnOffset(-60)).toBe('when the wave returns');
  });

  it('renders "N min after the wave returns" for positive offsets', () => {
    expect(humanizeReturnOffset(600)).toBe('10 min after the wave returns');
    expect(humanizeReturnOffset(1800)).toBe('30 min after the wave returns');
  });

  it('rounds magnitude to the nearest whole minute', () => {
    expect(humanizeReturnOffset(90)).toBe('2 min after the wave returns');
  });

  it('treats non-finite input as zero', () => {
    expect(humanizeReturnOffset(NaN)).toBe('when the wave returns');
  });
});

describe('humanizeOffsetShort', () => {
  it('renders the compact before / at / after form (reference point dropped)', () => {
    expect(humanizeOffsetShort(-600)).toBe('10m before');
    expect(humanizeOffsetShort(0)).toBe('at landing');
    expect(humanizeOffsetShort(900)).toBe('15m after');
  });

  it('rounds magnitude to the nearest whole minute', () => {
    expect(humanizeOffsetShort(-90)).toBe('2m before');
    expect(humanizeOffsetShort(30)).toBe('1m after');
  });

  it('treats non-finite input as zero', () => {
    expect(humanizeOffsetShort(NaN)).toBe('at landing');
  });
});

describe('humanizeReturnOffsetShort', () => {
  it('renders "at return" for zero (and non-positive)', () => {
    expect(humanizeReturnOffsetShort(0)).toBe('at return');
    expect(humanizeReturnOffsetShort(-60)).toBe('at return');
  });

  it('renders the compact "Nm after" form for positive offsets', () => {
    expect(humanizeReturnOffsetShort(600)).toBe('10m after');
    expect(humanizeReturnOffsetShort(1800)).toBe('30m after');
  });

  it('treats non-finite input as zero', () => {
    expect(humanizeReturnOffsetShort(NaN)).toBe('at return');
  });
});

describe('summarizeSchedule', () => {
  it('groups before / at / after, chronological within each group (landing)', () => {
    // before listed furthest-first, after nearest-first.
    expect(summarizeSchedule([-300, -900, 0, 1200, -600], 'landing'))
      .toBe('15m, 10m & 5m before landing · at landing · 20m after landing');
  });

  it('omits empty groups', () => {
    expect(summarizeSchedule([600, 1800], 'return')).toBe('10m & 30m after return');
    expect(summarizeSchedule([0], 'landing')).toBe('at landing');
    expect(summarizeSchedule([-600], 'landing')).toBe('10m before landing');
  });

  it('collapses duplicates and ignores non-finite values', () => {
    expect(summarizeSchedule([-600, -600, NaN], 'landing')).toBe('10m before landing');
  });

  it('returns the empty string for no offsets', () => {
    expect(summarizeSchedule([], 'return')).toBe('');
  });

  it('accepts an "arrival" reference point', () => {
    expect(summarizeSchedule([-60, 0, 300], 'arrival'))
      .toBe('1m before arrival · at arrival · 5m after arrival');
  });
});
