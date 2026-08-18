// @vitest-environment happy-dom
//
// Behavioural tests for the Spyglass FAB's mount gating (see
// `src/features/sendSpy/index.js` — lifecycle section). Visibility takes TWO
// verdicts:
//
//   1. is any work SOURCE configured — a watched player, a Neighbours cadence,
//      or a Patrol radius (`hasWorkSources`); and
//   2. is there any work to DO right now (`renderSpy` returning non-null).
//
// The second one needs the apiContext handoff, which these tests never
// populate — so they exercise (1) and the optimistic-mount cache, and a button
// that survives here is one holding the dim "loading…" state.
//
// The gate used to read `players.length > 0` alone, which switched the button
// off for a Neighbours-or-Patrol-only user and took two fully configured
// features down with it. `NO_SOURCES` below is therefore explicit about all
// three: an "empty" watch list still carries `homeHours: 24` by default, so
// clearing only the players array no longer means "nothing to do".
//
// These tests pin the optimistic-mount contract that kills the per-navigation
// blink:
//
//   • cache flag set   → the button mounts IMMEDIATELY at install, before the
//     hydrate settles (dim "loading…" paint);
//   • hydrate → no sources at all → the optimistic button is removed, cache cleared;
//   • hydrate → players → the mount is confirmed, the cache (re)written;
//   • hydrate → Neighbours only (no players) → still mounted;
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
 * A config with EVERY work source switched off — the only state in which the
 * button is supposed to be absent. Note `homeHours: 0`: the default is 24, so
 * `{ players: [] }` alone is a Neighbours-only user, not an idle one.
 */
const NO_SOURCES = { players: [], homeHours: 0, patrolSystems: 0 };

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

  it('does NOT mount without the cache flag, and the hydrate alone is not enough', async () => {
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(false);
    // Landing players no longer mounts on its own: presence is the DERIVED
    // verdict now, and these tests never populate the apiContext handoff, so no
    // verdict is reachable. On a real page the handoff lands and the button
    // appears then — one load later than the cached path, which is the whole
    // reason the cache exists.
    settleHydrate(['7']);
    await flushMicrotasks();
    expect(mounted()).toBe(false);
  });

  it('removes the optimistic button and clears the cache when the hydrate finds no sources', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    expect(mounted()).toBe(true);
    settleHydrate(NO_SOURCES); // every source explicitly off — the truth
    await flushMicrotasks();
    expect(mounted()).toBe(false);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBeNull();
  });

  it('stays mounted for a Neighbours-only user (no watched players at all)', async () => {
    // The regression this gate was rewritten for: a 24 h Neighbours cadence is
    // real, configured work, and it does not involve the watch-list.
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    settleHydrate({ players: [], homeHours: 24, patrolSystems: 0 });
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBe('1');
  });

  it('stays mounted for a Patrol-only user (no watched players at all)', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    settleHydrate({ players: [], homeHours: 0, patrolSystems: 5 });
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBe('1');
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

  it('switching off the LAST source removes the button and clears the cache', async () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '1');
    initWatchListStore();
    installSendSpy();
    settleHydrate(['7']);
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    // Un-starring the last player is no longer enough on its own — the array
    // form of the stored config carries the default 24 h Neighbours cadence.
    watchListStore.set({ ...INITIAL, players: [] });
    await flushMicrotasks();
    expect(mounted()).toBe(true);
    watchListStore.set({ ...INITIAL, ...NO_SOURCES });
    await flushMicrotasks();
    expect(mounted()).toBe(false);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBeNull();
  });
});
