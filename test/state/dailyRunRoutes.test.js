// Unit tests for the dailyRunRoutes state store.
//
// Like `state/scans.js`, the store is a thin `createStore` wrapper; the
// behaviour worth testing is the lazy persist wiring (`initDailyRunRoutesStore`
// hydrates from chrome.storage.local and subscribes a debounced
// write-through). We mock `lib/storage.js` before importing the module so
// every chromeStore call is an assertable vi.fn. Node env — no DOM.
//
// @ts-check

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
  DAILY_RUN_ROUTES_KEY_BASE,
  DAILY_RUN_ROUTES_TS_BASE,
  dailyRunRoutesKeyFor,
  dailyRunRoutesStore,
  initDailyRunRoutesStore,
  disposeDailyRunRoutesStore,
  stampDailyRunRoutesChanged,
} from '../../src/state/dailyRunRoutes.js';
import { parseDailyRunRoutes } from '../../src/domain/dailyRunRoutes.js';

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
  disposeDailyRunRoutesStore();
  dailyRunRoutesStore.set({ routes: [], collectTarget: null });
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

describe('dailyRunRoutesStore — defaults and basic ops', () => {
  beforeEach(resetAll);
  afterEach(disposeDailyRunRoutesStore);

  it('starts as an empty config when persist has not been initialised', () => {
    expect(dailyRunRoutesStore.get()).toEqual({ routes: [], collectTarget: null });
  });

  it('exports the expected key suffix', () => {
    expect(DAILY_RUN_ROUTES_KEY_BASE).toBe('oge_dailyRunRoutes');
  });

  it('dailyRunRoutesKeyFor composes a per-universe namespaced key', () => {
    expect(dailyRunRoutesKeyFor('s163-pl')).toBe('s163-pl:oge_dailyRunRoutes');
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
    dailyRunRoutesStore.set(/** @type {any} */ (cfg));
    expect(dailyRunRoutesStore.get()).toEqual(cfg);
  });

  it('notifies subscribers on set', () => {
    const sub = vi.fn();
    const unsub = dailyRunRoutesStore.subscribe(sub);
    dailyRunRoutesStore.set(/** @type {any} */ ({ routes: [], collectTarget: null }));
    expect(sub).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe('stampDailyRunRoutesChanged — flushes before stamping (debounce race)', () => {
  beforeEach(resetAll);
  afterEach(disposeDailyRunRoutesStore);

  it('flushes the routes value, THEN writes the timestamp', async () => {
    // A current in-memory edit that the debounce has not yet persisted.
    dailyRunRoutesStore.set(
      /** @type {any} */ ({ routes: [{ id: 'r1' }], collectTarget: null }),
    );
    mockStore.set.mockClear();

    await stampDailyRunRoutesChanged();

    // Exactly two writes, in order: routes value first (flush), then the
    // timestamp — so the clock can never claim "changed" before the value
    // is on disk.
    const keys = mockStore.set.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([DAILY_RUN_ROUTES_KEY_BASE, DAILY_RUN_ROUTES_TS_BASE]);
    expect(mockStore.set.mock.calls[0][1]).toEqual({
      routes: [{ id: 'r1' }],
      collectTarget: null,
    });
    expect(typeof mockStore.set.mock.calls[1][1]).toBe('number');
  });
});

describe('dailyRunRoutesStore — hydration via initDailyRunRoutesStore', () => {
  beforeEach(resetAll);
  afterEach(disposeDailyRunRoutesStore);

  it('calls chromeStore.get with the bare key in a non-DOM env', () => {
    initDailyRunRoutesStore();
    expect(mockStore.get).toHaveBeenCalledTimes(1);
    expect(mockStore.get).toHaveBeenCalledWith('oge_dailyRunRoutes');
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
    initDailyRunRoutesStore();
    expect(dailyRunRoutesStore.get()).toEqual({ routes: [], collectTarget: null });
    await flushMicrotasks();
    expect(dailyRunRoutesStore.get()).toEqual(stored);
  });

  it('is idempotent — a second init does not re-register', () => {
    const dispose1 = initDailyRunRoutesStore();
    const dispose2 = initDailyRunRoutesStore();
    expect(dispose1).toBe(dispose2);
    expect(mockStore.get).toHaveBeenCalledTimes(1);
  });
});

describe('parseDailyRunRoutes (pure)', () => {
  it('passes a current-shape array through, dropping malformed routes', () => {
    const ok = {
      sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
      targets: [{ galaxy: 1, system: 1, position: 2, type: 1 }],
      microFleet: { shipId: 203, count: 10 },
    };
    const result = parseDailyRunRoutes({
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

  it('defaults to an empty route list + null target for junk / missing input', () => {
    expect(parseDailyRunRoutes(null)).toEqual({ routes: [], collectTarget: null });
    expect(parseDailyRunRoutes({})).toEqual({ routes: [], collectTarget: null });
    expect(parseDailyRunRoutes({ routes: 42 })).toEqual({ routes: [], collectTarget: null });
  });

  it('preserves an existing collectTarget', () => {
    const ct = { galaxy: 4, system: 472, position: 15, type: 3 };
    expect(parseDailyRunRoutes({ routes: [], collectTarget: ct }).collectTarget).toEqual(ct);
  });
});
