// @vitest-environment happy-dom
//
// Behavioural tests for the Spyglass FAB's mount gating (see
// `src/features/sendSpy/index.js` — lifecycle section). The visibility is
// watch-list-driven, and the watch-list hydrates ASYNC from chrome.storage —
// these tests pin the optimistic-mount contract that kills the per-navigation
// blink:
//
//   • cache flag set  → the button mounts IMMEDIATELY at install, before the
//     hydrate settles (dim "loading…" paint);
//   • hydrate → empty  → the optimistic button is removed, the cache cleared;
//   • hydrate → players → the mount is confirmed, the cache (re)written;
//   • no cache flag    → no optimistic mount (the pre-cache behaviour).
//
// Hydration timing is controlled through a fake `globalThis.chrome` whose
// storage `get` parks its callback until the test releases it — the same
// async window a real page load has. safeLS (the cache) stays REAL over
// happy-dom's localStorage, so the tests observe the actual wire.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installSendSpy, _resetSendSpyForTest } from '../../../src/features/sendSpy/index.js';
import {
  watchListStore,
  initWatchListStore,
  disposeWatchListStore,
} from '../../../src/state/watchList.js';
import { SPY_FAB_SHOWN_KEY } from '../../../src/state/spyFabCache.js';

const BUTTON_ID = 'oge-send-spy';

/** The store's pristine default, captured before any test mutates it. */
const INITIAL = watchListStore.get();

/**
 * Parked chrome.storage.local.get callbacks — released per-test to settle
 * the watch-list hydrate at a chosen moment.
 * @type {Array<{ key: string, cb: (items: Record<string, unknown>) => void }>}
 */
let pendingGets = [];

/**
 * Release every parked read with `value` (or nothing stored when omitted).
 * @param {unknown} [value]
 */
const settleHydrate = (value) => {
  const gets = pendingGets;
  pendingGets = [];
  for (const { key, cb } of gets) cb(value === undefined ? {} : { [key]: value });
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const mounted = () => !!document.getElementById(BUTTON_ID);

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  pendingGets = [];
  /** @type {any} */ (globalThis).chrome = {
    storage: {
      local: {
        get: (/** @type {string} */ key, /** @type {any} */ cb) => {
          pendingGets.push({ key, cb });
        },
        set: (/** @type {any} */ _items, /** @type {any} */ cb) => { cb?.(); },
        remove: (/** @type {any} */ _key, /** @type {any} */ cb) => { cb?.(); },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {},
  };
});

afterEach(() => {
  _resetSendSpyForTest();
  disposeWatchListStore();
  watchListStore.set(INITIAL);
  delete (/** @type {any} */ (globalThis)).chrome;
});

describe('sendSpy — optimistic mount (spyFabCache)', () => {
  it('mounts immediately at install when the cache says shown, before the hydrate settles', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(true);
    // Pre-hydration the paint is the dim "loading…" hold — never a derived
    // verdict computed off the not-yet-trustworthy empty list.
    expect(document.getElementById(BUTTON_ID)?.textContent).toContain('loading');
  });

  it('does NOT mount optimistically without the cache flag (pre-cache behaviour)', async () => {
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(false);
    // The hydrate then lands players → the button appears AND the verdict is
    // cached for the next load's optimistic mount.
    settleHydrate(['7']);
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBe('1');
  });

  it('removes the optimistic button and clears the cache when the hydrate finds nothing', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(true);
    settleHydrate(); // nothing stored — the empty default IS the truth
    await flushMicrotasks();
    expect(mounted()).toBe(false);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBeNull();
  });

  it('confirms the optimistic mount when the hydrate lands players', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(true);
    settleHydrate(['7']);
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBe('1');
  });

  it('un-starring the last player removes the button and clears the cache', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    settleHydrate(['7']);
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    watchListStore.set({ ...INITIAL, players: [] });
    await flushMicrotasks();
    expect(mounted()).toBe(false);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBeNull();
  });
});
