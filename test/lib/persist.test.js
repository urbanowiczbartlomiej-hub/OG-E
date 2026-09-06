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

describe('persist — onHydrate callback', () => {
  it('fires once after a sync load that returned a value', () => {
    const store = createStore('initial');
    const onHydrate = vi.fn();
    persist({
      store,
      load: () => 'from-storage',
      save: () => {},
      onHydrate,
    });
    expect(onHydrate).toHaveBeenCalledTimes(1);
    // Store has been seeded by the time the callback fires; this is the
    // whole point of the gate (consumers reading the store inside
    // onHydrate must see the hydrated value, not the initial).
    expect(store.get()).toBe('from-storage');
  });

  it('fires once after a sync load that returned null (nothing stored)', () => {
    // Even "nothing to hydrate" must still settle the gate — otherwise
    // consumers (e.g. colonyRecorder) would hang forever waiting for
    // a hydrate signal that will never arrive.
    const store = createStore('initial');
    const onHydrate = vi.fn();
    persist({ store, load: () => null, save: () => {}, onHydrate });
    expect(onHydrate).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe('initial');
  });

  it('fires once after an async load resolves with a value', async () => {
    const store = createStore('initial');
    const onHydrate = vi.fn();
    persist({
      store,
      load: () => Promise.resolve('from-storage'),
      save: () => {},
      onHydrate,
    });
    // Async branch — not yet settled at the synchronous tick.
    expect(onHydrate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onHydrate).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe('from-storage');
  });

  it('fires once after an async load resolves with null', async () => {
    const store = createStore('initial');
    const onHydrate = vi.fn();
    persist({
      store,
      load: () => Promise.resolve(null),
      save: () => {},
      onHydrate,
    });
    await Promise.resolve();
    expect(onHydrate).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe('initial');
  });

  it('omitting onHydrate is fine (no throw, no observable difference)', async () => {
    const store = createStore('initial');
    // Sync branch with no onHydrate.
    expect(() => {
      persist({ store, load: () => 'sync-value', save: () => {} });
    }).not.toThrow();
    expect(store.get()).toBe('sync-value');

    // Async branch with no onHydrate.
    const store2 = createStore('init');
    persist({ store: store2, load: () => Promise.resolve('async-value'), save: () => {} });
    await Promise.resolve();
    expect(store2.get()).toBe('async-value');
  });

  it('does NOT fire on subsequent user-driven writes', async () => {
    const store = createStore('initial');
    const onHydrate = vi.fn();
    persist({ store, load: () => 'from-storage', save: () => {}, onHydrate });
    expect(onHydrate).toHaveBeenCalledTimes(1);

    store.set('a');
    store.set('b');
    store.update((s) => s + '-c');
    expect(onHydrate).toHaveBeenCalledTimes(1);
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

describe('persist — a failed save is reported, never silently dropped', () => {
  // The bug this pins: `writeNow` used to call `save()` and discard the
  // returned promise. chromeStore.set REJECTS when the browser refuses the
  // write (a full storage quota is the real-world case), so the store kept the
  // value in memory, storage never got it, and the change vanished on the next
  // page load with nothing in the console. Losing data must at minimum be
  // visible.
  /** @type {any} */
  let errSpy;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs when an async save rejects', async () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => null,
      save: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')),
    });

    store.set('next');
    // Let the rejection settle — the log happens in the promise's catch.
    await Promise.resolve();
    await Promise.resolve();

    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls
      .map((/** @type {unknown[]} */ c) => c.map(String).join(' '))
      .join('\n');
    expect(msg).toContain('change NOT saved');
    expect(msg).toContain('QUOTA_BYTES');
  });

  it('logs when a sync save throws, and does not break the subscription', () => {
    const store = createStore('initial');
    let calls = 0;
    persist({
      store,
      load: () => null,
      save: () => {
        calls += 1;
        if (calls === 1) throw new Error('disk on fire');
      },
    });

    expect(() => store.set('a')).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    // A throw must not unsubscribe the write-through: the NEXT change still
    // reaches storage (this is what makes a transient failure recoverable).
    store.set('b');
    expect(calls).toBe(2);
  });

  it('stays quiet when the save resolves', async () => {
    const store = createStore('initial');
    persist({ store, load: () => null, save: () => Promise.resolve() });
    store.set('next');
    await Promise.resolve();
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('persist — an orphaned content script is reported ONCE', () => {
  // Reloading/updating/disabling the extension severs an already-open tab's
  // bridge to chrome.storage: `chrome.runtime.id` goes undefined and every
  // write throws "Extension context invalidated". That is one fact about the
  // TAB, not one per store change — logged per write it buried the console
  // under hundreds of identical red errors. And it is not the silent-data-loss
  // case the error log exists for: nothing in that tab can be saved again
  // until the page reloads.
  /** @type {any} */
  let errSpy;
  /** @type {any} */
  let warnSpy;

  beforeEach(async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { _resetOrphanReportForTest } = await import('../../src/lib/persist.js');
    _resetOrphanReportForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (/** @type {any} */ (globalThis).chrome);
  });

  const invalidated = () => new Error('Extension context invalidated.');

  it('warns once and never errors, however many writes fail', async () => {
    const store = createStore('initial');
    persist({ store, load: () => null, save: () => Promise.reject(invalidated()) });

    for (const v of ['a', 'b', 'c', 'd']) store.set(v);
    await Promise.resolve();
    await Promise.resolve();

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0].join(' '))).toContain('Reload the page');
  });

  it('recognises the state from a dead runtime even when the error says nothing', () => {
    // Not every failure downstream of an invalidated context carries the
    // browser's wording; `chrome.runtime.id` gone is the same fact.
    /** @type {any} */ (globalThis).chrome = { runtime: {} };
    const store = createStore('initial');
    persist({
      store,
      load: () => null,
      save: () => {
        throw new Error('something vague');
      },
    });

    store.set('next');

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('still shouts about an ordinary write failure', async () => {
    const store = createStore('initial');
    persist({
      store,
      load: () => null,
      save: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')),
    });

    store.set('next');
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });
});
