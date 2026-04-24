// @vitest-environment happy-dom
//
// Unit tests for state/registry — the localStorage-backed reactive list
// of pending colonization entries.
//
// The happy-dom environment gives us a real `localStorage` implementation,
// which we reset between tests. We exercise the module through its public
// surface (`registryStore`, `initRegistryStore`, `disposeRegistryStore`,
// `REGISTRY_KEY`) and observe the effect in localStorage directly — no
// stubs — because the whole point of picking localStorage over
// chrome.storage was the synchronous write guarantee. These tests verify
// that guarantee end-to-end.
//
// Setup resets in beforeEach in this order:
//   1. disposeRegistryStore() — cut any leftover persist subscription.
//   2. registryStore.set([])  — wipe in-memory state.
//   3. localStorage.clear()   — wipe persistent state.
// That exact order matters: step 1 before step 2 so the wipe doesn't
// trigger a stale write-through into the previous test's key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registryStore,
  initRegistryStore,
  disposeRegistryStore,
  REGISTRY_KEY,
} from '../../src/state/registry.js';

/** @typedef {import('../../src/domain/registry.js').RegistryEntry} RegistryEntry */

beforeEach(() => {
  // Order matters — see file header.
  disposeRegistryStore();
  registryStore.set([]);
  localStorage.clear();
});

afterEach(() => {
  // Defensive — make sure a failed test cannot leak a live persist
  // subscription into the next describe block.
  disposeRegistryStore();
});

describe('REGISTRY_KEY', () => {
  it('is the canonical localStorage key', () => {
    // Pinned so a rename is a breaking-change diff (would orphan every
    // user's saved registry; the migration story is explicit).
    expect(REGISTRY_KEY).toBe('oge_colonizationRegistry');
  });
});

describe('registryStore — initial state', () => {
  it('returns an empty array before initRegistryStore runs', () => {
    expect(registryStore.get()).toEqual([]);
  });
});

describe('initRegistryStore — hydration', () => {
  it('loads a valid array payload from localStorage', () => {
    /** @type {RegistryEntry[]} */
    const stored = [
      { coords: '1:2:3', sentAt: 100, arrivalAt: 1000 },
    ];
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(stored));

    initRegistryStore();

    expect(registryStore.get()).toEqual(stored);
  });

  it('keeps the store at [] when the payload is corrupted JSON', () => {
    // safeLS.json swallows the parse error and returns its default
    // (null). Our `load` guard also returns null, so persist skips
    // hydration entirely.
    localStorage.setItem(REGISTRY_KEY, 'not-json');

    initRegistryStore();

    expect(registryStore.get()).toEqual([]);
  });

  it('keeps the store at [] when the payload is a non-array object', () => {
    // Defensive — an older schema or manual tampering might leave a
    // plain object under the key. We must NOT hydrate with it.
    localStorage.setItem(REGISTRY_KEY, JSON.stringify({ a: 1 }));

    initRegistryStore();

    expect(registryStore.get()).toEqual([]);
  });

  it('keeps the store at [] when the key is absent', () => {
    initRegistryStore();
    expect(registryStore.get()).toEqual([]);
  });
});

describe('initRegistryStore — write-through (synchronous)', () => {
  it('writes every set through to localStorage in the same tick', () => {
    initRegistryStore();

    /** @type {RegistryEntry[]} */
    const entries = [{ coords: '1:2:3', sentAt: 10, arrivalAt: 100 }];
    registryStore.set(entries);

    // No fake timers, no awaits — must be visible immediately.
    const raw = localStorage.getItem(REGISTRY_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(/** @type {string} */ (raw))).toEqual(entries);
  });

  it('writes on store.update as well as store.set', () => {
    initRegistryStore();

    registryStore.update(
      (reg) => [
        ...reg,
        /** @type {RegistryEntry} */ ({ coords: '4:5:6', sentAt: 20, arrivalAt: 200 }),
      ],
    );

    const raw = localStorage.getItem(REGISTRY_KEY);
    expect(JSON.parse(/** @type {string} */ (raw))).toEqual([
      { coords: '4:5:6', sentAt: 20, arrivalAt: 200 },
    ]);
  });

  it('collapses multiple sync writes to the last value (no debounce)', () => {
    initRegistryStore();

    /** @type {RegistryEntry[]} */
    const a = [{ coords: '1:1:1', sentAt: 1, arrivalAt: 11 }];
    /** @type {RegistryEntry[]} */
    const b = [{ coords: '2:2:2', sentAt: 2, arrivalAt: 22 }];
    /** @type {RegistryEntry[]} */
    const c = [{ coords: '3:3:3', sentAt: 3, arrivalAt: 33 }];

    registryStore.set(a);
    registryStore.set(b);
    registryStore.set(c);

    // Every write is synchronous; the final state in storage is C,
    // irrespective of intermediate writes (each overwrites the last).
    const raw = localStorage.getItem(REGISTRY_KEY);
    expect(JSON.parse(/** @type {string} */ (raw))).toEqual(c);
  });
});

describe('disposeRegistryStore', () => {
  it('prevents further writes to localStorage', () => {
    initRegistryStore();

    /** @type {RegistryEntry[]} */
    const before = [{ coords: '1:2:3', sentAt: 10, arrivalAt: 100 }];
    registryStore.set(before);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(REGISTRY_KEY)))).toEqual(before);

    disposeRegistryStore();

    /** @type {RegistryEntry[]} */
    const after = [{ coords: '9:9:9', sentAt: 99, arrivalAt: 999 }];
    registryStore.set(after);

    // Subscription was cut — localStorage still holds the pre-dispose value.
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(REGISTRY_KEY)))).toEqual(before);
  });

  it('is safe to call when never initialized (no-op)', () => {
    expect(() => disposeRegistryStore()).not.toThrow();
  });

  it('is safe to call twice in a row (idempotent)', () => {
    initRegistryStore();
    disposeRegistryStore();
    expect(() => disposeRegistryStore()).not.toThrow();
  });
});

describe('initRegistryStore — idempotent', () => {
  it('a second init does not install a duplicate write-through', () => {
    // If a duplicate subscription were installed, `save` would fire
    // twice per set — but we can't count saves through localStorage
    // directly. Instead we verify that disposing ONCE is enough to stop
    // all further writes: if init had installed two subscriptions, the
    // single dispose fn we return would only cut one of them.
    initRegistryStore();
    initRegistryStore();

    /** @type {RegistryEntry[]} */
    const a = [{ coords: '1:2:3', sentAt: 10, arrivalAt: 100 }];
    registryStore.set(a);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(REGISTRY_KEY)))).toEqual(a);

    disposeRegistryStore();

    /** @type {RegistryEntry[]} */
    const b = [{ coords: '9:9:9', sentAt: 99, arrivalAt: 999 }];
    registryStore.set(b);

    // If there were two subscriptions and dispose only cut one, we'd
    // see `b` in localStorage now. A single subscription means `a`
    // remains — which is exactly the dispose-prevents-writes invariant.
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(REGISTRY_KEY)))).toEqual(a);
  });

  it('returns the same dispose fn across repeated calls', () => {
    const d1 = initRegistryStore();
    const d2 = initRegistryStore();
    expect(d2).toBe(d1);
  });
});

describe('full round-trip', () => {
  it('init → write → dispose → storage still holds the entry as JSON', () => {
    initRegistryStore();

    /** @type {RegistryEntry} */
    const entry = { coords: '7:8:9', sentAt: 500, arrivalAt: 5000 };
    registryStore.update((reg) => [...reg, entry]);

    disposeRegistryStore();

    const raw = localStorage.getItem(REGISTRY_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(/** @type {string} */ (raw));
    expect(parsed).toEqual([entry]);
  });
});
