// Wire a reactive store to a persistent backing storage:
//   1. HYDRATE on init — read once, seed the store if a value exists.
//   2. WRITE THROUGH on every change — subscribe to the store, push to
//      storage (optionally debounced for bursty writers).
//
// The helper is intentionally storage-agnostic: callers supply `load` and
// `save` callbacks. `load` may be synchronous (e.g. localStorage-backed
// safeLS) or asynchronous (e.g. Promise-returning chromeStore). We detect
// which by inspecting whether `load()` returns a thenable and handle both
// transparently. The rest of the helper — the write-through subscription
// and optional debounce — is shape-independent.
//
// Separating the storage callbacks from the generic persist logic gives
// us three things:
//
//   - Each `state/*` module names its own key (`oge5_*`) and its own
//     codec (safeLS.json/setJSON, chromeStore.get/set, custom per-key
//     spread) right at the call site. One glance at the module tells
//     you exactly what lands where.
//
//   - Tests feed in-memory stubs for load/save and verify persistence
//     semantics without touching real storage APIs.
//
//   - The helper never has to know about JSON encoding, storage quotas,
//     cross-origin mirrors, or AGR-compatibility concerns. Those live in
//     the `load`/`save` closures supplied by callers.
//
// Returns an unsubscribe function for the write-through subscription.
// Callers rarely need it (stores live for the app lifetime), but tests
// use it to isolate persistence from cross-test state leaks, and any
// future teardown path has a clean cut-point.

import { debounce } from './debounce.js';

/**
 * Wire `store` to a backing storage layer. Hydrates synchronously or
 * asynchronously depending on what `load()` returns, then persists every
 * subsequent change via `save(value)`.
 *
 * Hydration semantics:
 *   - `load()` returns `undefined` or `null` → no hydration; store
 *     keeps its `createStore(initial)` value.
 *   - `load()` returns any other value → `store.set(value)` is called
 *     with it. This fires subscribers, including our own write-through —
 *     which is almost always fine: on the first tick storage already
 *     holds the hydrated value, so the round-trip is a no-op semantically
 *     (we rewrite the same bytes we just read). Callers who want to skip
 *     that round-trip should wire `persist` AFTER any other subscribers
 *     that would be upset by a re-notification.
 *
 * Write-through semantics:
 *   - Without `debounceMs`, every `store.set` / `store.update` triggers
 *     an immediate `save(current)`.
 *   - With `debounceMs > 0`, bursty writes collapse into a single
 *     trailing `save` after `debounceMs` of quiet. `save` always runs
 *     with the LATEST value (debounce captures fresh state via closure).
 *
 * @template T
 * @param {object} cfg
 * @param {import('./createStore.js').Store<T>} cfg.store
 *   The store to persist.
 * @param {() => T | null | undefined | Promise<T | null | undefined>} cfg.load
 *   Read the stored value. May be sync or async. Return `undefined`/`null`
 *   to mean "nothing stored yet, keep the store's initial value".
 * @param {(value: T) => void | Promise<void>} cfg.save
 *   Persist the given value. Return type is ignored — we don't wait on
 *   async saves. Storage errors are the callback's responsibility.
 * @param {number} [cfg.debounceMs=0]
 *   If > 0, debounce write-through by this many ms. Default 0 =
 *   immediate write on every change.
 * @returns {() => void} Unsubscribe the write-through listener. Does NOT
 *   attempt to remove any pending debounced save.
 */
export const persist = ({ store, load, save, debounceMs = 0 }) => {
  // Wire the write-through FIRST so that the hydrate `store.set` below
  // also fires through the subscription (the "echo" documented above).
  // The alternative order — hydrate, then subscribe — would silently
  // drop the hydrate value on the floor, leaving storage and store in
  // agreement but never confirming that agreement by round-trip.
  const writeNow = () => { save(store.get()); };
  const write = debounceMs > 0 ? debounce(writeNow, debounceMs) : writeNow;
  const unsubscribe = store.subscribe(write);

  // Hydrate — pick the sync or async branch by probing `load`'s return.
  // Thenable duck-type is enough; no need for `instanceof Promise`.
  const loaded = load();
  if (loaded !== null && loaded !== undefined && typeof (/** @type {any} */ (loaded)).then === 'function') {
    /** @type {Promise<T | null | undefined>} */ (loaded).then((v) => {
      if (v !== null && v !== undefined) store.set(v);
    });
  } else if (loaded !== null && loaded !== undefined) {
    store.set(/** @type {T} */ (loaded));
  }

  return unsubscribe;
};
