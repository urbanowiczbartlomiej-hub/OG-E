// @ts-check

// Watch-list store — the per-universe set of player ids the user has STARRED in
// the dashboard Targets sub-tab. The list of marked players the in-game "scan"
// FAB walks to send espionage probes.
//
// # Why chrome.storage (not localStorage / safeLS)
//
// This list is written from the dashboard (extension origin) and READ in-game
// (game origin) by the scan FAB. localStorage is per-origin, so it can't cross
// that boundary; chrome.storage.local is the one store both origins see —
// exactly the reason galaxyScanConfig / alarmClockConfig / targetReports live
// here. (M4 originally kept it in safeLS, which the in-game side can't read; the
// dashboard now migrates that data here on first load — see
// features/dashboard/index.js migrateWatchListFromLs.)
//
// LOCAL ONLY — never gist-synced: like targetReports / apiCache it's per-device
// intent, re-derivable by re-starring, so there's no `Ts` key and no merge.
//
// The store value is `{ players: string[], probes: number }` — the marked
// player ids plus the probe count the scan FAB pre-arms (the dashboard's
// "Probes" control writes it here so the in-game button uses the same number;
// it can't read the dashboard's localStorage). JSON-serialisable. The in-game
// FAB READS it via the reactive store; the dashboard composes the key for the
// selected universe and writes chrome.storage directly (its `location` is the
// extension origin, not a game universe, so it can't use the
// `currentUniverseKey` resolver — same pattern as targetReports).

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * @typedef {'enemy'|'friend'|'neutral'} Relationship
 *   How the user has tagged a watched player — drives the Spyglass map marker
 *   colour (enemy = red, friend = green, neutral = grey; own planets = white).
 *   Absent = neutral. Device-local intel, never synced.
 *
 * @typedef {object} WatchListConfig
 * @property {string[]} players   Watched player ids.
 * @property {number} probes      Espionage probes the scan FAB pre-arms per body.
 * @property {Record<string, number>} rescan
 *   Re-scan flags: player id (whole player) or "g:s:p" coord (one planet) →
 *   epoch-ms "treat any report older than this as needing a re-scan". Clears
 *   itself once a newer report lands. See `domain/spyScan.rescanAtFor`.
 * @property {Record<string, Relationship>} [relationships]
 *   Player id → user-assigned relationship tag (Spyglass map colour). Optional
 *   in the type (pre-relationships configs omit it) but `normalizeWatchList` +
 *   the store default always materialise it, so readers get `{}` not undefined.
 * @property {Record<string, true>} [mapHidden]
 *   Player id → hidden from the Spyglass positions map while STAYING watched
 *   (still in the table's scan scope + the FAB's scan walk) — the map-only
 *   mute the H5 player chips toggle with 👁. Same optional-but-materialised
 *   contract as `relationships`.
 */

/** Default probe count when none has been chosen yet. */
export const DEFAULT_SPY_PROBES = 20;

/**
 * Suffix of the per-universe chrome.storage.local key (full key:
 * `<universeId>:oge_watchedPlayers`). Exported so the dashboard can compose a
 * key for an arbitrary selected universe.
 */
export const WATCH_LIST_KEY_BASE = 'oge_watchedPlayers';

/**
 * Compose the full key for a universe id.
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string}
 */
export const watchListKeyFor = (universeId) => `${universeId}:${WATCH_LIST_KEY_BASE}`;

/**
 * Coerce any stored/legacy value into a complete {@link WatchListConfig}.
 * Tolerates the pre-reshape bare `string[]` (M4) and partial objects.
 * @param {unknown} raw
 * @returns {WatchListConfig}
 */
export const normalizeWatchList = (raw) => {
  if (Array.isArray(raw)) {
    return { players: raw.map(String), probes: DEFAULT_SPY_PROBES, rescan: {}, relationships: {}, mapHidden: {} };
  }
  const o = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const players = Array.isArray(o.players) ? o.players.map(String) : [];
  const probes = Number.isFinite(o.probes) && o.probes > 0 ? Math.round(o.probes) : DEFAULT_SPY_PROBES;
  /** @type {Record<string, number>} */
  const rescan = {};
  if (o.rescan && typeof o.rescan === 'object') {
    for (const k of Object.keys(o.rescan)) {
      const v = Number(o.rescan[k]);
      if (Number.isFinite(v) && v > 0) rescan[k] = v;
    }
  }
  /** @type {Record<string, Relationship>} */
  const relationships = {};
  if (o.relationships && typeof o.relationships === 'object') {
    for (const k of Object.keys(o.relationships)) {
      const v = o.relationships[k];
      if (v === 'enemy' || v === 'friend' || v === 'neutral') relationships[k] = v;
    }
  }
  /** @type {Record<string, true>} */
  const mapHidden = {};
  if (o.mapHidden && typeof o.mapHidden === 'object') {
    for (const k of Object.keys(o.mapHidden)) {
      if (o.mapHidden[k]) mapHidden[k] = true;
    }
  }
  return { players, probes, rescan, relationships, mapHidden };
};

const currentKey = () => currentUniverseKey(WATCH_LIST_KEY_BASE, watchListKeyFor);

/** @type {import('../lib/createStore.js').Store<WatchListConfig>} */
export const watchListStore = createStore(/** @type {WatchListConfig} */ ({
  players: [],
  probes: DEFAULT_SPY_PROBES,
  rescan: {},
  relationships: {},
  mapHidden: {},
}));

/** @type {(() => void) | null} */
let disposeFn = null;

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_watchedPlayers`, write through on change (200 ms debounce).
 * Idempotent. Called in-game from content.js so the scan FAB sees the dashboard's
 * starred players + probe count.
 * @returns {() => void}
 */
export const initWatchListStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: watchListStore,
    load: async () => {
      const raw = await chromeStore.get(currentKey());
      return raw == null ? null : normalizeWatchList(raw);
    },
    save: (value) => chromeStore.set(currentKey(), value),
    debounceMs: 200,
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent.
 * @returns {void}
 */
export const disposeWatchListStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};
