// @ts-check

// Colonization decision log — reactive store, keyed by `"g:s:p"`.
//
// The persistent home of the small "looks-free-but-isn't" correction set
// (`domain/colonizeDecisions.js`): sent / mine / abandoned / taken / reserved.
// Written by the colonize features (sendColony on send + checkTarget refusal;
// later colonyRecorder on a fresh colony, abandon on give-up) and read by the
// picker (which subtracts `blockingCoords`) and the dashboard Scout.
//
// Persisted to `chrome.storage.local` under a per-universe key
// (`<universeId>:oge_colonizeDecisions`). This is the ONE colonization store
// destined for gist sync (Stage 4) — small (bytes per colony) and the only
// state the API can't reproduce. Mirrors `state/scans.js`: lazy init, uniform
// dispose, plus a `flush*` for the synchronous save the post-send page reload
// needs (a debounced write would be lost when the game navigates).
//
// Compaction (pruning expired sent/reserved/aged-taken) runs once on hydrate —
// the picker's `blockingCoords` already ignores expired entries at read time,
// so this is storage hygiene, not correctness.

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';
import { compactDecisions } from '../domain/colonizeDecisions.js';

/** @typedef {import('../domain/colonizeDecisions.js').DecisionMap} DecisionMap */

/** Suffix of the per-universe chrome.storage.local key. Exported for the dashboard. */
const COLONIZE_DECISIONS_KEY_BASE = 'oge_colonizeDecisions';

/**
 * Compose the full key for a universe id.
 * @param {string} universeId e.g. `'s163-pl'`.
 * @returns {string}
 */
export const colonizeDecisionsKeyFor = (universeId) =>
  `${universeId}:${COLONIZE_DECISIONS_KEY_BASE}`;

/** Resolve the key for the current tab's universe (falls back in node tests). */
const currentKey = () => currentUniverseKey(COLONIZE_DECISIONS_KEY_BASE, colonizeDecisionsKeyFor);

/** Write-through debounce window (bursty checkTarget refusals collapse to one save). */
const DEBOUNCE_MS = 200;

/**
 * The decision-log store. Empty map initially; hydration is async via
 * {@link initColonizeDecisionsStore}.
 *
 * @type {import('../lib/createStore.js').Store<DecisionMap>}
 */
export const colonizeDecisionsStore = createStore(/** @type {DecisionMap} */ ({}));

/** @type {(() => void) | null} */
let disposeFn = null;
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();
/**
 * Synchronous mirror of {@link whenColonizeDecisionsHydrated}'s resolved state.
 * `true` in the pre-init sentinel state (no async load pending — e.g. unit tests
 * that set the store directly) and after hydrate settles; `false` only while a
 * real init's chrome.storage load is in flight. Lets a consumer decide its
 * initial gate synchronously (no forced first-microtask flip) — see
 * `features/sendColony`'s `storesReady`.
 */
let hydrated = true;

/**
 * Resolves once the store's hydrate phase has settled. Gating a fresh-colony
 * `mine` decision write on this prevents an early write being wiped by a late
 * load (the colonyRecorder race — see state/targets.js for the sibling fix and
 * state/history.js for the full story).
 * @returns {Promise<void>}
 */
export const whenColonizeDecisionsHydrated = () => hydratedPromise;

/**
 * Synchronous "has hydration settled?" — see {@link hydrated}. True before any
 * init (nothing pending) and once the load resolves.
 * @returns {boolean}
 */
export const isColonizeDecisionsHydrated = () => hydrated;

/**
 * Wire the store to chrome.storage.local (hydrate + debounced write-through),
 * compacting once after hydrate. Idempotent. Call once from the content-script
 * bootstrap.
 *
 * @returns {() => void}
 */
export const initColonizeDecisionsStore = () => {
  if (disposeFn) return disposeFn;
  hydrated = false;
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: colonizeDecisionsStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      return /** @type {DecisionMap | null | undefined} */ (raw);
    },
    save: (value) => chromeStore.set(currentKey(), value),
    debounceMs: DEBOUNCE_MS,
    onHydrate: () => {
      const { map, changed } = compactDecisions(colonizeDecisionsStore.get(), Date.now());
      if (changed) colonizeDecisionsStore.set(map);
      hydrated = true;
      resolveHydrated();
    },
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent. Resets
 * {@link whenColonizeDecisionsHydrated} to the pre-resolved sentinel, matching
 * the "no init has run" state.
 * @returns {void}
 */
export const disposeColonizeDecisionsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
  hydrated = true;
};

/**
 * Synchronously persist the current value, bypassing the debounce — used right
 * after writing a `sent` decision so it survives the game's immediate post-send
 * page reload (mirrors `flushScansStore`).
 * @returns {Promise<void>}
 */
export const flushColonizeDecisionsStore = () =>
  chromeStore.set(currentKey(), colonizeDecisionsStore.get());
