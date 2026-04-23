// Colony-history database — reactive list of every new-colony observation.
//
// Each `ColonyEntry` records a single moment: the first time we loaded the
// overview for a freshly-colonized planet (usedFields===0). That snapshot
// is the *histogram dataset* for the v5 histogram page — one datum per
// planet, showing how `fields` is distributed across all colonies we have
// ever seen.
//
// # Why we keep EVERY observation, including later-abandoned planets
//
// The rule here is counter-intuitive and was painfully re-discovered in
// v4 4.8.3: when a player colonizes a planet with a very small `fields`
// max they usually abandon it within days. If the history only kept
// planets that "stuck around", the small-fields bucket would look empty
// in the histogram — NOT because small planets are rare, but because
// they are short-lived. That would bias every downstream statistic
// (median, expected `fields` per colonize, probability of hitting a
// given size) toward the large end of the distribution.
//
// Concretely: abandoned colonies are the *left tail* of the size
// distribution. Losing them would hide the whole reason the histogram
// exists — to estimate the shape of the real `fields` distribution so
// the colonize-target picker knows when to bail on a run of bad rolls.
//
// We therefore append-only on first observation and never remove on
// abandonment. There is no removal path — the store is strictly
// append-only.
//
// # Why debounce 0 ms
//
// New-colony observations are rare events. In practice a player adds
// a handful of entries per day — one per colonize landing — not a
// burst. The `debounceMs: 0` setting tells `persist` to write through
// synchronously on every change, which keeps tests deterministic
// (no need to advance fake timers) and costs us nothing at runtime
// because there is no burst to collapse.
//
// @see ../../DESIGN.md §5 (Układ modułów) and §7 (Schematy danych,
//   subsection `oge5_colonyHistory`) for the store's place in the
//   v5 layout and the wire-format contract.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';

/**
 * One observation of a newly-colonized planet, captured the first time
 * its overview page loaded with `usedFields === 0`.
 *
 * Invariants:
 *   - `cp` is the game-assigned planet id. In OGame these are globally
 *     monotonically increasing, so we treat `cp` as the uniqueness key
 *     across the whole history — two entries with the same `cp` are
 *     treated as duplicates by any consumer that de-dupes on write.
 *   - `fields` is the planet's MAX fields (not used fields), which is
 *     fixed per planet for its lifetime.
 *   - `coords` is rendered in the `"[g:s:p]"` format the game itself
 *     uses in the DOM — brackets included, colon-separated, one-based.
 *   - `position` is an integer in 1..15.
 *   - `timestamp` is milliseconds since the Unix epoch, recorded at
 *     first observation and NEVER updated (even on later re-visits).
 *
 * @typedef {object} ColonyEntry
 * @property {number} cp
 *   Planet cp-id. Globally unique across the account; used as the
 *   uniqueness key when merging local and remote histories.
 * @property {number} fields
 *   Max fields of the planet (constant per planet).
 * @property {string} coords
 *   Coord string `"[galaxy:system:position]"` — brackets included,
 *   matching the game's DOM format.
 * @property {number} position
 *   Slot number 1..15.
 * @property {number} timestamp
 *   ms since epoch of the FIRST observation. Never rewritten.
 */

/**
 * The whole history — an append-mostly array of {@link ColonyEntry}.
 * Order is insertion order (observation order), but consumers must not
 * depend on it for correctness: the histogram is order-invariant, and
 * the Gist merge in v5 sorts on merge.
 *
 * @typedef {ColonyEntry[]} ColonyHistory
 */

/**
 * chrome.storage.local key under which the full {@link ColonyHistory}
 * array is persisted. Namespaced with the `oge5_` prefix shared by
 * every v5 storage key so v4 data (if any) never collides.
 */
export const HISTORY_KEY = 'oge5_colonyHistory';

/**
 * The colony-history store.
 *
 * Initial value is an empty array: on module load we have no data yet,
 * and hydration is async (chromeStore returns a Promise). Once
 * {@link initHistoryStore} is called the `persist` helper will resolve
 * the load promise and `store.set` the hydrated value on a microtask —
 * until that tick, consumers see `[]`.
 *
 * @type {import('../lib/createStore.js').Store<ColonyHistory>}
 */
export const historyStore = createStore(/** @type {ColonyHistory} */ ([]));

/**
 * The `persist` unsubscribe handle, or `null` before
 * {@link initHistoryStore} has been called (or after it has been torn
 * down via {@link disposeHistoryStore}). Kept at module scope so repeat
 * calls to `initHistoryStore` can be detected cheaply and collapsed to
 * a no-op (returning the same dispose fn).
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the history store to chrome.storage.local: hydrate from
 * `HISTORY_KEY`, and write every change back immediately (no debounce).
 * Safe to call multiple times — subsequent calls return the same
 * dispose handle without double-registering the write-through
 * subscription.
 *
 * Intended to be called exactly once from the content-script entry
 * during bootstrap. Tests call it explicitly after stubbing
 * `chromeStore` so they can observe the load/save wire.
 *
 * Hydration is defensive: a stored value that is not an array (corrupt
 * payload, earlier schema, manual tampering) is treated as "nothing
 * stored" so the store keeps its initial `[]`. The next legitimate
 * write overwrites the bad payload.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener.
 */
export const initHistoryStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: historyStore,
    load: async () => {
      // chromeStore.get resolves to `unknown` — any shape could live
      // at the key. Narrow to array; anything else is treated as
      // "nothing stored" so persist skips hydration and keeps [].
      const parsed = await chromeStore.get(HISTORY_KEY);
      return Array.isArray(parsed) ? /** @type {ColonyHistory} */ (parsed) : null;
    },
    save: (value) => chromeStore.set(HISTORY_KEY, value),
    // 0 ms = SYNC write on every set. History writes are rare (typically
    // a handful per day) so there is no burst to collapse; keeping it
    // immediate makes tests deterministic without fake timers.
    debounceMs: 0,
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring installed by {@link initHistoryStore}.
 * Idempotent — does nothing when persistence is not currently wired.
 * Primarily useful between tests so state and subscriptions don't
 * leak across cases; production code generally leaves the store
 * wired for the lifetime of the page.
 *
 * @returns {void}
 */
export const disposeHistoryStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};
