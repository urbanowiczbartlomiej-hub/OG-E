// @ts-check
//
// Cross-universe shared settings, bridged through chrome.storage.local.
//
// Most user preferences are per-origin localStorage (see state/settings.js).
// These four are different: they are configured ONCE from the OG-E Dashboard
// (which runs at the extension origin and cannot reach any game origin's
// localStorage) and must apply to every universe. So chrome.storage.local —
// shared across all origins the extension runs on — is their canonical home,
// and the dashboard is the SOLE writer.
//
//   cloudSync, gistToken, remindersMasterEnabled, reminderNtfyToken
//
// On each game origin this module is a READER: it hydrates the four fields into
// `settingsStore` from chrome.storage on init and on every change, so every
// existing game-side consumer (gist `getToken`, the reminder producer, …) keeps
// reading `settingsStore` / localStorage exactly as before — nothing downstream
// has to know the value now originates in chrome.storage. The game side never
// writes back, so there is no echo loop — EXCEPT a one-time migration that
// lifts a pre-existing per-origin localStorage value UP into chrome.storage the
// first time this build runs, so existing users don't lose their token.

import { chromeStore } from '../lib/storage.js';
import { settingsStore } from './settings.js';

/** chrome.storage.local key holding the cross-universe shared-settings dict. */
export const SHARED_SETTINGS_KEY = 'oge_sharedSettings';

/**
 * @typedef {object} SharedSettings
 * @property {boolean} cloudSync
 * @property {string}  gistToken
 * @property {boolean} remindersMasterEnabled
 * @property {string}  reminderNtfyToken
 */

/**
 * Pick the shared subset from a full Settings object.
 *
 * @param {import('./settings.js').Settings} s
 * @returns {SharedSettings}
 */
export const pickShared = (s) => ({
  cloudSync: s.cloudSync,
  gistToken: s.gistToken,
  remindersMasterEnabled: s.remindersMasterEnabled,
  reminderNtfyToken: s.reminderNtfyToken,
});

/**
 * Merge a raw chrome.storage value (canonical) with this origin's local values
 * to produce the effective shared settings. chrome.storage wins, EXCEPT an
 * empty token is back-filled from a non-empty local one — that's the migration
 * path: a token a user typed per-origin before this build existed is lifted up
 * rather than clobbered by an as-yet-empty cloud slot. Booleans take the cloud
 * value whenever it is present (a real `false` must not be treated as "unset").
 *
 * Pure — exported for unit tests.
 *
 * @param {unknown} raw   The chrome.storage value (any shape; may be null).
 * @param {SharedSettings} local  This origin's current shared values.
 * @returns {SharedSettings}
 */
export const mergeShared = (raw, local) => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    cloudSync: typeof o.cloudSync === 'boolean' ? o.cloudSync : local.cloudSync,
    remindersMasterEnabled:
      typeof o.remindersMasterEnabled === 'boolean'
        ? o.remindersMasterEnabled
        : local.remindersMasterEnabled,
    gistToken: typeof o.gistToken === 'string' && o.gistToken ? o.gistToken : local.gistToken,
    reminderNtfyToken:
      typeof o.reminderNtfyToken === 'string' && o.reminderNtfyToken
        ? o.reminderNtfyToken
        : local.reminderNtfyToken,
  };
};

/** Apply a shared-settings object onto the store (merges, notifies once). */
const applyToStore = (/** @type {SharedSettings} */ shared) => {
  settingsStore.set({ ...settingsStore.get(), ...shared });
};

/** @type {(() => void) | null} onChanged unsubscribe, for idempotent teardown. */
let unsub = null;

/**
 * Wire the game-origin side of shared settings. Idempotent — a second call
 * before {@link disposeSharedSettings} is a no-op. MUST run after
 * `initSettingsStore` (it reads + writes `settingsStore`).
 *
 * @returns {Promise<void>}
 */
export const initSharedSettings = async () => {
  if (unsub) return;
  const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
  const merged = mergeShared(raw, pickShared(settingsStore.get()));
  // Only write when the merge actually changed the cloud value (a fresh slot,
  // or a migrated-up token) — steady state must not spam onChanged.
  if (JSON.stringify(raw) !== JSON.stringify(merged)) {
    await chromeStore.set(SHARED_SETTINGS_KEY, merged);
  }
  applyToStore(merged);

  unsub = chromeStore.onChanged((changes) => {
    if (!(SHARED_SETTINGS_KEY in changes)) return;
    // Re-read the value rather than trust the change record's shape (the
    // wrapper forwards the raw StorageChange); same pattern as the dashboard's
    // reminder consumers.
    void chromeStore.get(SHARED_SETTINGS_KEY).then((next) => {
      applyToStore(mergeShared(next, pickShared(settingsStore.get())));
    });
  });
};

/** Teardown for tests. Idempotent. */
export const disposeSharedSettings = () => {
  if (unsub) {
    unsub();
    unsub = null;
  }
};
