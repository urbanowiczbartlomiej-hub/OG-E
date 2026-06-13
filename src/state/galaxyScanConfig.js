// Galaxy-Scan config store — the reactive, per-universe config behind the
// Scan button and the dashboard's Galaxy Scan view. Persisted to
// `chrome.storage.local` under `<universeId>:oge_galaxyScanConfig` (see
// {@link galaxyScanConfigKeyFor}).
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// This config is edited from TWO origins: in-game (game origin) and the
// dashboard (extension origin). localStorage is per-origin, so it can't be
// shared; `chrome.storage.local` is the one store both origins see — exactly
// the reason `state/fsRoutes.js` lives here too. This store is modelled on
// fsRoutes 1:1 (lazy `init*`, async hydrate, debounced write-through,
// per-universe `Ts` key for whole-slot newest-wins sync, `stamp*` helper).
//
// The shape, defaults, and normalisation live in the pure
// `domain/galaxyScanConfig.js`; this module only owns persistence + the
// cross-device sync timestamp.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore, safeLS } from '../lib/storage.js';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../domain/galaxyScanConfig.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * @typedef {import('../domain/galaxyScanConfig.js').GalaxyScanConfig} GalaxyScanConfig
 */

/**
 * Suffix portion of the chrome.storage.local key. The full key written is
 * `<universeId>:<GALAXY_SCAN_CONFIG_KEY_BASE>` — see
 * {@link galaxyScanConfigKeyFor}. Exported so the dashboard (extension
 * origin) can compose a key for an arbitrary selected universe.
 */
export const GALAXY_SCAN_CONFIG_KEY_BASE = 'oge_galaxyScanConfig';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from `parseUniverseId`.
 * @returns {string} e.g. `'s163-pl:oge_galaxyScanConfig'`.
 */
export const galaxyScanConfigKeyFor = (universeId) =>
  `${universeId}:${GALAXY_SCAN_CONFIG_KEY_BASE}`;

/**
 * Suffix of the per-universe "config last changed" timestamp key
 * (`<universeId>:oge_galaxyScanConfigTs`). The sync engine uses this
 * epoch-ms value for whole-universe newest-wins merging (see
 * `sync/merge.mergeGalaxyScanConfig`). Separate key for the same reasons as
 * `fsRoutesTsKeyFor`: it is sync metadata (not config), and it must be
 * visible across both editing origins.
 */
export const GALAXY_SCAN_CONFIG_TS_BASE = 'oge_galaxyScanConfigTs';

/**
 * Compose the per-universe config-timestamp key.
 *
 * @param {string} universeId
 * @returns {string} e.g. `'s163-pl:oge_galaxyScanConfigTs'`.
 */
export const galaxyScanConfigTsKeyFor = (universeId) =>
  `${universeId}:${GALAXY_SCAN_CONFIG_TS_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe.
 * Falls back to the bare suffix in non-DOM test environments (mirrors
 * `state/fsRoutes.js:currentFsRoutesKey`).
 *
 * @returns {string}
 */
const currentKey = () =>
  currentUniverseKey(GALAXY_SCAN_CONFIG_KEY_BASE, galaxyScanConfigKeyFor);

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

/**
 * Legacy AGR-settings localStorage keys whose values moved into this config
 * when the Galaxy-Scan editor relocated from the AGR settings panel to the
 * dashboard. Read once during {@link initGalaxyScanConfigStore}'s hydrate to
 * seed `positions` / `preferOtherGalaxies` so the move is transparent for an
 * upgrading user. The keys are intentionally NOT removed (a downgrade keeps
 * working); they are simply no longer the source of truth.
 */
const LEGACY_POSITIONS_KEY = 'oge_colPositions';
const LEGACY_PREFER_KEY = 'oge_colPreferOtherGalaxies';

/**
 * One-time seed from the legacy AGR settings keys. Returns a complete config
 * built on the default preset with `positions` / `preferOtherGalaxies` taken
 * from localStorage when present, or `null` when neither legacy key exists
 * (a fresh install, or the extension/dashboard origin — which can't see the
 * game origin's localStorage). Returning `null` tells `persist` to keep the
 * default preset without a migration write.
 *
 * NB: the seeded config is written through to chrome.storage but its sync
 * timestamp is left at 0, so it does not clobber a remote config from another
 * device; the migrated positions begin syncing once the user first edits the
 * config in the dashboard (which stamps the clock).
 *
 * @returns {GalaxyScanConfig | null}
 */
const seedFromLegacySettings = () => {
  const pos = safeLS.get(LEGACY_POSITIONS_KEY);
  const prefRaw = safeLS.get(LEGACY_PREFER_KEY);
  if (pos === null && prefRaw === null) return null;
  const cfg = defaultGalaxyScanConfig();
  if (pos !== null) cfg.positions = pos;
  if (prefRaw !== null) {
    cfg.preferOtherGalaxies = safeLS.bool(LEGACY_PREFER_KEY, cfg.preferOtherGalaxies);
  }
  return cfg;
};

/**
 * The Galaxy-Scan config store. Initial value is the built-in "free
 * positions" preset (so the Scan button has sane behaviour before the async
 * hydrate lands), replaced by the persisted value once
 * {@link initGalaxyScanConfigStore} resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<GalaxyScanConfig>}
 */
export const galaxyScanConfigStore = createStore(defaultGalaxyScanConfig());

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initGalaxyScanConfigStore} call.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * Pre-resolved until {@link initGalaxyScanConfigStore} swaps it for a pending
 * one, so tests that bypass init don't hang awaiting a hydrate.
 *
 * @type {Promise<void>}
 */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the hydrate phase has settled (the stored value applied, or
 * the load found nothing). Call as a function — the binding changes across
 * init/dispose.
 *
 * @returns {Promise<void>}
 */
export const whenGalaxyScanConfigHydrated = () => hydratedPromise;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_galaxyScanConfig` (normalised, so a partial/legacy blob
 * is filled to a complete config) and write every change back (debounced).
 * Idempotent.
 *
 * @returns {() => void} Dispose function that unsubscribes write-through.
 */
export const initGalaxyScanConfigStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: galaxyScanConfigStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      if (raw !== null && raw !== undefined) return normalizeGalaxyScanConfig(raw);
      // Nothing in chrome.storage yet: first run after the upgrade (game
      // origin) seeds from the legacy AGR settings keys; a fresh install /
      // the dashboard origin gets null → keeps the default preset, no write.
      return seedFromLegacySettings();
    },
    save: (value) => chromeStore.set(currentKey(), value),
    debounceMs: DEBOUNCE_MS,
    onHydrate: () => { resolveHydrated(); },
  });
  return disposeFn;
};

/**
 * Bypass the debounce and write the current value immediately. Call before
 * navigating away so an in-memory edit is not lost to a pending debounce.
 *
 * @returns {Promise<void>}
 */
export const flushGalaxyScanConfigStore = () =>
  chromeStore.set(currentKey(), galaxyScanConfigStore.get());

/**
 * Stamp "config changed just now" for the current universe so the next sync
 * round-trip treats this device's config as freshest (whole-universe
 * newest-wins, see `sync/merge.mergeGalaxyScanConfig`). Flushes the value
 * first to close the debounce race (same rationale as
 * `state/fsRoutes.stampFsRoutesChanged`). The dashboard writes the same key
 * directly on save.
 *
 * @returns {Promise<void>}
 */
export const stampGalaxyScanConfigChanged = async () => {
  await flushGalaxyScanConfigStore();
  await chromeStore.set(
    currentUniverseKey(GALAXY_SCAN_CONFIG_TS_BASE, galaxyScanConfigTsKeyFor),
    Date.now(),
  );
};

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeGalaxyScanConfigStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
