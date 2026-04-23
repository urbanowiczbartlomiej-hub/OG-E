// Unit tests for the known-planets state module.
//
// Node environment (no happy-dom): the module under test only depends on
// `chromeStore`, which we replace wholesale with a `vi.mock` so no real
// storage API is ever touched. Tests verify:
//   - the reactive-store surface (initial empty Set, set/update notify),
//   - the array↔Set codec on hydrate and save,
//   - idempotent init + dispose cutting the subscription.
//
// Mirrors `state/history.test.js` structurally — the only interesting
// difference is the Set-vs-array persistence boundary that this test
// suite explicitly pins.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the storage layer BEFORE importing the module under test — vi.mock
// is hoisted, so the knownPlanets.js import below sees the mocked
// chromeStore, not the real one. The store only reaches for get/set.
vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  knownPlanetsStore,
  initKnownPlanetsStore,
  disposeKnownPlanetsStore,
  _resetKnownPlanetsStoreForTest,
  KNOWN_PLANETS_KEY,
} from '../../src/state/knownPlanets.js';

describe('knownPlanetsStore (module)', () => {
  beforeEach(() => {
    // Clear mock call logs AND the store singleton between tests.
    vi.clearAllMocks();
    _resetKnownPlanetsStoreForTest();
    /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(undefined);
    /** @type {import('vitest').Mock} */ (chromeStore.set).mockResolvedValue(undefined);
  });

  describe('reactive-store surface', () => {
    it('starts with an empty Set', () => {
      const s = knownPlanetsStore.get();
      expect(s).toBeInstanceOf(Set);
      expect(s.size).toBe(0);
    });

    it('set replaces the state and get returns the new Set', () => {
      const next = new Set([1, 2, 3]);
      knownPlanetsStore.set(next);
      expect(knownPlanetsStore.get()).toBe(next);
    });

    it('update derives new state from prev', () => {
      knownPlanetsStore.set(new Set([1]));
      knownPlanetsStore.update((prev) => new Set([...prev, 2]));
      expect([...knownPlanetsStore.get()]).toEqual([1, 2]);
    });

    it('subscribe fires on subsequent set (not on registration)', () => {
      const listener = vi.fn();
      const unsubscribe = knownPlanetsStore.subscribe(listener);
      expect(listener).not.toHaveBeenCalled();

      knownPlanetsStore.set(new Set([42]));
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      knownPlanetsStore.set(new Set());
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('KNOWN_PLANETS_KEY', () => {
    it("is the documented 'oge5_knownPlanets'", () => {
      expect(KNOWN_PLANETS_KEY).toBe('oge5_knownPlanets');
    });
  });

  describe('initKnownPlanetsStore — hydration', () => {
    it('reads via chromeStore.get with KNOWN_PLANETS_KEY', () => {
      initKnownPlanetsStore();
      expect(chromeStore.get).toHaveBeenCalledTimes(1);
      expect(chromeStore.get).toHaveBeenCalledWith('oge5_knownPlanets');
    });

    it('seeds the store as a Set when the stored value is an array', async () => {
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(
        [10, 20, 30],
      );
      initKnownPlanetsStore();
      // Flush microtasks: chromeStore.get → load closure → persist.then.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const s = knownPlanetsStore.get();
      expect(s).toBeInstanceOf(Set);
      expect([...s].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    });

    it('filters out non-finite entries from corrupt payloads', async () => {
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(
        // eslint-disable-next-line no-sparse-arrays
        [1, 'banana', Number.NaN, Infinity, 2, null, 3],
      );
      initKnownPlanetsStore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect([...knownPlanetsStore.get()].sort((a, b) => a - b)).toEqual([
        1, 2, 3,
      ]);
    });

    it('keeps the empty initial Set when stored payload is non-array', async () => {
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(
        { a: 1 },
      );
      initKnownPlanetsStore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(knownPlanetsStore.get().size).toBe(0);
    });

    it('keeps the empty initial Set when nothing is stored', async () => {
      /** @type {import('vitest').Mock} */ (chromeStore.get).mockResolvedValue(undefined);
      initKnownPlanetsStore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(knownPlanetsStore.get().size).toBe(0);
    });
  });

  describe('initKnownPlanetsStore — write-through (0ms debounce)', () => {
    it('writes an array synchronously on every store.set', () => {
      initKnownPlanetsStore();
      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();

      const payload = new Set([100, 200]);
      knownPlanetsStore.set(payload);

      expect(chromeStore.set).toHaveBeenCalledTimes(1);
      const [key, value] = /** @type {import('vitest').Mock} */ (chromeStore.set).mock.calls[0];
      expect(key).toBe('oge5_knownPlanets');
      // Persist shape is a plain array — never a Set.
      expect(Array.isArray(value)).toBe(true);
      expect(/** @type {number[]} */ (value).sort((a, b) => a - b)).toEqual([
        100, 200,
      ]);
    });

    it('dispose prevents further writes', () => {
      initKnownPlanetsStore();
      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();

      knownPlanetsStore.set(new Set([1]));
      expect(chromeStore.set).toHaveBeenCalledTimes(1);

      disposeKnownPlanetsStore();

      knownPlanetsStore.set(new Set([2]));
      knownPlanetsStore.set(new Set([3]));
      expect(chromeStore.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('initKnownPlanetsStore — idempotency', () => {
    it('second call returns the same dispose fn without re-subscribing', () => {
      const d1 = initKnownPlanetsStore();
      const d2 = initKnownPlanetsStore();

      expect(d2).toBe(d1);
      expect(chromeStore.get).toHaveBeenCalledTimes(1);

      /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();
      knownPlanetsStore.set(new Set([9]));
      // Only one subscription means exactly one save.
      expect(chromeStore.set).toHaveBeenCalledTimes(1);
    });
  });
});
