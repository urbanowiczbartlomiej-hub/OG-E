// Daily Run route config — reactive store for the `features/dailyRun`
// micro-fleet workflow (the "Daily Run" the user sees in the UI). Persisted
// to `chrome.storage.local` under a per-universe key
// (`<universeId>:oge_dailyRunRoutes`, see {@link dailyRunRoutesKeyFor}).
//
// # What it holds
//
//   - `routes` — an ARRAY of {@link Route}. Each route has one or more
//     SOURCE bodies (planets and/or moons), one ordered target list, and
//     one micro-fleet; standing on any source fires it. Stored values are
//     normalised on hydrate by {@link parseDailyRunRoutes} (well-formed
//     routes only).
//   - `collectTarget` — the single ad-hoc destination the COLLECT action
//     sends everything back to. Set by clicking "set target" while on the
//     staging moon; `null` until chosen. Carries `type` because the
//     target may be a moon (type 3) or planet (type 1).
//   - `collectMission` — the fleet mission the COLLECT ("Send All") action
//     sends with (game `mission=` id). Defaults to deployment (stay); can be
//     switched to transport (drop resources + return) from the dashboard's
//     Daily Run tab.
//   - `collectShips` / `collectResources` — how COLLECT selects ships and
//     loads cargo: `'all'` or `'most'` (AGR's "send/load most", leaving a
//     reserve). Both default to `'most'`. Set from the dashboard's Daily Run tab.
//
// # Why per-universe namespacing
//
// Same rationale as `state/scans.js`: `chrome.storage.local` is shared
// across every origin the extension runs on, so each OGame server keeps
// its own routes under a `<universeId>:` prefix.
//
// Persistence is wired lazily via {@link initDailyRunRoutesStore} (NOT on
// import) so tests can mock `chromeStore` before any I/O fires and the
// content-script bootstrap is the one place that wires it, exactly once.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { DAILY_RUN_REDIRECT_KEY } from '../lib/storageKeys.js';
import { parseDailyRunRoutes } from '../domain/dailyRunRoutes.js';
import { MISSION_DEPLOYMENT } from '../domain/rules.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * The coordinate / route shapes live in `domain/dailyRunRoutes.js` (pure,
 * shared with the dashboard editor). Re-exported as type aliases here so
 * the store's JSDoc reads naturally without each consumer reaching into
 * domain. Runtime values flow only one way (state → domain).
 *
 * @typedef {import('../domain/dailyRunRoutes.js').TargetCoord} TargetCoord
 * @typedef {import('../domain/dailyRunRoutes.js').MicroFleet} MicroFleet
 * @typedef {import('../domain/dailyRunRoutes.js').Route} Route
 */

/**
 * Full route config persisted under `<universeId>:oge_dailyRunRoutes`.
 *
 * @typedef {object} DailyRunRoutes
 * @property {Route[]} routes  All micro-fleet routes (each with its own
 *   source/target lists). See {@link parseDailyRunRoutes} for normalisation.
 * @property {TargetCoord | null} collectTarget  Ad-hoc collect destination.
 * @property {number} collectMission  Mission id the in-game "Send All"
 *   (collect) action sends with (default {@link MISSION_DEPLOYMENT}).
 * @property {'all' | 'most'} collectShips  How "Send All" selects ships:
 *   `'all'` (explicit fill) or `'most'` (AGR "send most" — leaves a reserve).
 * @property {'all' | 'most'} collectResources  How "Send All" loads cargo:
 *   `'all'` (#allresources) or `'most'` (#mostresources — leaves a reserve).
 */

/**
 * Suffix portion of the chrome.storage.local key. The full key written
 * is `<universeId>:<DAILY_RUN_ROUTES_KEY_BASE>` — see {@link dailyRunRoutesKeyFor}.
 * Exported so the dashboard (extension origin) can compose a key for an
 * arbitrary selected universe.
 */
export const DAILY_RUN_ROUTES_KEY_BASE = 'oge_dailyRunRoutes';

/**
 * localStorage handoff key between the isolated-world dailyRun
 * orchestrator (writer) and the MAIN-world `bridges/deployRedirect.js`
 * (reader). The orchestrator writes an absolute URL string here
 * synchronously before clicking dispatch; the bridge consumes it to
 * rewrite the post-send `redirectUrl`. A bare string constant (no
 * universe namespacing — it is a transient one-shot, not persisted
 * config). The canonical string now lives in `lib/storageKeys.js` so the
 * MAIN-world bridge can import it without pulling in this isolated-world
 * store module; re-exported here so existing `state/dailyRunRoutes` importers
 * are unchanged. Mirrors `REGISTRY_KEY` in `state/registry.js`.
 */
export { DAILY_RUN_REDIRECT_KEY };

/**
 * localStorage key for the post-send LANDING CHECK — the same URL we handed
 * the bridge, kept a few seconds longer so the next page load can verify we
 * actually got there.
 *
 * Why it exists: our redirect only wins if nothing else navigates the page
 * after the send. AGR's "fleet save" option does exactly that — it jumps to
 * the NEXT planet the moment a fleet leaves — so with that box ticked a Daily
 * Run micro send landed the player on a foreign planet instead of back on the
 * body they were working. Rather than reach into another extension's state, we
 * re-assert our own: the orchestrator writes `{url, at}` here beside the bridge
 * handoff, and on the next page load reads it ONCE (removing it first, so the
 * worst case is a single extra navigation, never a loop) and goes back if the
 * landing body isn't the one it asked for.
 *
 * Transient one-shot like {@link DAILY_RUN_REDIRECT_KEY} — no universe prefix.
 */
export const DAILY_RUN_LANDING_KEY = 'oge_dailyRunLanding';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from {@link parseUniverseId}.
 * @returns {string} The namespaced key, e.g. `'s163-pl:oge_dailyRunRoutes'`.
 */
export const dailyRunRoutesKeyFor = (universeId) => `${universeId}:${DAILY_RUN_ROUTES_KEY_BASE}`;

/**
 * Suffix of the per-universe "routes last changed" timestamp key
 * (`<universeId>:oge_dailyRunRoutesTs`). The cross-device sync engine uses this
 * epoch-ms value for whole-universe newest-wins merging (see
 * `sync/merge.mergeDailyRunRoutes`).
 *
 * Why a SEPARATE chrome.storage key rather than a field inside the routes
 * value, and why chrome.storage rather than localStorage:
 *   - It's sync METADATA, not route config — kept out of the {@link DailyRunRoutes}
 *     domain value, exactly as the settings ts map is kept out of the
 *     settings values (`settingsSync.SETTINGS_TS_KEY`).
 *   - Routes are edited from TWO origins: in-game (game origin) AND the
 *     dashboard (extension origin). localStorage is per-origin, so it
 *     couldn't be shared; `chrome.storage.local` is the one store both
 *     origins see. Every writer (dashboard save, in-game prune / set-target)
 *     stamps it via {@link stampDailyRunRoutesChanged} / the dashboard's own write.
 */
export const DAILY_RUN_ROUTES_TS_BASE = 'oge_dailyRunRoutesTs';

/**
 * Compose the per-universe routes-timestamp key.
 *
 * @param {string} universeId
 * @returns {string} e.g. `'s163-pl:oge_dailyRunRoutesTs'`.
 */
export const dailyRunRoutesTsKeyFor = (universeId) => `${universeId}:${DAILY_RUN_ROUTES_TS_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe.
 * Falls back to the bare key in non-DOM test environments (mirrors
 * `state/scans.js:currentScansKey`).
 *
 * @returns {string}
 */
const currentDailyRunRoutesKey = () => currentUniverseKey(DAILY_RUN_ROUTES_KEY_BASE, dailyRunRoutesKeyFor);

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

/**
 * The empty initial config. A fresh function each call so callers can't
 * accidentally share/mutate one frozen literal.
 *
 * @returns {DailyRunRoutes}
 */
const emptyConfig = () => ({
  routes: [],
  collectTarget: null,
  collectMission: MISSION_DEPLOYMENT,
  collectShips: 'most',
  collectResources: 'most',
});

/**
 * The Daily Run route store. Initial value is empty; hydration is async
 * (chromeStore returns a Promise) and lands once {@link initDailyRunRoutesStore}
 * resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<DailyRunRoutes>}
 */
export const dailyRunRoutesStore = createStore(/** @type {DailyRunRoutes} */ (emptyConfig()));

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 * Module scope so repeat `initDailyRunRoutesStore` calls collapse to a no-op.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initDailyRunRoutesStore} call. See `state/history.js` for the full
 * lifecycle rationale.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * The promise returned by {@link whenDailyRunRoutesHydrated}. Pre-resolved until
 * {@link initDailyRunRoutesStore} swaps it for a pending one, so tests that bypass
 * init don't hang awaiting a hydrate that never arrives.
 *
 * @type {Promise<void>}
 */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the {@link dailyRunRoutesStore} hydrate phase has settled (the
 * stored value has been applied, or the load found nothing). The planet-bar
 * capture gates route RECONCILIATION on this so it
 * never prunes against not-yet-hydrated (empty) routes. Call as a function,
 * not captured at import — the binding changes across init/dispose.
 *
 * @returns {Promise<void>}
 */
export const whenDailyRunRoutesHydrated = () => hydratedPromise;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_dailyRunRoutes` and write every change back (debounced).
 * Idempotent — subsequent calls return the same dispose handle without
 * double-registering.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener.
 */
export const initDailyRunRoutesStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: dailyRunRoutesStore,
    load: async () => {
      const raw = await chromeStore.get(currentDailyRunRoutesKey());
      // Nothing stored yet → keep the empty initial.
      if (raw === null || raw === undefined) return null;
      // Normalise the stored value (drops malformed routes) before it
      // reaches `store.set`.
      return /** @type {DailyRunRoutes} */ (parseDailyRunRoutes(raw));
    },
    save: (value) => chromeStore.set(currentDailyRunRoutesKey(), value),
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
export const flushDailyRunRoutesStore = () =>
  chromeStore.set(currentDailyRunRoutesKey(), dailyRunRoutesStore.get());

/**
 * Stamp "routes changed just now" for the current universe, so the next
 * sync round-trip treats this device's routes as the freshest for
 * whole-universe newest-wins (see `sync/merge.mergeDailyRunRoutes`). Call AFTER
 * any in-game write that changes routes/collectTarget (route pruning,
 * set-collect-target). The dashboard writes the same key directly on save.
 *
 * # Flushes the routes value first (closes the debounce race)
 *
 * The routes VALUE saves on a {@link DEBOUNCE_MS} debounce, but this
 * timestamp writes immediately. A caller that mutates routes, stamps, then
 * navigates away could otherwise land the timestamp while the value is still
 * sitting in the debounce timer — the next sync would then advertise this
 * device as freshest (newest ts) while its routes value is stale or lost.
 * Flushing via {@link flushDailyRunRoutesStore} first guarantees the value is on
 * disk before the clock says it changed. Both writes are awaited, so callers
 * that navigate should `await` (or `void`-and-accept the in-flight write).
 *
 * @returns {Promise<void>}
 */
export const stampDailyRunRoutesChanged = async () => {
  await flushDailyRunRoutesStore();
  await chromeStore.set(currentUniverseKey(DAILY_RUN_ROUTES_TS_BASE, dailyRunRoutesTsKeyFor), Date.now());
};

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeDailyRunRoutesStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
