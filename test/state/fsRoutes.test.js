// Unit tests for the fsRoutes state store.
//
// Like `state/scans.js`, the store is a thin `createStore` wrapper; the
// behaviour worth testing is the lazy persist wiring (`initFsRoutesStore`
// hydrates from chrome.storage.local and subscribes a debounced
// write-through). We mock `lib/storage.js` before importing the module so
// every chromeStore call is an assertable vi.fn. Node env — no DOM.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    onChanged: vi.fn(),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  FS_ROUTES_KEY_BASE,
  fsRoutesKeyFor,
  fsRoutesStore,
  initFsRoutesStore,
  disposeFsRoutesStore,
  _resetFsRoutesStoreForTest,
} from '../../src/state/fsRoutes.js';

/**
 * @type {{
 *   get: import('vitest').Mock,
 *   set: import('vitest').Mock,
 *   remove: import('vitest').Mock,
 *   onChanged: import('vitest').Mock,
 * }}
 */
const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  _resetFsRoutesStoreForTest();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.remove.mockReset();
  mockStore.onChanged.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

/** Await enough microtasks for the persist hydrate `.then` chain to land. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('fsRoutesStore — defaults and basic ops', () => {
  beforeEach(resetAll);
  afterEach(disposeFsRoutesStore);

  it('starts as an empty config when persist has not been initialised', () => {
    expect(fsRoutesStore.get()).toEqual({ routes: {}, collectTarget: null });
  });

  it('exports the expected key suffix', () => {
    expect(FS_ROUTES_KEY_BASE).toBe('oge_fsRoutes');
  });

  it('fsRoutesKeyFor composes a per-universe namespaced key', () => {
    expect(fsRoutesKeyFor('s163-pl')).toBe('s163-pl:oge_fsRoutes');
  });

  it('round-trips set/get without persist wiring', () => {
    const cfg = {
      routes: {
        '4:472:15': {
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
      },
      collectTarget: { galaxy: 4, system: 472, position: 15, type: 3 },
    };
    fsRoutesStore.set(/** @type {any} */ (cfg));
    expect(fsRoutesStore.get()).toEqual(cfg);
  });

  it('notifies subscribers on set', () => {
    const sub = vi.fn();
    const unsub = fsRoutesStore.subscribe(sub);
    fsRoutesStore.set(/** @type {any} */ ({ routes: {}, collectTarget: null }));
    expect(sub).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe('fsRoutesStore — hydration via initFsRoutesStore', () => {
  beforeEach(resetAll);
  afterEach(disposeFsRoutesStore);

  it('calls chromeStore.get with the bare key in a non-DOM env', () => {
    initFsRoutesStore();
    expect(mockStore.get).toHaveBeenCalledTimes(1);
    expect(mockStore.get).toHaveBeenCalledWith('oge_fsRoutes');
  });

  it('hydrates the store when chromeStore.get resolves with a value', async () => {
    const stored = {
      routes: { '1:2:3': { targets: [], microFleet: { shipId: 219, count: 100000 } } },
      collectTarget: null,
    };
    mockStore.get.mockResolvedValueOnce(stored);
    initFsRoutesStore();
    expect(fsRoutesStore.get()).toEqual({ routes: {}, collectTarget: null });
    await flushMicrotasks();
    expect(fsRoutesStore.get()).toEqual(stored);
  });

  it('is idempotent — a second init does not re-register', () => {
    const dispose1 = initFsRoutesStore();
    const dispose2 = initFsRoutesStore();
    expect(dispose1).toBe(dispose2);
    expect(mockStore.get).toHaveBeenCalledTimes(1);
  });
});
