// @ts-check
//
// Unit tests for the sync scheduler's pure decision core. No DOM, no
// timers, no stores — every input is a plain value passed in, so these
// run in the default node env and exercise the gating rules directly
// (the orchestrator test in ../scheduler.test.js still covers the wired
// behaviour end-to-end).

import { describe, it, expect } from 'vitest';
import {
  canStartSync,
  shouldScheduleUpload,
  slotHasData,
  dailyStateHasData,
  galaxyConfigSlotHasData,
  alarmClockConfigSlotHasData,
  playersSlotHasData,
  ownProfileHasData,
  sameJSON,
  gistIsCurrent,
} from '../../../src/sync/scheduler/pure.js';

/** The three "collect" config fields a DailyRunRoutesSlot now carries.
 * `slotHasData` ignores them, but the literal must be a complete slot to
 * typecheck — spread these in. */
const COLLECT_DEFAULTS = /** @type {const} */ ({
  collectMission: 4,
  collectShips: 'most',
  collectResources: 'most',
});

describe('canStartSync', () => {
  it('is true only when sync is enabled, a token exists, and nothing is in flight', () => {
    expect(canStartSync({ cloudSync: true, hasToken: true, inFlight: false })).toBe(true);
  });

  it('is false when cloud sync is off', () => {
    expect(canStartSync({ cloudSync: false, hasToken: true, inFlight: false })).toBe(false);
  });

  it('is false when no token is configured', () => {
    expect(canStartSync({ cloudSync: true, hasToken: false, inFlight: false })).toBe(false);
  });

  it('is false while a download/upload is already in flight (the lock)', () => {
    expect(canStartSync({ cloudSync: true, hasToken: true, inFlight: true })).toBe(false);
  });

  it('coerces a falsy/truthy cloudSync to a boolean result', () => {
    expect(canStartSync({ cloudSync: undefined, hasToken: true, inFlight: false })).toBe(false);
    expect(canStartSync({ cloudSync: 1, hasToken: true, inFlight: false })).toBe(true);
  });
});

describe('shouldScheduleUpload', () => {
  it('schedules when cloud sync is on and the change is not sync-origin', () => {
    expect(shouldScheduleUpload({ cloudSync: true })).toBe(true);
    expect(shouldScheduleUpload({ cloudSync: true, applying: false })).toBe(true);
  });

  it('does not schedule when cloud sync is off', () => {
    expect(shouldScheduleUpload({ cloudSync: false })).toBe(false);
  });

  it('does not schedule a sync-origin write (anti-loop)', () => {
    expect(shouldScheduleUpload({ cloudSync: true, applying: true })).toBe(false);
  });

  it('treats a missing `applying` as not-applying', () => {
    expect(shouldScheduleUpload({ cloudSync: true })).toBe(true);
  });
});

describe('slotHasData', () => {
  it('is false for a never-configured slot (no routes, no target, ts 0)', () => {
    expect(slotHasData({ updatedAt: 0, routes: [], collectTarget: null, ...COLLECT_DEFAULTS })).toBe(false);
  });

  it('is true when the slot has a timestamp', () => {
    expect(slotHasData({ updatedAt: 123, routes: [], collectTarget: null, ...COLLECT_DEFAULTS })).toBe(true);
  });

  it('is true when the slot has at least one route', () => {
    expect(
      slotHasData({ updatedAt: 0, routes: [/** @type {any} */ ({})], collectTarget: null, ...COLLECT_DEFAULTS }),
    ).toBe(true);
  });

  it('is true when a collect target is set', () => {
    expect(
      slotHasData({
        updatedAt: 0,
        routes: [],
        collectTarget: /** @type {any} */ ({ galaxy: 1, system: 2, position: 3, type: 1 }),
        ...COLLECT_DEFAULTS,
      }),
    ).toBe(true);
  });
});

describe('galaxyConfigSlotHasData', () => {
  it('is false until the config has been edited (ts 0)', () => {
    expect(galaxyConfigSlotHasData(/** @type {any} */ ({ config: {}, updatedAt: 0 }))).toBe(false);
  });

  it('is true once the slot carries a real timestamp', () => {
    expect(galaxyConfigSlotHasData(/** @type {any} */ ({ config: {}, updatedAt: 123 }))).toBe(true);
  });
});

describe('alarmClockConfigSlotHasData', () => {
  it('is false until the config has been edited (ts 0)', () => {
    expect(alarmClockConfigSlotHasData(/** @type {any} */ ({ config: {}, updatedAt: 0 }))).toBe(false);
  });

  it('is true once the slot carries a real timestamp', () => {
    expect(alarmClockConfigSlotHasData(/** @type {any} */ ({ config: {}, updatedAt: 5 }))).toBe(true);
  });
});

describe('dailyStateHasData', () => {
  it('is false for an all-empty record', () => {
    expect(dailyStateHasData({})).toBe(false);
    expect(
      dailyStateHasData({
        rewardingDoneDay: '',
        traderImportDay: '',
        traderAuctionBidAt: 0,
        traderAuctionQuietUntil: 0,
        artifactShopDoneUntil: 0,
      }),
    ).toBe(false);
  });

  it('is true when any single field carries a value', () => {
    expect(dailyStateHasData({ rewardingDoneDay: '2026-06-13' })).toBe(true);
    expect(dailyStateHasData({ traderImportDay: '2026-06-13' })).toBe(true);
    expect(dailyStateHasData({ traderAuctionBidAt: 123 })).toBe(true);
    expect(dailyStateHasData({ traderAuctionQuietUntil: 456 })).toBe(true);
    expect(dailyStateHasData({ artifactShopDoneUntil: 789 })).toBe(true);
  });
});

describe('sameJSON', () => {
  it('treats undefined / null / missing as equal (the empty-field case)', () => {
    expect(sameJSON(undefined, null)).toBe(true);
    expect(sameJSON(null, undefined)).toBe(true);
  });

  it('compares nested structures by value', () => {
    expect(sameJSON({ a: [1, 2], b: { c: 3 } }, { a: [1, 2], b: { c: 3 } })).toBe(true);
    expect(sameJSON({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it('distinguishes an empty container from a missing field', () => {
    expect(sameJSON({}, undefined)).toBe(false);
    expect(sameJSON([], undefined)).toBe(false);
  });
});

describe('gistIsCurrent', () => {
  const merged = {
    galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
    colonyHistoryPerUniverse: [{ id: 'a' }],
    settings: { values: { x: 1 }, ts: { x: 10 } },
    dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
    settingsPerUniverse: undefined,
    dailyStatePerUniverse: undefined,
    galaxyScanConfig: undefined,
    alarmClockConfigPerUniverse: undefined,
  };

  it('is true when every synced field matches (skip the PATCH)', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
      // settingsPerUniverse / dailyStatePerUniverse / galaxyScanConfig absent
      // — equal to merged's undefined.
    });
    expect(gistIsCurrent(remote, merged)).toBe(true);
  });

  it('is false when only the galaxyScanConfig slot differs', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
      galaxyScanConfig: { 's1-pl': { config: { positions: '9' }, updatedAt: 7 } },
    });
    // merged has galaxyScanConfig: undefined → differs → PATCH needed.
    expect(gistIsCurrent(remote, merged)).toBe(false);
  });

  it('is false when only the alarmClockConfigPerUniverse slot differs', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
      alarmClockConfigPerUniverse: { config: { alarmClockEnabled: true }, updatedAt: 7 },
    });
    // merged has alarmClockConfigPerUniverse: undefined → differs → PATCH needed.
    expect(gistIsCurrent(remote, merged)).toBe(false);
  });

  it('is false when any single field differs (PATCH needed)', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 2 } }, // differs
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
    });
    expect(gistIsCurrent(remote, merged)).toBe(false);
  });

  it('is false when only the playersPerUniverse slot differs', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
      playersPerUniverse: { 's1-pl': { 7: { id: 7, name: 'x', seenAt: 1 } } },
    });
    // merged has no playersPerUniverse (undefined) → differs → PATCH needed.
    expect(gistIsCurrent(remote, merged)).toBe(false);
  });

  it('is false when only the ownProfilePerUniverse slot differs', () => {
    const remote = /** @type {any} */ ({
      galaxyScansPerUniverse: { '1:1:1': { t: 1 } },
      colonyHistoryPerUniverse: [{ id: 'a' }],
      settings: { values: { x: 1 }, ts: { x: 10 } },
      dailyRunRoutes: { 's1-pl': { routes: [], collectTarget: null, updatedAt: 5 } },
      ownProfilePerUniverse: { 's1-pl': { rank: 1, updatedAt: 9 } },
    });
    expect(gistIsCurrent(remote, merged)).toBe(false);
  });

  it('treats a null/undefined remote as not-current (first upload)', () => {
    expect(gistIsCurrent(null, merged)).toBe(false);
    expect(gistIsCurrent(undefined, merged)).toBe(false);
  });
});

describe('playersSlotHasData', () => {
  it('is true for a non-empty roster, false for empty / undefined', () => {
    expect(playersSlotHasData({ 7: { id: 7, name: 'x', seenAt: 1 } })).toBe(true);
    expect(playersSlotHasData({})).toBe(false);
    expect(playersSlotHasData(undefined)).toBe(false);
  });
});

describe('ownProfileHasData', () => {
  it('is true only when the profile carries a real updatedAt', () => {
    expect(ownProfileHasData({ rank: 1, updatedAt: 5 })).toBe(true);
    expect(ownProfileHasData({})).toBe(false); // {} from readOwnProfile = never written
    expect(ownProfileHasData(undefined)).toBe(false);
    expect(ownProfileHasData({ rank: 1 })).toBe(false); // no updatedAt
  });
});
