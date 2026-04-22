// In-flight colonization registry — reactive list of `RegistryEntry` records
// for fleets we just dispatched on mission=colonize. Powers two UX-critical
// jobs:
//
//   - min-gap checking: "is there another colonize fleet landing within
//     minGap of this candidate?" (domain/registry.js :: findConflict)
//   - double-send detection: block the rare case where the XHR hook fires
//     twice for the same send (domain/registry.js :: dedupeEntry)
//
// # Why localStorage (and not chrome.storage.local)?
//
// OG-E 4.8.5 deliberately forced this migration and v5 inherits the
// decision. The `chrome.storage.set` API is asynchronous: on mobile
// Firefox, a quick colonize-then-navigate sequence can start the
// navigation before the browser has flushed the storage write, losing
// the entry and letting a duplicate send slip through. `localStorage`,
// by contrast, is fully synchronous — the entry is visible to any
// subsequent read in the same JS tick, before the navigation begins.
// This is the core "mobile race fix" and the reason this module exists
// separately from the chrome.storage-backed settings.
//
// # Why 0 ms debounce?
//
// Every single `registryStore.set(...)` MUST hit localStorage before the
// next tick can schedule navigation. A 1ms debounce would reintroduce the
// exact race the 4.8.5 migration fixed. Writes are infrequent (one per
// fleet send, plus the occasional prune) so there is no burst to
// collapse anyway. `debounceMs: 0` means `persist` calls `save` inline
// inside the subscribe callback — which is inside the `store.set` stack
// frame — which is in the same tick as the caller.
//
// # Defensive hydration
//
// `safeLS.json` parses whatever string is at the key. A corrupted, non-
// array payload (left over from an earlier schema, or tampered with)
// must not crash the hydrate. The `load` closure narrows to arrays only
// and returns `null` otherwise, which `persist` treats as "nothing
// stored, keep the initial empty list". The next legitimate write
// overwrites the bad payload.

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { safeLS } from '../lib/storage.js';

/**
 * @typedef {import('../domain/registry.js').RegistryEntry} RegistryEntry
 */

/**
 * localStorage key for the colonization registry. Namespaced under the
 * v5 prefix so it does not collide with v4's `oge_colonizationRegistry`
 * (the two schemas intentionally do not share storage — v4 and v5 can
 * coexist on the same profile during migration).
 */
export const REGISTRY_KEY = 'oge5_colonizationRegistry';

/**
 * Reactive store of the currently-pending colonization entries. Always
 * starts as the empty array before {@link initRegistryStore} runs;
 * callers that read before init see `[]` (never `null`/`undefined`).
 *
 * @type {import('../lib/createStore.js').Store<RegistryEntry[]>}
 */
export const registryStore = createStore(/** @type {RegistryEntry[]} */ ([]));

/**
 * Holds the `persist` unsubscribe handle from the most recent
 * {@link initRegistryStore} call, or `null` when not wired. Used to make
 * init idempotent (second call returns the existing dispose fn) and to
 * let tests / teardown cut the write-through subscription cleanly.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the registry store to localStorage via {@link persist}. Idempotent:
 * if already wired, returns the existing unsubscribe fn without installing
 * a second persist subscription (which would double-write on every change).
 *
 * Hydration reads `REGISTRY_KEY` through `safeLS.json`; a missing,
 * corrupt, or non-array payload is treated as "no saved data" and the
 * store keeps its initial `[]`. Valid array payloads seed the store and
 * fire one write-through echo — acceptable because the bytes we write
 * back are identical to the bytes we just read.
 *
 * @returns {() => void} Dispose fn that cuts the write-through subscription.
 */
export const initRegistryStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: registryStore,
    load: () => {
      // safeLS.json returns `unknown` — a previous tab might have
      // written any shape. Narrow to array; anything else is treated as
      // "nothing stored" so persist skips hydration and keeps [].
      const parsed = safeLS.json(REGISTRY_KEY);
      return Array.isArray(parsed) ? /** @type {RegistryEntry[]} */ (parsed) : null;
    },
    save: (value) => safeLS.setJSON(REGISTRY_KEY, value),
    // 0 ms = SYNC write on every set. Mobile race mitigation — see
    // module header. Do NOT raise this without revisiting 4.8.5.
    debounceMs: 0,
  });
  return disposeFn;
};

/**
 * Cut the persist subscription installed by {@link initRegistryStore}.
 * Primarily a test-teardown affordance — production callers wire the
 * store at startup and leave it for the app lifetime. Safe to call when
 * already disposed (no-op).
 */
export const disposeRegistryStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};
