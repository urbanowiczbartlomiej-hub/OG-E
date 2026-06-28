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
import { MISSION_DEPLOYMENT } from '../../src/domain/rules.js';

/** The three "collect" config defaults parseDailyRunRoutes / emptyConfig fill
 * in (junk/missing input ⇒ deployment mission + "most" ships + "most" cargo). */
const COLLECT_DEFAULTS = /** @type {const} */ ({
  collectMission: MISSION_DEPLOYMENT,
  collectShips: 'most',
  collectResources: 'most',
});

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
  dailyRunRoutesStore.set({ routes: [], collectTarget: null, ...COLLECT_DEFAULTS });
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
    expect(dailyRunRoutesStore.get()).toEqual({ routes: [], collectTarget: null, ...COLLECT_DEFAULTS });
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
          enabled: true,
          sources: [{ galaxy: 4, system: 472, position: 15, type: 3 }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: 1 }],
          fleet: [{ shipId: 203, count: 15000 }],
          mission: 4,
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
          fleet: [{ shipId: 219, count: 100000 }],
        },
      ],
      collectTarget: null,
    };
    mockStore.get.mockResolvedValueOnce(stored);
    initDailyRunRoutesStore();
    expect(dailyRunRoutesStore.get()).toEqual({ routes: [], collectTarget: null, ...COLLECT_DEFAULTS });
    await flushMicrotasks();
    // Hydrate normalises through parseDailyRunRoutes → explicit enabled +
    // mission on each route, plus the three "collect" config defaults.
    expect(dailyRunRoutesStore.get()).toEqual({
      routes: [
        {
          enabled: true,
          sources: [{ galaxy: 1, system: 2, position: 3, type: 3 }],
          targets: [{ galaxy: 1, system: 2, position: 4, type: 1 }],
          fleet: [{ shipId: 219, count: 100000 }],
          mission: 4,
        },
      ],
      collectTarget: null,
      ...COLLECT_DEFAULTS,
    });
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
      fleet: [{ shipId: 203, count: 10 }],
    };
    const result = parseDailyRunRoutes({
      routes: [
        ok,
        { sources: [], targets: [{}], fleet: [{ shipId: 1, count: 1 }] }, // no sources
        { sources: [{}], fleet: [{ shipId: 1, count: 1 }] }, // no targets array
        { sources: [{}], targets: [] }, // no fleet
      ],
      collectTarget: null,
    });
    // Normalised: explicit enabled + mission added to the survivor.
    expect(result.routes).toEqual([
      { enabled: true, sources: ok.sources, targets: ok.targets, fleet: ok.fleet, mission: 4 },
    ]);
  });

  it('migrates a legacy single-ship route (microFleet → fleet[]) and fills defaults', () => {
    const { routes } = parseDailyRunRoutes({
      routes: [
        {
          sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
          targets: [{ galaxy: 1, system: 1, position: 2, type: 1 }],
          microFleet: { shipId: 203, count: 15000 },
        },
      ],
      collectTarget: null,
    });
    expect(routes).toEqual([
      {
        enabled: true,
        sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
        targets: [{ galaxy: 1, system: 1, position: 2, type: 1 }],
        fleet: [{ shipId: 203, count: 15000 }],
        mission: 4,
      },
    ]);
  });

  it('preserves enabled:false, a non-default mission, and a custom target flag', () => {
    const { routes } = parseDailyRunRoutes({
      routes: [
        {
          enabled: false,
          mission: 3,
          sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
          targets: [{ galaxy: 9, system: 9, position: 9, type: 1, custom: true }],
          fleet: [{ shipId: 203, count: 1 }, { shipId: 219, count: 2 }],
        },
      ],
      collectTarget: null,
    });
    expect(routes[0].enabled).toBe(false);
    expect(routes[0].mission).toBe(3);
    expect(routes[0].fleet).toEqual([{ shipId: 203, count: 1 }, { shipId: 219, count: 2 }]);
    expect(routes[0].targets[0].custom).toBe(true);
  });

  it('drops unusable fleet entries and the route when none remain', () => {
    const { routes } = parseDailyRunRoutes({
      routes: [
        {
          sources: [{ galaxy: 1, system: 1, position: 1, type: 3 }],
          targets: [{ galaxy: 1, system: 1, position: 2, type: 1 }],
          fleet: [{ shipId: 203, count: 0 }, { shipId: 219, count: 5 }, { count: 9 }],
        },
        {
          sources: [{ galaxy: 2, system: 2, position: 2, type: 1 }],
          targets: [{ galaxy: 2, system: 2, position: 3, type: 1 }],
          fleet: [{ shipId: 203, count: -1 }],
        },
      ],
      collectTarget: null,
    });
    // First route keeps only the usable entry; second has no usable fleet → dropped.
    expect(routes).toHaveLength(1);
    expect(routes[0].fleet).toEqual([{ shipId: 219, count: 5 }]);
  });

  it('defaults to an empty route list + null target for junk / missing input', () => {
    const empty = { routes: [], collectTarget: null, ...COLLECT_DEFAULTS };
    expect(parseDailyRunRoutes(null)).toEqual(empty);
    expect(parseDailyRunRoutes({})).toEqual(empty);
    expect(parseDailyRunRoutes({ routes: 42 })).toEqual(empty);
  });

  it('preserves an existing collectTarget', () => {
    const ct = { galaxy: 4, system: 472, position: 15, type: 3 };
    expect(parseDailyRunRoutes({ routes: [], collectTarget: ct }).collectTarget).toEqual(ct);
  });

  it('defaults the collect config (mission 4 / most / most) on junk input', () => {
    const r = parseDailyRunRoutes({ routes: [] });
    expect(r.collectMission).toBe(MISSION_DEPLOYMENT); // 4
    expect(r.collectShips).toBe('most');
    expect(r.collectResources).toBe('most');
  });

  it('round-trips an explicit collect config (custom mission, all/all)', () => {
    const r = parseDailyRunRoutes({
      routes: [],
      collectTarget: null,
      collectMission: 3,
      collectShips: 'all',
      collectResources: 'all',
    });
    expect(r.collectMission).toBe(3);
    expect(r.collectShips).toBe('all');
    expect(r.collectResources).toBe('all');
  });

  it('coerces any non-"all" collect ship/resource flag to "most"', () => {
    const r = parseDailyRunRoutes({
      routes: [],
      collectShips: /** @type {any} */ ('garbage'),
      collectResources: /** @type {any} */ (undefined),
    });
    expect(r.collectShips).toBe('most');
    expect(r.collectResources).toBe('most');
  });
});
