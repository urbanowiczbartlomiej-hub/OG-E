// Fleet-save route config — reactive store for the `features/fsCollect`
// micro-fleet workflow. Persisted to `chrome.storage.local` under a
// per-universe key (`<universeId>:oge_fsRoutes`, see {@link fsRoutesKeyFor}).
//
// # What it holds
//
//   - `routes` — an ARRAY of {@link Route}. Each route has one or more
//     SOURCE bodies (planets and/or moons), one ordered target list, and
//     one micro-fleet; standing on any source fires it. Legacy configs
//     keyed routes by a single source-moon coord — {@link migrateFsRoutes}
//     lifts that `Record<coordKey, …>` form into the source-array shape on
//     hydrate (and the migrated value is written straight back).
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
import { migrateFsRoutes } from '../domain/fsRoutes.js';

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
 * @property {Route[]} routes  All micro-fleet routes (each with its own
 *   source/target lists). See {@link migrateFsRoutes} for the legacy shape.
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
 * Suffix of the per-universe "routes last changed" timestamp key
 * (`<universeId>:oge_fsRoutesTs`). The cross-device sync engine uses this
 * epoch-ms value for whole-universe newest-wins merging (see
 * `sync/merge.mergeFsRoutes`).
 *
 * Why a SEPARATE chrome.storage key rather than a field inside the routes
 * value, and why chrome.storage rather than localStorage:
 *   - It's sync METADATA, not route config — kept out of the {@link FsRoutes}
 *     domain value, exactly as the settings ts map is kept out of the
 *     settings values (`settingsSync.SETTINGS_TS_KEY`).
 *   - Routes are edited from TWO origins: in-game (game origin) AND the
 *     dashboard (extension origin). localStorage is per-origin, so it
 *     couldn't be shared; `chrome.storage.local` is the one store both
 *     origins see. Every writer (dashboard save, in-game prune / set-target)
 *     stamps it via {@link stampFsRoutesChanged} / the dashboard's own write.
 */
export const FS_ROUTES_TS_BASE = 'oge_fsRoutesTs';

/**
 * Compose the per-universe routes-timestamp key.
 *
 * @param {string} universeId
 * @returns {string} e.g. `'s163-pl:oge_fsRoutesTs'`.
 */
export const fsRoutesTsKeyFor = (universeId) => `${universeId}:${FS_ROUTES_TS_BASE}`;

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
const emptyConfig = () => ({ routes: [], collectTarget: null });

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
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initFsRoutesStore} call. See `state/history.js` for the full
 * lifecycle rationale.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * The promise returned by {@link whenFsRoutesHydrated}. Pre-resolved until
 * {@link initFsRoutesStore} swaps it for a pending one, so tests that bypass
 * init don't hang awaiting a hydrate that never arrives.
 *
 * @type {Promise<void>}
 */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the {@link fsRoutesStore} hydrate phase has settled (the
 * stored value — migrated if legacy — has been applied, or the load found
 * nothing). The planet-bar capture gates route RECONCILIATION on this so it
 * never prunes against not-yet-hydrated (empty) routes. Call as a function,
 * not captured at import — the binding changes across init/dispose.
 *
 * @returns {Promise<void>}
 */
export const whenFsRoutesHydrated = () => hydratedPromise;

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
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: fsRoutesStore,
    load: async () => {
      const raw = await chromeStore.get(currentFsRoutesKey());
      // Nothing stored yet → keep the empty initial (no migration write).
      if (raw === null || raw === undefined) return null;
      // Normalise + migrate the legacy moon-keyed shape. The migrated value
      // is what gets `store.set`, so the write-through persists it back in
      // the current shape — a one-time, transparent upgrade.
      return /** @type {FsRoutes} */ (migrateFsRoutes(raw));
    },
    save: (value) => chromeStore.set(currentFsRoutesKey(), value),
    debounceMs: DEBOUNCE_MS,
    onHydrate: () => { resolveHydrated(); },
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
 * Stamp "routes changed just now" for the current universe, so the next
 * sync round-trip treats this device's routes as the freshest for
 * whole-universe newest-wins (see `sync/merge.mergeFsRoutes`). Call AFTER
 * any in-game write that changes routes/collectTarget (route pruning,
 * set-collect-target). The dashboard writes the same key directly on save.
 *
 * @returns {Promise<void>}
 */
export const stampFsRoutesChanged = () => {
  if (typeof location === 'undefined') return chromeStore.set(FS_ROUTES_TS_BASE, Date.now());
  const id = parseUniverseId(location.host);
  return chromeStore.set(id ? fsRoutesTsKeyFor(id) : FS_ROUTES_TS_BASE, Date.now());
};

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
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
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
