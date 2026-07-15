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

// ── colonyPassword localStorage backup ──────────────────────────────────
//
// The abandon password is DEVICE-LOCAL by policy (never gist-synced, never
// exported — domain/galaxyScanConfig sanitizer). Its authoritative copy rides
// this store's chrome.storage slot so the dashboard (extension origin) can
// edit it — but chrome.storage is WIPED by an extension remove+reinstall,
// which used to silently drop the password (while localStorage-backed
// settings like the gist/ntfy tokens survived). The user explicitly chose
// localStorage durability over page-readability isolation, so the game tab
// keeps a `{ pw, ts }` backup in game-origin localStorage (per-origin ⇒
// per-universe for free) and reconciles by NEWEST EDIT on every hydrate:
//
//   - backup newer (post-reinstall: chrome.storage slot rebuilt without a
//     password) → adopt the backup into the config; the persist echo writes
//     it back to chrome.storage, so the dashboard shows it again.
//   - config newer (dashboard edit — including a deliberate CLEAR, which
//     stamps `colonyPasswordTs` too) → refresh the backup, empty pw included:
//     the stamped clear is the tombstone that stops a stale backup from
//     resurrecting a removed password.
//
// Game-origin only in effect: the dashboard never inits this store, and on
// any origin without a stored backup the read degrades to null.

/** localStorage key of the `{ pw: string, ts: number }` password backup. */
const COLONY_PASSWORD_BACKUP_KEY = 'oge_colonyPasswordBackup';

/** @returns {{ pw: string, ts: number } | null} */
const readColonyPasswordBackup = () => {
  const raw = safeLS.json(COLONY_PASSWORD_BACKUP_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {{ pw?: unknown, ts?: unknown }} */ (raw);
  if (typeof r.pw !== 'string' || typeof r.ts !== 'number' || !(r.ts > 0)) return null;
  return { pw: r.pw, ts: r.ts };
};

/**
 * Bring the backup up to date with a (normalised) config carrying a newer
 * password stamp. No-op for configs whose stamp doesn't beat the stored one,
 * and for never-stamped configs (ts 0 — nothing to arbitrate with later).
 *
 * @param {GalaxyScanConfig} config
 * @returns {void}
 */
const writeColonyPasswordBackupFrom = (config) => {
  const ts = config.colonyPasswordTs || 0;
  if (ts <= 0) return;
  const cur = readColonyPasswordBackup();
  if (cur && cur.ts >= ts && cur.pw === config.colonyPassword) return;
  if (cur && cur.ts > ts) return;
  safeLS.setJSON(COLONY_PASSWORD_BACKUP_KEY, { pw: config.colonyPassword, ts });
};

/**
 * Reconcile a hydrated config (or `null` when chrome.storage holds nothing)
 * with the localStorage backup — newest `colonyPasswordTs` wins. Also the
 * one-time migration point: a pre-stamp config carrying a password gets
 * stamped `now` so the backup machinery has a clock to work with.
 *
 * @param {GalaxyScanConfig | null} config
 * @returns {GalaxyScanConfig | null}
 */
const reconcileColonyPasswordBackup = (config) => {
  if (config && config.colonyPassword && !config.colonyPasswordTs) {
    // Migration: password predates the edit clock. Stamp it now so it can
    // both win against an absent backup and lose to a genuinely newer one.
    config = { ...config, colonyPasswordTs: Date.now() };
  }
  const backup = readColonyPasswordBackup();
  const cfgTs = config?.colonyPasswordTs || 0;
  if (backup && backup.ts > cfgTs) {
    return {
      ...(config ?? defaultGalaxyScanConfig()),
      colonyPassword: backup.pw,
      colonyPasswordTs: backup.ts,
    };
  }
  if (config) writeColonyPasswordBackupFrom(config);
  return config;
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
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the store's hydrate phase has settled. Consumers that ACT on
 * `colonyPassword` / `colonyMinGap` at interaction time (the abandon FAB, the
 * colonize send gate) MUST await this before trusting the store: before the
 * async chrome.storage load lands, `galaxyScanConfigStore.get()` returns the
 * built-in default — empty password, 15 s min-gap — and a tap on a slow device
 * lands exactly in that window (the "Set password despite a set password" /
 * premature-wave race).
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
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: galaxyScanConfigStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      const config =
        raw !== null && raw !== undefined ? normalizeGalaxyScanConfig(raw) : null;
      // Newest-edit reconcile with the localStorage password backup — this is
      // what restores the password after an extension reinstall (chrome.storage
      // wiped, localStorage survived). A null config with a live backup returns
      // a default config carrying the backup password; the persist echo then
      // seeds chrome.storage with it, so the dashboard sees it again too.
      return reconcileColonyPasswordBackup(config);
    },
    save: (value) => {
      // Keep the backup current on every write-through (sync adoptions and
      // dashboard-driven store refreshes flow through here) — a stamped CLEAR
      // updates the backup too, which is exactly the tombstone we want.
      writeColonyPasswordBackupFrom(value);
      return chromeStore.set(currentKey(), value);
    },
    debounceMs: DEBOUNCE_MS,
    onHydrate: () => {
      resolveHydrated();
    },
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent. Resets
 * {@link whenGalaxyScanConfigHydrated} to the pre-resolved sentinel, matching
 * the "no init has run" state (same convention as `state/targets.js`).
 *
 * @returns {void}
 */
export const disposeGalaxyScanConfigStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
    resolveHydrated();
    hydratedPromise = Promise.resolve();
  }
};
