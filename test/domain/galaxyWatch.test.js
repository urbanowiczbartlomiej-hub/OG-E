// Unit tests for domain/galaxyWatch.js — the passive look plan + the honest
// activity readout. Two separate questions, tested separately: "should we
// LOOK again?" keys on the last-LOOK time (any marker), while "when was the
// body last ACTIVE?" keys on the positive markers' implied interaction time —
// the fix for the misleading "<1 h" reading a quiet look used to produce.
//
// Node env — pure, `nowMs` injected.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  lastSightSec,
  bodyActivityReadout,
  galaxySightStatus,
  buildGalaxyPlan,
  RECHECK_BOOST,
} from '../../src/domain/galaxyWatch.js';

const NOW = 1_700_000_000_000;
const STALE_MS = 24 * 3600 * 1000; // the default galaxyHours cadence
/** @param {number} ms */
const sec = (ms) => Math.floor(ms / 1000);

describe('lastSightSec', () => {
  it('is the newest entry time — ANY marker counts as a look', () => {
    expect(lastSightSec([{ t: 100, m: 0 }, { t: 200, m: -1 }])).toBe(200);
  });

  it('is 0 for no ring / junk', () => {
    expect(lastSightSec(undefined)).toBe(0);
    expect(lastSightSec([])).toBe(0);
    expect(lastSightSec([{ t: NaN, m: 0 }])).toBe(0);
  });
});

describe('galaxySightStatus', () => {
  it('never sighted → none; recent → fresh; old → stale; ↻ after the look → rescan', () => {
    const base = { nowMs: NOW, staleMs: STALE_MS };
    expect(galaxySightStatus({ ...base, lastSightSec: 0 })).toBe('none');
    expect(galaxySightStatus({ ...base, lastSightSec: sec(NOW - 3600e3) })).toBe('fresh');
    expect(galaxySightStatus({ ...base, lastSightSec: sec(NOW - STALE_MS - 3600e3) })).toBe('stale');
    expect(galaxySightStatus({
      ...base,
      lastSightSec: sec(NOW - 3600e3),
      rescanAtMs: NOW - 60e3, // requested AFTER the sighting
    })).toBe('rescan');
  });
});

describe('bodyActivityReadout — the honesty fix', () => {
  it('quiet-only ring: NO lastActiveSec, a quietSince bound, quietNow', () => {
    const r = bodyActivityReadout([
      { t: sec(NOW - 7200e3), m: -1 },
      { t: sec(NOW - 3600e3), m: -1 },
    ]);
    expect(r.lastActiveSec).toBeUndefined(); // never claim "active <1h" off a quiet look
    expect(r.quietSinceSec).toBe(sec(NOW - 7200e3));
    expect(r.quietNow).toBe(true);
    expect(r.looks).toBe(2);
    expect(r.hits).toBe(0);
  });

  it('positive markers: lastActive = the newest implied INTERACTION, not the look', () => {
    const lookT = sec(NOW - 3600e3);
    // m=30 → the interaction happened ~30 min BEFORE the look.
    const r = bodyActivityReadout([{ t: lookT, m: 30 }]);
    expect(r.lastActiveSec).toBe(lookT - 30 * 60);
    expect(r.hits).toBe(1);
    expect(r.quietSinceSec).toBeUndefined();
  });

  it('no ring → an all-quiet zero readout', () => {
    expect(bodyActivityReadout(undefined)).toEqual({ quietNow: false, looks: 0, hits: 0 });
  });
});

describe('buildGalaxyPlan', () => {
  const universePlanets = [
    { coords: '1:2:3', player: 42, hasMoon: true },
    { coords: '1:2:8', player: 42 },
    { coords: '5:5:5', player: 42 },
  ];

  it('groups needs-sight bodies by SYSTEM — one navigation covers them all', () => {
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets,
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    // Two systems: 1:2 (planet + moon + second planet = 3 bodies) and 5:5.
    expect(entries).toHaveLength(2);
    const sys12 = entries.find((e) => e.label === '1:2');
    expect(sys12?.bodies).toHaveLength(3);
    expect(sys12?.worst).toBe('none');
  });

  it('a fresh sighting satisfies a body; a whole-fresh system drops out', () => {
    const fresh = [{ t: sec(NOW - 3600e3), m: -1 }];
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets,
      rings: { 42: { '5:5:5:1': fresh } },
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    expect(entries.map((e) => e.label)).toEqual(['1:2']);
  });

  it('galaxyMode "off" mutes a player\'s look proposals entirely', () => {
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets,
      galaxyMode: { 42: 'off' },
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    expect(entries).toHaveLength(0);
  });

  it('ranks by danger — the dangerous player\'s system comes first', () => {
    const { entries } = buildGalaxyPlan({
      players: ['42', '80'],
      universePlanets: [
        { coords: '1:2:3', player: 42 },
        { coords: '7:7:7', player: 80 },
      ],
      dangerByPlayer: { 42: 5, 80: 90 },
      nowMs: NOW,
      staleMs: STALE_MS,
    });
    expect(entries[0].label).toBe('7:7');
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority);
  });

  it('an OPEN ambiguous-moon re-look window force-includes its fresh-covered system at RECHECK_BOOST', () => {
    const fresh = [{ t: sec(NOW - 60e3), m: -1 }];
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets,
      // Every body freshly sighted — without the recheck the plan is EMPTY.
      rings: {
        42: {
          '1:2:3:1': fresh, '1:2:3:3': fresh, '1:2:8:1': fresh, '5:5:5:1': fresh,
        },
      },
      nowMs: NOW,
      staleMs: STALE_MS,
      rechecks: {
        42: {
          coord: '1:2:3', bodyType: 3,
          readyAtMs: NOW - 60e3, expiresAtMs: NOW + 600e3,
        },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: '1:2', priority: RECHECK_BOOST, recheck: true,
    });
    expect(entries[0].bodies).toEqual([
      { playerId: '42', position: 3, bodyType: 3, status: 'rescan' },
    ]);
    expect(entries[0].why).toContain('moon');
  });

  it('an account SWEEP force-includes every uncovered system at RECHECK_BOOST', () => {
    const fresh = [{ t: sec(NOW - 60e3), m: -1 }];
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets,
      // Every body freshly sighted by the ORDINARY cadence — only the sweep
      // (60-min coverage for a live candidate) still wants looks.
      rings: {
        42: {
          '1:2:3:1': fresh, '1:2:3:3': fresh, '1:2:8:1': fresh, '5:5:5:1': fresh,
        },
      },
      nowMs: NOW,
      staleMs: STALE_MS,
      sweeps: {
        42: { coord: '1:2:3', bodyType: 3, systems: ['5:5'], expiresAtMs: NOW + 600e3 },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: '5:5', priority: RECHECK_BOOST, sweep: true, worst: 'rescan',
    });
    expect(entries[0].why).toContain('sweep');
  });

  it('an expired or muted sweep adds nothing', () => {
    const base = {
      players: ['42'],
      universePlanets,
      rings: /** @type {any} */ ({ 42: { '1:2:3:1': [{ t: sec(NOW - 60e3), m: -1 }], '1:2:3:3': [{ t: sec(NOW - 60e3), m: -1 }], '1:2:8:1': [{ t: sec(NOW - 60e3), m: -1 }], '5:5:5:1': [{ t: sec(NOW - 60e3), m: -1 }] } }),
      nowMs: NOW,
      staleMs: STALE_MS,
    };
    const sweep = (/** @type {number} */ expiresAtMs) => ({
      42: { coord: '1:2:3', bodyType: /** @type {3} */ (3), systems: ['5:5'], expiresAtMs },
    });
    expect(buildGalaxyPlan({ ...base, sweeps: sweep(NOW - 1) }).entries).toHaveLength(0);
    expect(buildGalaxyPlan({
      ...base, galaxyMode: { 42: 'off' }, sweeps: sweep(NOW + 600e3),
    }).entries).toHaveLength(0);
  });

  it('sysLookSec floors coverage — a browsed system clears even when the browse left NO ring entry', () => {
    // The stuck-Look regression: the watched player's only body kept its ring
    // empty across browses — every observation was discounted as our own
    // probe's marker (activityObs.appendActivityObs → null), or the slot is
    // empty/relocated per a stale universe.xml row. The scan record
    // (state/scans `scannedAt`) still proves the browse happened; without
    // that floor the plan re-proposed the same system on every rebuild,
    // forever, and the FAB looped "Look [g:s]" on every tap.
    const base = {
      players: ['42'],
      universePlanets: [{ coords: '4:465:7', player: 42 }],
      rings: { 42: {} },
      nowMs: NOW,
      staleMs: STALE_MS,
    };
    // Ring never advances → proposed…
    expect(buildGalaxyPlan(base).entries.map((e) => e.label)).toEqual(['4:465']);
    // …but a browse on record clears it.
    expect(buildGalaxyPlan({
      ...base,
      sysLookSec: { '4:465': sec(NOW - 3600e3) },
    }).entries).toHaveLength(0);
  });

  it('an old browse (beyond cadence) does not satisfy — the system is still proposed as stale', () => {
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets: [{ coords: '4:465:7', player: 42 }],
      nowMs: NOW,
      staleMs: STALE_MS,
      sysLookSec: { '4:465': sec(NOW - STALE_MS - 3600e3) },
    });
    expect(entries.map((e) => `${e.label}:${e.worst}`)).toEqual(['4:465:stale']);
  });

  it('a ↻ rescan mark set AFTER the browse still forces the look', () => {
    const { entries } = buildGalaxyPlan({
      players: ['42'],
      universePlanets: [{ coords: '4:465:7', player: 42 }],
      nowMs: NOW,
      staleMs: STALE_MS,
      sysLookSec: { '4:465': sec(NOW - 3600e3) },
      rescan: { 42: NOW - 60e3 },
    });
    expect(entries.map((e) => `${e.label}:${e.worst}`)).toEqual(['4:465:rescan']);
  });

  it('junk sysLookSec values are ignored (0 / NaN / negative)', () => {
    const base = {
      players: ['42'],
      universePlanets: [{ coords: '4:465:7', player: 42 }],
      nowMs: NOW,
      staleMs: STALE_MS,
    };
    for (const v of [0, NaN, -5]) {
      expect(buildGalaxyPlan({ ...base, sysLookSec: { '4:465': v } })
        .entries.map((e) => e.worst)).toEqual(['none']);
    }
  });

  it('a recheck window that is not yet ready (or already expired, or muted) adds nothing', () => {
    const fresh = [{ t: sec(NOW - 60e3), m: -1 }];
    const base = {
      players: ['42'],
      universePlanets,
      rings: /** @type {any} */ ({
        42: {
          '1:2:3:1': fresh, '1:2:3:3': fresh, '1:2:8:1': fresh, '5:5:5:1': fresh,
        },
      }),
      nowMs: NOW,
      staleMs: STALE_MS,
    };
    const win = (/** @type {number} */ readyAtMs, /** @type {number} */ expiresAtMs) => ({
      42: { coord: '1:2:3', bodyType: /** @type {3} */ (3), readyAtMs, expiresAtMs },
    });
    expect(buildGalaxyPlan({ ...base, rechecks: win(NOW + 60e3, NOW + 600e3) }).entries)
      .toHaveLength(0); // not ready yet
    expect(buildGalaxyPlan({ ...base, rechecks: win(NOW - 600e3, NOW - 60e3) }).entries)
      .toHaveLength(0); // expired
    expect(buildGalaxyPlan({
      ...base, galaxyMode: { 42: 'off' }, rechecks: win(NOW - 60e3, NOW + 600e3),
    }).entries).toHaveLength(0); // player muted
  });
});
