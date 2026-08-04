// Tests for the in-game Home-watch reader: a fresh galaxy sighting of one of
// OUR systems must produce a persisted baseline plus an arrival log, and the
// pass must stay quiet when it has nothing to say (mode off, inventory not
// hydrated, nothing new).
//
// The stores are real (in-memory `createStore`s); only the chrome.storage-backed
// home-watch key is mocked, so the assertions read what the feature actually
// decided to write.
//
// @ts-check

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** @type {{ baseline: Record<string, any>, arrivals: any[] }} */
let stored = { baseline: {}, arrivals: [] };

vi.mock('../../src/state/homeWatch.js', () => ({
  readHomeWatch: vi.fn(() => Promise.resolve(stored)),
  writeHomeWatch: vi.fn((v) => { stored = v; return Promise.resolve(); }),
  emptyHomeWatch: () => ({ baseline: {}, arrivals: [] }),
}));
vi.mock('../../src/features/shared/apiContextStore.js', () => ({
  getApiContext: () => ({ ownId: 103 }),
}));

import { scansStore } from '../../src/state/scans.js';
import { bodiesStore } from '../../src/state/bodies.js';
import { watchListStore } from '../../src/state/watchList.js';
import { writeHomeWatch } from '../../src/state/homeWatch.js';
import { runHomeWatchPass, _resetHomeWatchForTest } from '../../src/features/homeWatch/index.js';

/** @param {number} id */
const occ = (id) => ({ status: 'occupied', player: { id, name: 'P' + id } });
const mine = { status: 'mine' };

beforeEach(() => {
  _resetHomeWatchForTest();
  vi.clearAllMocks();
  stored = { baseline: {}, arrivals: [] };
  scansStore.set(/** @type {any} */ ({}));
  bodiesStore.set(/** @type {any} */ ({ bodies: [{ galaxy: 4, system: 151 }] }));
  watchListStore.update((c) => ({ ...c, homeWatch: true }));
});

describe('runHomeWatchPass', () => {
  it('seeds the baseline from a fresh sighting without logging arrivals', async () => {
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 1000, positions: { 1: mine, 3: occ(207) } },
    }));
    await runHomeWatchPass();
    expect(writeHomeWatch).toHaveBeenCalledTimes(1);
    expect(stored.baseline['4:151']).toEqual({ ids: [207], seenAt: 1000 });
    expect(stored.arrivals).toEqual([]);
  });

  it('logs a stranger who arrived since the previous sighting', async () => {
    stored = { baseline: { '4:151': { ids: [207], seenAt: 1000 } }, arrivals: [] };
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 2000, positions: { 1: mine, 3: occ(207), 12: occ(555) } },
    }));
    await runHomeWatchPass();
    expect(stored.arrivals).toEqual([
      { system: '4:151', coord: '4:151:12', playerId: 555, atMs: 2000 },
    ]);
  });

  it('writes nothing when the sighting is not newer than the baseline', async () => {
    stored = { baseline: { '4:151': { ids: [207], seenAt: 2000 } }, arrivals: [] };
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 2000, positions: { 3: occ(207) } },
    }));
    await runHomeWatchPass();
    expect(writeHomeWatch).not.toHaveBeenCalled();
  });

  it('is a no-op while the mode is off', async () => {
    watchListStore.update((c) => ({ ...c, homeWatch: false }));
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 1000, positions: { 3: occ(207) } },
    }));
    await runHomeWatchPass();
    expect(writeHomeWatch).not.toHaveBeenCalled();
  });

  it('is a no-op before the body inventory hydrates (an empty one would wipe the baseline)', async () => {
    bodiesStore.set(/** @type {any} */ ({ bodies: [] }));
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 1000, positions: { 3: occ(207) } },
    }));
    await runHomeWatchPass();
    expect(writeHomeWatch).not.toHaveBeenCalled();
  });

  it('only diffs systems we actually live in', async () => {
    scansStore.set(/** @type {any} */ ({
      '4:151': { scannedAt: 1000, positions: { 1: mine } },
      '9:9': { scannedAt: 1000, positions: { 3: occ(777) } },
    }));
    await runHomeWatchPass();
    expect(Object.keys(stored.baseline)).toEqual(['4:151']);
  });
});
