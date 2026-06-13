// @ts-check

// Unit tests for the pure Galaxy-Scan config domain module: defaults,
// normalisation of partial/legacy blobs, the RescanPolicy projection (the
// bridge to isSystemStale), and the durable-text duration grammar.
//
// Node env, no DOM. A key invariant verified here: the default config's
// rescan policy equals the historical `RESCAN_AFTER` constant — locking the
// new configurable path to the old hard-coded behaviour.

import { describe, it, expect } from 'vitest';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
  buildRescanPolicy,
  parseRescanDuration,
  formatRescanDuration,
  RESCAN_FIELDS,
} from '../../src/domain/galaxyScanConfig.js';
import { RESCAN_AFTER } from '../../src/domain/scheduling.js';

describe('defaultGalaxyScanConfig', () => {
  it('returns the "free positions" preset (positions 8, prefer-other on)', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.positions).toBe('8');
    expect(d.preferOtherGalaxies).toBe(true);
    expect(d.rescan.abandonedEnabled).toBe(true);
    expect(d.rescan.empty).toBe(0); // never, by default
  });

  it('returns a fresh object each call (no shared mutable literal)', () => {
    const a = defaultGalaxyScanConfig();
    const b = defaultGalaxyScanConfig();
    expect(a).not.toBe(b);
    a.rescan.empty = 999;
    expect(b.rescan.empty).toBe(0);
  });
});

describe('buildRescanPolicy', () => {
  it('reproduces RESCAN_AFTER exactly from the default config', () => {
    const policy = buildRescanPolicy(defaultGalaxyScanConfig().rescan);
    // The default `empty` is 0 (never) so it is absent — matching the
    // historical map, which never listed empty/mine/admin.
    expect(policy.rescanAfter).toEqual(RESCAN_AFTER);
    expect(policy.abandonedEnabled).toBe(true);
  });

  it('drops 0-second fields (never) and converts the rest to ms', () => {
    const policy = buildRescanPolicy({
      emptySent: 0,        // never → absent
      empty: 6 * 3600,     // 6h → included (aggressive play)
      reserved: 0,
      inactive: 2 * 86400, // 2d
      longInactive: 0,
      occupied: 0,
      vacation: 0,
      banned: 0,
      abandonedEnabled: false,
    });
    expect(policy.rescanAfter.empty_sent).toBeUndefined();
    expect(policy.rescanAfter.empty).toBe(6 * 3600 * 1000);
    expect(policy.rescanAfter.inactive).toBe(2 * 86400 * 1000);
    expect(policy.abandonedEnabled).toBe(false);
  });
});

describe('normalizeGalaxyScanConfig', () => {
  it('fills a complete config from null / garbage', () => {
    expect(normalizeGalaxyScanConfig(null)).toEqual(defaultGalaxyScanConfig());
    expect(normalizeGalaxyScanConfig('nope')).toEqual(defaultGalaxyScanConfig());
    expect(normalizeGalaxyScanConfig(42)).toEqual(defaultGalaxyScanConfig());
  });

  it('keeps valid fields and fills missing ones from defaults', () => {
    const out = normalizeGalaxyScanConfig({
      positions: '12-15',
      rescan: { inactive: 99 },
    });
    expect(out.positions).toBe('12-15');
    expect(out.preferOtherGalaxies).toBe(true);         // default
    expect(out.rescan.inactive).toBe(99);
    expect(out.rescan.occupied).toBe(30 * 86400);       // default
    expect(out.rescan.abandonedEnabled).toBe(true);     // default
  });

  it('coerces negative / NaN durations back to the default', () => {
    const d = defaultGalaxyScanConfig();
    const out = normalizeGalaxyScanConfig({
      rescan: { reserved: -5, vacation: 'x', emptySent: 0 },
    });
    expect(out.rescan.reserved).toBe(d.rescan.reserved);
    expect(out.rescan.vacation).toBe(d.rescan.vacation);
    expect(out.rescan.emptySent).toBe(0); // explicit 0 is valid (never)
  });

  it('covers every RESCAN_FIELDS key with a number', () => {
    const out = normalizeGalaxyScanConfig({});
    for (const { field } of RESCAN_FIELDS) {
      expect(typeof out.rescan[field]).toBe('number');
    }
  });
});

describe('parseRescanDuration', () => {
  it('treats a bare number as hours', () => {
    expect(parseRescanDuration('6')).toBe(6 * 3600);
    expect(parseRescanDuration(' 24 ')).toBe(24 * 3600);
  });

  it('honours explicit d / h / m units', () => {
    expect(parseRescanDuration('5d')).toBe(5 * 86400);
    expect(parseRescanDuration('6h')).toBe(6 * 3600);
    expect(parseRescanDuration('90m')).toBe(90 * 60);
  });

  it('maps 0 (any unit) to "never"', () => {
    expect(parseRescanDuration('0')).toBe(0);
    expect(parseRescanDuration('0d')).toBe(0);
  });

  it('rejects garbage and negatives with null', () => {
    expect(parseRescanDuration('')).toBeNull();
    expect(parseRescanDuration('abc')).toBeNull();
    expect(parseRescanDuration('-5d')).toBeNull();
    expect(parseRescanDuration('5x')).toBeNull();
  });
});

describe('formatRescanDuration', () => {
  it('prefers the largest whole unit; 0 renders as "0"', () => {
    expect(formatRescanDuration(0)).toBe('0');
    expect(formatRescanDuration(5 * 86400)).toBe('5d');
    expect(formatRescanDuration(6 * 3600)).toBe('6h');
    expect(formatRescanDuration(90 * 60)).toBe('90m');
    expect(formatRescanDuration(45)).toBe('45s');
  });

  it('round-trips through parseRescanDuration for canonical units', () => {
    for (const secs of [0, 6 * 3600, 24 * 3600, 5 * 86400, 30 * 86400]) {
      expect(parseRescanDuration(formatRescanDuration(secs))).toBe(secs);
    }
  });
});
