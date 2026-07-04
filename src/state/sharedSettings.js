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
//   cloudSync, gistToken, alarmClockMasterEnabled, alarmClockNtfyToken
//
// On each game origin this module is a READER: it hydrates the four fields into
// `settingsStore` from chrome.storage on init and on every change, so every
// existing game-side consumer (gist `getToken`, the alarmClock producer, …) keeps
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
 * @property {boolean} alarmClockMasterEnabled
 * @property {string}  alarmClockNtfyToken
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
  alarmClockMasterEnabled: s.alarmClockMasterEnabled,
  alarmClockNtfyToken: s.alarmClockNtfyToken,
});

/**
 * Merge a raw chrome.storage value (canonical) with this origin's local values
 * to produce the effective shared settings. chrome.storage wins whenever the
 * key is PRESENT — including a present-but-empty token, which is an
 * authoritative clear (the dashboard's "remove my token") and must not be
 * resurrected from this origin's mirror. Only an ABSENT key falls back to the
 * local value — that's the migration path: a token a user typed per-origin
 * before this build existed is lifted up into the fresh cloud slot. To keep
 * that window open, {@link initSharedSettings} never SEEDS an empty token key
 * (a token-less origin booting first must not materialize `''` as "present"
 * and clobber a sibling origin's yet-unmigrated token). Booleans likewise
 * take the cloud value whenever it is present (a real `false` must not be
 * treated as "unset").
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
    alarmClockMasterEnabled:
      typeof o.alarmClockMasterEnabled === 'boolean'
        ? o.alarmClockMasterEnabled
        : local.alarmClockMasterEnabled,
    gistToken: typeof o.gistToken === 'string' ? o.gistToken : local.gistToken,
    alarmClockNtfyToken:
      typeof o.alarmClockNtfyToken === 'string'
        ? o.alarmClockNtfyToken
        : local.alarmClockNtfyToken,
  };
};

/** Apply a shared-settings object onto the store (merges, notifies once). */
const applyToStore = (/** @type {SharedSettings} */ shared) => {
  settingsStore.set({ ...settingsStore.get(), ...shared });
};

/** @type {(() => void) | null} onChanged unsubscribe, for idempotent teardown. */
let unsub = null;

/**
 * @type {Promise<void> | null} In-flight/settled init latch. Set synchronously
 * on the first call so overlapping callers await the SAME init instead of each
 * racing past the (async) `unsub` assignment and double-registering onChanged.
 */
let initPromise = null;

/**
 * Wire the game-origin side of shared settings. Idempotent — a second call
 * before {@link disposeSharedSettings} is a no-op. MUST run after
 * `initSettingsStore` (it reads + writes `settingsStore`).
 *
 * @returns {Promise<void>}
 */
export const initSharedSettings = () => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
    const rawObj = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
    const merged = mergeShared(raw, pickShared(settingsStore.get()));
    // Write-up payload: NEVER seed an empty token key. Materializing `''` for a
    // token this origin simply doesn't have would read as an authoritative
    // dashboard clear on every OTHER origin (mergeShared: a present string
    // wins) and destroy a yet-unmigrated local token there — boot order must
    // not decide whether the migration works. An absent key keeps the
    // migration window open until a REAL value exists (a dashboard write, or a
    // non-empty local lifted up).
    /** @type {Record<string, unknown>} */
    const toWrite = { ...merged };
    if (!('gistToken' in rawObj) && !merged.gistToken) delete toWrite.gistToken;
    if (!('alarmClockNtfyToken' in rawObj) && !merged.alarmClockNtfyToken) {
      delete toWrite.alarmClockNtfyToken;
    }
    // Only write when the merge actually changed the cloud value (a fresh slot,
    // or a migrated-up token) — steady state must not spam onChanged.
    if (JSON.stringify(raw) !== JSON.stringify(toWrite)) {
      try {
        await chromeStore.set(SHARED_SETTINGS_KEY, toWrite);
      } catch {
        // Best-effort migration write: a failed chrome.storage write (quota,
        // shutdown) must not abort the hydration below or the onChanged
        // subscription — the next boot simply retries the write-up.
      }
    }
    applyToStore(merged);

    unsub = chromeStore.onChanged((changes) => {
      if (!(SHARED_SETTINGS_KEY in changes)) return;
      // Re-read the value rather than trust the change record's shape (the
      // wrapper forwards the raw StorageChange); same pattern as the dashboard's
      // alarmClock consumers.
      void chromeStore.get(SHARED_SETTINGS_KEY).then((next) => {
        applyToStore(mergeShared(next, pickShared(settingsStore.get())));
      });
    });
  })();
  return initPromise;
};

/** Teardown for tests. Idempotent. */
export const disposeSharedSettings = () => {
  initPromise = null;
  if (unsub) {
    unsub();
    unsub = null;
  }
};
