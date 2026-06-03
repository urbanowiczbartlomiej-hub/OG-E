// Body inventory store — the snapshot of the player's planets + moons
// captured from the in-game left planet bar (`#planetList`). Persisted to
// `chrome.storage.local` under a per-universe key (`<universeId>:oge_bodies`,
// see {@link bodiesKeyFor}).
//
// # What it holds
//
//   - `bodies` — every owned planet and moon as a {@link Body}
//     (`cp`, `name`, `galaxy`, `system`, `position`, `type`). A full
//     snapshot, REPLACED wholesale on each capture (the planet bar is
//     always complete on every in-game page, so one capture = the whole
//     truth — there is nothing to merge incrementally).
//   - `capturedAt` — epoch-ms of the last successful capture, so the
//     dashboard can show "inventory last refreshed …" and warn when it
//     looks stale.
//
// # Who reads it
//
//   - The dashboard route editor (extension origin) composes a key via
//     {@link bodiesKeyFor} for the selected universe and renders a
//     clickable planet/moon picker from `bodies`.
//   - `domain/fsRoutes.reconcileRoutes` uses `bodies` to prune routes
//     whose source/target endpoints no longer exist.
//
// # Why the hydrate gate ({@link whenBodiesHydrated})
//
// Same race as `state/history.js`: the capture feature `store.set(...)`s a
// fresh snapshot, and if the async chrome.storage hydrate lands AFTER that
// write it would clobber the fresh capture with the older stored value (and
// the write-through would then save the stale value back). Gating the
// capture on {@link whenBodiesHydrated} makes the fresh write always win.
//
// # Why per-universe namespacing
//
// `chrome.storage.local` is shared across every origin the extension runs
// on, so each OGame server keeps its own inventory under a `<universeId>:`
// prefix — same rationale as `state/history.js` / `state/scans.js`.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';

/**
 * The body shape lives in `domain/bodies.js` (pure, shared with the
 * dashboard picker + reconciliation). Re-exported as a type alias here so
 * the store's JSDoc reads naturally. Runtime values flow one way only
 * (state → domain).
 *
 * @typedef {import('../domain/bodies.js').Body} Body
 */

/**
 * Full inventory snapshot persisted under `<universeId>:oge_bodies`.
 *
 * @typedef {object} BodyInventory
 * @property {Body[]} bodies        Every owned planet + moon.
 * @property {number} capturedAt    Epoch-ms of the last capture (0 = never).
 */

/**
 * Suffix portion of the chrome.storage.local key. The full key written is
 * `<universeId>:<BODIES_KEY_BASE>` — see {@link bodiesKeyFor}. Exported so
 * the dashboard (extension origin) can compose a key for an arbitrary
 * selected universe.
 */
export const BODIES_KEY_BASE = 'oge_bodies';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from {@link parseUniverseId}.
 * @returns {string} The namespaced key, e.g. `'s163-pl:oge_bodies'`.
 */
export const bodiesKeyFor = (universeId) => `${universeId}:${BODIES_KEY_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe.
 * Falls back to the bare key in non-DOM test environments (mirrors
 * `state/history.js:currentHistoryKey`).
 *
 * @returns {string}
 */
const currentBodiesKey = () => {
  if (typeof location === 'undefined') return BODIES_KEY_BASE;
  const id = parseUniverseId(location.host);
  return id ? bodiesKeyFor(id) : BODIES_KEY_BASE;
};

/**
 * The empty initial inventory. A fresh object each call so callers can't
 * accidentally share/mutate one literal.
 *
 * @returns {BodyInventory}
 */
const emptyInventory = () => ({ bodies: [], capturedAt: 0 });

/**
 * The body-inventory store. Initial value is empty; hydration is async
 * (chromeStore returns a Promise) and lands once {@link initBodiesStore}
 * resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<BodyInventory>}
 */
export const bodiesStore = createStore(/** @type {BodyInventory} */ (emptyInventory()));

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initBodiesStore} call. See `state/history.js` for the full
 * lifecycle rationale.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * The promise returned by {@link whenBodiesHydrated}. Pre-resolved until
 * {@link initBodiesStore} swaps it for a pending one, so tests that bypass
 * init don't hang awaiting a hydrate that never arrives.
 *
 * @type {Promise<void>}
 */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the {@link bodiesStore} hydrate phase has settled. The
 * capture feature gates its first write on this so a late hydrate cannot
 * clobber the fresh snapshot — see the file header and `state/history.js`
 * for the full failure mode. Call as a function (not captured at import)
 * because the binding identity changes across init/dispose.
 *
 * @returns {Promise<void>}
 */
export const whenBodiesHydrated = () => hydratedPromise;

/**
 * Narrow an unknown stored value to a {@link BodyInventory}, or `null`
 * when it is missing / the wrong shape (corrupt payload, earlier schema,
 * manual tampering). `null` makes `persist` keep the store's empty initial
 * value; the next legitimate capture overwrites the bad payload.
 *
 * @param {unknown} raw
 * @returns {BodyInventory | null}
 */
const narrowInventory = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const v = /** @type {{ bodies?: unknown, capturedAt?: unknown }} */ (raw);
  if (!Array.isArray(v.bodies)) return null;
  return {
    bodies: /** @type {Body[]} */ (v.bodies),
    capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : 0,
  };
};

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_bodies` and write every change back. Idempotent —
 * subsequent calls return the same dispose handle without double-wiring.
 *
 * Writes are immediate (no debounce): a capture is a single write per
 * page-load, so there is no burst to collapse, and immediacy keeps tests
 * deterministic without fake timers (same choice as `state/history.js`).
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener.
 */
export const initBodiesStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: bodiesStore,
    load: async () => narrowInventory(await chromeStore.get(currentBodiesKey())),
    save: (value) => chromeStore.set(currentBodiesKey(), value),
    debounceMs: 0,
    onHydrate: () => { resolveHydrated(); },
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent. Also resets
 * {@link whenBodiesHydrated} to the pre-resolved sentinel.
 *
 * @returns {void}
 */
export const disposeBodiesStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};

/**
 * Test-only reset — disposes persistence and resets the in-memory value
 * so each case starts clean. `_`-prefixed: do not import from production.
 *
 * @returns {void}
 */
export const _resetBodiesStoreForTest = () => {
  disposeBodiesStore();
  bodiesStore.set(emptyInventory());
};
