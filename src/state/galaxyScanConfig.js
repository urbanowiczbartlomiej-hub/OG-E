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
// the reason `state/dailyRunRoutes.js` lives here too. This store is modelled on
// dailyRunRoutes 1:1 (lazy `init*`, async hydrate, debounced write-through,
// per-universe `Ts` key for whole-slot newest-wins sync, `stamp*` helper).
//
// The shape, defaults, and normalisation live in the pure
// `domain/galaxyScanConfig.js`; this module only owns persistence + the
// cross-device sync timestamp.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
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
 * `dailyRunRoutesTsKeyFor`: it is sync metadata (not config), and it must be
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
 * `state/dailyRunRoutes.js:currentDailyRunRoutesKey`).
 *
 * @returns {string}
 */
const currentKey = () =>
  currentUniverseKey(GALAXY_SCAN_CONFIG_KEY_BASE, galaxyScanConfigKeyFor);

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

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
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_galaxyScanConfig` (normalised, so a partial/legacy blob
 * is filled to a complete config) and write every change back (debounced).
 * Idempotent.
 *
 * @returns {() => void} Dispose function that unsubscribes write-through.
 */
export const initGalaxyScanConfigStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: galaxyScanConfigStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      if (raw !== null && raw !== undefined) return normalizeGalaxyScanConfig(raw);
      // Nothing in chrome.storage yet → keep the default preset, no write.
      return null;
    },
    save: (value) => chromeStore.set(currentKey(), value),
    debounceMs: DEBOUNCE_MS,
  });
  return disposeFn;
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
};
