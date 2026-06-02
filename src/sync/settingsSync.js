// @ts-check

// Helpers for syncing the user's Settings bag across devices (the gist
// payload's optional `settings` slice). Splits cleanly into PURE logic
// (pick / seed / stamp — unit-tested in Node, no I/O, `now` injected) and
// two thin localStorage wrappers for the per-key timestamp map. The actual
// merge is `mergeSettings` in `./merge.js`; the orchestration that calls
// all of this lives in `./scheduler.js`.

import { safeLS } from '../lib/storage.js';
import { SETTINGS_SCHEMA } from '../state/settings.js';

/**
 * Settings keys that are deliberately PER-DEVICE and never synced:
 *   - `enterBtnSize` / `colBtnSize`: the floating-button sizes, tuned to
 *     each screen (a phone and a desktop want different sizes).
 *   - `gistToken`: the sync credential itself — circular to sync (you need
 *     it to read the gist) and a security footgun to place inside a
 *     (private but unencrypted) gist.
 *
 * @type {Set<string>}
 */
export const EXCLUDED_SETTINGS = new Set(['enterBtnSize', 'colBtnSize', 'gistToken']);

/** localStorage key holding the per-key last-change timestamp map (JSON). */
export const SETTINGS_TS_KEY = 'oge_settingsTs';

/** @param {string} key @returns {boolean} True if the key participates in sync. */
export const isSyncedSetting = (key) => !EXCLUDED_SETTINGS.has(key);

/**
 * Pick the synced (non-excluded) subset of a Settings object. Pure.
 *
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export const pickSyncedValues = (settings) => {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(settings)) {
    if (isSyncedSetting(key)) out[key] = settings[key];
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
 * One-time seed: if no ts map exists yet, stamp the user's currently-
 * customised settings with `now` (see {@link seedTsMap}). No-op once a map
 * is present. Returns true iff it seeded.
 *
 * @param {Record<string, unknown>} settings  Full current Settings object.
 * @param {number} now
 * @returns {boolean}
 */
export const seedSettingsTsIfAbsent = (settings, now) => {
  if (safeLS.get(SETTINGS_TS_KEY) !== null) return false;
  writeTsMap(seedTsMap(pickSyncedValues(settings), now));
  return true;
};
