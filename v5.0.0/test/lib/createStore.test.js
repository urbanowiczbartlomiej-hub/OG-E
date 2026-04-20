// Unit tests for the reactive store primitive.
//
// Covers the full observable surface: get/set/update semantics,
// subscribe registration (no immediate call), notification order,
// unsubscribe behavior (including idempotence) and generic typing.
// Pure in-memory — no DOM, no timers, no fakes beyond `vi.fn()`.

import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/lib/createStore.js';

describe('createStore', () => {
  it('get() returns the initial value immediately after creation', () => {
    const store = createStore(42);
    expect(store.get()).toBe(42);
  });

  it('set(next) replaces state; subsequent get() returns next', () => {
    const store = createStore(1);
    store.set(2);
    expect(store.get()).toBe(2);
    store.set(3);
    expect(store.get()).toBe(3);
  });

  it('update(fn) calls fn with current state and stores the returned value', () => {
    const store = createStore(10);
    const fn = vi.fn((/** @type {number} */ prev) => prev + 5);
    store.update(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(10);
    expect(store.get()).toBe(15);
  });

  it('subscribe does NOT invoke the callback on registration', () => {
    const store = createStore('hello');
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('set() notifies subscribers with the new state', () => {
    const store = createStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(7);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(7);
  });

  it('update() notifies subscribers with the new state', () => {
    const store = createStore(100);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((prev) => prev * 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(200);
  });

  it('notifies multiple subscribers in registration order', () => {
    const store = createStore(0);
    /** @type {string[]} */
    const calls = [];
    const a = vi.fn(() => {
      calls.push('a');
    });
    const b = vi.fn(() => {
      calls.push('b');
    });
    const c = vi.fn(() => {
      calls.push('c');
    });

    store.subscribe(a);
    store.subscribe(b);
    store.subscribe(c);

    store.set(1);

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(a).toHaveBeenCalledWith(1);
    expect(b).toHaveBeenCalledWith(1);
    expect(c).toHaveBeenCalledWith(1);
  });

  it('unsubscribe() removes the callback — no further notifications after set/update', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    store.set(2);
    store.update((prev) => prev + 1);

    // Still exactly one call — the two later mutations must not reach it.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(3);
  });

  it('unsubscribe is idempotent — calling it repeatedly does not throw', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();

    store.set(99);
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports generic T across primitive and object shapes', () => {
    // Number store
    const numStore = createStore(0);
    numStore.set(5);
    numStore.update((n) => n + 1);
    expect(numStore.get()).toBe(6);

    // String store
    const strStore = createStore('abc');
    strStore.update((s) => s + 'd');
    expect(strStore.get()).toBe('abcd');

    // Object store — generics infer the literal shape so field access
    // below is type-checked by tsc (would fail typecheck if T broadened).
    const objStore = createStore({ count: 0, label: 'x' });
    objStore.update((prev) => ({ ...prev, count: prev.count + 1 }));
    const snapshot = objStore.get();
    expect(snapshot.count).toBe(1);
    expect(snapshot.label).toBe('x');
  });
});
