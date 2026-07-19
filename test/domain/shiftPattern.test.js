// Unit tests for domain/shiftPattern.js — the shift-rotation / weekend-rhythm
// layer on top of the presence ledger. Pins the properties the dossier's
// "Weeks" explorer and its verdict lines lean on:
//
//   1. weeklyProfiles groups local days into ISO-weeks and only earns a phase
//      reading once a week clears the observed/active bars;
//   2. circMeanHour/circDistHour are the wrap-safe (23→0 seam) hour maths
//      everything else is built on;
//   3. detectRotation gates on sample size, clusters by circular gap, and
//      only calls a "rotation" when the cluster sequence repeats on a fixed
//      period — steady lives, thin data, and irregular lives must NOT.
//   4. weekendPattern fits the simplest hypothesis (always/never/alternating)
//      and predicts the next occurrence only when one fits.
//
// Fixtures for detectRotation/weekendPattern build WeekRow/DayRec objects
// directly (bypassing collectLocalDays) so the clustering/periodicity math is
// tested independent of the runner's timezone; collectLocalDays/weeklyProfiles
// get their own smaller, timezone-tolerant tests below.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  collectLocalDays,
  weeklyProfiles,
  circMeanHour,
  circDistHour,
  detectRotation,
  weekendPattern,
  summarizeShiftPattern,
  WEEKDAYS_MON_FRI,
} from '../../src/domain/shiftPattern.js';

const DAY_S = 86400;
const HOUR_S = 3600;
/** Epoch-seconds at hour `h` of epoch-day `day`. @param {number} day @param {number} h */
const at = (day, h) => day * DAY_S + h * HOUR_S;

/** Local-day index the SAME way the source places a UTC instant (fixture helper, not a re-test of it). @param {number} utcSec */
const localDayIdxOf = (utcSec) => {
  const d = new Date(utcSec * 1000);
  return Math.floor((utcSec - d.getTimezoneOffset() * 60) / DAY_S);
};
/** Local-Monday day index of the week containing `utcSec`. @param {number} utcSec */
const mondayOf = (utcSec) => {
  const d = new Date(utcSec * 1000);
  return localDayIdxOf(utcSec) - ((d.getDay() + 6) % 7);
};
/** Contextually type a `[active, quiet]`-tuple ledger literal. @param {Record<string, [number, number]>} m @returns {import('../../src/domain/presenceLedger.js').PresenceLedger} */
const led = (m) => m;

describe('collectLocalDays', () => {
  it('extracts one record per local day with self-consistent dow/localDayIdx', () => {
    const ledger = led({
      20000: [1 << 14, 1 << 3], // active 14:00 UTC, quiet 03:00 UTC
      20010: [0, 1 << 9],
    });
    const days = collectLocalDays(ledger, at(20020, 0), 0);
    expect(days.length).toBeGreaterThanOrEqual(2);
    for (const rec of days) {
      // The record's own dow must match what Date says for an instant on it.
      const check = new Date(rec.localDayIdx * DAY_S * 1000 + 12 * HOUR_S * 1000);
      expect(rec.dow).toBe(check.getDay());
      expect(rec.weekStartIdx).toBe(rec.localDayIdx - ((rec.dow + 6) % 7));
    }
    expect(days).toEqual([...days].sort((a, b) => a.localDayIdx - b.localDayIdx));
  });

  it('active dominates quiet within the same local hour', () => {
    // Two different UTC days whose sole bits, once placed locally, could only
    // ever land as separate hours of separate days — so instead we assert the
    // per-record invariant directly: no record ever has both bits set on the
    // same hour.
    const ledger = led({ 20000: [1 << 14, 1 << 14 | 1 << 3] });
    const [rec] = collectLocalDays(ledger, at(20001, 0), 0);
    expect(rec.activeHours & rec.quietHours).toBe(0);
  });

  it('drops days outside rangeDays', () => {
    const ledger = led({ 20000: [1, 0], [String(20000 - 100)]: [1, 0] });
    const days = collectLocalDays(ledger, at(20000, 12), 30);
    expect(days.length).toBe(1);
  });

  it('ignores empty/malformed entries', () => {
    const days = collectLocalDays({ 20000: [0, 0] }, at(20001, 0), 0);
    expect(days).toEqual([]);
  });
});

describe('weeklyProfiles', () => {
  /**
   * @param {number} localDayIdx @param {number} dow @param {number} weekStartIdx
   * @param {number} activeHours @param {number} [quietHours]
   * @returns {import('../../src/domain/shiftPattern.js').DayRec}
   */
  const day = (localDayIdx, dow, weekStartIdx, activeHours, quietHours = 0) =>
    ({ localDayIdx, dow, weekStartIdx, activeHours, quietHours });

  it('groups days by weekStartIdx and earns a phase once past the coverage bars', () => {
    // 3 observed days, ≥3 active hours total → phased. Monday=1000.
    const days = [
      day(1000, 1, 1000, 1 << 14),
      day(1001, 2, 1000, 1 << 14),
      day(1002, 3, 1000, 1 << 14),
    ];
    const [week] = weeklyProfiles(days);
    expect(week.weekStartIdx).toBe(1000);
    expect(week.observedDays).toBe(3);
    expect(week.activeDays).toBe(3);
    expect(week.phaseHour).toBeCloseTo(14, 5);
  });

  it('withholds a phase when the week is too thin', () => {
    const days = [day(1000, 1, 1000, 1 << 14), day(1001, 2, 1000, 1 << 14)]; // only 2 observed days
    const [week] = weeklyProfiles(days);
    expect(week.phaseHour).toBeNull();
  });

  it('weekdays filter drops days outside the given set (e.g. Mon–Fri)', () => {
    const days = [
      day(1000, 1, 1000, 1 << 10), // Mon
      day(1005, 6, 1000, 1 << 20), // Sat, same week
    ];
    const [week] = weeklyProfiles(days, { weekdays: WEEKDAYS_MON_FRI });
    expect(week.observedDays).toBe(1);
    expect(week.cells[20].observed).toBe(0);
    expect(week.cells[10].observed).toBe(1);
  });

  it('returns weeks sorted ascending by weekStartIdx', () => {
    const days = [day(2000, 1, 2000, 1), day(1000, 1, 1000, 1), day(1500, 1, 1500, 1)];
    const weeks = weeklyProfiles(days);
    expect(weeks.map((w) => w.weekStartIdx)).toEqual([1000, 1500, 2000]);
  });
});

describe('circMeanHour / circDistHour', () => {
  it('is a plain mean away from the midnight seam', () => {
    const w = new Array(24).fill(0);
    w[10] = 1; w[14] = 1;
    expect(circMeanHour(w)).toBeCloseTo(12, 1);
  });

  it('wraps correctly across the 23→0 seam (23 and 1 average to 0, not 12)', () => {
    const w = new Array(24).fill(0);
    w[23] = 1; w[1] = 1;
    const mean = /** @type {number} */ (circMeanHour(w));
    expect(circDistHour(mean, 0)).toBeLessThan(0.5);
  });

  it('returns null for an all-zero weight vector', () => {
    expect(circMeanHour(new Array(24).fill(0))).toBeNull();
  });

  it('circDistHour is the shortest ring distance', () => {
    expect(circDistHour(23, 1)).toBe(2);
    expect(circDistHour(2, 22)).toBe(4);
    expect(circDistHour(5, 5)).toBe(0);
  });
});

/**
 * Build a minimal WeekRow fixture for detectRotation: one active hour
 * (`onlineHour`) across `observedDays` days, everything else quiet.
 * @param {number} weekStartIdx
 * @param {number} onlineHour
 * @param {number} [observedDays]
 * @returns {import('../../src/domain/shiftPattern.js').WeekRow}
 */
function fixtureWeek(weekStartIdx, onlineHour, observedDays = 5) {
  const cells = Array.from({ length: 24 }, (_, h) => (h === onlineHour
    ? { active: observedDays, quiet: 0, observed: observedDays }
    : { active: 0, quiet: observedDays, observed: observedDays }));
  return {
    weekStartIdx,
    weekStartMs: weekStartIdx * DAY_S * 1000,
    parity: ((weekStartIdx % 2) + 2) % 2,
    cells,
    observedDays,
    activeDays: observedDays,
    phaseHour: onlineHour,
    activeTotal: observedDays,
  };
}

describe('detectRotation', () => {
  it('gate=none when fewer than 5 phased weeks', () => {
    const weeks = [fixtureWeek(1000, 14), fixtureWeek(1007, 14), fixtureWeek(1014, 14)];
    const rot = detectRotation(weeks, at(1014, 12));
    expect(rot.gate).toBe('none');
    expect(rot.clusters).toEqual([]);
  });

  it('a steady life (one online hour every week) is ONE cluster, no rotation', () => {
    const nowSec = at(500700, 12);
    const anchor = mondayOf(nowSec); // "this week" = the newest fixture week
    const weeks = Array.from({ length: 8 }, (_, i) => fixtureWeek(anchor - (7 - i) * 7, 20));
    const rot = detectRotation(weeks, nowSec);
    expect(rot.clusters.length).toBe(1);
    expect(rot.period).toBeNull();
    expect(rot.gate).toBe('pattern'); // 8 phased weeks clears the strong-steady bar
    expect(rot.thisWeek?.id).toBe(0);
  });

  it('detects a clean weekly-rotating 3-shift roster and predicts the next week', () => {
    // 9 weeks, oldest→newest, online hour cycles morning(6)/afternoon(14)/night(22).
    const hours = [6, 14, 22];
    const anchor = mondayOf(at(500000, 12)); // "this week" = the newest week below
    const weeks = Array.from({ length: 9 }, (_, i) => {
      const weekStartIdx = anchor - (8 - i) * 7;
      return fixtureWeek(weekStartIdx, hours[i % 3]);
    });
    const rot = detectRotation(weeks, at(500000, 12));

    expect(rot.clusters.length).toBe(3);
    expect(rot.period).toBe(3);
    expect(rot.agreement).toBeCloseTo(1, 5);
    expect(rot.gate).toBe('strong');

    // Newest week (i=8) used hour 22 → night, the highest-centre cluster.
    expect(rot.thisWeek?.centreHour).toBeCloseTo(22, 1);
    // The cycle always continues night(22) → morning(6) next.
    expect(rot.nextWeek?.centreHour).toBeCloseTo(6, 1);
  });

  it('too many distinct phases (more than 3 shifts) reads as irregular, not a roster', () => {
    const hours = [0, 4, 8, 12, 16, 20]; // 6 clusters, each ≥4h apart
    const weeks = hours.map((h, i) => fixtureWeek(1000 + i * 7, h));
    const rot = detectRotation(weeks, at(1000 + 5 * 7, 12));
    expect(rot.clusters).toEqual([]);
    expect(rot.gate).toBe('hint');
  });

  it('two clusters that do NOT alternate on a clean period stay un-rotated', () => {
    // Same cluster (14) six weeks running, then a one-off blip (22) — no
    // periodic structure, so this must not be called a rotation.
    const weeks = [
      fixtureWeek(1000, 14), fixtureWeek(1007, 14), fixtureWeek(1014, 14),
      fixtureWeek(1021, 14), fixtureWeek(1028, 14), fixtureWeek(1035, 22),
    ];
    const rot = detectRotation(weeks, at(1035, 12));
    expect(rot.period).toBeNull();
  });
});

describe('weekendPattern', () => {
  /**
   * @param {number} localDayIdx @param {number} weekStartIdx @param {'active'|'quiet'} state
   * @returns {import('../../src/domain/shiftPattern.js').DayRec}
   */
  const sat = (localDayIdx, weekStartIdx, state) => ({
    localDayIdx,
    dow: 6,
    weekStartIdx,
    activeHours: state === 'active' ? (1 << 12) : 0, // noon, inside the 08–20 daytime window
    quietHours: state === 'quiet' ? (1 << 12) : 0,
  });

  it('gate=none with fewer than 4 classified Saturdays', () => {
    const days = [sat(1005, 1000, 'active'), sat(1012, 1007, 'quiet')];
    const w = weekendPattern(days, at(1020, 12));
    expect(w.gate).toBe('none');
    expect(w.pattern).toBe('unknown');
  });

  it('recognises "always active"', () => {
    const days = Array.from({ length: 6 }, (_, i) => sat(1005 + i * 7, 1000 + i * 7, 'active'));
    const w = weekendPattern(days, at(1005 + 6 * 7, 12));
    expect(w.pattern).toBe('always');
    expect(w.nextSaturday).toBe('active');
  });

  it('recognises "never" (consistently quiet)', () => {
    const days = Array.from({ length: 6 }, (_, i) => sat(1005 + i * 7, 1000 + i * 7, 'quiet'));
    const w = weekendPattern(days, at(1005 + 6 * 7, 12));
    expect(w.pattern).toBe('never');
    expect(w.nextSaturday).toBe('quiet');
  });

  it('recognises "every other Saturday" and predicts the coming one', () => {
    // Newest-first parity alternation: active, quiet, active, quiet, ...
    const days = Array.from({ length: 8 }, (_, i) => sat(1005 + i * 7, 1000 + i * 7, i % 2 === 0 ? 'quiet' : 'active'));
    const w = weekendPattern(days, at(1005 + 8 * 7, 12));
    expect(w.pattern).toBe('alternating');
    expect(['active', 'quiet']).toContain(w.nextSaturday);
  });
});

describe('summarizeShiftPattern', () => {
  it('wires collectLocalDays → weeklyProfiles/detectRotation + weekendPattern without throwing', () => {
    /** @type {Record<string, [number, number]>} */
    const ledger = {};
    for (let i = 0; i < 40; i++) ledger[String(20000 + i)] = [1 << 14, 1 << 3];
    const out = summarizeShiftPattern(ledger, at(20050, 12));
    expect(out.rotation).toHaveProperty('gate');
    expect(out.weekend).toHaveProperty('gate');
  });
});
