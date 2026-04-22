// Unit tests for the colony-history state module.
//
// Node environment (no happy-dom): the module under test only depends on
// `chromeStore`, which we replace wholesale with a `vi.mock` so no real
// storage API is ever touched. Tests verify:
//   - the reactive-store surface (initial, set/update, subscribe notify),
//   - persistence wiring through `initHistoryStore` (key, hydration
//     branches, synchronous write-through with 0ms debounce, dispose
//     cutting the subscription, idempotent init).
//
// We deliberately keep the test fixtures minimal — one or two
// `ColonyEntry`-shaped objects are enough to prove the round-trip; the
// schema details live in `src/state/history.js` JSDoc.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the storage layer BEFORE importing the module under test — vi.mock
// is hoisted, so the history.js import below sees the mocked chromeStore,
// not the real one. We keep the mock surface tiny (get/set only) since
// the history store never reaches for remove/onChanged.
vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  historyStore,
  initHistoryStore,
  disposeHistoryStore,
  HISTORY_KEY,
} from '../../src/state/history.js';

/** @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry */

/**
 * Convenience builder — returns a fresh `ColonyEntry` per call so tests
 * can mutate the objects they get back without contaminating siblings.
 *
 * @param {Partial<ColonyEntry>} [overrides]
 * @returns {ColonyEntry}
 */
const entry = (overrides = {}) => ({
  cp: 1,
  fields: 200,
  coords: '[1:2:3]',
  position: 3,
  timestamp: 100,
  ...overrides,
});

describe('historyStore (module)', () => {
  beforeEach(() => {
    // Clear both the mock call logs AND the historyStore singleton's
    // persistence wiring between tests. Without the dispose step a
    // subscription from a previous test would still observe `set` calls
    // in later tests and double-fire our `save` assertions.
    vi.clearAllMocks();
    disposeHistoryStore();
    historyStore.set([]);
    // Give mocks a sensible default return so tests that don't care
    // about hydration still get a well-behaved chromeStore.
    /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(undefined);
    /** @type {import('vitest').Mock} */ (chromeStore.set).mockResolvedValue(undefined);
  });

  describe('reactive-store surface', () => {
    it('starts with an empty array as the initial state', () => {
      expect(historyStore.get()).toEqual([]);
    });

    it('set replaces the state and get returns the new value', () => {
      const next = [entry()];
      historyStore.set(next);
      expect(historyStore.get()).toBe(next);
    });

    it('update derives new state from prev', () => {
      historyStore.set([entry({ cp: 1 })]);
      historyStore.update((prev) => [...prev, entry({ cp: 2, timestamp: 200 })]);
      expect(historyStore.get()).toEqual([
        entry({ cp: 1 }),
        entry({ cp: 2, timestamp: 200 }),
      ]);
    });

    it('subscribe fires the listener on subsequent set calls (not on registration)', () => {
      const listener = vi.fn();
      const unsubscribe = historyStore.subscribe(listener);

      // createStore's contract: subscribe does NOT call back on register.
      expect(listener).not.toHaveBeenCalled();

      historyStore.set([entry()]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith([entry()]);

      unsubscribe();
      historyStore.set([]);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('HISTORY_KEY', () => {
    it("is the documented 'oge5_colonyHistory'", () => {
      // Pinning the exact string guards against an accidental rename —
      // the key is the wire contract with chrome.storage.local and the
      // sync payload.
      expect(HISTORY_KEY).toBe('oge5_colonyHistory');
    });
  });

  describe('initHistoryStore — hydration', () => {
    it('reads via chromeStore.get with HISTORY_KEY', () => {
      initHistoryStore();
      expect(chromeStore.get).toHaveBeenCalledTimes(1);
      expect(chromeStore.get).toHaveBeenCalledWith('oge5_colonyHistory');
    });

    it('seeds the store when the stored value is an array', async () => {
      const stored = [entry({ cp: 7, fields: 150, coords: '[1:2:3]', position: 3, timestamp: 100 })];
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(stored);

      initHistoryStore();
      // Flush the full microtask chain: chromeStore.get resolves, then
      // our async `load` closure resolves, then persist's `.then` fires
      // store.set. A simple four-tick settle (via Promise.resolve) is
      // enough to cover both awaits in the chain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(historyStore.get()).toEqual(stored);
    });

    it('keeps the empty initial value when stored payload is a non-array object', async () => {
      // Defensive narrowing: a corrupt payload (earlier schema, manual
      // tampering) must not crash hydration. `Array.isArray` gate in
      // the load closure returns null so persist skips hydrate.
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue({ a: 1 });

      initHistoryStore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(historyStore.get()).toEqual([]);
    });

    it('keeps the empty initial value when nothing is stored (undefined)', async () => {
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(undefined);

      initHistoryStore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(historyStore.get()).toEqual([]);
    });
  });

  describe('initHistoryStore — write-through (0ms debounce)', () => {
    it('writes synchronously on every store.set (no timer needed)', () => {
      initHistoryStore();
      // Reset after init so the assertions below count only the
      // user-driven writes, not any (possibly-empty) hydrate echo.
      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();

      const payload = [entry()];
      historyStore.set(payload);

      // Immediate, no fake timers: 0ms debounce means persist passes
      // `save` straight to the store subscription.
      expect(chromeStore.set).toHaveBeenCalledTimes(1);
      expect(chromeStore.set).toHaveBeenCalledWith('oge5_colonyHistory', payload);
    });

    it('dispose prevents further writes', () => {
      initHistoryStore();
      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();

      historyStore.set([entry({ cp: 1 })]);
      expect(chromeStore.set).toHaveBeenCalledTimes(1);

      disposeHistoryStore();

      historyStore.set([entry({ cp: 2, timestamp: 200 })]);
      historyStore.set([entry({ cp: 3, timestamp: 300 })]);
      // Subscription was cut — chromeStore.set must not be called again.
      expect(chromeStore.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('initHistoryStore — idempotency', () => {
    it('second call returns the same dispose fn without re-subscribing', () => {
      const dispose1 = initHistoryStore();
      const dispose2 = initHistoryStore();

      // Same handle, meaning no second persist wiring was installed.
      expect(dispose2).toBe(dispose1);
      // chromeStore.get was called exactly once (first init), not twice.
      expect(chromeStore.get).toHaveBeenCalledTimes(1);

      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();
      historyStore.set([entry()]);
      // If a second subscription had snuck in we'd see two calls.
      expect(chromeStore.set).toHaveBeenCalledTimes(1);
    });
  });
});
