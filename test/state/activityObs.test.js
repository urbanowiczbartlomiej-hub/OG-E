// @vitest-environment happy-dom

// Behavioural tests for the galaxy-activity observation store. We drive
// `recordGalaxyActivity` (and, for the wiring case, the real
// `oge:galaxyScanned` event through the installed listener) and assert the
// observable ring state: the watched-only write gate, planet+moon markers
// recorded independently, and the self-induced-probe discount fed by the
// shared sent-coords map. No chrome.storage wiring — the recorder is the unit
// under test (hydration resolves to the pre-resolved sentinel when persist is
// never initialised, mirroring players.test.js's install-listener-directly).
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  activityObsStore,
  recordGalaxyActivity,
  installActivityObsListener,
  disposeActivityObsStore,
} from '../../src/state/activityObs.js';
import { watchListStore } from '../../src/state/watchList.js';
import { markSpySent } from '../../src/lib/spySentSession.js';
import { GALAXY_SCANNED_EVENT } from '../../src/lib/ogeEvents.js';

const SCAN_MS = 1_700_000_000_000;
const SCAN_S = Math.floor(SCAN_MS / 1000);

/** @param {string[]} players */
const watch = (players) => watchListStore.set({ players, probes: 20, rescan: {}, relationships: {} });
/** @returns {any} */
const rings = () => /** @type {any} */ (activityObsStore.get());
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  activityObsStore.set({});
  watch([]);
  window.sessionStorage.clear();
});

afterEach(() => {
  disposeActivityObsStore();
  activityObsStore.set({});
  watch([]);
});

describe('recordGalaxyActivity — watched-only gate', () => {
  it('records nothing when the watch list is empty', async () => {
    await recordGalaxyActivity({
      galaxy: 1, system: 1, scannedAt: SCAN_MS,
      positions: { 1: { status: 'occupied', player: { id: 42, name: 'A' }, activity: 0 } },
    });
    expect(rings()).toEqual({});
  });

  it('ignores an unwatched player while recording a watched one', async () => {
    watch(['42']);
    await recordGalaxyActivity({
      galaxy: 1, system: 1, scannedAt: SCAN_MS,
      positions: {
        1: { status: 'occupied', player: { id: 42, name: 'A' }, activity: 0 },
        2: { status: 'occupied', player: { id: 7, name: 'B' }, activity: 30 },
      },
    });
    expect(rings()['42']).toBeDefined();
    expect(rings()['7']).toBeUndefined();
  });
});

describe('recordGalaxyActivity — planet + moon markers', () => {
  it('records the planet and moon activity of a watched body independently', async () => {
    watch(['42']);
    await recordGalaxyActivity({
      galaxy: 1, system: 1, scannedAt: SCAN_MS,
      positions: { 1: { status: 'occupied', player: { id: 42, name: 'A' }, activity: 0, moonActivity: 30 } },
    });
    const bucket = rings()['42'];
    expect(bucket['1:1:1:1']).toEqual([{ t: SCAN_S, m: 0 }]); // planet
    expect(bucket['1:1:1:3']).toEqual([{ t: SCAN_S, m: 30 }]); // moon
  });

  it('skips a body with no numeric activity marker', async () => {
    watch(['42']);
    await recordGalaxyActivity({
      galaxy: 1, system: 1, scannedAt: SCAN_MS,
      positions: { 1: { status: 'occupied', player: { id: 42, name: 'A' } } },
    });
    expect(rings()['42']).toBeUndefined();
  });
});

describe('recordGalaxyActivity — self-induced discount', () => {
  it('drops a marker our own probe (recorded in the sent map) lit', async () => {
    watch(['42']);
    // We sent a probe to this coord at the observation time → the fresh-dot
    // marker is self-induced and must not enter the ring.
    markSpySent('1:1:1', SCAN_MS);
    await recordGalaxyActivity({
      galaxy: 1, system: 1, scannedAt: SCAN_MS,
      positions: { 1: { status: 'occupied', player: { id: 42, name: 'A' }, activity: 0 } },
    });
    const bucket = rings()['42'];
    // Nothing recorded for that body (whole update was a no-op).
    expect(bucket === undefined || bucket['1:1:1:1'] === undefined).toBe(true);
  });
});

describe('installActivityObsListener — event wiring', () => {
  it('records from a dispatched oge:galaxyScanned event', async () => {
    watch(['42']);
    installActivityObsListener();
    document.dispatchEvent(new CustomEvent(GALAXY_SCANNED_EVENT, {
      detail: {
        galaxy: 2, system: 3, scannedAt: SCAN_MS,
        positions: { 4: { status: 'occupied', player: { id: 42, name: 'A' }, activity: 0 } },
      },
    }));
    await flush();
    expect(rings()['42']['2:3:4:1']).toEqual([{ t: SCAN_S, m: 0 }]);
  });
});
