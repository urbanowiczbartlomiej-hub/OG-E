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

  it('carries the fleet-save alarmClock knobs (moved here from settingsStore, B3)', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.fsEnabled).toBe(false);
    expect(d.fsThreshold).toBe(100000);
    expect(d.fsMinFlightSec).toBe(600);
    expect(d.fsOffsets).toBe('-10m, 0m, 10m');
  });

  it('carries the bare-fleet guardian knobs', () => {
    const d = defaultGalaxyScanConfig();
    expect(d.guardianEnabled).toBe(true);
    expect(d.guardianIntervalMin).toBe(20);
    expect(d.guardianAckIntervalMin).toBe(3);
  });

  it('shows the Colonize FAB module by default (showFabButton)', () => {
    expect(defaultGalaxyScanConfig().showFabButton).toBe(true);
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

  it('keeps an explicit showFabButton:false but coerces garbage / absent to shown', () => {
    expect(normalizeGalaxyScanConfig({ showFabButton: false }).showFabButton).toBe(false);
    expect(normalizeGalaxyScanConfig({ showFabButton: 'off' }).showFabButton).toBe(true);
    // A pre-1.40.1 stored blob has no such key — the button must stay visible.
    expect(normalizeGalaxyScanConfig({ positions: '8' }).showFabButton).toBe(true);
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

  it('keeps / coerces the fleet-save alarmClock knobs (B3)', () => {
    const d = defaultGalaxyScanConfig();
    const out = normalizeGalaxyScanConfig({
      fsEnabled: true,
      fsThreshold: '50000',
      fsMinFlightSec: -5,
      fsOffsets: '-5m, 0m',
    });
    expect(out.fsEnabled).toBe(true);
    expect(out.fsThreshold).toBe(50000);               // coerced from string
    expect(out.fsMinFlightSec).toBe(d.fsMinFlightSec); // negative → default
    expect(out.fsOffsets).toBe('-5m, 0m');
    // Non-boolean enable / non-string offsets fall back to defaults.
    const bad = normalizeGalaxyScanConfig({ fsEnabled: 'yes', fsOffsets: 42 });
    expect(bad.fsEnabled).toBe(false);
    expect(bad.fsOffsets).toBe(d.fsOffsets);
    // Missing → defaults.
    const bare = normalizeGalaxyScanConfig({});
    expect(bare.fsEnabled).toBe(false);
    expect(bare.fsThreshold).toBe(d.fsThreshold);
  });

  it('keeps / coerces the guardian knobs', () => {
    const d = defaultGalaxyScanConfig();
    const out = normalizeGalaxyScanConfig({
      guardianEnabled: false,
      guardianIntervalMin: '45',
      guardianAckIntervalMin: -1,
    });
    expect(out.guardianEnabled).toBe(false);
    expect(out.guardianIntervalMin).toBe(45);                       // coerced from string
    expect(out.guardianAckIntervalMin).toBe(d.guardianAckIntervalMin); // negative → default
  });
});
