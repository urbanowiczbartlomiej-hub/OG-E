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
//   - Each `state/*` module names its own key (`oge_*`) and its own
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
 *   Persist the given value. We never WAIT on an async save, but a returned
 *   promise IS observed: a rejection is logged as "change NOT saved" rather
 *   than silently swallowed (see `writeNow`). Recovery/retry remains the
 *   callback's concern.
 * @param {number} [cfg.debounceMs=0]
 *   If > 0, debounce write-through by this many ms. Default 0 =
 *   immediate write on every change.
 * @param {() => void} [cfg.onHydrate]
 *   Fires exactly once, after the hydrate phase finishes — i.e. after the
 *   sync `load` returns, or after the async `load` promise resolves. Lets
 *   consumers gate side-effectful work that reads the store on a hydrated
 *   value (see `colonyRecorder.js` + `whenHistoryHydrated`). Receives no
 *   arguments — read the store via `store.get()` if you need the value.
 *   Called even when `load` returned `null`/`undefined` (no value
 *   hydrated, but the read settled).
 * @returns {() => void} Unsubscribe the write-through listener. Does NOT
 *   attempt to remove any pending debounced save.
 */
export const persist = ({ store, load, save, debounceMs = 0, onHydrate }) => {
  // Wire the write-through FIRST so that the hydrate `store.set` below
  // also fires through the subscription (the "echo" documented above).
  // The alternative order — hydrate, then subscribe — would silently
  // drop the hydrate value on the floor, leaving storage and store in
  // agreement but never confirming that agreement by round-trip.
  // A rejected `save` used to be dropped on the floor: `chromeStore.set`
  // rejects when the browser refuses the write (quota exhausted, shutdown),
  // and with the promise unobserved the store kept the value in memory while
  // storage never got it — the change simply vanished on the next page load.
  // That is exactly how a full `chrome.storage.local` (several universes'
  // apiCache against the 10 MB default) silently stopped recording new
  // colonies. We cannot recover the write here, but it must never be
  // INVISIBLE: log it loudly and let the caller's own error surfacing (the
  // durability-critical flush paths already try/catch) do the rest.
  const writeNow = () => {
    try {
      const r = save(store.get());
      if (r && typeof (/** @type {any} */ (r)).then === 'function') {
        /** @type {Promise<void>} */ (r).catch((err) => {
          // Raw console, NOT lib/logger: that sink is opt-in (off unless the
          // user sets the debug flag), and losing a write must be visible to
          // the user who never knew a flag existed.
          // eslint-disable-next-line no-console -- silent data loss is worse than a stray log
          console.error('[OG-E] persist: write failed, change NOT saved:', err);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console -- see above
      console.error('[OG-E] persist: write threw, change NOT saved:', err);
    }
  };
  const write = debounceMs > 0 ? debounce(writeNow, debounceMs) : writeNow;
  const unsubscribe = store.subscribe(write);

  // Hydrate — pick the sync or async branch by probing `load`'s return.
  // Thenable duck-type is enough; no need for `instanceof Promise`.
  const loaded = load();
  if (loaded !== null && loaded !== undefined && typeof (/** @type {any} */ (loaded)).then === 'function') {
    /** @type {Promise<T | null | undefined>} */ (loaded).then((v) => {
      if (v !== null && v !== undefined) store.set(v);
      onHydrate?.();
    });
  } else {
    if (loaded !== null && loaded !== undefined) store.set(/** @type {T} */ (loaded));
    onHydrate?.();
  }

  return unsubscribe;
};
