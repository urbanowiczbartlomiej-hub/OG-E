// Shared-settings store — the reactive, GLOBAL (not per-universe) config that
// is edited from the dashboard (extension origin) and read in-game (game
// origin). Persisted to `chrome.storage.local` under {@link SHARED_SETTINGS_KEY}.
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// localStorage is per-origin, so the game tab and the dashboard page see
// different localStorage and can't share an edit. `chrome.storage.local` is
// the one backing both origins see — the same reason `state/galaxyScanConfig.js`
// and `state/dailyRunRoutes.js` live there. This store is modelled on
// galaxyScanConfig (lazy `init*`, async hydrate, debounced write-through), minus
// the per-universe key (these preferences are global) and the sync timestamp
// (they are device-local, exactly as they were as localStorage settings).
//
// The shape, defaults, and normalisation live in the pure
// `domain/sharedSettings.js`; this module only owns persistence.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import {
  defaultSharedSettings,
  normalizeSharedSettings,
} from '../domain/sharedSettings.js';

/**
 * @typedef {import('../domain/sharedSettings.js').SharedSettings} SharedSettings
 */

/**
 * chrome.storage.local key for the whole shared-settings blob. Global (no
 * `<universeId>:` prefix) — these preferences are not per-universe. Exported
 * so the dashboard (extension origin) can read/write the same key directly,
 * the way `dashboard/scanConfig.js` composes the galaxy-scan key.
 */
export const SHARED_SETTINGS_KEY = 'oge_sharedSettings';

/** Write-through debounce window (edits arrive in bursts of typing). */
const DEBOUNCE_MS = 200;

/**
 * The shared-settings store. Initial value is the built-in defaults (so
 * in-game consumers have sane values before the async hydrate lands),
 * replaced by the persisted blob once {@link initSharedSettingsStore} resolves.
 *
 * @type {import('../lib/createStore.js').Store<SharedSettings>}
 */
export const sharedSettingsStore = createStore(defaultSharedSettings());

/** @type {(() => void) | null} */
let disposeFn = null;

/** @type {() => void} */
let resolveHydrated = () => {};

/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the hydrate phase has settled (stored value applied, or the
 * read found nothing). Call as a function — the binding changes across
 * init/dispose.
 *
 * @returns {Promise<void>}
 */
export const whenSharedSettingsHydrated = () => hydratedPromise;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * {@link SHARED_SETTINGS_KEY} (normalised, so a partial blob is filled to a
 * complete object) and write every change back (debounced). Idempotent.
 *
 * Must run in a context that can persist back to chrome.storage — i.e. the
 * content script and the dashboard page both call it; whichever writes last
 * wins (edits are user-driven and infrequent, so a cross-tab race is moot).
 *
 * @returns {() => void} Dispose function that unsubscribes write-through.
 */
export const initSharedSettingsStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: sharedSettingsStore,
    load: async () => {
      const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
      if (raw !== null && raw !== undefined) return normalizeSharedSettings(raw);
      // Nothing stored yet → keep the defaults, write nothing (a later edit
      // creates the blob). Matches galaxyScanConfig's no-write-on-empty rule.
      return null;
    },
    save: (value) => chromeStore.set(SHARED_SETTINGS_KEY, value),
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
export const flushSharedSettingsStore = () =>
  chromeStore.set(SHARED_SETTINGS_KEY, sharedSettingsStore.get());

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeSharedSettingsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
