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
// GIST-SYNCED since 1.40 (SPYGLASS-SYNC-PLAN): the workbench DECISIONS —
// players, relationships, scanMode, galaxyMode, mapHidden, scanBodies,
// cadence — follow the user across devices via the `watchListPerUniverse`
// sync slot. `probes` (per-device FAB convenience) and `rescan` (transient,
// self-clears against the per-device targetReports) stay local. Per-key
// last-write-wins timestamps live in a sidecar ledger key
// (`<uni>:oge_watchListTs`, the settings `oge_settingsTs` precedent) so this
// store's value keeps the exact shape every reader already knows. ALL config
// writes must go through {@link writeWatchListConfig} (it stamps the ledger);
// the pure merge/stamp logic is domain/watchListMerge.js.
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
import {
  WATCH_FAMILIES,
  decomposeWatchSlot,
  seedWatchListLedger,
  stampWatchListDiff,
} from '../domain/watchListMerge.js';

/**
 * @typedef {'enemy'|'friend'|'neutral'} Relationship
 *   How the user has tagged a watched player — drives the Spyglass map marker
 *   colour (enemy = red, friend = green, neutral = grey; own planets = white).
 *   Absent = neutral. Synced across devices (a workbench decision).
 *
 * @typedef {'planets'|'moons'|'both'} ScanBodies
 *   Which body types the scan FAB / plan proposes: planets only (default),
 *   moons only, or both. Shared with the in-game FAB like the rest of this
 *   config; synced across devices (a strategy knob, like `cadence`).
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
 * @property {number} rescanHours Probe staleness for every watched body (the
 *   old hot/warm/cold danger tiers collapsed into this one hour-scale knob).
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
 *   lives in domain/scanMode.effectiveScan (player-'off' dominates, else body
 *   override, else 'on'). Galaxy activity is NOT in this map. Same
 *   optional-but-materialised contract as `relationships`.
 * @property {Record<string, ScanMode>} [galaxyMode]
 *   Per-player galaxy-watch toggle (player-id keys only): 'off' mutes the
 *   galaxy-LOOK plan for that player (the dossier's "Watch via → galaxy"
 *   button). Passive sighting RECORDING stays always-on. Absent key = 'on'.
 *   Same optional-but-materialised contract as `relationships`.
 * @property {Cadence} [cadence]
 *   Re-scan cadences (see {@link Cadence}); materialised with
 *   {@link DEFAULT_CADENCE}.
 * @property {MoonStrikeMode} [moonStrike]
 *   Moon-strike aggressiveness (domain/fleetLanding ladder — off/lone/
 *   newest/any): how much corroboration the scan plan demands before
 *   flagging a moon as a parked-fleet candidate. Synced (a strategy knob,
 *   like `cadence`); materialised with {@link DEFAULT_MOON_STRIKE}.
 * @property {number} [patrolSystems]
 *   Patrol territory radius (domain/patrol): ±N systems around every own
 *   body whose neighbourhood the Look plan walks and the moon-strike
 *   detector hunts. 0 = patrol off (the default). Synced (a strategy knob);
 *   clamped to 0..{@link import('../domain/patrol.js').PATROL_SYSTEMS_MAX}.
 */

/** @typedef {import('../domain/fleetLanding.js').MoonStrikeMode} MoonStrikeMode */

/** Default probe count when none has been chosen yet. */
export const DEFAULT_SPY_PROBES = 20;

/**
 * Default moon-strike mode: 'newest' — flags a moon holding the account's
 * newest interaction (including the afterglow case) while staying out of the
 * owner-may-be-online territory ('any' is a deliberate opt-in).
 * @type {MoonStrikeMode}
 */
export const DEFAULT_MOON_STRIKE = 'newest';

/**
 * Coerce a raw value into a valid {@link MoonStrikeMode} (else the default).
 * @param {unknown} v
 * @returns {MoonStrikeMode}
 */
const moonStrikeField = (v) =>
  (v === 'off' || v === 'lone' || v === 'newest' || v === 'any' ? v : DEFAULT_MOON_STRIKE);

/** Default patrol radius: 0 — the territory mode is a deliberate opt-in. */
export const DEFAULT_PATROL_SYSTEMS = 0;

/**
 * Coerce a raw value into a valid patrol radius (integer, clamped; else the
 * default). The max mirrors domain/patrol.PATROL_SYSTEMS_MAX (kept as a
 * literal here so state's normalize pulls no extra import).
 * @param {unknown} v
 * @returns {number}
 */
const patrolField = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(50, n) : DEFAULT_PATROL_SYSTEMS;
};

/**
 * Default cadences: probe re-scan after 48 h (the old hot tier — the tightest
 * of the retired hot/warm/cold trio) + a daily galaxy look.
 * @type {Cadence}
 */
export const DEFAULT_CADENCE = Object.freeze({
  rescanHours: 48, galaxyHours: 24,
});

/** Probe re-scan clamps (hours): 1 h .. 60 days (the old day-field ceiling). */
export const RESCAN_HOURS_MIN = 1;
export const RESCAN_HOURS_MAX = 24 * 60;
/** Galaxy hours floor: 1 h — the ring's own resolution (the quiet throttle /
 * same-interaction dedup lag), so anything shorter couldn't observe more. */
export const CADENCE_HOURS_MIN = 1;
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
 * fall back to {@link DEFAULT_CADENCE}). A legacy tiered config (pre-collapse
 * `hotDays`/`warmDays`/`coldDays`) migrates via its `hotDays` — the tightest
 * tier, so no target gets scanned LESS often than the user had asked for.
 * Exported for the dashboard inputs.
 * @param {unknown} raw
 * @returns {Cadence}
 */
export const normalizeCadence = (raw) => {
  const o = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const legacyHours = Number.isFinite(Number(o.hotDays)) ? Number(o.hotDays) * 24 : NaN;
  return {
    rescanHours: cadenceField(
      Number.isFinite(Number(o.rescanHours)) ? o.rescanHours : legacyHours,
      RESCAN_HOURS_MIN, RESCAN_HOURS_MAX, DEFAULT_CADENCE.rescanHours,
    ),
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
      players: raw.map(String), probes: DEFAULT_SPY_PROBES, scanBodies: 'planets', rescan: {}, relationships: {}, mapHidden: {}, scanMode: {}, galaxyMode: {}, cadence: { ...DEFAULT_CADENCE }, moonStrike: DEFAULT_MOON_STRIKE, patrolSystems: DEFAULT_PATROL_SYSTEMS,
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
  /** @type {Record<string, ScanMode>} */
  const galaxyMode = {};
  if (o.galaxyMode && typeof o.galaxyMode === 'object') {
    for (const k of Object.keys(o.galaxyMode)) {
      const v = o.galaxyMode[k];
      if (v === 'on' || v === 'off') galaxyMode[k] = v;
    }
  }
  const cadence = normalizeCadence(o.cadence);
  const moonStrike = moonStrikeField(o.moonStrike);
  const patrolSystems = patrolField(o.patrolSystems);
  return {
    players, probes, scanBodies, rescan, relationships, mapHidden, scanMode, galaxyMode, cadence, moonStrike, patrolSystems,
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
  galaxyMode: {},
  cadence: { ...DEFAULT_CADENCE },
  moonStrike: DEFAULT_MOON_STRIKE,
  patrolSystems: DEFAULT_PATROL_SYSTEMS,
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

// ── Sync ts-ledger (per-key LWW stamps + tombstones) ────────────────────────
//
// The sidecar `<uni>:oge_watchListTs` key mirrors the settings `oge_settingsTs`
// pattern: the config value above keeps its reader-friendly shape, and this
// ledger records WHEN each synced key last changed. A ledger stamp whose key
// is absent from the config is the record of a removal (tombstone) — that is
// what lets an un-star propagate across devices instead of being resurrected
// by a union. See domain/watchListMerge.js for the model and the merge.

/**
 * Suffix of the per-universe ts-ledger key (full key:
 * `<universeId>:oge_watchListTs`). The `Ts` suffix classifies it as sync
 * plumbing for the dashboard inventory (syncInventory.isPlumbingBase).
 */
export const WATCH_LIST_TS_KEY_BASE = 'oge_watchListTs';

/**
 * Compose the full ts-ledger key for a universe id.
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string}
 */
export const watchListTsKeyFor = (universeId) => `${universeId}:${WATCH_LIST_TS_KEY_BASE}`;

/**
 * Coerce any stored/legacy value into a complete ledger (every family
 * present, non-finite stamps dropped).
 *
 * @param {unknown} raw
 * @returns {import('../domain/watchListMerge.js').WatchListLedger}
 */
export const normalizeWatchListLedger = (raw) => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  /** @type {import('../domain/watchListMerge.js').WatchListLedger} */
  const out = {};
  for (const fam of WATCH_FAMILIES) {
    out[fam] = {};
    const m = o[fam];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      for (const [k, v] of Object.entries(m)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) out[fam][k] = n;
      }
    }
  }
  return out;
};

/**
 * Read one universe's config + ts ledger from chrome.storage (the
 * cross-origin source of truth — the dashboard and the game tab both edit
 * through it, so neither trusts an in-memory store here).
 *
 * @param {string} universeId
 * @returns {Promise<{ cfg: WatchListConfig, ledger: import('../domain/watchListMerge.js').WatchListLedger }>}
 */
export const readWatchListSlot = async (universeId) => {
  const [rawCfg, rawLedger] = await Promise.all([
    chromeStore.get(watchListKeyFor(universeId)),
    chromeStore.get(watchListTsKeyFor(universeId)),
  ]);
  return { cfg: normalizeWatchList(rawCfg), ledger: normalizeWatchListLedger(rawLedger) };
};

/**
 * First-sync safety (SPYGLASS-SYNC-PLAN invariant 2): make sure every LIVE
 * key of the stored config carries a stamp, persisting the seeded ledger so
 * the stamps are STABLE (re-seeding a fresh `now` on every read would make
 * the composed slot differ each round and defeat the no-op-PATCH guard).
 * Never creates tombstones (C6 invariant 1 — seeding is not a user action).
 * Idempotent after the first call.
 *
 * @param {string} universeId
 * @param {number} [now]
 * @returns {Promise<{ cfg: WatchListConfig, ledger: import('../domain/watchListMerge.js').WatchListLedger }>}
 */
export const ensureWatchListLedgerSeeded = async (universeId, now = Date.now()) => {
  const { cfg, ledger } = await readWatchListSlot(universeId);
  const seeded = seedWatchListLedger(cfg, ledger, now, SEED_DEFAULTS);
  if (seeded.changed) await chromeStore.set(watchListTsKeyFor(universeId), seeded.ledger);
  return { cfg, ledger: seeded.ledger };
};

/**
 * The materialised single-family defaults `seedWatchListLedger` compares
 * against — a default-valued `scanBodies`/`cadence`/`moonStrike` carries no
 * user intent and must NOT get a protective stamp (it would win LWW over
 * another device's earlier-seeded TUNED value). See the domain fn's doc.
 */
const SEED_DEFAULTS = Object.freeze({
  scanBodies: 'planets',
  cadence: DEFAULT_CADENCE,
  moonStrike: DEFAULT_MOON_STRIKE,
  patrol: DEFAULT_PATROL_SYSTEMS,
});

/**
 * Adopt a MERGED sync slot (gist download or JSON import) into one universe's
 * stored config + ledger: decompose the per-key `{ v?, ts }` families back
 * into config fields, overlay them onto the CURRENT stored config so the
 * local-only fields (`probes`, `rescan`) survive, and persist both keys with
 * the slot's OWN stamps (never re-stamped `now` — a remote/imported ts must
 * be kept or this device would win LWW races it didn't earn). Config first,
 * ledger second — same crash-ordering argument as {@link writeWatchListConfig}.
 *
 * Callers: the sync scheduler's `writeLocal` (which additionally refreshes
 * the in-memory store under its anti-loop suppressor) and the dashboard's
 * JSON import.
 *
 * @param {string} universeId
 * @param {import('../domain/watchListMerge.js').WatchListSyncSlot} slot
 * @returns {Promise<WatchListConfig>} The written config.
 */
export const applyWatchListSyncSlot = async (universeId, slot) => {
  const cur = normalizeWatchList(await chromeStore.get(watchListKeyFor(universeId)));
  const { cfg, ledger } = decomposeWatchSlot(slot);
  const next = normalizeWatchList({ ...cur, ...cfg });
  await chromeStore.set(watchListKeyFor(universeId), next);
  await chromeStore.set(watchListTsKeyFor(universeId), ledger);
  return next;
};

/**
 * Serialises {@link writeWatchListConfig} calls: the dashboard fires them on
 * every star/toggle click, and two overlapping read-modify-write rounds could
 * otherwise interleave their prev-reads and drop a stamp.
 * @type {Promise<void>}
 */
let writeChain = Promise.resolve();

/**
 * THE write path for user edits of the watch-list config (the dashboard's
 * save funnel). Read-modify-write: diffs the incoming config against the
 * stored one and stamps every changed/removed synced key in the ts ledger —
 * this is the only place removal tombstones are born, which is exactly the
 * C6 invariant ("a tombstone records a user action, never a migration").
 *
 * Write order is deliberate: config FIRST, ledger second. A crash between
 * the two leaves a fresh value with a stale stamp — under-defended in the
 * next merge, recoverable by re-editing — never a stale value with a fresh
 * stamp, which would WIN merges it shouldn't and propagate the stale value
 * to other devices.
 *
 * @param {string} universeId
 * @param {unknown} nextCfgRaw  The full next config (normalised here).
 * @param {number} [now]
 * @returns {Promise<void>} Settles when both keys are persisted.
 */
export const writeWatchListConfig = (universeId, nextCfgRaw, now = Date.now()) => {
  const run = async () => {
    const next = normalizeWatchList(nextCfgRaw);
    const { cfg: prev, ledger } = await readWatchListSlot(universeId);
    const seeded = seedWatchListLedger(prev, ledger, now, SEED_DEFAULTS);
    const stamped = stampWatchListDiff(prev, next, seeded.ledger, now);
    await chromeStore.set(watchListKeyFor(universeId), next);
    if (seeded.changed || stamped.changed) {
      await chromeStore.set(watchListTsKeyFor(universeId), stamped.ledger);
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
};
