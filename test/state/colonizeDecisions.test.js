// Unit tests for state/colonizeDecisions — the reactive decision-log store.
//
// The store itself is a trivial createStore wrapper; the behaviour lives in
// the persist wiring: `initColonizeDecisionsStore()` hydrates from
// chrome.storage.local (async), compacts once on hydrate, and subscribes a
// 200ms debounced write-through. `flushColonizeDecisionsStore()` is the
// synchronous bypass the post-send page reload needs. We mock
// `../../src/lib/storage.js` (so chromeStore is a vi.fn) and drive the key
// through the real currentUniverseKey by pinning location.host.
//
// @vitest-environment happy-dom
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
  colonizeDecisionsKeyFor,
  colonizeDecisionsStore,
  initColonizeDecisionsStore,
  disposeColonizeDecisionsStore,
  flushColonizeDecisionsStore,
} from '../../src/state/colonizeDecisions.js';
import { DEC_SENT, DEC_MINE, SENT_GRACE_MS } from '../../src/domain/colonizeDecisions.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

/** Drain a few microtasks so the persist hydrate `.then(...)` chain lands. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const resetAll = () => {
  disposeColonizeDecisionsStore();
  colonizeDecisionsStore.set({});
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php';
};

describe('colonizeDecisions store — keys + basic ops', () => {
  beforeEach(resetAll);
  afterEach(disposeColonizeDecisionsStore);

  it('composes a per-universe namespaced key', () => {
    expect(colonizeDecisionsKeyFor('s163-pl')).toBe('s163-pl:oge_colonizeDecisions');
  });

  it('starts as an empty object before any persist wiring', () => {
    expect(colonizeDecisionsStore.get()).toEqual({});
  });

  it('notifies subscribers on set', () => {
    const sub = vi.fn();
    const off = colonizeDecisionsStore.subscribe(sub);
    colonizeDecisionsStore.set({ '1:1:2': { s: DEC_SENT, ts: 100 } });
    expect(sub).toHaveBeenCalledWith({ '1:1:2': { s: DEC_SENT, ts: 100 } });
    off();
  });
});

describe('colonizeDecisions store — hydration + compaction', () => {
  beforeEach(resetAll);
  afterEach(disposeColonizeDecisionsStore);

  it('initColonizeDecisionsStore reads the current-universe key once', () => {
    initColonizeDecisionsStore();
    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(mock.get).toHaveBeenCalledWith('s163-pl:oge_colonizeDecisions');
  });

  it('is idempotent — a second init returns the same disposer without re-reading', () => {
    const d1 = initColonizeDecisionsStore();
    const d2 = initColonizeDecisionsStore();
    expect(d1).toBe(d2);
    expect(mock.get).toHaveBeenCalledTimes(1);
  });

  it('hydrates the store from the stored map', async () => {
    const stored = { '1:1:2': { s: DEC_MINE, ts: 100, f: 200 } };
    mock.get.mockResolvedValueOnce(stored);
    initColonizeDecisionsStore();
    expect(colonizeDecisionsStore.get()).toEqual({}); // before resolve
    await flushMicrotasks();
    expect(colonizeDecisionsStore.get()).toEqual(stored);
  });

  it('compacts expired entries once on hydrate (no-show sent dropped, mine kept)', async () => {
    const now = Date.now();
    const stored = {
      keep: { s: DEC_MINE, ts: 1, f: 50 },
      drop: { s: DEC_SENT, ts: 1, aa: now - SENT_GRACE_MS - 1000 },
    };
    mock.get.mockResolvedValueOnce(stored);
    initColonizeDecisionsStore();
    await flushMicrotasks();
    expect(colonizeDecisionsStore.get()).toEqual({ keep: { s: DEC_MINE, ts: 1, f: 50 } });
  });

  it('leaves the store at {} when nothing is stored', async () => {
    initColonizeDecisionsStore();
    await flushMicrotasks();
    expect(colonizeDecisionsStore.get()).toEqual({});
  });
});

describe('colonizeDecisions store — write-through (debounced 200ms)', () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    disposeColonizeDecisionsStore();
  });

  it('collapses a burst of sets into one save with the latest value', async () => {
    initColonizeDecisionsStore();
    await mock.get.mock.results[0].value; // flush hydrate (undefined → no-op)
    await Promise.resolve();

    colonizeDecisionsStore.set({ '1:1:1': { s: DEC_SENT, ts: 1 } });
    colonizeDecisionsStore.set({ '1:1:1': { s: DEC_SENT, ts: 2 } });
    colonizeDecisionsStore.set({ '1:1:1': { s: DEC_MINE, ts: 3 } });

    expect(mock.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(mock.set).toHaveBeenCalledTimes(1);
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_colonizeDecisions', {
      '1:1:1': { s: DEC_MINE, ts: 3 },
    });
  });

  it('does not save before the full 200ms window has elapsed', async () => {
    initColonizeDecisionsStore();
    await mock.get.mock.results[0].value;
    await Promise.resolve();

    colonizeDecisionsStore.set({ '1:1:1': { s: DEC_SENT, ts: 1 } });
    vi.advanceTimersByTime(199);
    expect(mock.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mock.set).toHaveBeenCalledTimes(1);
  });
});

describe('colonizeDecisions store — dispose + flush', () => {
  beforeEach(resetAll);
  afterEach(disposeColonizeDecisionsStore);

  it('dispose stops the write-through subscription', async () => {
    vi.useFakeTimers();
    try {
      initColonizeDecisionsStore();
      await mock.get.mock.results[0].value;
      await Promise.resolve();
      disposeColonizeDecisionsStore();
      colonizeDecisionsStore.set({ '1:1:1': { s: DEC_SENT, ts: 1 } });
      vi.advanceTimersByTime(500);
      expect(mock.set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose is idempotent (a second call is a no-op)', () => {
    initColonizeDecisionsStore();
    disposeColonizeDecisionsStore();
    expect(() => disposeColonizeDecisionsStore()).not.toThrow();
  });

  it('flush synchronously persists the current value, bypassing the debounce', async () => {
    colonizeDecisionsStore.set({ '4:30:8': { s: DEC_SENT, ts: 5, aa: 99 } });
    await flushColonizeDecisionsStore();
    expect(mock.set).toHaveBeenCalledTimes(1);
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_colonizeDecisions', {
      '4:30:8': { s: DEC_SENT, ts: 5, aa: 99 },
    });
  });
});
