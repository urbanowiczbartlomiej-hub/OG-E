// Unit tests for the watchList state store.
//
// The pure parts (normalizeWatchList, watchListKeyFor, store default) carry the
// real logic; the persist wiring (init hydrates from chrome.storage.local, write
// -through on change) mirrors galaxyScanConfig.test.js — we mock lib/storage.js
// (chromeStore) before importing the module. Node env — no DOM
// (currentUniverseKey falls back to the bare suffix).
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
  DEFAULT_SPY_PROBES,
  WATCH_LIST_KEY_BASE,
  watchListKeyFor,
  normalizeWatchList,
  watchListStore,
  initWatchListStore,
  disposeWatchListStore,
} from '../../src/state/watchList.js';

const mockStore = /** @type {any} */ (chromeStore);

const initialValue = () => ({ players: [], probes: DEFAULT_SPY_PROBES, rescan: {} });

const resetAll = () => {
  disposeWatchListStore();
  watchListStore.set(initialValue());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('watchList — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeWatchListStore);

  it('exports the expected key suffix and default probe count', () => {
    expect(WATCH_LIST_KEY_BASE).toBe('oge_watchedPlayers');
    expect(DEFAULT_SPY_PROBES).toBe(20);
  });

  it('composes the per-universe namespaced key', () => {
    expect(watchListKeyFor('s163-pl')).toBe('s163-pl:oge_watchedPlayers');
    expect(watchListKeyFor('42')).toBe('42:oge_watchedPlayers');
  });

  it('starts at the empty default before init', () => {
    expect(watchListStore.get()).toEqual({ players: [], probes: DEFAULT_SPY_PROBES, rescan: {} });
  });
});

describe('normalizeWatchList', () => {
  it('coerces a bare legacy string[] into players (stringified), default probes, empty rescan', () => {
    expect(normalizeWatchList(['1', '2', '3'])).toEqual({
      players: ['1', '2', '3'],
      probes: DEFAULT_SPY_PROBES,
      rescan: {},
      relationships: {},
    });
  });

  it('stringifies numeric ids in a legacy array', () => {
    expect(normalizeWatchList([1, 2, 3])).toEqual({
      players: ['1', '2', '3'],
      probes: DEFAULT_SPY_PROBES,
      rescan: {},
      relationships: {},
    });
  });

  it('accepts a partial object with only players, filling probes + rescan', () => {
    expect(normalizeWatchList({ players: ['7', '8'] })).toEqual({
      players: ['7', '8'],
      probes: DEFAULT_SPY_PROBES,
      rescan: {},
      relationships: {},
    });
  });

  it('stringifies object.players entries', () => {
    expect(normalizeWatchList({ players: [7, 8] }).players).toEqual(['7', '8']);
  });

  it('keeps a positive finite probe count (rounded)', () => {
    expect(normalizeWatchList({ players: [], probes: 33 }).probes).toBe(33);
    expect(normalizeWatchList({ players: [], probes: 12.7 }).probes).toBe(13);
  });

  it('falls back to DEFAULT_SPY_PROBES for missing / zero / negative / non-finite probes', () => {
    expect(normalizeWatchList({ players: [] }).probes).toBe(DEFAULT_SPY_PROBES);
    expect(normalizeWatchList({ players: [], probes: 0 }).probes).toBe(DEFAULT_SPY_PROBES);
    expect(normalizeWatchList({ players: [], probes: -5 }).probes).toBe(DEFAULT_SPY_PROBES);
    expect(normalizeWatchList({ players: [], probes: NaN }).probes).toBe(DEFAULT_SPY_PROBES);
    expect(normalizeWatchList({ players: [], probes: Infinity }).probes).toBe(DEFAULT_SPY_PROBES);
    expect(normalizeWatchList({ players: [], probes: 'abc' }).probes).toBe(DEFAULT_SPY_PROBES);
  });

  it('keeps only finite > 0 numeric rescan values, coercing numeric strings', () => {
    const out = normalizeWatchList({
      players: [],
      rescan: {
        a: 100,
        b: '200',
        zero: 0,
        neg: -1,
        nan: 'xyz',
        inf: Infinity,
      },
    });
    expect(out.rescan).toEqual({ a: 100, b: 200 });
  });

  it('returns an empty config for null / undefined / garbage', () => {
    const empty = { players: [], probes: DEFAULT_SPY_PROBES, rescan: {}, relationships: {} };
    expect(normalizeWatchList(null)).toEqual(empty);
    expect(normalizeWatchList(undefined)).toEqual(empty);
    expect(normalizeWatchList(42)).toEqual(empty);
    expect(normalizeWatchList('nope')).toEqual(empty);
    expect(normalizeWatchList(true)).toEqual(empty);
  });

  it('ignores a non-object rescan field', () => {
    expect(normalizeWatchList({ players: [], rescan: 'nope' }).rescan).toEqual({});
    expect(normalizeWatchList({ players: [], rescan: 5 }).rescan).toEqual({});
  });
});

describe('watchList store — hydration + write-through', () => {
  beforeEach(resetAll);
  afterEach(disposeWatchListStore);

  it('hydrates (and normalises) a stored legacy array into the store', async () => {
    mockStore.get.mockResolvedValue(['11', '22']);
    initWatchListStore();
    await flushMicrotasks();
    expect(watchListStore.get()).toEqual({
      players: ['11', '22'],
      probes: DEFAULT_SPY_PROBES,
      rescan: {},
      relationships: {},
    });
  });

  it('keeps the empty default and does NOT write when nothing is stored', async () => {
    initWatchListStore();
    await flushMicrotasks();
    expect(watchListStore.get()).toEqual(initialValue());
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('writes through on change (debounced) under the bare suffix key in node env', async () => {
    vi.useFakeTimers();
    try {
      initWatchListStore();
      watchListStore.set({ players: ['99'], probes: 30, rescan: {} });
      await vi.advanceTimersByTimeAsync(250);
      expect(mockStore.set).toHaveBeenCalledWith(
        WATCH_LIST_KEY_BASE,
        { players: ['99'], probes: 30, rescan: {} },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('initWatchListStore is idempotent (returns the same dispose fn)', () => {
    const a = initWatchListStore();
    const b = initWatchListStore();
    expect(a).toBe(b);
  });
});
