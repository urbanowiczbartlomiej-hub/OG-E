// @ts-check

// Unit tests for domain/targetReports — the pure accessors + projection that
// insulate every reader from the store-migration keystone: a persisted per-body
// entry is EITHER the new `{latest, history}` shape OR a legacy bare `SpyReport`.
// Both `latestOf` / `historyOf` must tolerate BOTH, and `toLite` must gate
// defence/fleet on `revealed` (absent → legacy full reveal). Pure node, no DOM.

import { describe, it, expect } from 'vitest';
import { latestOf, historyOf, toLite, HISTORY_CAP } from '../../src/domain/targetReports.js';

/** A minimal full SpyReport fixture; override fields per case. */
function makeReport(over = {}) {
  return {
    galaxy: 1,
    system: 203,
    position: 4,
    planetType: 1,
    playerId: 42,
    timestamp: 1700000000,
    defenseValue: 5000,
    fleetValue: 12000,
    resources: 340000,
    activityMin: 15,
    revealed: { resources: true, fleet: true, defense: true, buildings: true, research: true },
    ...over,
  };
}

describe('latestOf', () => {
  it('returns .latest on the new {latest, history} shape', () => {
    const latest = makeReport();
    const entry = { latest, history: [] };
    expect(latestOf(entry)).toBe(latest);
  });

  it('returns the report itself for a legacy bare SpyReport (no .latest)', () => {
    const bare = makeReport();
    expect(latestOf(bare)).toBe(bare);
  });

  it('tolerates a null/undefined-ish entry', () => {
    expect(latestOf(/** @type {any} */ (null))).toBe(null);
    expect(latestOf(/** @type {any} */ (undefined))).toBe(undefined);
  });
});

describe('historyOf', () => {
  it('returns the .history array on the new shape', () => {
    const history = [{ ts: 1700000000, resTotal: 100 }];
    expect(historyOf({ latest: makeReport(), history })).toBe(history);
  });

  it('returns [] for a legacy bare report (no history)', () => {
    expect(historyOf(makeReport())).toEqual([]);
  });

  it('returns [] for a null/undefined-ish entry', () => {
    expect(historyOf(/** @type {any} */ (null))).toEqual([]);
    expect(historyOf(/** @type {any} */ (undefined))).toEqual([]);
  });
});

describe('toLite', () => {
  it('copies ts, activityMin and resTotal from a full report', () => {
    const lite = toLite(makeReport());
    expect(lite.ts).toBe(1700000000);
    expect(lite.activityMin).toBe(15);
    expect(lite.resTotal).toBe(340000);
  });

  it('includes defenseValue/fleetValue when revealed.defense/fleet are true', () => {
    const lite = toLite(makeReport());
    expect(lite.defenseValue).toBe(5000);
    expect(lite.fleetValue).toBe(12000);
  });

  it('gates OUT defenseValue/fleetValue when revealed.defense/fleet are false', () => {
    const lite = toLite(
      makeReport({ revealed: { resources: true, fleet: false, defense: false, buildings: false, research: false } }),
    );
    // Partial (resources-only) report: loot rhythm survives, values do not.
    expect(lite.resTotal).toBe(340000);
    expect(lite).not.toHaveProperty('defenseValue');
    expect(lite).not.toHaveProperty('fleetValue');
  });

  it('gates each section independently (defence hidden, fleet shown)', () => {
    const lite = toLite(
      makeReport({ revealed: { resources: true, fleet: true, defense: false, buildings: true, research: true } }),
    );
    expect(lite).not.toHaveProperty('defenseValue');
    expect(lite.fleetValue).toBe(12000);
  });

  it('treats an ABSENT revealed map (legacy report) as fully revealed', () => {
    const legacy = makeReport({ revealed: undefined });
    const lite = toLite(legacy);
    expect(lite.defenseValue).toBe(5000);
    expect(lite.fleetValue).toBe(12000);
  });

  it('omits fields that are absent or non-number on the report', () => {
    const lite = toLite(/** @type {any} */ ({
      timestamp: 1700000000,
      // activityMin, resources, fleetValue absent; defenseValue non-number.
      defenseValue: 'nope',
      revealed: { resources: true, fleet: true, defense: true, buildings: true, research: true },
    }));
    expect(lite.ts).toBe(1700000000);
    expect(lite).not.toHaveProperty('activityMin');
    expect(lite).not.toHaveProperty('resTotal');
    expect(lite).not.toHaveProperty('fleetValue');
    expect(lite).not.toHaveProperty('defenseValue');
  });
});

describe('HISTORY_CAP', () => {
  it('is a positive number (24)', () => {
    expect(typeof HISTORY_CAP).toBe('number');
    expect(HISTORY_CAP).toBeGreaterThan(0);
    expect(HISTORY_CAP).toBe(24);
  });
});
