// @ts-check

// Unit tests for the ONE-TIME timestamp unit repair on persisted espionage
// report maps. Reports recorded before the unit fix stored `timestamp` in
// MILLISECONDS while every consumer expects SECONDS, so their staleness always
// read as fresh. `normalizeReportTimestamps` rewrites any value above 1e11
// (only explicable as ms) down to seconds, and is otherwise a data-preserving
// identity. Pure node — plain object fixtures, no DOM.

import { describe, it, expect } from 'vitest';
import { normalizeReportTimestamps as normalizeReal } from '../../src/domain/espionageReport.js';

/**
 * The fixtures below are intentionally partial SpyReport shapes (`timestamp`
 * only) plus deliberately malformed buckets — the whole point of the unit. Cast
 * past the strict `SpyReport` param without weakening the return typing.
 * @param {any} reports
 */
const normalizeReportTimestamps = (reports) => normalizeReal(reports);

describe('normalizeReportTimestamps', () => {
  it('converts a millisecond timestamp (> 1e11) to seconds', () => {
    const ms = 1782405308000; // seconds ×1000
    const out = normalizeReportTimestamps({
      '115886': { '4:470:15:1': { playerId: 115886, timestamp: ms } },
    });
    expect(out['115886']['4:470:15:1'].timestamp).toBe(1782405308);
  });

  it('rounds a fractional millisecond conversion', () => {
    const out = normalizeReportTimestamps({
      p: { k: { timestamp: 1782405308500 } }, // /1000 = 1782405308.5 → 1782405309
    });
    expect(out.p.k.timestamp).toBe(1782405309);
  });

  it('leaves a seconds timestamp unchanged and returns the input identity', () => {
    const reports = {
      '1': { a: { playerId: 1, timestamp: 1782405308 } }, // already seconds (< 1e11)
    };
    const out = normalizeReportTimestamps(reports);
    // Nothing needed fixing → the exact same reference comes back.
    expect(out).toBe(reports);
    expect(out['1'].a.timestamp).toBe(1782405308);
  });

  it('passes a malformed/null report entry THROUGH the bucket (never dropped)', () => {
    const reports = {
      p: {
        good: { timestamp: 9999999999999 }, // ms → gets fixed
        bad: /** @type {any} */ (null), // malformed entry — must survive
        noTs: /** @type {any} */ ({ playerId: 5 }), // no numeric timestamp — kept as-is
      },
    };
    const out = normalizeReportTimestamps(reports);
    // The whole set of keys is preserved — nothing silently dropped.
    expect(Object.keys(out.p).sort()).toEqual(['bad', 'good', 'noTs']);
    expect(out.p.bad).toBeNull();
    expect(out.p.noTs).toEqual({ playerId: 5 });
    // And the good one was still converted.
    expect(out.p.good.timestamp).toBe(Math.round(9999999999999 / 1000));
  });

  it('passes a malformed (non-object) bucket through untouched', () => {
    const reports = {
      ok: { k: { timestamp: 9999999999999 } }, // forces changed=true so we return `out`
      broken: /** @type {any} */ (null),
      alsoBroken: /** @type {any} */ ('not-an-object'),
    };
    const out = normalizeReportTimestamps(reports);
    expect(out.broken).toBeNull();
    expect(out.alsoBroken).toBe('not-an-object');
  });

  it('returns the SAME object reference when nothing needs changing', () => {
    const reports = { p: { k: { timestamp: 1782405308 } } }; // seconds, no fix
    expect(normalizeReportTimestamps(reports)).toBe(reports);
  });

  it('returns a NEW top-level object when at least one report is rewritten', () => {
    const reports = { p: { k: { timestamp: 1782405308000 } } }; // ms → fixed
    const out = normalizeReportTimestamps(reports);
    expect(out).not.toBe(reports);
    // The original is left untouched (pure) — the ms value is intact upstream.
    expect(reports.p.k.timestamp).toBe(1782405308000);
  });

  it('clones only the bucket that changed; untouched buckets keep their identity', () => {
    const clean = { c: { timestamp: 1782405308 } }; // all-seconds bucket
    const dirty = { d: { timestamp: 1782405308000 } }; // has an ms report
    const out = normalizeReportTimestamps({ clean, dirty });
    // The clean bucket is returned by reference (never rewritten)…
    expect(out.clean).toBe(clean);
    // …while the dirty bucket is a fresh clone (the original is not mutated).
    expect(out.dirty).not.toBe(dirty);
    expect(dirty.d.timestamp).toBe(1782405308000);
    expect(out.dirty.d.timestamp).toBe(1782405308);
  });
});
