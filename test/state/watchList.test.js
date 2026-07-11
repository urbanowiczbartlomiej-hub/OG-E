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
  DEFAULT_CADENCE,
  WATCH_LIST_KEY_BASE,
  WATCH_LIST_TS_KEY_BASE,
  watchListKeyFor,
  watchListTsKeyFor,
  normalizeWatchList,
  normalizeWatchListLedger,
  ensureWatchListLedgerSeeded,
  writeWatchListConfig,
  applyWatchListSyncSlot,
  watchListStore,
  initWatchListStore,
  disposeWatchListStore,
} from '../../src/state/watchList.js';

const mockStore = /** @type {any} */ (chromeStore);

const initialValue = () => ({ players: [], probes: DEFAULT_SPY_PROBES, rescan: {} });

/** A fully-materialised normalized config (what normalizeWatchList emits). */
const fullCfg = (over = {}) => ({
  players: [],
  probes: DEFAULT_SPY_PROBES,
  scanBodies: 'planets',
  rescan: {},
  relationships: {},
  mapHidden: {},
  scanMode: {},
  galaxyMode: {},
  cadence: { ...DEFAULT_CADENCE },
  moonStrike: 'newest',
  patrolSystems: 0,
  ...over,
});

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
    expect(normalizeWatchList(['1', '2', '3'])).toEqual(fullCfg({ players: ['1', '2', '3'] }));
  });

  it('stringifies numeric ids in a legacy array', () => {
    expect(normalizeWatchList([1, 2, 3])).toEqual(fullCfg({ players: ['1', '2', '3'] }));
  });

  it('accepts a partial object with only players, filling probes + rescan', () => {
    expect(normalizeWatchList({ players: ['7', '8'] })).toEqual(fullCfg({ players: ['7', '8'] }));
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
    const empty = fullCfg();
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

  it('keeps only truthy mapHidden entries and tolerates a non-object field (Etap H5)', () => {
    const out = normalizeWatchList({
      players: [],
      mapHidden: { '7': true, '8': false, '9': 1, '10': 0, '11': '' },
    });
    expect(out.mapHidden).toEqual({ '7': true, '9': true });
    expect(normalizeWatchList({ players: [], mapHidden: 'nope' }).mapHidden).toEqual({});
    expect(normalizeWatchList({ players: [] }).mapHidden).toEqual({});
  });
});

describe('watchList store — hydration + write-through', () => {
  beforeEach(resetAll);
  afterEach(disposeWatchListStore);

  it('hydrates (and normalises) a stored legacy array into the store', async () => {
    mockStore.get.mockResolvedValue(['11', '22']);
    initWatchListStore();
    await flushMicrotasks();
    expect(watchListStore.get()).toEqual(fullCfg({ players: ['11', '22'] }));
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

describe('watchList — sync ts-ledger (per-key LWW stamps)', () => {
  const UNI = 's163-pl';
  const CKEY = watchListKeyFor(UNI);
  const TKEY = watchListTsKeyFor(UNI);
  const NOW = 1_700_000_000_000;
  /** @type {Map<string, any>} */
  const backing = new Map();

  beforeEach(() => {
    disposeWatchListStore();
    backing.clear();
    mockStore.get.mockReset();
    mockStore.set.mockReset();
    // Map-backed store: the ledger helpers are read-modify-write, so the
    // resolved-undefined stub the other suites use is not enough here.
    mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(backing.get(k)));
    mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
      backing.set(k, v);
      return Promise.resolve();
    });
  });
  afterEach(disposeWatchListStore);

  it('exports the ledger key suffix (a *Ts base — sync plumbing for the inventory)', () => {
    expect(WATCH_LIST_TS_KEY_BASE).toBe('oge_watchListTs');
    expect(watchListTsKeyFor(UNI)).toBe('s163-pl:oge_watchListTs');
  });

  it('normalizeWatchListLedger materialises every family and drops junk stamps', () => {
    const led = normalizeWatchListLedger({ watched: { 1: 100, 2: 'NaN' }, rel: 'junk' });
    expect(led.watched).toEqual({ 1: 100 });
    expect(led.rel).toEqual({});
    expect(led.cadence).toEqual({});
  });

  it('writeWatchListConfig stamps additions; an explicit removal births the tombstone', async () => {
    await writeWatchListConfig(UNI, { players: ['1', '2'] }, NOW);
    expect(backing.get(CKEY).players).toEqual(['1', '2']);
    expect(backing.get(TKEY).watched).toEqual({ 1: NOW, 2: NOW });

    // Un-star player 1: the config loses the key, the ledger KEEPS it,
    // re-stamped — that entry is the removal tombstone sync propagates.
    await writeWatchListConfig(UNI, { players: ['2'] }, NOW + 5000);
    expect(backing.get(CKEY).players).toEqual(['2']);
    expect(backing.get(TKEY).watched).toEqual({ 1: NOW + 5000, 2: NOW });
  });

  it('a probes-only change rewrites the config but never touches the ledger', async () => {
    await writeWatchListConfig(UNI, { players: ['1'] }, NOW);
    const setsBefore = mockStore.set.mock.calls.length;
    await writeWatchListConfig(UNI, { players: ['1'], probes: 33 }, NOW + 1000);
    const setsAfter = mockStore.set.mock.calls.slice(setsBefore);
    expect(setsAfter.map((/** @type {any[]} */ c) => c[0])).toEqual([CKEY]); // no TKEY write
    expect(backing.get(TKEY).watched).toEqual({ 1: NOW });
  });

  it('ensureWatchListLedgerSeeded stamps a pre-ledger legacy config ONCE (stable stamps)', async () => {
    backing.set(CKEY, { players: ['7'], probes: 5, relationships: { 7: 'enemy' } });
    const first = await ensureWatchListLedgerSeeded(UNI, NOW);
    expect(first.ledger.watched).toEqual({ 7: NOW });
    expect(first.ledger.rel).toEqual({ 7: NOW });
    expect(backing.get(TKEY)).toEqual(first.ledger); // persisted

    const setsBefore = mockStore.set.mock.calls.length;
    const second = await ensureWatchListLedgerSeeded(UNI, NOW + 9999);
    expect(second.ledger).toEqual(first.ledger); // no re-stamp drift
    expect(mockStore.set.mock.calls.length).toBe(setsBefore); // no write
  });

  it('applyWatchListSyncSlot adopts remote values verbatim and preserves the local-only fields', async () => {
    backing.set(CKEY, { players: ['1'], probes: 7, rescan: { 1: 123 } });
    await applyWatchListSyncSlot(UNI, /** @type {any} */ ({
      watched: { 1: { ts: NOW }, 2: { v: true, ts: NOW - 50 } }, // 1 un-starred remotely
      rel: { 2: { v: 'friend', ts: NOW - 50 } },
      scan: {}, gal: {}, hide: {},
      scanBodies: { _: { v: 'both', ts: NOW - 50 } },
      cadence: {},
    }));
    const cfg = backing.get(CKEY);
    expect(cfg.players).toEqual(['2']);
    expect(cfg.relationships).toEqual({ 2: 'friend' });
    expect(cfg.scanBodies).toBe('both');
    expect(cfg.probes).toBe(7); // local-only fields survive the adoption
    expect(cfg.rescan).toEqual({ 1: 123 });
    // The ledger carries the REMOTE stamps (never re-stamped with local now).
    expect(backing.get(TKEY).watched).toEqual({ 1: NOW, 2: NOW - 50 });
  });
});
