// Set of CPs the user has "confirmed" as permanent planets. New
// (unconfirmed) planets are any in the current `#planetList` not in this
// set — they are the universe the `newPlanetDetector` feature operates
// on to decide whether to paint the "new planet" banner.
//
// # What counts as "confirmed"
//
// A planet is confirmed once the user has built at least one field on it
// (`usedFields > 0`), OR once it has been seeded as part of the first-run
// bootstrap. The first-run bootstrap exists so that a fresh extension
// install does NOT pop a banner for every single planet the user already
// owns — that would be a nag, not a feature. On the very first content
// script mount with an empty set, we seed ALL current planets at once,
// then start the actual new/old diffing only on subsequent reloads.
//
// # What counts as "new"
//
// `new = current #planetList CPs - stored set`. The user will see a
// banner for the first entry in that diff. Freshly-colonized planets
// sit in the `new` bucket until the user either builds on them (moving
// them into the set via the confirmation rule above) or abandons them
// (removed by the `pruneAbandoned` cleanup path in the feature module).
//
// # Persistence shape
//
// We keep the in-memory store as a Set<number> because every consumer
// needs O(1) membership checks. But `chrome.storage.local` round-trips
// through structured clone / JSON, which doesn't preserve Set identity
// faithfully across browsers — Firefox's `storage.local` serializes Set
// as `{}` (an empty object) rather than preserving its entries. So we
// persist as a plain `number[]` and convert to/from the Set at the
// hydrate and save boundaries.
//
// # Why debounce 0 ms
//
// The detector runs once per content-script mount and may write to the
// store exactly once per mount (seed, prune, or mark-built). There is
// no burst scenario to collapse, so write-through is immediate — same
// trade-off as `history.js`, with the same "deterministic tests without
// fake timers" benefit.
//
// @see ./history.js ./scans.js — same init/dispose pattern; this module
//   just adds the Set↔array codec at the hydrate/save boundary.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';

/**
 * chrome.storage.local key under which the `knownPlanets` CP list is
 * persisted. Namespaced with the `oge5_` prefix shared by every v5
 * storage key so v4 data (if any) never collides.
 */
export const KNOWN_PLANETS_KEY = 'oge5_knownPlanets';

/**
 * The known-planets store.
 *
 * Initial value is an empty Set: on module load we have no data yet, and
 * hydration is async (chromeStore returns a Promise). Once
 * {@link initKnownPlanetsStore} is called the `persist` helper will
 * resolve the load promise and `store.set` the hydrated value on a
 * microtask — until that tick, consumers see an empty Set.
 *
 * @type {import('../lib/createStore.js').Store<Set<number>>}
 */
export const knownPlanetsStore = createStore(/** @type {Set<number>} */ (new Set()));

/**
 * The `persist` unsubscribe handle, or `null` before
 * {@link initKnownPlanetsStore} has been called (or after it has been
 * torn down via {@link disposeKnownPlanetsStore}). Kept at module scope
 * so repeat calls to `initKnownPlanetsStore` can be detected cheaply and
 * collapsed to a no-op (returning the same dispose fn).
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the known-planets store to chrome.storage.local: hydrate from
 * `KNOWN_PLANETS_KEY` (array-shaped on disk, Set in memory), and write
 * every change back immediately (no debounce).
 *
 * Safe to call multiple times — subsequent calls return the same
 * dispose handle without double-registering the write-through
 * subscription.
 *
 * Hydration is defensive: a stored value that is not an array (corrupt
 * payload, earlier schema, manual tampering) is treated as "nothing
 * stored" so the store keeps its initial empty Set. The next legitimate
 * write overwrites the bad payload.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener.
 */
export const initKnownPlanetsStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: knownPlanetsStore,
    load: async () => {
      const parsed = await chromeStore.get(KNOWN_PLANETS_KEY);
      if (!Array.isArray(parsed)) return null;
      // Filter out non-finite values — a corrupt entry would otherwise
      // poison every future membership check with a silent miss.
      const cps = /** @type {unknown[]} */ (parsed)
        .filter((v) => typeof v === 'number' && Number.isFinite(v))
        .map((v) => /** @type {number} */ (v));
      return new Set(cps);
    },
    // Persist as an array for JSON/structured-clone compatibility — Set
    // doesn't round-trip through `chrome.storage.local` consistently
    // across browsers (Firefox serializes it as `{}`).
    save: (value) => chromeStore.set(KNOWN_PLANETS_KEY, Array.from(value)),
    // 0 ms = SYNC write on every set. Writes happen at most once per
    // content-script mount so there is no burst to collapse; keeping it
    // immediate makes tests deterministic without fake timers.
    debounceMs: 0,
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring installed by {@link initKnownPlanetsStore}.
 * Idempotent — does nothing when persistence is not currently wired.
 * Primarily useful between tests so state and subscriptions don't
 * leak across cases; production code generally leaves the store
 * wired for the lifetime of the page.
 *
 * @returns {void}
 */
export const disposeKnownPlanetsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};

/**
 * Test-only reset: tear down persistence AND empty the in-memory Set so
 * each test case starts from scratch. Exported with a `_` prefix to
 * signal "do not import from production code".
 *
 * @returns {void}
 */
export const _resetKnownPlanetsStoreForTest = () => {
  disposeKnownPlanetsStore();
  knownPlanetsStore.set(new Set());
};
