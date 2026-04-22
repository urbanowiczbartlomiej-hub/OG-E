// Unit tests for the scans state store.
//
// The store itself is a trivial `createStore` wrapper — interesting
// behaviour lives in the lazy persist wiring: `initScansStore()` hydrates
// from `chrome.storage.local` (async) and subscribes a 200ms debounced
// write-through. We exercise both halves by mocking `../../src/lib/storage.js`
// at the top of the file (before importing `state/scans.js`) so every
// `chromeStore.get`/`chromeStore.set` call is a vi.fn we can assert on.
//
// Node environment — no DOM needed; the storage module is fully stubbed.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the storage layer BEFORE importing the module under test so that
// `state/scans.js` picks up the stubbed `chromeStore` when its
// `initScansStore` wires up persist. Must be a static factory — vi.mock
// is hoisted above the imports at runtime.
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
  SCANS_KEY,
  scansStore,
  initScansStore,
  disposeScansStore,
} from '../../src/state/scans.js';

/**
 * The mocked chromeStore is a shared singleton across every test. Tell
 * TypeScript that `get`/`set` are vitest Mocks so we can use
 * `.mockResolvedValueOnce` / `.mockReturnValueOnce` / `.mock.calls` etc.
 *
 * @type {{
 *   get: import('vitest').Mock,
 *   set: import('vitest').Mock,
 *   remove: import('vitest').Mock,
 *   onChanged: import('vitest').Mock,
 * }}
 */
const mockStore = /** @type {any} */ (chromeStore);

/**
 * Tests install and tear down `persist` wiring per-case via
 * `disposeScansStore`, but `scansStore` itself is a long-lived singleton —
 * its state persists across tests unless we reset it. Called from
 * beforeEach so every case starts with a clean {@link scansStore} at the
 * default `{}` value regardless of what the previous test left behind.
 *
 * @returns {void}
 */
const resetAll = () => {
  disposeScansStore();
  scansStore.set({});
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.remove.mockReset();
  mockStore.onChanged.mockReset();
  // Default: nothing stored (hydrate resolves to undefined → no-op).
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

describe('scansStore — default state and basic ops', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    disposeScansStore();
  });

  it('starts as an empty object when persist has not been initialised', () => {
    // No `initScansStore()` call — store should still be the initial {}.
    expect(scansStore.get()).toEqual({});
  });

  it('exports the expected chrome.storage key', () => {
    expect(SCANS_KEY).toBe('oge5_galaxyScans');
  });

  it('round-trips set/get without any persist wiring', () => {
    /** @type {import('../../src/state/scans.js').SystemScan} */
    const sys = { scannedAt: 123, positions: {} };
    scansStore.set(/** @type {any} */ ({ '4:30': sys }));
    expect(scansStore.get()).toEqual({ '4:30': sys });
  });

  it('notifies subscribers on set', () => {
    const sub = vi.fn();
    const unsubscribe = scansStore.subscribe(sub);
    /** @type {import('../../src/state/scans.js').SystemScan} */
    const sys = { scannedAt: 999, positions: {} };
    scansStore.set(/** @type {any} */ ({ '1:1': sys }));
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub).toHaveBeenCalledWith({ '1:1': sys });
    unsubscribe();
  });
});

describe('scansStore — hydration via initScansStore', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    disposeScansStore();
  });

  it('initScansStore calls chromeStore.get with SCANS_KEY', () => {
    initScansStore();
    expect(mockStore.get).toHaveBeenCalledTimes(1);
    expect(mockStore.get).toHaveBeenCalledWith('oge5_galaxyScans');
  });

  it('hydrates the store when chromeStore.get resolves with a value', async () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const stored = {
      '4:30': { scannedAt: 1700000000, positions: {} },
      '1:5': { scannedAt: 1700000500, positions: {} },
    };
    mockStore.get.mockResolvedValueOnce(stored);

    initScansStore();

    // Before the promise resolves the store still holds the initial {}.
    expect(scansStore.get()).toEqual({});

    // Use a polling-style flush that awaits as many microtasks as needed
    // for the persist `.then(v => store.set(v))` chain to land. Two
    // microtask ticks are usually enough (mockResolvedValueOnce → then),
    // but we loop a few times for safety against library-version quirks.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(scansStore.get()).toEqual(stored);
  });

  it('leaves the store alone when chromeStore.get resolves with undefined', async () => {
    // Default `mockResolvedValue(undefined)` applied in resetAll.
    initScansStore();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(scansStore.get()).toEqual({});
  });
});

describe('scansStore — write-through (debounced 200ms)', () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    disposeScansStore();
  });

  it('collapses a burst of sets into one save with the latest value', async () => {
    initScansStore();
    // Flush hydrate (resolves to undefined → no-op, no save fired).
    await mockStore.get.mock.results[0].value;
    await Promise.resolve();

    /** @type {import('../../src/state/scans.js').SystemScan} */
    const a = { scannedAt: 1, positions: {} };
    /** @type {import('../../src/state/scans.js').SystemScan} */
    const b = { scannedAt: 2, positions: {} };
    /** @type {import('../../src/state/scans.js').SystemScan} */
    const c = { scannedAt: 3, positions: {} };
    scansStore.set(/** @type {any} */ ({ '4:30': a }));
    scansStore.set(/** @type {any} */ ({ '4:30': b }));
    scansStore.set(/** @type {any} */ ({ '4:30': c }));

    // Before the debounce window closes, nothing has been saved.
    expect(mockStore.set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(mockStore.set).toHaveBeenCalledTimes(1);
    expect(mockStore.set).toHaveBeenCalledWith('oge5_galaxyScans', { '4:30': c });
  });

  it('does NOT fire save before the full 200ms has elapsed', async () => {
    initScansStore();
    await mockStore.get.mock.results[0].value;
    await Promise.resolve();

    scansStore.set(
      /** @type {any} */ ({ '1:1': { scannedAt: 1, positions: {} } }),
    );

    vi.advanceTimersByTime(199);
    expect(mockStore.set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // now at 200ms
    expect(mockStore.set).toHaveBeenCalledTimes(1);
  });
});

describe('scansStore — teardown and idempotency', () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    disposeScansStore();
  });

  it('disposeScansStore stops further saves', async () => {
    initScansStore();
    await mockStore.get.mock.results[0].value;
    await Promise.resolve();

    scansStore.set(
      /** @type {any} */ ({ '4:30': { scannedAt: 10, positions: {} } }),
    );
    vi.advanceTimersByTime(200);
    expect(mockStore.set).toHaveBeenCalledTimes(1);

    disposeScansStore();

    scansStore.set(
      /** @type {any} */ ({ '4:30': { scannedAt: 20, positions: {} } }),
    );
    vi.advanceTimersByTime(200);
    // Still 1 — the write-through subscription was unhooked.
    expect(mockStore.set).toHaveBeenCalledTimes(1);
  });

  it('initScansStore is idempotent — a second call does not double-wire the subscription', async () => {
    initScansStore();
    initScansStore();
    initScansStore();
    await mockStore.get.mock.results[0].value;
    await Promise.resolve();

    // Hydrate probe — only the first init fired chromeStore.get.
    expect(mockStore.get).toHaveBeenCalledTimes(1);

    // And a single mutation debounces into a single save, not three.
    scansStore.set(
      /** @type {any} */ ({ '4:30': { scannedAt: 99, positions: {} } }),
    );
    vi.advanceTimersByTime(200);
    expect(mockStore.set).toHaveBeenCalledTimes(1);
  });
});
