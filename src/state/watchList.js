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
import { pruneRescan } from '../domain/spyScan.js';

/**
 * @typedef {'enemy'|'friend'|'neutral'} Relationship
 *   How the user has tagged a watched player — drives the Spyglass map marker
 *   colour (enemy = red, friend = green, neutral = grey; own planets = white).
 *   Absent = neutral. Device-local intel, never synced.
 *
 * @typedef {'planets'|'moons'|'both'} ScanBodies
 *   Which body types the scan FAB / plan proposes: planets only (default),
 *   moons only, or both. Device-local, shared with the in-game FAB like the
 *   rest of this config.
 *
 * @typedef {import('../domain/scanMode.js').ScanMode} ScanMode
 *   Whether a body is PROBE-scanned: 'on' (default) / 'off'. Union + resolution
 *   live in the domain floor (domain/scanMode.js). Galaxy activity observation
 *   is ALWAYS on for every watched body (passive/undetectable — nothing to
 *   gate); scan-'off' just means "don't reveal me with probes".
 *
 * @typedef {object} Cadence
 *   Re-scan cadences, edited in the dashboard Spyglass config row. Read
 *   IN-TAB for ranking/display only (fair-play persistence invariant: no
 *   background path ever acts on these).
 * @property {number} hotDays     Probe staleness for hot targets (D≥60).
 * @property {number} warmDays    Probe staleness for warm targets (D≥30).
 * @property {number} coldDays    Probe staleness for everyone else.
 * @property {number} galaxyHours Galaxy-sighting (activity-coverage) staleness.
 *
 * @typedef {object} WatchListConfig
 * @property {string[]} players   Watched player ids.
 * @property {number} probes      Espionage probes the scan FAB pre-arms per body.
 * @property {ScanBodies} [scanBodies]  Planet/moon scan filter (default 'planets').
 *   Optional in the type (pre-scanBodies configs omit it) but `normalizeWatchList`
 *   + the store default always materialise it.
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
 * @property {Record<string, ScanMode>} [scanMode]
 *   Scan-mode map: player id (whole-player default) or bodyKey "g:s:p" /
 *   "g:s:p:3" (per-body override) → 'on'|'off'. Absent key = 'on'. Resolution
 *   lives in domain/scanMode.effectiveScan (body ?? player ?? 'on'). Galaxy
 *   activity is NOT in this map — it's always on. Same optional-but-materialised
 *   contract as `relationships`.
 * @property {Cadence} [cadence]
 *   Re-scan cadences (see {@link Cadence}); materialised with
 *   {@link DEFAULT_CADENCE} — the pre-cadence hardcoded thresholds.
 */

/** Default probe count when none has been chosen yet. */
export const DEFAULT_SPY_PROBES = 20;

/**
 * Default cadences = the thresholds that were hardcoded before cadence became
 * configurable (domain/scanPriority's HOT/WARM/default tiers + a daily galaxy
 * look), so an untouched config behaves exactly as it always did.
 * @type {Cadence}
 */
export const DEFAULT_CADENCE = Object.freeze({
  hotDays: 2, warmDays: 4, coldDays: 7, galaxyHours: 24,
});

/** Cadence input clamps — day fields and the hour field respectively. */
export const CADENCE_DAYS_MIN = 0.5;
export const CADENCE_DAYS_MAX = 60;
/** Galaxy hours floor: sighting freshness has ~1 h ring resolution (the quiet
 * throttle / same-interaction dedup lag), so sub-2 h cadences would just churn. */
export const CADENCE_HOURS_MIN = 2;
export const CADENCE_HOURS_MAX = 24 * 14;

/**
 * Coerce one cadence field: finite + clamped, else the default.
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {number} dflt
 * @returns {number}
 */
const cadenceField = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};

/**
 * Coerce any raw value into a complete {@link Cadence} (missing/invalid fields
 * fall back to {@link DEFAULT_CADENCE}). Exported for the dashboard inputs.
 * @param {unknown} raw
 * @returns {Cadence}
 */
export const normalizeCadence = (raw) => {
  const o = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  return {
    hotDays: cadenceField(o.hotDays, CADENCE_DAYS_MIN, CADENCE_DAYS_MAX, DEFAULT_CADENCE.hotDays),
    warmDays: cadenceField(o.warmDays, CADENCE_DAYS_MIN, CADENCE_DAYS_MAX, DEFAULT_CADENCE.warmDays),
    coldDays: cadenceField(o.coldDays, CADENCE_DAYS_MIN, CADENCE_DAYS_MAX, DEFAULT_CADENCE.coldDays),
    galaxyHours: cadenceField(o.galaxyHours, CADENCE_HOURS_MIN, CADENCE_HOURS_MAX, DEFAULT_CADENCE.galaxyHours),
  };
};

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
    return {
      players: raw.map(String), probes: DEFAULT_SPY_PROBES, scanBodies: 'planets', rescan: {}, relationships: {}, mapHidden: {}, scanMode: {}, cadence: { ...DEFAULT_CADENCE },
    };
  }
  const o = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const players = Array.isArray(o.players) ? o.players.map(String) : [];
  const probes = Number.isFinite(o.probes) && o.probes > 0 ? Math.round(o.probes) : DEFAULT_SPY_PROBES;
  /** @type {ScanBodies} */
  const scanBodies = (o.scanBodies === 'moons' || o.scanBodies === 'both') ? o.scanBodies : 'planets';
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
  /** @type {Record<string, ScanMode>} */
  const scanMode = {};
  if (o.scanMode && typeof o.scanMode === 'object') {
    for (const k of Object.keys(o.scanMode)) {
      const v = o.scanMode[k];
      // 'on' entries are stored too (an explicit body override back to on under
      // an 'off' player default is meaningful).
      if (v === 'on' || v === 'off') scanMode[k] = v;
    }
  } else if (o.watchMode && typeof o.watchMode === 'object') {
    // One-time migration from the old tri-state watchMode: galaxy activity is
    // now always on, so the only thing to carry over is "was probing off here".
    // 'galaxy' (galaxy-only, no probe) and 'off' → scan 'off'; 'probe' → 'on'.
    for (const k of Object.keys(o.watchMode)) {
      const v = o.watchMode[k];
      if (v === 'galaxy' || v === 'off') scanMode[k] = 'off';
      else if (v === 'probe') scanMode[k] = 'on';
    }
  }
  const cadence = normalizeCadence(o.cadence);
  return {
    players, probes, scanBodies, rescan, relationships, mapHidden, scanMode, cadence,
  };
};

const currentKey = () => currentUniverseKey(WATCH_LIST_KEY_BASE, watchListKeyFor);

/** @type {import('../lib/createStore.js').Store<WatchListConfig>} */
export const watchListStore = createStore(/** @type {WatchListConfig} */ ({
  players: [],
  probes: DEFAULT_SPY_PROBES,
  scanBodies: 'planets',
  rescan: {},
  relationships: {},
  mapHidden: {},
  scanMode: {},
  cadence: { ...DEFAULT_CADENCE },
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
      if (raw == null) return null;
      const cfg = normalizeWatchList(raw);
      // Hydrate-time hygiene (§6.7): drop rescan marks old enough to be
      // redundant (any report they'd flag is already stale) — the map was
      // previously append-only and never cleaned. Persists on the next write.
      cfg.rescan = pruneRescan(cfg.rescan, Date.now());
      return cfg;
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
