// @ts-check

// Unit tests for domain/raidVerdict — the pure raid-or-skip decision core of the
// Spyglass redesign. Every case drives plain fixtures (profile / estimate /
// reports / inBand / nowMs) and asserts the returned verdict shape (kind, label,
// tier, lootNow…). No DOM, no time of its own — pure node.

import { describe, it, expect } from 'vitest';
import { raidVerdict } from '../../src/domain/raidVerdict.js';

// Thresholds mirrored from the module (kept in sync via the header consts there).
const FRESH_MS = 12 * 60 * 60 * 1000; // 12 h
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 d
const FLEET_RISK_FLOOR = 30_000;

/** A report fat enough to clear LOOT_FLOOR at the default 50% plunder. */
function fatReport(over = {}) {
  return {
    galaxy: 1, system: 2, position: 3, planetType: 1, playerId: 7,
    defenseValue: 0, fleetValue: 0, resources: 2_000_000, timestamp: 0, ...over,
  };
}

describe('raidVerdict — gating branches (priority order)', () => {
  it('friendly player is never a target (wins over everything)', () => {
    const v = raidVerdict({
      profile: /** @type {any} */ ({ friendly: true, mobileHi: 999_999 }),
      estimate: /** @type {any} */ ({ hiddenFleetPoints: 999_999 }),
      reports: [fatReport()],
      inBand: false,
      nowMs: 0,
    });
    expect(v.kind).toBe('friendly');
    expect(v.label).toBe('friendly');
    expect(v.tier).toBe('high');
    expect(v.lootNow).toBe(0);
    expect(v.reasons).toContain('your alliance / buddy');
  });

  it('inBand === false → cant-hit (before scan/loot are considered)', () => {
    const v = raidVerdict({ reports: [fatReport()], inBand: false });
    expect(v.kind).toBe('cant-hit');
    expect(v.label).toBe("can't hit");
    expect(v.tier).toBe('high');
    expect(v.lootNow).toBe(0);
    expect(v.reasons).toEqual(['outside your attack band']);
  });

  it('inBand undefined is NOT asserted (band unknown → falls through to loot)', () => {
    const v = raidVerdict({ reports: [fatReport()], nowMs: 0 });
    expect(v.kind).toBe('raid');
  });

  it('no reports at all → scan first (low tier)', () => {
    const v = raidVerdict({ inBand: true, nowMs: 0 });
    expect(v.kind).toBe('scan');
    expect(v.label).toBe('scan first');
    expect(v.tier).toBe('low');
    expect(v.lootNow).toBe(0);
    expect(v.reasons).toEqual(['never spied']);
  });

  it('empty reports array is treated the same as no reports', () => {
    expect(raidVerdict({ reports: [] }).kind).toBe('scan');
  });
});

describe('raidVerdict — loot estimate composition', () => {
  it('picks the fattest single body, applies default 50% plunder, records its coord', () => {
    const v = raidVerdict({
      reports: [
        fatReport({ galaxy: 1, system: 2, position: 3, resources: 1_000_000 }),
        fatReport({ galaxy: 4, system: 5, position: 6, resources: 3_000_000 }),
      ],
      nowMs: 0,
    });
    expect(v.lootNow).toBe(1_500_000); // 3M × 50%
    expect(v.lootCoord).toBe('4:5:6');
  });

  it('honours a per-report lootPct over the default', () => {
    const v = raidVerdict({
      reports: [fatReport({ resources: 4_000_000, lootPct: 25 })],
      nowMs: 0,
    });
    expect(v.lootNow).toBe(1_000_000); // 4M × 25%
  });

  it('ignores non-positive / non-finite resource figures', () => {
    const v = raidVerdict({
      reports: [
        fatReport({ resources: 0 }),
        fatReport({ resources: -5 }),
        fatReport({ resources: Number.NaN }),
        fatReport({ galaxy: 9, system: 9, position: 9, resources: 2_000_000 }),
      ],
      nowMs: 0,
    });
    expect(v.lootNow).toBe(1_000_000);
    expect(v.lootCoord).toBe('9:9:9');
  });

  it('reports with no usable resources at all → loot 0 → empty, no coord/age', () => {
    const v = raidVerdict({ reports: [fatReport({ resources: undefined })], nowMs: 0 });
    expect(v.kind).toBe('empty');
    expect(v.lootNow).toBe(0);
    expect(v.lootCoord).toBeUndefined();
    expect(v.ageMs).toBeUndefined();
  });
});

describe('raidVerdict — confidence tiering from intel age', () => {
  it('fresh intel (< 12h) → high tier, ageMs computed from timestamp (s→ms)', () => {
    const now = 100 * 60 * 60 * 1000; // 100 h in ms
    const v = raidVerdict({ reports: [fatReport({ timestamp: now / 1000 - 3600 })], nowMs: now });
    expect(v.tier).toBe('high');
    expect(v.ageMs).toBe(3600 * 1000); // 1 h old
  });

  it('mid-age intel (12h–3d) → medium tier', () => {
    const now = STALE_MS + FRESH_MS;
    const v = raidVerdict({ reports: [fatReport({ timestamp: (now - FRESH_MS - 1000) / 1000 })], nowMs: now });
    expect(v.tier).toBe('medium');
  });

  it('stale intel (> 3d) → low tier', () => {
    const now = 10 * STALE_MS;
    const v = raidVerdict({ reports: [fatReport({ timestamp: (now - STALE_MS - 1000) / 1000 })], nowMs: now });
    expect(v.tier).toBe('low');
  });

  it('ageMs never goes negative when a report is timestamped in the future', () => {
    const v = raidVerdict({ reports: [fatReport({ timestamp: 10_000 })], nowMs: 0 });
    expect(v.ageMs).toBe(0);
    expect(v.tier).toBe('high');
  });
});

describe('raidVerdict — final raid/empty/loaded-risky decision', () => {
  it('below the loot floor → skip — empty (carries loot fields + tier)', () => {
    const v = raidVerdict({ reports: [fatReport({ resources: 200_000 })], nowMs: 0 });
    expect(v.kind).toBe('empty');
    expect(v.label).toBe('skip — empty');
    expect(v.lootNow).toBe(100_000); // < LOOT_FLOOR
    expect(v.lootCoord).toBe('1:2:3');
    expect(v.reasons).toEqual(['little to steal right now']);
  });

  it('loaded + a hidden fleet at/above the risk floor → loaded · fleet risk', () => {
    const v = raidVerdict({
      estimate: /** @type {any} */ ({ hiddenFleetPoints: FLEET_RISK_FLOOR }),
      reports: [fatReport()],
      nowMs: 0,
    });
    expect(v.kind).toBe('loaded-risky');
    expect(v.label).toBe('loaded · fleet risk');
    expect(v.lootNow).toBe(1_000_000);
    expect(v.reasons).toEqual(['loaded, but a mobile fleet could bounce the raid']);
  });

  it('fleet risk also comes from the profile mobile-fleet ceiling (max of the two)', () => {
    const v = raidVerdict({
      profile: /** @type {any} */ ({ mobileHi: FLEET_RISK_FLOOR + 1 }),
      estimate: /** @type {any} */ ({ hiddenFleetPoints: 0 }),
      reports: [fatReport()],
      nowMs: 0,
    });
    expect(v.kind).toBe('loaded-risky');
  });

  it('loaded + low fleet risk → RAID NOW', () => {
    const v = raidVerdict({
      profile: /** @type {any} */ ({ mobileHi: FLEET_RISK_FLOOR - 1 }),
      estimate: /** @type {any} */ ({ hiddenFleetPoints: FLEET_RISK_FLOOR - 1 }),
      reports: [fatReport()],
      nowMs: 0,
    });
    expect(v.kind).toBe('raid');
    expect(v.label).toBe('RAID NOW');
    expect(v.lootNow).toBe(1_000_000);
    expect(v.reasons).toEqual(['loaded, low fleet risk']);
  });

  it('empty check beats fleet risk: little loot + huge fleet is still "empty"', () => {
    const v = raidVerdict({
      estimate: /** @type {any} */ ({ hiddenFleetPoints: 10 * FLEET_RISK_FLOOR }),
      reports: [fatReport({ resources: 100_000 })],
      nowMs: 0,
    });
    expect(v.kind).toBe('empty');
  });
});
