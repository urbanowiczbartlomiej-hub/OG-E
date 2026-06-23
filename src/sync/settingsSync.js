// @ts-check

// Helpers for syncing the user's Settings bag across devices (the gist
// payload's optional `settings` slice). Splits cleanly into PURE logic
// (pick / seed / stamp — unit-tested in Node, no I/O, `now` injected) and
// thin I/O wrappers for the per-key timestamp maps. The actual merge is
// `mergeSettings` in `./merge.js`; the orchestration that calls all of this
// lives in `./scheduler.js`.
//
// # Global vs universe-scoped settings
//
// Synced settings are split into two buckets:
//
//   - GLOBAL: UI / behaviour preferences that apply identically on every
//     OGame server (fabMode, readabilityBoost, …). Stored in the gist's
//     top-level `settings` field and in a localStorage timestamp map under
//     `SETTINGS_TS_KEY`. (The alarmClock knobs — wave enable/schedule, ad-hoc
//     lead time, templates — live in the per-universe `alarmClockConfig` slot.)
//
//   - UNIVERSE_SCOPED: game-logic parameters that are meaningful only on a
//     specific server (alarmClockNtfyToken, maxExpeditionsPerPlanet).
//     Stored in `settingsPerUniverse[universeId]` and in a per-universe
//     chrome.storage timestamp map under `<universeId>:oge_settingsTs`.
//
// The split is purely in the scheduler (how values are routed) — features
// continue reading from the flat `settingsStore` without any change.

import { safeLS, chromeStore } from '../lib/storage.js';
import { SETTINGS_SCHEMA } from '../state/settings.js';

/**
 * Settings keys that are deliberately PER-DEVICE and never synced:
 *   - `fabBtnSize`: the unified floating-button size, tuned to each
 *     screen (a phone and a desktop want different sizes).
 *   - `gistToken`: the sync credential itself — circular to sync (you need
 *     it to read the gist) and a security footgun to place inside a
 *     (private but unencrypted) gist.
 *
 * @type {Set<string>}
 */
export const EXCLUDED_SETTINGS = new Set(['fabBtnSize', 'gistToken']);

/**
 * Settings keys that are synced PER-UNIVERSE (one slot per server in the
 * gist's `settingsPerUniverse` map). These are game-logic parameters whose
 * correct value depends on which OGame server you're playing — the same
 * user's `alarmClockNtfyToken` or expedition cap may legitimately differ.
 *
 * Only keys NOT in this set (and not in {@link EXCLUDED_SETTINGS}) go into
 * the global `settings` slot.
 *
 * @type {Set<string>}
 */
export const UNIVERSE_SCOPED_SETTINGS = new Set([
  // colonyPassword / colonyMinGap / colonyMinFields and the fleet-save knobs
  // fsEnabled / fsThreshold / fsOffsets / fsMinFlightSec moved to the
  // per-universe galaxyScanConfig store (which syncs on its own slot); the
  // wave/ad-hoc knobs live in the per-universe alarmClockConfig slot.
  'maxExpeditionsPerPlanet',
  'alarmClockNtfyToken',
]);

/** localStorage key holding the global per-key last-change timestamp map (JSON). */
export const SETTINGS_TS_KEY = 'oge_settingsTs';

/** @param {string} key @returns {boolean} True if the key participates in sync (any scope). */
export const isSyncedSetting = (key) => !EXCLUDED_SETTINGS.has(key);

/** @param {string} key @returns {boolean} True if the key is per-universe (server-scoped). */
export const isUniverseScopedSetting = (key) => UNIVERSE_SCOPED_SETTINGS.has(key);

/**
 * Pick the synced subset of a Settings object, optionally filtered by scope.
 *
 * @param {Record<string, unknown>} settings
 * @param {'all' | 'global' | 'universe'} [scope]
 *   `'all'` (default) — all synced keys;
 *   `'global'` — only keys that are NOT universe-scoped;
 *   `'universe'` — only universe-scoped keys.
 * @returns {Record<string, unknown>}
 */
export const pickSyncedValues = (settings, scope = 'all') => {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(settings)) {
    if (!isSyncedSetting(key)) continue;
    const uni = isUniverseScopedSetting(key);
    if (scope === 'all' || (scope === 'universe' && uni) || (scope === 'global' && !uni)) {
      out[key] = settings[key];
    }
  }
  return out;
};

/** Each synced key → its schema default. Pre-computed once for seeding. */
const SYNCED_DEFAULTS = (() => {
  /** @type {Record<string, unknown>} */
  const d = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    if (isSyncedSetting(key)) {
      d[key] = /** @type {Record<string, { default: unknown }>} */ (SETTINGS_SCHEMA)[key].default;
    }
  }
  return d;
})();

/** Universe-scoped subset of {@link SYNCED_DEFAULTS}. Used by {@link seedUniverseTsIfAbsent}. */
const UNIVERSE_SYNCED_DEFAULTS = (() => {
  /** @type {Record<string, unknown>} */
  const d = {};
  for (const key of Object.keys(SYNCED_DEFAULTS)) {
    if (isUniverseScopedSetting(key)) d[key] = SYNCED_DEFAULTS[key];
  }
  return d;
})();

/**
 * Pure: build a fresh ts map that stamps `now` for every synced key whose
 * value DIFFERS from its schema default — i.e. the ones the user has
 * explicitly customised. Defaults stay unstamped (absent ⇒ treated as ts 0
 * by the merge), so a fresh device (all defaults) ADOPTS a configured
 * device's customisations on the first cross-device sync, while two
 * configured devices reconcile per key by recency. One-time seed: only
 * used when no ts map exists yet (see `seedSettingsTsIfAbsent`).
 *
 * @param {Record<string, unknown>} values  Synced settings values.
 * @param {number} now  Epoch ms to stamp customised keys with.
 * @param {Record<string, unknown>} [defaults]  Override for tests.
 * @returns {Record<string, number>}
 */
export const seedTsMap = (values, now, defaults = SYNCED_DEFAULTS) => {
  /** @type {Record<string, number>} */
  const ts = {};
  for (const key of Object.keys(values)) {
    if (isSyncedSetting(key) && values[key] !== defaults[key]) ts[key] = now;
  }
  return ts;
};

/**
 * Pure: stamp `now` on every synced key that changed between `prev` and
 * `next`. Returns a NEW ts map (the old one spread, never mutated) and
 * whether anything changed (so the caller can skip a redundant write).
 *
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} next
 * @param {Record<string, number>} tsMap
 * @param {number} now
 * @returns {{ ts: Record<string, number>, changed: boolean }}
 */
export const stampChanged = (prev, next, tsMap, now) => {
  /** @type {Record<string, number>} */
  const ts = { ...tsMap };
  let changed = false;
  for (const key of Object.keys(next)) {
    if (isSyncedSetting(key) && prev[key] !== next[key]) {
      ts[key] = now;
      changed = true;
    }
  }
  return { ts, changed };
};

// ── localStorage wrappers (I/O) ──────────────────────────────────────

/**
 * Read the per-key timestamp map. Returns `{}` when absent / unparseable.
 *
 * @returns {Record<string, number>}
 */
export const readTsMap = () => {
  const raw = safeLS.get(SETTINGS_TS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

/** @param {Record<string, number>} map @returns {void} */
export const writeTsMap = (map) => safeLS.set(SETTINGS_TS_KEY, JSON.stringify(map));

/**
 * One-time seed for the GLOBAL timestamp map: if no map exists yet, stamp
 * the user's currently-customised global settings with `now` (see
 * {@link seedTsMap}). No-op once a map is present. Returns true iff seeded.
 *
 * Only global (non-universe-scoped) keys are seeded here. Universe-scoped
 * keys are handled by {@link seedUniverseTsIfAbsent}.
 *
 * @param {Record<string, unknown>} settings  Full current Settings object.
 * @param {number} now
 * @returns {boolean}
 */
export const seedSettingsTsIfAbsent = (settings, now) => {
  if (safeLS.get(SETTINGS_TS_KEY) !== null) return false;
  writeTsMap(seedTsMap(pickSyncedValues(settings, 'global'), now));
  return true;
};

// ── Per-universe chrome.storage wrappers ────────────────────────────

/**
 * chrome.storage key for the per-universe settings timestamp map.
 * Pattern mirrors `dailyRunRoutesTsKeyFor` in `state/dailyRunRoutes.js`.
 *
 * @param {string} universeId
 * @returns {string}
 */
export const universeSettingsTsKeyFor = (universeId) =>
  `${universeId}:oge_settingsTs`;

/**
 * Read the per-universe settings timestamp map from chrome.storage.
 * Returns `{}` when absent or unparseable.
 *
 * @param {string} universeId
 * @returns {Promise<Record<string, number>>}
 */
export const readUniverseTsMap = async (universeId) => {
  const raw = await chromeStore.get(universeSettingsTsKeyFor(universeId));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return /** @type {Record<string, number>} */ (raw);
};

/**
 * Write the per-universe settings timestamp map to chrome.storage.
 *
 * @param {string} universeId
 * @param {Record<string, number>} map
 * @returns {Promise<void>}
 */
export const writeUniverseTsMap = async (universeId, map) => {
  await chromeStore.set(universeSettingsTsKeyFor(universeId), map);
};

/**
 * One-time seed for a universe's timestamp map: if no map exists yet in
 * chrome.storage, stamp the user's currently-customised universe-scoped
 * settings with `now` and return the seeded map. Returns `null` when a map
 * already exists (no-op). The scheduler uses the returned map to initialise
 * {@link localUniverseTsMap} on first boot so the seed is immediately
 * effective without a second chromeStore round-trip.
 *
 * @param {string} universeId
 * @param {Record<string, unknown>} settings  Full current Settings object.
 * @param {number} now
 * @returns {Promise<Record<string, number> | null>}
 */
export const seedUniverseTsIfAbsent = async (universeId, settings, now) => {
  const existing = await chromeStore.get(universeSettingsTsKeyFor(universeId));
  if (existing !== null && existing !== undefined) return null;
  const ts = seedTsMap(
    pickSyncedValues(settings, 'universe'),
    now,
    UNIVERSE_SYNCED_DEFAULTS,
  );
  await writeUniverseTsMap(universeId, ts);
  return ts;
};
