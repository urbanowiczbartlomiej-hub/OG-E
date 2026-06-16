// Reminder config store — the reactive, per-universe config behind expedition-
// wave auto-reminders, the ad-hoc lead time, and the per-kind message
// templates. Persisted to `chrome.storage.local` under
// `<universeId>:oge_reminderConfig` (see {@link reminderConfigKeyFor}).
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// This config is edited from TWO origins: in-game (game origin) and the
// dashboard (extension origin). localStorage is per-origin, so it can't be
// shared; `chrome.storage.local` is the one store both origins see. This store
// is modelled on `state/galaxyScanConfig.js` 1:1 (lazy `init*`, async hydrate,
// debounced write-through, per-universe `Ts` key for whole-slot newest-wins
// sync, `stamp*` helper).
//
// The shape, defaults, and normalisation live in the pure
// `domain/reminderConfig.js`; this module only owns persistence + the
// cross-device sync timestamp.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import {
  defaultReminderConfig,
  normalizeReminderConfig,
} from '../domain/reminderConfig.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * @typedef {import('../domain/reminderConfig.js').ReminderConfig} ReminderConfig
 */

/**
 * Suffix portion of the chrome.storage.local key. The full key written is
 * `<universeId>:<REMINDER_CONFIG_KEY_BASE>` — see
 * {@link reminderConfigKeyFor}. Exported so the dashboard (extension origin)
 * can compose a key for an arbitrary selected universe.
 */
export const REMINDER_CONFIG_KEY_BASE = 'oge_reminderConfig';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from `parseUniverseId`.
 * @returns {string} e.g. `'s163-pl:oge_reminderConfig'`.
 */
export const reminderConfigKeyFor = (universeId) =>
  `${universeId}:${REMINDER_CONFIG_KEY_BASE}`;

/**
 * Suffix of the per-universe "config last changed" timestamp key
 * (`<universeId>:oge_reminderConfigTs`). The sync engine uses this epoch-ms
 * value for whole-universe newest-wins merging (see
 * `sync/merge.mergeReminderConfig`). Separate key for the same reasons as
 * `galaxyScanConfigTsKeyFor`: it is sync metadata (not config), and it must be
 * visible across both editing origins.
 */
export const REMINDER_CONFIG_TS_BASE = 'oge_reminderConfigTs';

/**
 * Compose the per-universe config-timestamp key.
 *
 * @param {string} universeId
 * @returns {string} e.g. `'s163-pl:oge_reminderConfigTs'`.
 */
export const reminderConfigTsKeyFor = (universeId) =>
  `${universeId}:${REMINDER_CONFIG_TS_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe. Falls
 * back to the bare suffix in non-DOM test environments (mirrors
 * `state/galaxyScanConfig.js:currentKey`).
 *
 * @returns {string}
 */
const currentKey = () =>
  currentUniverseKey(REMINDER_CONFIG_KEY_BASE, reminderConfigKeyFor);

/** Write-through debounce window (config edits are infrequent bursts). */
const DEBOUNCE_MS = 200;

/**
 * The reminder config store. Initial value is the built-in defaults (so
 * reminder consumers have sane behaviour before the async hydrate lands),
 * replaced by the persisted value once {@link initReminderConfigStore}
 * resolves the load.
 *
 * @type {import('../lib/createStore.js').Store<ReminderConfig>}
 */
export const reminderConfigStore = createStore(defaultReminderConfig());

/**
 * The `persist` unsubscribe handle, or `null` before init / after dispose.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Resolver for {@link hydratedPromise}, re-bound on every
 * {@link initReminderConfigStore} call.
 *
 * @type {() => void}
 */
let resolveHydrated = () => {};

/**
 * Pre-resolved until {@link initReminderConfigStore} swaps it for a pending
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
export const whenReminderConfigHydrated = () => hydratedPromise;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_reminderConfig` (normalised, so a partial/legacy blob is
 * filled to a complete config) and write every change back (debounced).
 * Idempotent.
 *
 * @returns {() => void} Dispose function that unsubscribes write-through.
 */
export const initReminderConfigStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => { resolveHydrated = resolve; });
  disposeFn = persist({
    store: reminderConfigStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      if (raw !== null && raw !== undefined) return normalizeReminderConfig(raw);
      // Nothing in chrome.storage yet → keep the defaults, no write.
      return null;
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
export const flushReminderConfigStore = () =>
  chromeStore.set(currentKey(), reminderConfigStore.get());

/**
 * Stamp "config changed just now" for the current universe so the next sync
 * round-trip treats this device's config as freshest (whole-universe
 * newest-wins, see `sync/merge.mergeReminderConfig`). Flushes the value first
 * to close the debounce race (same rationale as `stampGalaxyScanConfigChanged`).
 * The dashboard writes the same key directly on save.
 *
 * @returns {Promise<void>}
 */
export const stampReminderConfigChanged = async () => {
  await flushReminderConfigStore();
  await chromeStore.set(
    currentUniverseKey(REMINDER_CONFIG_TS_BASE, reminderConfigTsKeyFor),
    Date.now(),
  );
};

/**
 * Tear down the persist wiring. Idempotent.
 *
 * @returns {void}
 */
export const disposeReminderConfigStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
