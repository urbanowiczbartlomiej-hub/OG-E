// Unit tests for the body-inventory state store.
//
// Like `state/fsRoutes.js`, the store is a thin `createStore` wrapper; the
// behaviour worth testing is the lazy persist wiring (`initBodiesStore`
// hydrates from chrome.storage.local and subscribes a write-through) plus
// the `narrowInventory` guard. We mock `lib/storage.js` before importing so
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
  BODIES_KEY_BASE,
  bodiesKeyFor,
  bodiesStore,
  initBodiesStore,
  disposeBodiesStore,
  whenBodiesHydrated,
  _resetBodiesStoreForTest,
} from '../../src/state/bodies.js';

/**
 * @type {{ get: import('vitest').Mock, set: import('vitest').Mock,
 *   remove: import('vitest').Mock, onChanged: import('vitest').Mock }}
 */
const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  _resetBodiesStoreForTest();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

/** Await enough microtasks for the persist hydrate `.then` chain to land. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** @returns {import('../../src/state/bodies.js').BodyInventory} */
const sampleInventory = () => ({
  bodies: [
    { cp: 100, name: 'P1', galaxy: 4, system: 467, position: 15, type: 1 },
    { cp: 101, name: 'K1', galaxy: 4, system: 467, position: 15, type: 3 },
  ],
  capturedAt: 1700000000000,
});

describe('bodiesStore — defaults and keys', () => {
  beforeEach(resetAll);
  afterEach(disposeBodiesStore);

  it('starts as an empty inventory before init', () => {
    expect(bodiesStore.get()).toEqual({ bodies: [], capturedAt: 0 });
  });

  it('exports the expected key suffix and composes a per-universe key', () => {
    expect(BODIES_KEY_BASE).toBe('oge_bodies');
    expect(bodiesKeyFor('s163-pl')).toBe('s163-pl:oge_bodies');
  });

  it('round-trips set/get without persist wiring', () => {
    const inv = sampleInventory();
    bodiesStore.set(inv);
    expect(bodiesStore.get()).toEqual(inv);
  });
});

describe('bodiesStore — hydration via initBodiesStore', () => {
  beforeEach(resetAll);
  afterEach(disposeBodiesStore);

  it('calls chromeStore.get with the bare key in a non-DOM env', () => {
    initBodiesStore();
    expect(mockStore.get).toHaveBeenCalledTimes(1);
    expect(mockStore.get).toHaveBeenCalledWith('oge_bodies');
  });

  it('hydrates a well-formed inventory and resolves whenBodiesHydrated', async () => {
    const stored = sampleInventory();
    mockStore.get.mockResolvedValueOnce(stored);

    let hydrated = false;
    void whenBodiesHydrated().then(() => { hydrated = true; });

    initBodiesStore();
    expect(bodiesStore.get()).toEqual({ bodies: [], capturedAt: 0 }); // not yet
    await flushMicrotasks();

    expect(bodiesStore.get()).toEqual(stored);
    expect(hydrated).toBe(true);
  });

  it('rejects a malformed payload (bodies not an array) and keeps the empty initial', async () => {
    mockStore.get.mockResolvedValueOnce({ bodies: 'nope', capturedAt: 5 });
    initBodiesStore();
    await flushMicrotasks();
    expect(bodiesStore.get()).toEqual({ bodies: [], capturedAt: 0 });
  });

  it('defaults capturedAt to 0 when the stored value omits / mistypes it', async () => {
    mockStore.get.mockResolvedValueOnce({ bodies: [], capturedAt: 'x' });
    initBodiesStore();
    await flushMicrotasks();
    expect(bodiesStore.get()).toEqual({ bodies: [], capturedAt: 0 });
  });

  it('writes through to chromeStore.set on change', async () => {
    initBodiesStore();
    await flushMicrotasks();
    const inv = sampleInventory();
    bodiesStore.set(inv);
    // Last write-through payload must carry the inventory under one key.
    const lastCall = mockStore.set.mock.calls[mockStore.set.mock.calls.length - 1];
    expect(lastCall[0]).toBe('oge_bodies');
    expect(lastCall[1]).toEqual(inv);
  });

  it('is idempotent — a second init does not re-register', () => {
    const dispose1 = initBodiesStore();
    const dispose2 = initBodiesStore();
    expect(dispose1).toBe(dispose2);
    expect(mockStore.get).toHaveBeenCalledTimes(1);
  });
});
