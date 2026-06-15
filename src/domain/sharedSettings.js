// @ts-check

// Pure shape + defaults + normalisation for OG-E's "shared settings" — the
// subset of preferences that need to be EDITED FROM THE DASHBOARD (extension
// origin) as well as read in-game (game origin).
//
// # Why these can't stay in the localStorage settingsStore
//
// `state/settings.js` persists every preference to localStorage, which is
// per-origin: the game tab and the dashboard extension page see DIFFERENT
// localStorage. For an option the dashboard must edit, the only backing both
// origins share is `chrome.storage.local` — the exact reason
// `state/galaxyScanConfig.js` and `state/dailyRunRoutes.js` already live there.
//
// This module is pure (no DOM / storage / chrome.*): the schema, the defaults,
// and a normaliser that fills a partial blob to a complete object.
// Persistence lives in `state/sharedSettings.js`.
//
// Field names mirror the corresponding `state/settings.js` Settings fields
// 1:1, so an in-game consumer reads the same property name no matter which
// store now owns it. (No localStorage→chrome.storage migration: OG-E has a
// single user today, so on first run after the move these reset to defaults
// and get re-set once from the dashboard — not worth the migration code.)

/**
 * The dashboard-editable preferences (global, not per-universe). Property
 * names match the `Settings` typedef in `state/settings.js`.
 *
 * @typedef {object} SharedSettings
 * @property {number}  colonyMinGap      seconds between colonize arrivals
 * @property {number}  colonyMinFields   abandon threshold (fields)
 * @property {string}  colonyPassword    autofill value for the abandon form
 * @property {boolean} reminderEnabled   auto-schedule expedition-wave pushes
 * @property {string}  reminderSchedule  wave cadence (minutes-first offsets)
 * @property {number}  adhocOffsetSec    lead time for ad-hoc reminders (sec)
 * @property {boolean} fsEnabled         auto-detect fleet-saves in the event list
 * @property {number}  fsThreshold       min ships for a leg to count as a fleet-save
 * @property {string}  fsOffsets         fleet-save reminder offsets (minutes-first)
 * @property {number}  fsMinFlightSec    min flight time (sec) for a fleet-save leg
 */

/**
 * One schema row: storage type and default value.
 *
 * @typedef {object} SharedSettingSchema
 * @property {'bool' | 'int' | 'string'} type
 * @property {boolean | number | string} default
 */

/**
 * Single source of truth for the shared-settings fields. The defaults are
 * kept identical to the matching rows of
 * `state/settings.js:SETTINGS_SCHEMA` (those rows are removed once every
 * consumer reads from this store — see REFRESH-PLAN.md, step B4).
 *
 * @type {Record<keyof SharedSettings, SharedSettingSchema>}
 */
export const SHARED_SETTINGS_SCHEMA = {
  colonyMinGap:     { type: 'int',    default: 15 },
  colonyMinFields:  { type: 'int',    default: 320 },
  colonyPassword:   { type: 'string', default: '' },
  reminderEnabled:  { type: 'bool',   default: false },
  reminderSchedule: { type: 'string', default: '0m, 10m, 30m, 60m' },
  adhocOffsetSec:   { type: 'int',    default: 60 },
  fsEnabled:        { type: 'bool',   default: false },
  fsThreshold:      { type: 'int',    default: 100000 },
  fsOffsets:        { type: 'string', default: '-10m, 0m, 10m' },
  fsMinFlightSec:   { type: 'int',    default: 600 },
};

/**
 * Coerce a raw stored/legacy value to the schema-declared type, falling back
 * to `def` when absent or unparseable. Mirrors `safeLS`' lossy semantics so a
 * value round-trips identically whether it came from localStorage (always a
 * string) or a chrome.storage blob (already typed).
 *
 * @param {'bool' | 'int' | 'string'} type
 * @param {unknown} value
 * @param {boolean | number | string} def
 * @returns {boolean | number | string}
 */
const coerce = (type, value, def) => {
  if (value === undefined || value === null) return def;
  if (type === 'bool') {
    return typeof value === 'boolean' ? value : String(value) === 'true';
  }
  if (type === 'int') {
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isFinite(n) ? n : def;
  }
  return String(value);
};

/**
 * A complete {@link SharedSettings} object at the built-in defaults.
 *
 * @returns {SharedSettings}
 */
export const defaultSharedSettings = () => {
  /** @type {Record<string, boolean | number | string>} */
  const out = {};
  for (const [field, schema] of Object.entries(SHARED_SETTINGS_SCHEMA)) {
    out[field] = schema.default;
  }
  return /** @type {SharedSettings} */ (out);
};

/**
 * Fill a partial / legacy / garbage blob into a complete, type-correct
 * {@link SharedSettings}. Unknown extra keys are dropped; missing keys fall
 * back to their default.
 *
 * @param {unknown} raw
 * @returns {SharedSettings}
 */
export const normalizeSharedSettings = (raw) => {
  const src = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === 'object' ? raw : {}
  );
  /** @type {Record<string, boolean | number | string>} */
  const out = {};
  for (const [field, schema] of Object.entries(SHARED_SETTINGS_SCHEMA)) {
    out[field] = coerce(schema.type, src[field], schema.default);
  }
  return /** @type {SharedSettings} */ (out);
};
