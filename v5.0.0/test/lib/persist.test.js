// Unit tests for the persist helper — verify hydration (sync + async),
// write-through (immediate + debounced), and the unsubscribe handle.
//
// No real storage is used. Every test wires in-memory load/save stubs
// so we can assert exactly when and with what values the helper calls
// into the backing layer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '../../src/lib/createStore.js';
import { persist } from '../../src/lib/persist.js';

describe('persist — hydration (sync load)', () => {
  it('seeds the store with the loaded value when load returns something', () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => 'from-storage',
      save: () => {},
    });
    expect(store.get()).toBe('from-storage');
  });

  it('leaves the store at its initial value when load returns null', () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => null,
      save: () => {},
    });
    expect(store.get()).toBe('initial');
  });

  it('leaves the store at its initial value when load returns undefined', () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => undefined,
      save: () => {},
    });
    expect(store.get()).toBe('initial');
  });

  it('hydrates falsy-but-meaningful values (0, empty string, false)', () => {
    // Guard against over-eager coalescing: only null / undefined should
    // skip hydration. 0, '', and false are legitimate persisted values.
    const numStore = createStore(99);
    persist({ store: numStore, load: () => 0, save: () => {} });
    expect(numStore.get()).toBe(0);

    const strStore = createStore('init');
    persist({ store: strStore, load: () => '', save: () => {} });
    expect(strStore.get()).toBe('');

    const boolStore = createStore(true);
    persist({ store: boolStore, load: () => false, save: () => {} });
    expect(boolStore.get()).toBe(false);
  });

  it('calls load exactly once (on init, not on each change)', () => {
    const store = createStore(0);
    const load = vi.fn(() => 42);
    persist({ store, load, save: () => {} });
    store.set(1);
    store.set(2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('persist — hydration (async load)', () => {
  it('seeds the store once the promise resolves', async () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => Promise.resolve('from-storage'),
      save: () => {},
    });
    // Promise hasn't resolved yet; store still holds initial.
    expect(store.get()).toBe('initial');
    // Flush microtasks.
    await Promise.resolve();
    expect(store.get()).toBe('from-storage');
  });

  it('leaves the store alone when the promise resolves to null', async () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => Promise.resolve(null),
      save: () => {},
    });
    await Promise.resolve();
    expect(store.get()).toBe('initial');
  });

  it('leaves the store alone when the promise resolves to undefined', async () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => Promise.resolve(undefined),
      save: () => {},
    });
    await Promise.resolve();
    expect(store.get()).toBe('initial');
  });
});

describe('persist — write-through (immediate)', () => {
  it('save is NOT called during init hydration', () => {
    // A save after the initial hydrate would be a round-trip (read then
    // immediately rewrite the same bytes). We don't forbid it if a
    // subscriber fires (hydrate DOES call store.set which triggers the
    // write-through subscription — that's the documented semantics), but
    // we DO want callers to see it at most once and only with the
    // freshly-hydrated value. Below we verify the behavior for the
    // null-load case where there's no hydration at all.
    const store = createStore('initial');
    const save = vi.fn();
    persist({ store, load: () => null, save });
    expect(save).not.toHaveBeenCalled();
  });

  it('save is called on every store.set when debounceMs is 0', () => {
    const store = createStore('initial');
    const save = vi.fn();
    persist({ store, load: () => null, save });

    store.set('a');
    store.set('b');
    store.set('c');

    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenNthCalledWith(1, 'a');
    expect(save).toHaveBeenNthCalledWith(2, 'b');
    expect(save).toHaveBeenNthCalledWith(3, 'c');
  });

  it('save is called on store.update as well', () => {
    const store = createStore(10);
    const save = vi.fn();
    persist({ store, load: () => null, save });

    store.update((n) => n + 1);
    store.update((n) => n * 2);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, 11);
    expect(save).toHaveBeenNthCalledWith(2, 22);
  });

  it('fires save once on hydrate (write-through echo), then per user change', () => {
    // Hydration goes through store.set, which fires the subscribe chain,
    // which triggers the write-through. That's documented as acceptable:
    // we rewrite the same bytes we just read. Test pins the exact count.
    const store = createStore('initial');
    const save = vi.fn();
    persist({ store, load: () => 'from-storage', save });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('from-storage');

    store.set('next');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('next');
  });
});

describe('persist — write-through (debounced)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collapses a burst of writes into one trailing save', () => {
    const store = createStore('initial');
    const save = vi.fn();
    persist({ store, load: () => null, save, debounceMs: 100 });

    store.set('a');
    store.set('b');
    store.set('c');

    // Nothing yet — debounce holds the save.
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    // One call, with the latest value.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('c');
  });

  it('fires again after a second quiet period', () => {
    const store = createStore('initial');
    const save = vi.fn();
    persist({ store, load: () => null, save, debounceMs: 100 });

    store.set('a');
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith('a');

    store.set('b');
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('b');
  });
});

describe('persist — unsubscribe', () => {
  it('returned function prevents future saves', () => {
    const store = createStore('initial');
    const save = vi.fn();
    const unsubscribe = persist({ store, load: () => null, save });

    store.set('a');
    expect(save).toHaveBeenCalledTimes(1);

    unsubscribe();

    store.set('b');
    store.set('c');
    expect(save).toHaveBeenCalledTimes(1); // still 1 — unsubscribed
  });

  it('unsubscribe is idempotent (no throw on repeat)', () => {
    const store = createStore('initial');
    const unsubscribe = persist({ store, load: () => null, save: () => {} });
    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});
