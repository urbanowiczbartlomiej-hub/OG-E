// Unit tests for domain/presenceLedger.js — the long-horizon day×hour
// presence memory (bit masks) behind the dossier's offline-pattern explorer
// and the alliance pool. The suite pins the properties the rest of the system
// leans on:
//
//   1. FOLD sets exactly one bit per probe, active DOMINATES quiet for the
//      same hour of the same day, and re-folding is a structural no-op (the
//      idempotence that lets folds run on any cadence);
//   2. MERGE is a per-day bitwise OR — commutative, idempotent, monotonic
//      (the convergence device-sync + alliance pooling rely on);
//   3. SWEEP drops days past the retention horizon;
//   4. the wire codec round-trips and is tolerant of junk;
//   5. AGGREGATE folds onto a local-time phase grid with day-deduped
//      active/quiet/observed counts.
//
// Time note: aggregate buckets by LOCAL getDay()/getHours()/getDate(), so the
// grid-placement assertions here stay coarse (observed-day totals, not exact
// cells) to remain timezone-independent; the bit-level fold/merge/pack tests
// are UTC and exact.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  foldProbesIntoLedger,
  mergePresenceLedgers,
  mergePresenceLedgerMaps,
  sweepPresenceLedger,
  sweepPresenceLedgerMap,
  packPresenceLedger,
  unpackPresenceLedger,
  aggregateLedger,
  LEDGER_KEEP_DAYS,
} from '../../src/domain/presenceLedger.js';

/** @typedef {import('../../src/domain/presenceLedger.js').PresenceLedger} PresenceLedger */

const DAY_S = 86400;
const HOUR_S = 3600;
/** Epoch-seconds at hour `h` of epoch-day `day`. @param {number} day @param {number} h */
const at = (day, h) => day * DAY_S + h * HOUR_S;
/** Contextually type a `[active, quiet]`-tuple ledger literal. @param {Record<string, [number, number]>} m @returns {PresenceLedger} */
const led = (m) => m;
/** Contextually type a pid→ledger map literal. @param {Record<string, Record<string, [number, number]>>} m @returns {Record<string, PresenceLedger>} */
const ledMap = (m) => m;

describe('foldProbesIntoLedger', () => {
  it('sets one bit per probe: active on online, quiet on offline', () => {
    const { merged, changed } = foldProbesIntoLedger({}, [
      { tSec: at(20000, 14), online: true },
      { tSec: at(20000, 3), online: false },
    ]);
    expect(changed).toBe(true);
    // bit14 active, bit3 quiet.
    expect(merged['20000']).toEqual([1 << 14, 1 << 3]);
  });

  it('active DOMINATES quiet for the same hour of the same day (either order)', () => {
    const quietThenActive = foldProbesIntoLedger({}, [
      { tSec: at(20000, 9), online: false },
      { tSec: at(20000, 9) + 30, online: true },
    ]).merged['20000'];
    const activeThenQuiet = foldProbesIntoLedger({}, [
      { tSec: at(20000, 9), online: true },
      { tSec: at(20000, 9) + 30, online: false },
    ]).merged['20000'];
    expect(quietThenActive).toEqual([1 << 9, 0]);
    expect(activeThenQuiet).toEqual([1 << 9, 0]);
  });

  it('re-folding already-folded probes is a no-op (idempotent, same reference)', () => {
    const first = foldProbesIntoLedger({}, [{ tSec: at(20000, 14), online: true }]).merged;
    const again = foldProbesIntoLedger(first, [{ tSec: at(20000, 14), online: true }]);
    expect(again.changed).toBe(false);
    expect(again.merged).toBe(first);
  });

  it('ignores non-finite / non-positive probe times', () => {
    const { changed } = foldProbesIntoLedger({}, [
      { tSec: 0, online: true }, { tSec: -5, online: false }, { tSec: NaN, online: true },
    ]);
    expect(changed).toBe(false);
  });
});

describe('mergePresenceLedgers', () => {
  it('ORs per day and reports changed only when a NEW bit arrives', () => {
    const local = led({ 20000: [1 << 14, 0] });
    const first = mergePresenceLedgers(local, led({ 20000: [1 << 2, 1 << 3] }));
    expect(first.changed).toBe(true);
    expect(first.merged['20000']).toEqual([(1 << 14) | (1 << 2), 1 << 3]);
    // Re-merging the same contribution adds nothing.
    const again = mergePresenceLedgers(first.merged, led({ 20000: [1 << 2, 1 << 3] }));
    expect(again.changed).toBe(false);
    expect(again.merged).toBe(first.merged);
  });

  it('is commutative (OR)', () => {
    const a = led({ 20000: [1 << 1, 1 << 2], 20001: [1 << 5, 0] });
    const b = led({ 20000: [1 << 3, 0], 20002: [0, 1 << 6] });
    const ab = mergePresenceLedgers(a, b).merged;
    const ba = mergePresenceLedgers(b, a).merged;
    expect(ab).toEqual(ba);
  });

  it('map-level merge folds every pid', () => {
    const { merged, changed } = mergePresenceLedgerMaps(
      ledMap({ p1: { 20000: [1, 0] } }),
      ledMap({ p1: { 20000: [2, 0] }, p2: { 20001: [4, 0] } }),
    );
    expect(changed).toBe(true);
    expect(merged.p1['20000']).toEqual([3, 0]);
    expect(merged.p2['20001']).toEqual([4, 0]);
  });
});

describe('sweep', () => {
  it('drops days older than the keep horizon', () => {
    const now = at(20000, 0);
    const swept = sweepPresenceLedger(
      led({ [String(20000 - LEDGER_KEEP_DAYS - 1)]: [1, 0], 20000: [1, 0] }),
      now,
    );
    expect(Object.keys(swept)).toEqual(['20000']);
  });

  it('map sweep drops emptied pids', () => {
    const now = at(20000, 0);
    const swept = sweepPresenceLedgerMap(
      ledMap({ stale: { [String(20000 - LEDGER_KEEP_DAYS - 5)]: [1, 0] }, live: { 20000: [1, 0] } }),
      now,
    );
    expect(Object.keys(swept)).toEqual(['live']);
  });
});

describe('wire codec', () => {
  it('round-trips through pack/unpack', () => {
    const ledger = foldProbesIntoLedger({}, [
      { tSec: at(20000, 14), online: true },
      { tSec: at(20000, 3), online: false },
      { tSec: at(19990, 22), online: true },
    ]).merged;
    const packed = packPresenceLedger(ledger, at(20000, 23), 400);
    expect(typeof packed).toBe('string');
    expect(unpackPresenceLedger(packed)).toEqual(ledger);
  });

  it('trims to the share horizon on pack', () => {
    const ledger = led({ 20000: [1, 0], [String(20000 - 500)]: [1, 0] });
    const packed = packPresenceLedger(ledger, at(20000, 0), 180);
    expect(Object.keys(unpackPresenceLedger(packed))).toEqual(['20000']);
  });

  it('unpack tolerates junk (never throws, drops bad rows)', () => {
    expect(unpackPresenceLedger('not a real row')).toEqual({});
    expect(unpackPresenceLedger(123)).toEqual({});
    expect(unpackPresenceLedger('')).toEqual({});
  });
});

describe('aggregateLedger', () => {
  it('counts observed/active days and places them on a phase grid', () => {
    // Two days, both with an active hour; range = all.
    const ledger = foldProbesIntoLedger({}, [
      { tSec: at(20000, 14), online: true },
      { tSec: at(20001, 15), online: false },
    ]).merged;
    const agg = aggregateLedger(ledger, at(20002, 0), { phase: 'weekHour', rangeDays: 0 });
    expect(agg.observedDays).toBe(2);
    expect(agg.activeDays).toBe(1);
    expect(agg.rows).toBe(7);
    expect(agg.cols).toBe(24);
    let observedCells = 0;
    for (const row of agg.cells) for (const c of row) observedCells += c.observed;
    expect(observedCells).toBeGreaterThan(0);
  });

  it('monthDay phase is 1×31; dayHour is 1×24', () => {
    const ledger = led({ 20000: [1 << 12, 0] });
    expect(aggregateLedger(ledger, at(20001, 0), { phase: 'monthDay' }).cols).toBe(31);
    expect(aggregateLedger(ledger, at(20001, 0), { phase: 'dayHour' }).rows).toBe(1);
  });

  it('respects the range window', () => {
    const ledger = led({ 20000: [1, 0], [String(20000 - 100)]: [1, 0] });
    const agg = aggregateLedger(ledger, at(20000, 12), { phase: 'dayHour', rangeDays: 30 });
    expect(agg.observedDays).toBe(1);
  });
});
