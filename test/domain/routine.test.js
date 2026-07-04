// @ts-check

// Unit tests for domain/routine — the pure, sample-gated routine summaries the
// Spyglass dossier shows (hour-of-day activity, weekday resource medians, the
// "collection" body, a timeline). Every case drives plain SpyReportLite fixtures
// (ts in epoch SECONDS). Hours/weekdays are LOCAL by design, so expectations that
// depend on the exact local hour/weekday are DERIVED with the same `new Date(...)`
// math the module uses — never hard-coded — so the suite is timezone-robust.

import { describe, it, expect } from 'vitest';
import { summarizeRoutine } from '../../src/domain/routine.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 6, 4, 12, 0, 0); // fixed base for all fixtures

/** Local hour a report implies (mirrors the module's activityHour). */
const localHour = (/** @type {number} */ ts, /** @type {number} */ activityMin) =>
  new Date((ts - activityMin * 60) * 1000).getHours();
/** Local weekday of a report ts (mirrors the module's byDay bucketing). */
const localDay = (/** @type {number} */ ts) => new Date(ts * 1000).getDay();

describe('summarizeRoutine — empty input', () => {
  it('reports nothing and gates everything to none', () => {
    const r = summarizeRoutine([], NOW_MS);
    expect(r.observations).toBe(0);
    expect(r.activity.samples).toBe(0);
    expect(r.activity.gate).toBe('none');
    expect(r.activity.label).toBeUndefined();
    expect(r.activity.bins).toHaveLength(24);
    expect(r.activity.bins.every((c) => c === 0)).toBe(true);
    expect(r.weekday.gate).toBe('none');
    expect(r.collection).toBeNull();
    expect(r.timeline).toEqual([]);
  });

  it('treats null bodies / missing history as empty', () => {
    const r = summarizeRoutine(/** @type {any} */ (null), NOW_MS);
    expect(r.observations).toBe(0);
    expect(r.timeline).toEqual([]);
  });
});

describe('summarizeRoutine — hour-of-day activity + gate escalation', () => {
  // n reports whose implied local hour all land in ONE bin. tsBase is recent, and
  // each report is spaced a day apart so ts stays inside the recency window while
  // the SAME (ts - activityMin*60) local hour is preserved (whole-day shifts don't
  // move the wall-clock hour).
  const clustered = (/** @type {number} */ n) => {
    const activityMin = 30;
    const baseTs = Math.floor((NOW_MS - DAY_MS) / 1000);
    return Array.from({ length: n }, (_, i) => ({
      ts: baseTs - i * 24 * 60 * 60,
      activityMin,
    }));
  };

  it('populates the implied-hour bin and counts samples', () => {
    const history = clustered(3);
    const hour = localHour(history[0].ts, history[0].activityMin);
    const r = summarizeRoutine([{ coord: '1:1:1', history }], NOW_MS);
    expect(r.activity.samples).toBe(3);
    expect(r.activity.bins[hour]).toBe(3);
    expect(r.activity.bins.reduce((a, c) => a + c, 0)).toBe(3);
  });

  it('gate none < 3 samples', () => {
    const r = summarizeRoutine([{ coord: '1:1:1', history: clustered(2) }], NOW_MS);
    expect(r.activity.samples).toBe(2);
    expect(r.activity.gate).toBe('none');
    expect(r.activity.label).toBeUndefined();
  });

  it('gate hint at 3–4 concentrated samples (no label below pattern)', () => {
    const r = summarizeRoutine([{ coord: '1:1:1', history: clustered(4) }], NOW_MS);
    expect(r.activity.gate).toBe('hint');
    expect(r.activity.label).toBeUndefined();
  });

  it('gate pattern at ≥5 fully-concentrated samples, with a label', () => {
    const r = summarizeRoutine([{ coord: '1:1:1', history: clustered(6) }], NOW_MS);
    expect(r.activity.gate).toBe('pattern');
    expect(typeof r.activity.label).toBe('string');
    expect(/** @type {string} */ (r.activity.label).length).toBeGreaterThan(0);
  });

  it('gate strong at ≥10 fully-concentrated samples', () => {
    const r = summarizeRoutine([{ coord: '1:1:1', history: clustered(12) }], NOW_MS);
    expect(r.activity.gate).toBe('strong');
    expect(typeof r.activity.label).toBe('string');
  });

  it('ignores reports lacking ts or activityMin for the activity signal', () => {
    const history = [
      ...clustered(3),
      { resTotal: 999 }, // no ts/activityMin → no activity sample
      { ts: Math.floor((NOW_MS - DAY_MS) / 1000) }, // ts but no activityMin
    ];
    const r = summarizeRoutine([{ coord: '1:1:1', history }], NOW_MS);
    expect(r.activity.samples).toBe(3);
  });
});

describe('summarizeRoutine — 30-day recency', () => {
  it('drops observations older than the cutoff', () => {
    const recentTs = Math.floor((NOW_MS - DAY_MS) / 1000);
    const staleTs = Math.floor((NOW_MS - 31 * DAY_MS) / 1000);
    const r = summarizeRoutine(
      [{ coord: '1:1:1', history: [{ ts: recentTs, resTotal: 100 }, { ts: staleTs, resTotal: 100 }] }],
      NOW_MS,
    );
    expect(r.observations).toBe(1);
    expect(r.timeline).toHaveLength(1);
    expect(r.timeline[0].ts).toBe(recentTs);
  });
});

describe('summarizeRoutine — weekday resource medians', () => {
  it('takes the per-weekday median of resTotal and counts samples', () => {
    // Three reports on the SAME local weekday (whole-day spacing preserves dow),
    // resTotals 10/20/30 → median 20.
    const baseTs = Math.floor((NOW_MS - DAY_MS) / 1000);
    const history = [10, 20, 30].map((resTotal, i) => ({
      ts: baseTs - i * 24 * 60 * 60 * 7, // step whole weeks → identical weekday
      resTotal,
    }));
    const dow = localDay(history[0].ts);
    const r = summarizeRoutine([{ coord: '1:1:1', history }], NOW_MS);
    expect(r.weekday.samples[dow]).toBe(3);
    expect(r.weekday.medians[dow]).toBe(20);
    // Every other weekday has no sample.
    for (let d = 0; d < 7; d++) {
      if (d === dow) continue;
      expect(r.weekday.samples[d]).toBe(0);
      expect(r.weekday.medians[d]).toBeNull();
    }
  });
});

describe('summarizeRoutine — collection (richest body)', () => {
  it('returns the body with the highest median resTotal, with sample/ofBodies counts', () => {
    const ts = Math.floor((NOW_MS - DAY_MS) / 1000);
    const r = summarizeRoutine(
      [
        { coord: '1:1:1', history: [{ ts, resTotal: 100 }, { ts: ts - 3600, resTotal: 200 }] }, // median 150
        { coord: '1:1:2', history: [{ ts, resTotal: 900 }, { ts: ts - 3600, resTotal: 1100 }] }, // median 1000
      ],
      NOW_MS,
    );
    const col = r.collection;
    expect(col).not.toBeNull();
    expect(col?.coord).toBe('1:1:2');
    expect(col?.medianRes).toBe(1000);
    expect(col?.samples).toBe(2);
    expect(col?.ofBodies).toBe(2);
  });

  it('is null when no observation carries resTotal', () => {
    const ts = Math.floor((NOW_MS - DAY_MS) / 1000);
    const r = summarizeRoutine([{ coord: '1:1:1', history: [{ ts, activityMin: 10 }] }], NOW_MS);
    expect(r.collection).toBeNull();
  });
});

describe('summarizeRoutine — timeline', () => {
  it('is newest-first, carries coord + values, and caps at 14', () => {
    const baseTs = Math.floor((NOW_MS - DAY_MS) / 1000);
    const history = Array.from({ length: 20 }, (_, i) => ({
      ts: baseTs - i * 3600, // 1h apart, all recent
      resTotal: i,
      fleetValue: i * 10,
      defenseValue: i * 100,
    }));
    const r = summarizeRoutine([{ coord: '2:3:4', history }], NOW_MS);
    expect(r.timeline).toHaveLength(14);
    // newest first
    for (let i = 1; i < r.timeline.length; i++) {
      expect(r.timeline[i - 1].ts).toBeGreaterThanOrEqual(/** @type {number} */ (r.timeline[i].ts));
    }
    const head = r.timeline[0];
    expect(head.ts).toBe(baseTs);
    expect(head.coord).toBe('2:3:4');
    expect(head.resTotal).toBe(0);
    expect(head.fleetValue).toBe(0);
    expect(head.defenseValue).toBe(0);
  });

  it('excludes entries without a ts', () => {
    const ts = Math.floor((NOW_MS - DAY_MS) / 1000);
    const r = summarizeRoutine(
      [{ coord: '1:1:1', history: [{ ts, resTotal: 5 }, { resTotal: 7 }] }],
      NOW_MS,
    );
    expect(r.timeline).toHaveLength(1);
    expect(r.timeline[0].resTotal).toBe(5);
  });
});
