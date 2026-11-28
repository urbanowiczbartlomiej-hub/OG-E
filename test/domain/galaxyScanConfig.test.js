// @ts-check

// Unit tests for the pure Galaxy-Scan config domain module: defaults and the
// normalisation of partial / legacy / garbage blobs.
//
// Node env, no DOM. §5d removed the per-status "Re-scan after" policy (the
// `rescan` field + buildRescanPolicy / parse·formatRescanDuration / RESCAN_FIELDS
// and the whole scheduling.js staleness machinery): galaxy occupancy is now
// re-derived from the OGame API and colonization state lives in the decision
// log with its own built-in horizons. A legacy `rescan` field on a stored blob
// is now simply ignored.

import { describe, it, expect } from 'vitest';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
  sanitizeGalaxyScanConfigForWire,
  deriveFsGuardian,
} from '../../src/domain/galaxyScanConfig.js';

describe('defaultGalaxyScanConfig', () => {
  it('returns the "free positions" preset (positions 8, prefer-other on)', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.positions).toBe('8');
    expect(d.preferOtherGalaxies).toBe(true);
    expect(d.preferFarthestSystems).toBe(true); // historical behaviour
  });

  it('returns a fresh object each call (no shared mutable literal)', () => {
    const a = defaultGalaxyScanConfig();
    const b = defaultGalaxyScanConfig();
    expect(a).not.toBe(b);
    a.positions = '999';
    expect(b.positions).toBe('8');
  });

  it('carries the colonization knobs (moved here from settingsStore)', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.colonyMinGap).toBe(15);
    expect(d.colonyMinFields).toBe(320);
    expect(d.colonyPassword).toBe('');
  });

  it('carries the fleet-save knobs — detection always on', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.fsEnabled).toBe(true);
    expect(d.fsThreshold).toBe(100000);
    expect(d.fsMinFlightSec).toBe(600);
    expect(d.fsOffsets).toBe('-10m, 0m, 10m');
  });

  it('carries the landed-fleet (guardian) timing that follows from the default times', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.guardianEnabled).toBe(true);
    expect(d.guardianIntervalMin).toBe(10); // first after-landing time
    expect(d.guardianAckIntervalMin).toBe(3); // a quarter of it, rounded
  });
});

describe('normalizeGalaxyScanConfig', () => {
  it('fills a complete config from null / garbage', () => {
    expect(normalizeGalaxyScanConfig(null)).toEqual(defaultGalaxyScanConfig());
    expect(normalizeGalaxyScanConfig('nope')).toEqual(defaultGalaxyScanConfig());
    expect(normalizeGalaxyScanConfig(42)).toEqual(defaultGalaxyScanConfig());
  });

  it('keeps valid fields and fills missing ones from defaults', () => {
    const out = normalizeGalaxyScanConfig({ positions: '12-15' });
    expect(out.positions).toBe('12-15');
    expect(out.preferOtherGalaxies).toBe(true);   // default
    expect(out.preferFarthestSystems).toBe(true); // default
  });

  it('ignores a legacy `rescan` field (§5d removed it)', () => {
    const out = normalizeGalaxyScanConfig({
      positions: '12-15',
      rescan: { inactive: 99 },
    });
    expect(out.positions).toBe('12-15');
    expect(/** @type {any} */ (out).rescan).toBeUndefined();
    // The normalised config has exactly the surviving keys.
    expect(out).toEqual({ ...defaultGalaxyScanConfig(), positions: '12-15' });
  });

  it('keeps an explicit preferFarthestSystems:false but coerces garbage to the default', () => {
    expect(normalizeGalaxyScanConfig({ preferFarthestSystems: false }).preferFarthestSystems).toBe(false);
    expect(normalizeGalaxyScanConfig({ preferFarthestSystems: 'yes' }).preferFarthestSystems).toBe(true);
  });

  it('keeps an explicit preferOtherGalaxies:false but coerces garbage to the default', () => {
    expect(normalizeGalaxyScanConfig({ preferOtherGalaxies: false }).preferOtherGalaxies).toBe(false);
    expect(normalizeGalaxyScanConfig({ preferOtherGalaxies: 'yes' }).preferOtherGalaxies).toBe(true);
  });

  it('keeps / coerces the colonization knobs', () => {
    const d = defaultGalaxyScanConfig();
    const out = normalizeGalaxyScanConfig({
      colonyMinGap: '30',
      colonyMinFields: 'bad',
      colonyPassword: 'hunter2',
    });
    expect(out.colonyMinGap).toBe(30);                   // coerced from string
    expect(out.colonyMinFields).toBe(d.colonyMinFields); // NaN → default
    expect(out.colonyPassword).toBe('hunter2');
    // Missing → defaults.
    const bare = normalizeGalaxyScanConfig({});
    expect(bare.colonyMinGap).toBe(d.colonyMinGap);
    expect(bare.colonyPassword).toBe('');
  });

  it('coerces negative colonyMinGap back to the default', () => {
    const d = defaultGalaxyScanConfig();
    expect(normalizeGalaxyScanConfig({ colonyMinGap: -5 }).colonyMinGap).toBe(d.colonyMinGap);
  });

  it('keeps / coerces the fleet-save knobs; detection has no off switch', () => {
    const d = defaultGalaxyScanConfig();
    const out = normalizeGalaxyScanConfig({
      fsEnabled: false, // a stored "off" from an older build is ignored
      fsThreshold: '50000',
      fsMinFlightSec: -5,
      fsOffsets: '-5m, 0m, 20m',
    });
    expect(out.fsEnabled).toBe(true);
    expect(out.fsThreshold).toBe(50000);               // coerced from string
    expect(out.fsMinFlightSec).toBe(d.fsMinFlightSec); // negative → default
    expect(out.fsOffsets).toBe('-5m, 0m, 20m');
    // Non-string offsets fall back to the defaults.
    expect(normalizeGalaxyScanConfig({ fsOffsets: 42 }).fsOffsets).toBe(d.fsOffsets);
    expect(normalizeGalaxyScanConfig({}).fsThreshold).toBe(d.fsThreshold);
  });

  it('the landed-fleet timing is derived from the times, never taken from storage', () => {
    const out = normalizeGalaxyScanConfig({
      fsOffsets: '-5m, 0m, 20m, 40m',
      guardianEnabled: false,
      guardianIntervalMin: 99,
      guardianAckIntervalMin: 99,
    });
    expect(out.guardianEnabled).toBe(true);
    expect(out.guardianIntervalMin).toBe(20);   // FIRST after-landing time
    expect(out.guardianAckIntervalMin).toBe(5); // a quarter of it
  });
});

describe('deriveFsGuardian', () => {
  it('adds the default after-landing time when the list has none', () => {
    expect(deriveFsGuardian('-10m, 0m')).toEqual({
      fsOffsets: '-10m, 0m, 10m', guardianIntervalMin: 10, guardianAckIntervalMin: 3,
    });
    expect(deriveFsGuardian('').fsOffsets).toBe('10m');
  });

  it('leaves a list that already has one untouched; ACK is at least a minute', () => {
    expect(deriveFsGuardian('0m, 2m')).toEqual({
      fsOffsets: '0m, 2m', guardianIntervalMin: 2, guardianAckIntervalMin: 1,
    });
  });
});

describe('sanitizeGalaxyScanConfigForWire — colonyPassword is device-local', () => {
  it('blanks the password, keeps every other knob, and never mutates the input', () => {
    const cfg = normalizeGalaxyScanConfig({ colonyPassword: 'hunter2', fsThreshold: 9 });
    const wire = sanitizeGalaxyScanConfigForWire(cfg);
    expect(wire.colonyPassword).toBe('');
    expect(wire.fsThreshold).toBe(9);
    expect(cfg.colonyPassword).toBe('hunter2'); // input untouched
    // The field stays PRESENT ('' = unset) so any version normalises cleanly.
    expect(normalizeGalaxyScanConfig(wire).colonyPassword).toBe('');
  });
});

describe('normalizeGalaxyScanConfig — planet size bonus', () => {
  it('defaults to "not read yet"', () => {
    const cfg = normalizeGalaxyScanConfig(null);
    expect(cfg.colonySizeBonus).toBe(0);
    expect(cfg.colonyBonusReadAt).toBe(0);
  });

  it('keeps a read bonus, rounded to 2 decimals, and rejects garbage', () => {
    expect(normalizeGalaxyScanConfig({ colonySizeBonus: 20.3691 }).colonySizeBonus).toBe(20.37);
    expect(normalizeGalaxyScanConfig({ colonySizeBonus: '19,7' }).colonySizeBonus).toBe(19.7);
    expect(normalizeGalaxyScanConfig({ colonySizeBonus: -5 }).colonySizeBonus).toBe(0);
    expect(normalizeGalaxyScanConfig({ colonySizeBonus: 'abc' }).colonySizeBonus).toBe(0);
  });
});
