// @ts-check

import { describe, it, expect } from 'vitest';
import { scanStatus, needsScan, rescanAtFor, pruneRescan, SPY_STALE_MS } from '../../src/domain/spyScan.js';

// A fixed "now" used everywhere — never call Date.now() in a pure-logic test.
const NOW = 1_000_000_000_000;

describe('SPY_STALE_MS', () => {
  it('is 7 days in milliseconds', () => {
    expect(SPY_STALE_MS).toBe(7 * 24 * 3600 * 1000);
    expect(SPY_STALE_MS).toBe(604_800_000);
  });
});

describe('scanStatus', () => {
  it("returns 'none' when there is no report", () => {
    expect(scanStatus({ nowMs: NOW })).toBe('none');
    expect(scanStatus({ reportTsSec: undefined, nowMs: NOW })).toBe('none');
    expect(scanStatus({ reportTsSec: 0, nowMs: NOW })).toBe('none');
    expect(scanStatus({ reportTsSec: -5, nowMs: NOW })).toBe('none');
  });

  it("returns 'fresh' for a recent report not flagged for re-scan", () => {
    const reportTsSec = NOW / 1000 - 60; // one minute ago
    expect(scanStatus({ reportTsSec, nowMs: NOW })).toBe('fresh');
  });

  it("treats a report exactly at the stale threshold as still 'fresh'", () => {
    // nowMs - reportMs === staleMs is NOT strictly greater, so still fresh.
    const reportMs = NOW - SPY_STALE_MS;
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW })).toBe('fresh');
  });

  it("returns 'stale' for a report older than the default threshold", () => {
    const reportMs = NOW - SPY_STALE_MS - 1000; // one second past stale
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW })).toBe('stale');
  });

  it('honours a custom staleMs threshold', () => {
    const staleMs = 60 * 1000; // one minute
    const reportFreshSec = NOW / 1000 - 30; // 30s ago
    const reportStaleSec = NOW / 1000 - 120; // 2 min ago
    expect(scanStatus({ reportTsSec: reportFreshSec, nowMs: NOW, staleMs })).toBe('fresh');
    expect(scanStatus({ reportTsSec: reportStaleSec, nowMs: NOW, staleMs })).toBe('stale');
  });

  it("returns 'rescan' when the report predates the rescan mark", () => {
    const reportMs = NOW - 1000; // recent report
    const rescanAtMs = NOW; // re-scan requested after the report
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs })).toBe('rescan');
  });

  it("does NOT flag 'rescan' when the report is newer than the rescan mark", () => {
    const reportMs = NOW - 1000;
    const rescanAtMs = NOW - 5000; // re-scan mark predates the report → cleared
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs })).toBe('fresh');
  });

  it("treats a report exactly at the rescan mark as NOT a rescan", () => {
    // reportMs < rescanAtMs is strict, so equality does not trigger rescan.
    const reportMs = NOW - 1000;
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs: reportMs })).toBe('fresh');
  });

  it("'rescan' takes precedence over 'stale'", () => {
    const reportMs = NOW - SPY_STALE_MS - 10_000; // old enough to be stale
    const rescanAtMs = NOW; // and flagged for re-scan
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs })).toBe('rescan');
  });

  it("'rescan' takes precedence over 'fresh'", () => {
    const reportMs = NOW - 60_000; // recent → would be fresh
    const rescanAtMs = NOW;
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs })).toBe('rescan');
  });

  it('ignores a zero rescan mark (no re-scan requested)', () => {
    const reportMs = NOW - 60_000;
    expect(scanStatus({ reportTsSec: reportMs / 1000, nowMs: NOW, rescanAtMs: 0 })).toBe('fresh');
  });
});

describe('needsScan', () => {
  it("is false only for 'fresh'", () => {
    expect(needsScan('fresh')).toBe(false);
    expect(needsScan('none')).toBe(true);
    expect(needsScan('stale')).toBe(true);
    expect(needsScan('rescan')).toBe(true);
  });
});

describe('rescanAtFor', () => {
  const playerId = 'p123';
  const coord = '1:2:3';

  it('returns 0 when the map is undefined', () => {
    expect(rescanAtFor(undefined, playerId, coord)).toBe(0);
  });

  it('returns 0 when neither key is present', () => {
    expect(rescanAtFor({}, playerId, coord)).toBe(0);
    expect(rescanAtFor({ other: 5 }, playerId, coord)).toBe(0);
  });

  it('returns the player-keyed mark when only that is set', () => {
    expect(rescanAtFor({ [playerId]: 42 }, playerId, coord)).toBe(42);
  });

  it('returns the coord-keyed mark when only that is set', () => {
    expect(rescanAtFor({ [coord]: 77 }, playerId, coord)).toBe(77);
  });

  it('returns the later of the two when both are set', () => {
    expect(rescanAtFor({ [playerId]: 10, [coord]: 99 }, playerId, coord)).toBe(99);
    expect(rescanAtFor({ [playerId]: 99, [coord]: 10 }, playerId, coord)).toBe(99);
  });

  it('treats a falsy/zero value as absent', () => {
    expect(rescanAtFor({ [playerId]: 0, [coord]: 0 }, playerId, coord)).toBe(0);
    expect(rescanAtFor({ [playerId]: 0, [coord]: 5 }, playerId, coord)).toBe(5);
  });
});

describe('pruneRescan', () => {
  it('returns the SAME object reference when every entry is recent (nothing to prune)', () => {
    const rescan = {
      p1: NOW - 1000, // just now
      '1:2:3': NOW - SPY_STALE_MS, // exactly at the horizon → still kept
    };
    const out = pruneRescan(rescan, NOW);
    expect(out).toBe(rescan); // identity: no-op skips the copy
    expect(out).toEqual({ p1: NOW - 1000, '1:2:3': NOW - SPY_STALE_MS });
  });

  it('drops entries older than the 7-day horizon, keeping the recent ones', () => {
    const rescan = {
      stale: NOW - SPY_STALE_MS - 1, // one ms past the horizon → pruned
      fresh: NOW - 60_000, // a minute ago → kept
    };
    const out = pruneRescan(rescan, NOW);
    expect(out).not.toBe(rescan); // a new object, since something was pruned
    expect(out).toEqual({ fresh: NOW - 60_000 });
  });

  it('honours a custom (shorter) staleMs that the default horizon would keep', () => {
    const staleMs = 60 * 60 * 1000; // one hour
    const rescan = {
      recent: NOW - 30 * 60 * 1000, // 30 min ago → within the hour, kept
      old: NOW - 2 * 60 * 60 * 1000, // 2 h ago → past the hour, pruned…
    };
    // …but the default 7-day horizon would keep BOTH, so this proves staleMs is used.
    expect(pruneRescan(rescan, NOW)).toBe(rescan);
    const out = pruneRescan(rescan, NOW, staleMs);
    expect(out).not.toBe(rescan);
    expect(out).toEqual({ recent: NOW - 30 * 60 * 1000 });
  });

  it('returns the same (empty) reference for an empty map', () => {
    const rescan = /** @type {Record<string, number>} */ ({});
    expect(pruneRescan(rescan, NOW)).toBe(rescan);
  });

  it('keeps an entry exactly at the cutoff boundary (test is strictly <)', () => {
    // value === nowMs - staleMs is NOT < cutoff, so it is retained.
    const rescan = { edge: NOW - SPY_STALE_MS };
    const out = pruneRescan(rescan, NOW);
    expect(out).toBe(rescan); // nothing pruned → same reference
    expect(out).toEqual({ edge: NOW - SPY_STALE_MS });
  });
});
