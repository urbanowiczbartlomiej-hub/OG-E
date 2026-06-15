// Global reminder config store — the reactive, GLOBAL (server-independent)
// config behind expedition-wave auto-reminders and the ad-hoc lead time.
// Persisted to `chrome.storage.local` under `oge_reminderGlobalConfig`.
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// Same reason as `state/galaxyScanConfig.js`: this config is edited from TWO
// origins — in-game (game origin) and the dashboard's Reminders tab (extension
// origin). localStorage is per-origin, so it can't be shared; `chrome.storage.local`
// is the one store both origins see. This store is modelled on
// `state/galaxyScanConfig.js`, MINUS the per-universe key prefix: there is
// exactly ONE global slot (the wave cadence / ad-hoc lead time apply to every
// server), so the keys are bare and `currentUniverseKey` is not used.
//
// The shape, defaults, and normalisation live in the pure
// `domain/reminderGlobalConfig.js`; this module only owns persistence + the
// cross-device sync timestamp.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import {
  defaultReminderGlobalConfig,
  normalizeReminderGlobalConfig,
} from '../domain/reminderGlobalConfig.js';

/**
 * @typedef {import('../domain/reminderGlobalConfig.js').ReminderGlobalConfig} ReminderGlobalConfig
 */

/**
 * chrome.storage.local key for the global reminder config. No universe
 * prefix — this slot is global (one value for every server).
 */
export const REMINDER_GLOBAL_CONFIG_KEY = 'oge_reminderGlobalConfig';

/**
 * chrome.storage.local key for the "config last changed" timestamp. The sync
 * engine uses this epoch-ms value for whole-slot newest-wins merging (see
 * `sync/merge.mergeReminderGlobalConfig`). Separate key for the same reason as
 * `galaxyScanConfigTsKeyFor`: it is sync metadata (not config), and it must be
 * visible across both editing origins.
 */
export const REMINDER_GLOBAL_CONFIG_TS_KEY = 'oge_reminderGlobalConfigTs';

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

/**
 * The global reminder config store. Initial value is the built-in defaults
 * (so reminder consumers have sane behaviour before the async hydrate lands),
 * replaced by the persisted value once {@link initReminderGlobalConfigStore}
 * resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<ReminderGlobalConfig>}
 */
export const reminderGlobalConfigStore = createStore(defaultReminderGlobalConfig());

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initReminderGlobalConfigStore} call.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * Pre-resolved until {@link initReminderGlobalConfigStore} swaps it for a
 * pending one, so tests that bypass init don't hang awaiting a hydrate.
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
export const whenReminderGlobalConfigHydrated = () => hydratedPromise;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `oge_reminderGlobalConfig` (normalised, so a partial/legacy blob is filled
 * to a complete config) and write every change back (debounced). Idempotent.
 *
 * @returns {() => void} Dispose function that unsubscribes write-through.
 */
export const initReminderGlobalConfigStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: reminderGlobalConfigStore,
    load: async () => {
      const raw = await chromeStore.get(REMINDER_GLOBAL_CONFIG_KEY);
      if (raw !== null && raw !== undefined) return normalizeReminderGlobalConfig(raw);
      // Nothing in chrome.storage yet → keep the defaults, no write.
      return null;
    },
    save: (value) => chromeStore.set(REMINDER_GLOBAL_CONFIG_KEY, value),
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
export const flushReminderGlobalConfigStore = () =>
  chromeStore.set(REMINDER_GLOBAL_CONFIG_KEY, reminderGlobalConfigStore.get());

/**
 * Stamp "config changed just now" so the next sync round-trip treats this
 * device's config as freshest (whole-slot newest-wins, see
 * `sync/merge.mergeReminderGlobalConfig`). Flushes the value first to close
 * the debounce race (same rationale as `stampGalaxyScanConfigChanged`). The
 * dashboard writes the same key directly on save.
 *
 * @returns {Promise<void>}
 */
export const stampReminderGlobalConfigChanged = async () => {
  await flushReminderGlobalConfigStore();
  await chromeStore.set(REMINDER_GLOBAL_CONFIG_TS_KEY, Date.now());
};

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeReminderGlobalConfigStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
