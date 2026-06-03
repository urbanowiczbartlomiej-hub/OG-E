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
import { migrateFsRoutes } from '../../src/domain/fsRoutes.js';

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
    expect(fsRoutesStore.get()).toEqual({ routes: [], collectTarget: null });
  });

  it('exports the expected key suffix', () => {
    expect(FS_ROUTES_KEY_BASE).toBe('oge_fsRoutes');
  });

  it('fsRoutesKeyFor composes a per-universe namespaced key', () => {
    expect(fsRoutesKeyFor('s163-pl')).toBe('s163-pl:oge_fsRoutes');
  });

  it('round-trips set/get without persist wiring', () => {
    const cfg = {
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: 3 }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
      ],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: 3 },
    };
    fsRoutesStore.set(/** @type {any} */ (cfg));
    expect(fsRoutesStore.get()).toEqual(cfg);
  });

  it('notifies subscribers on set', () => {
    const sub = vi.fn();
    const unsub = fsRoutesStore.subscribe(sub);
    fsRoutesStore.set(/** @type {any} */ ({ routes: [], collectTarget: null }));
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

  it('hydrates the store when chromeStore.get resolves with a current-shape value', async () => {
    const stored = {
      routes: [
        {
          sources: [{ galaxy: 1, system: 2, position: 3, type: 3 }],
          targets: [{ galaxy: 1, system: 2, position: 4, type: 1 }],
          microFleet: { shipId: 219, count: 100000 },
        },
      ],
      collectTarget: null,
    };
    mockStore.get.mockResolvedValueOnce(stored);
    initFsRoutesStore();
    expect(fsRoutesStore.get()).toEqual({ routes: [], collectTarget: null });
    await flushMicrotasks();
    expect(fsRoutesStore.get()).toEqual(stored);
  });

  it('MIGRATES a legacy moon-keyed Record on hydrate into the source-array shape', async () => {
    // Legacy shape: routes keyed by source-moon coords, type-less.
    const legacy = {
      routes: {
        '4:472:15': {
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
      },
      collectTarget: { galaxy: 4, system: 472, position: 15, type: 3 },
    };
    mockStore.get.mockResolvedValueOnce(legacy);
    initFsRoutesStore();
    await flushMicrotasks();

    expect(fsRoutesStore.get()).toEqual({
      routes: [
        {
          // legacy key lifted to a single MOON source (type 3)
          sources: [{ galaxy: 4, system: 472, position: 15, type: 3 }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
      ],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: 3 },
    });
  });

  it('is idempotent — a second init does not re-register', () => {
    const dispose1 = initFsRoutesStore();
    const dispose2 = initFsRoutesStore();
    expect(dispose1).toBe(dispose2);
    expect(mockStore.get).toHaveBeenCalledTimes(1);
  });
});

describe('migrateFsRoutes (pure)', () => {
  it('passes a current-shape array through, dropping malformed routes', () => {
    const ok = {
      sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
      targets: [{ galaxy: 1, system: 1, position: 2, type: 1 }],
      microFleet: { shipId: 203, count: 10 },
    };
    const result = migrateFsRoutes({
      routes: [
        ok,
        { sources: [], targets: [{}], microFleet: { shipId: 1, count: 1 } }, // no sources
        { sources: [{}], microFleet: { shipId: 1, count: 1 } }, // no targets array
        { sources: [{}], targets: [] }, // no microFleet
      ],
      collectTarget: null,
    });
    expect(result.routes).toEqual([ok]);
  });

  it('converts the legacy moon-keyed Record into single-moon-source routes', () => {
    const result = migrateFsRoutes({
      routes: {
        '4:472:15': {
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
        '5:120:6': {
          targets: [{ galaxy: 5, system: 120, position: 7, type: 1 }],
          microFleet: { shipId: 202, count: 500 },
        },
      },
      collectTarget: null,
    });
    expect(result.routes).toEqual([
      {
        sources: [{ galaxy: 4, system: 472, position: 15, type: 3 }],
        targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
        microFleet: { shipId: 203, count: 15000 },
      },
      {
        sources: [{ galaxy: 5, system: 120, position: 6, type: 3 }],
        targets: [{ galaxy: 5, system: 120, position: 7, type: 1 }],
        microFleet: { shipId: 202, count: 500 },
      },
    ]);
  });

  it('is idempotent — migrating an already-migrated value is a no-op', () => {
    const legacy = {
      routes: { '4:472:15': { targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }], microFleet: { shipId: 203, count: 15000 } } },
      collectTarget: null,
    };
    const once = migrateFsRoutes(legacy);
    const twice = migrateFsRoutes(once);
    expect(twice).toEqual(once);
  });

  it('defaults to an empty route list + null target for junk / missing input', () => {
    expect(migrateFsRoutes(null)).toEqual({ routes: [], collectTarget: null });
    expect(migrateFsRoutes({})).toEqual({ routes: [], collectTarget: null });
    expect(migrateFsRoutes({ routes: 42 })).toEqual({ routes: [], collectTarget: null });
  });

  it('preserves an existing collectTarget', () => {
    const ct = { galaxy: 4, system: 472, position: 15, type: 3 };
    expect(migrateFsRoutes({ routes: [], collectTarget: ct }).collectTarget).toEqual(ct);
  });
});
