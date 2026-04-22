// Galaxy-scan database — reactive store keyed by `"galaxy:system"`.
//
// Every scanned system lands here as a {scannedAt, positions} record, with
// `positions` keyed by slot number 1..15 using the canonical {@link Position}
// shape from `domain/scans.js`. The store is persisted to
// `chrome.storage.local` under `SCANS_KEY` ("oge5_galaxyScans"), which is
// async — hydration resolves on a microtask, so the initial in-memory state
// is an empty map `{}` and real data flows in once the chromeStore
// promise settles (see `persist` — it handles both sync and async loads).
//
// Persistence is wired lazily via {@link initScansStore}, NOT on import.
// Two reasons:
//   1. Tests can mock `chromeStore` and decide when (if ever) to bind
//      persist — otherwise a singleton wire-up on module load would fire
//      real I/O before vi.mock could intercept it.
//   2. The content-script entry is the one place that should wire
//      persistence, exactly once, at bootstrap. Calling `initScansStore`
//      from anywhere else is a no-op thanks to idempotency.
//
// Why debounce 200ms: scrolling through the galaxy produces a rapid burst
// of per-system scans (our XHR hook fires once per navigation step). A
// naive write-through would hit chrome.storage.local once per step,
// which is both wasteful and measurably slow. 200ms is long enough to
// collapse a continuous scroll into one trailing save yet short enough
// that a pause-and-check pattern still persists promptly.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';

/**
 * @typedef {import('../domain/scans.js').Position} Position
 */

/**
 * One system's worth of scan data. `scannedAt` is an epoch-ms timestamp of
 * the moment we classified this system; `positions` is a dense-ish record
 * keyed by slot number 1..15 whose values are the canonical Position
 * projections. Missing keys mean "we haven't observed that slot yet in
 * this scan" and should be treated as absent (NOT as `empty`).
 *
 * Invariants:
 *   - `scannedAt` is always a finite number of milliseconds since epoch.
 *   - `positions` keys are integer strings 1..15 at runtime (TypeScript
 *     widens this to `number` because JSON objects cannot distinguish
 *     integer-string keys from other keys; callers that care enforce
 *     the range at write time).
 *
 * @typedef {object} SystemScan
 * @property {number} scannedAt
 *   ms timestamp of the most recent scan of this system.
 * @property {Record<number, Position>} positions
 *   Per-slot classification. Keys are numeric slots 1..15.
 */

/**
 * Full galaxy-scan map. Keys are `"galaxy:system"` template strings (e.g.
 * `"4:30"`), values are the per-system scan record. This is the shape
 * persisted under `SCANS_KEY` in chrome.storage.local.
 *
 * @typedef {Record<`${number}:${number}`, SystemScan>} GalaxyScans
 */

/**
 * chrome.storage.local key under which the full {@link GalaxyScans} map
 * is persisted. Namespaced with the `oge5_` prefix shared by every v5
 * storage key so v4 data (if any) never collides.
 */
export const SCANS_KEY = 'oge5_galaxyScans';

/**
 * Write-through debounce window. See file header for the "collapse a
 * galaxy-navigation burst" rationale.
 */
const DEBOUNCE_MS = 200;

/**
 * The galaxy-scan store.
 *
 * Initial value is an empty map: on module load we have no data yet, and
 * hydration is async (chromeStore returns a Promise). Once
 * {@link initScansStore} is called the `persist` helper will resolve the
 * load promise and `store.set` the hydrated value on a microtask — until
 * that tick, consumers see `{}`.
 *
 * @type {import('../lib/createStore.js').Store<GalaxyScans>}
 */
export const scansStore = createStore(/** @type {GalaxyScans} */ ({}));

/**
 * The `persist` unsubscribe handle, or `null` before `initScansStore`
 * has been called (or after it has been torn down via
 * {@link disposeScansStore}). Kept at module scope so repeat calls to
 * `initScansStore` can be detected cheaply and collapsed to a no-op.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the scans store to chrome.storage.local: hydrate from
 * `SCANS_KEY`, and write every change back (debounced by
 * {@link DEBOUNCE_MS}). Safe to call multiple times — subsequent calls
 * return the same dispose handle without double-registering the
 * write-through subscription.
 *
 * Intended to be called exactly once from the content-script entry
 * during bootstrap. Tests call it explicitly after stubbing
 * `chromeStore` so they can observe the load/save wire.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener. The pending debounced save (if any) is NOT
 *   cancelled — callers that need a clean teardown should advance
 *   timers past {@link DEBOUNCE_MS} first.
 */
export const initScansStore = () => {
  if (disposeFn) return disposeFn;
  // `chromeStore.get` returns `Promise<unknown>` (the API cannot know the
  // persisted shape). The cast here promises TS that whatever we read
  // back under SCANS_KEY is a GalaxyScans — which is true by construction
  // because we are also the only writer under this key. A corrupted or
  // shape-mismatched value would produce runtime-visible misbehaviour
  // downstream; we accept that trade-off rather than validating every
  // persisted blob on every load.
  disposeFn = persist({
    store: scansStore,
    // `chromeStore.get` returns `Promise<unknown>` (the API cannot know the
    // persisted shape). The cast inside the async wrapper tells tsc that
    // whatever we read under SCANS_KEY is a GalaxyScans — which holds by
    // construction because we are the only writer under this key. A
    // corrupted value would misbehave downstream; we accept the trade-off
    // rather than validating every persisted blob on every load.
    load: async () => {
      const raw = await chromeStore.get(SCANS_KEY);
      return /** @type {GalaxyScans | null | undefined} */ (raw);
    },
    save: (value) => chromeStore.set(SCANS_KEY, value),
    debounceMs: DEBOUNCE_MS,
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring installed by {@link initScansStore}.
 * Idempotent — does nothing when persistence is not currently wired.
 * Primarily useful between tests so state and subscriptions don't
 * leak across cases; production code generally leaves the store
 * wired for the lifetime of the page.
 *
 * @returns {void}
 */
export const disposeScansStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};
