// Fleet-save route config — reactive store for the `features/fsCollect`
// micro-fleet workflow. Persisted to `chrome.storage.local` under a
// per-universe key (`<universeId>:oge_fsRoutes`, see {@link fsRoutesKeyFor}).
//
// # What it holds
//
//   - `routes` — keyed by SOURCE-MOON coords `"galaxy:system:position"`.
//     Each route is the target list + micro-fleet definition for sending
//     micro-fleets OUT from that moon. Keyed by coords (not by type)
//     because a source is always a moon; the position uniquely identifies
//     it within the account.
//   - `collectTarget` — the single ad-hoc destination the COLLECT action
//     sends everything back to. Set by clicking "set target" while on the
//     staging moon; `null` until chosen. Carries `type` because the
//     target may be a moon (type 3) or planet (type 1).
//
// # Why per-universe namespacing
//
// Same rationale as `state/scans.js`: `chrome.storage.local` is shared
// across every origin the extension runs on, so each OGame server keeps
// its own routes under a `<universeId>:` prefix.
//
// Persistence is wired lazily via {@link initFsRoutesStore} (NOT on
// import) so tests can mock `chromeStore` before any I/O fires and the
// content-script bootstrap is the one place that wires it, exactly once.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';

/**
 * The coordinate / route shapes live in `domain/fsRoutes.js` (pure,
 * shared with the dashboard editor). Re-exported as type aliases here so
 * the store's JSDoc reads naturally without each consumer reaching into
 * domain. Runtime values flow only one way (state → domain).
 *
 * @typedef {import('../domain/fsRoutes.js').TargetCoord} TargetCoord
 * @typedef {import('../domain/fsRoutes.js').MicroFleet} MicroFleet
 * @typedef {import('../domain/fsRoutes.js').Route} Route
 */

/**
 * Full route config persisted under `<universeId>:oge_fsRoutes`.
 *
 * @typedef {object} FsRoutes
 * @property {Record<string, Route>} routes  Keyed by source-moon
 *   `"galaxy:system:position"`.
 * @property {TargetCoord | null} collectTarget  Ad-hoc collect destination.
 */

/**
 * Suffix portion of the chrome.storage.local key. The full key written
 * is `<universeId>:<FS_ROUTES_KEY_BASE>` — see {@link fsRoutesKeyFor}.
 * Exported so the dashboard (extension origin) can compose a key for an
 * arbitrary selected universe.
 */
export const FS_ROUTES_KEY_BASE = 'oge_fsRoutes';

/**
 * localStorage handoff key between the isolated-world fsCollect
 * orchestrator (writer) and the MAIN-world `bridges/deployRedirect.js`
 * (reader). The orchestrator writes an absolute URL string here
 * synchronously before clicking dispatch; the bridge consumes it to
 * rewrite the post-send `redirectUrl`. A bare string constant (no
 * universe namespacing — it is a transient one-shot, not persisted
 * config), kept here so both worlds share one source of truth without
 * the bridge importing isolated-world code. Mirrors how `sendFleetHook`
 * imports `REGISTRY_KEY` from `state/registry.js`.
 */
export const FS_REDIRECT_KEY = 'oge_fsRedirect';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from {@link parseUniverseId}.
 * @returns {string} The namespaced key, e.g. `'s163-pl:oge_fsRoutes'`.
 */
export const fsRoutesKeyFor = (universeId) => `${universeId}:${FS_ROUTES_KEY_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe.
 * Falls back to the bare key in non-DOM test environments (mirrors
 * `state/scans.js:currentScansKey`).
 *
 * @returns {string}
 */
const currentFsRoutesKey = () => {
  if (typeof location === 'undefined') return FS_ROUTES_KEY_BASE;
  const id = parseUniverseId(location.host);
  return id ? fsRoutesKeyFor(id) : FS_ROUTES_KEY_BASE;
};

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

/**
 * The empty initial config. A fresh function each call so callers can't
 * accidentally share/mutate one frozen literal.
 *
 * @returns {FsRoutes}
 */
const emptyConfig = () => ({ routes: {}, collectTarget: null });

/**
 * The fleet-save route store. Initial value is empty; hydration is async
 * (chromeStore returns a Promise) and lands once {@link initFsRoutesStore}
 * resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<FsRoutes>}
 */
export const fsRoutesStore = createStore(/** @type {FsRoutes} */ (emptyConfig()));

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 * Module scope so repeat `initFsRoutesStore` calls collapse to a no-op.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_fsRoutes` and write every change back (debounced).
 * Idempotent — subsequent calls return the same dispose handle without
 * double-registering.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener.
 */
export const initFsRoutesStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: fsRoutesStore,
    load: async () => {
      const raw = await chromeStore.get(currentFsRoutesKey());
      return /** @type {FsRoutes | null | undefined} */ (raw);
    },
    save: (value) => chromeStore.set(currentFsRoutesKey(), value),
    debounceMs: DEBOUNCE_MS,
  });
  return disposeFn;
};

/**
 * Bypass the debounce and write the current value immediately. Call
 * before navigating away so an in-memory edit (e.g. marking a collect
 * target) is not lost if the page unloads before the debounced save.
 *
 * @returns {Promise<void>}
 */
export const flushFsRoutesStore = () =>
  chromeStore.set(currentFsRoutesKey(), fsRoutesStore.get());

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeFsRoutesStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};

/**
 * Test-only reset — disposes persistence and resets the in-memory value
 * so each case starts clean. `_`-prefixed: do not import from production.
 *
 * @returns {void}
 */
export const _resetFsRoutesStoreForTest = () => {
  disposeFsRoutesStore();
  fsRoutesStore.set(emptyConfig());
};
