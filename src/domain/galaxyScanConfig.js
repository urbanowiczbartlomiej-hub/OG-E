// @ts-check

// Galaxy-Scan configuration — the user-tunable strategy that drives the
// Scan button and the dashboard's stale/free-region views.
//
// It is ALSO the per-universe home for the colonize/abandon knobs (B2) and
// the fleet-save reminder knobs (`fs*`): those are all server-scoped
// settings edited from the dashboard, so folding them into this one
// per-universe `chrome.storage` slot lets them ride its whole-slot
// newest-wins gist sync for free. The fields are otherwise unrelated to
// scanning; they share the store, not the concept.
//
// # Why this is its own domain module (and its own store)
//
// Historically the "which positions" knobs lived in `settingsStore`
// (localStorage, edited from the AGR settings panel) and the rescan
// thresholds were a frozen constant (`domain/scheduling.RESCAN_AFTER`).
// This module unifies them into ONE plain-data config that is:
//
//   - edited from the dashboard (extension origin) — so it must be backed
//     by `chrome.storage`, the only store both origins see (see
//     `state/galaxyScanConfig.js`, modelled on `state/dailyRunRoutes.js`);
//   - synced per-universe via the gist pipeline (whole-slot newest-wins);
//   - read in-game by `features/sendColony` and on the dashboard by the
//     galaxy renderer.
//
// Everything here is PURE: no DOM, no storage, no clock. The shape, its
// defaults, the durable-text duration grammar, and the
// {@link RescanPolicy} projection consumed by `isSystemStale` all live
// here so they are unit-testable in Node and shared verbatim across the
// game/dashboard origins.
//
// # Rescan durations are stored in SECONDS, 0 = "never rescan"
//
// Seconds keep the on-disk value human-readable in DevTools and match the
// grammar `domain/duration.js` already speaks. A field of 0 means the
// status never triggers a rescan (the same effect as a status being absent
// from the legacy `RESCAN_AFTER` map). `abandoned` is special: its timing
// is the dynamic 3 AM-sweep deadline, not a flat age, so it is a boolean
// on/off (`abandonedEnabled`) rather than a duration.

import { parseDuration } from './duration.js';
import {
  defaultReminderGlobalConfig,
  normalizeReminderGlobalConfig,
} from './reminderGlobalConfig.js';

/**
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
 * @typedef {import('./scheduling.js').RescanPolicy} RescanPolicy
 * @typedef {import('./reminderGlobalConfig.js').ReminderGlobalConfig} ReminderGlobalConfig
 */

/**
 * Per-status rescan thresholds, in SECONDS (0 = never). Field names are
 * camelCase config keys; {@link RESCAN_FIELDS} maps each to the OGame
 * {@link PositionStatus} it governs. `abandoned` is intentionally NOT here
 * — see {@link GalaxyScanRescan.abandonedEnabled}.
 *
 * @typedef {object} GalaxyScanRescan
 * @property {number} emptySent     Our colonizer in flight (status `empty_sent`).
 * @property {number} reserved      Planet-move cooldown (status `reserved`).
 * @property {number} inactive      `i` dormancy flag (status `inactive`).
 * @property {number} longInactive  `I` dormancy flag (status `long_inactive`).
 * @property {number} occupied      Active player (status `occupied`).
 * @property {number} vacation      Vacation mode (status `vacation`).
 * @property {number} banned        Banned account (status `banned`).
 * @property {number} empty         Empty slot (status `empty`); 0 by default —
 *   enables "detect a neighbour colonising near me" for aggressive play.
 * @property {boolean} abandonedEnabled  Whether `abandoned` slots are
 *   rescanned at all (using the dynamic 3 AM-sweep deadline).
 */

/**
 * The full Galaxy-Scan config, persisted per-universe.
 *
 * @typedef {object} GalaxyScanConfig
 * @property {string} positions  Comma/range list of target positions
 *   (e.g. `"8,10-12,15"`). Drives both which positions count as a "free
 *   region" and which the colonize button targets (one shared value).
 * @property {boolean} preferOtherGalaxies  Prefer neighbouring galaxies for
 *   colonization (was `colPreferOtherGalaxies`).
 * @property {number} colonyMinGap  Min seconds between colonize arrivals (the
 *   min-gap scheduling guard read by `features/sendColony`).
 * @property {number} colonyMinFields  Abandon-eligibility floor: a fresh
 *   colony under this many fields is offered for abandon.
 * @property {string} colonyPassword  Account password the abandon flow
 *   autofills into the game's give-up confirmation form.
 * @property {boolean} fsEnabled  Fleet-save auto-detection on/off (per-server:
 *   the "big fleet" cutoff is speed-dependent, so it lives here, not global).
 * @property {number} fsThreshold  Minimum total ships for a leg to count as a
 *   fleet-save.
 * @property {number} fsMinFlightSec  Minimum flight time (s) for a leg to count
 *   as a fleet-save — excludes short planet⇄moon hops. Server-speed dependent.
 * @property {string} fsOffsets  Fleet-save reminder offsets relative to landing
 *   (comma-separated, minutes-first; negative = before, 0 = at, + = after).
 * @property {boolean} reminderOverrideEnabled  When true, THIS universe uses
 *   its own {@link reminderOverride} for expedition-wave + ad-hoc reminders
 *   instead of the global config (whole-group override — see
 *   `domain/resolveReminderConfig`).
 * @property {ReminderGlobalConfig} reminderOverride  Per-server snapshot of the
 *   wave/ad-hoc config (enable, schedule, lead time, message templates). Same
 *   shape as the global config so it normalises with the same code; its
 *   `templates.fleetSave` is carried but ignored (FS presentation stays
 *   global). Only consulted when {@link reminderOverrideEnabled} is true.
 * @property {GalaxyScanRescan} rescan  Per-status rescan policy inputs.
 */

/**
 * Maps each {@link GalaxyScanRescan} duration field to the OGame
 * {@link PositionStatus} it governs, plus a human label for the dashboard
 * editor. Order is the order rows render in. `abandoned` is handled
 * separately (a checkbox), so it is not in this list.
 *
 * @type {ReadonlyArray<{ field: keyof GalaxyScanRescan, status: PositionStatus, label: string }>}
 */
export const RESCAN_FIELDS = Object.freeze([
  { field: 'emptySent',    status: 'empty_sent',    label: 'Colonizer in flight (empty, ours)' },
  { field: 'empty',        status: 'empty',         label: 'Empty slot (0 = never)' },
  { field: 'reserved',     status: 'reserved',      label: 'Reserved (planet-move cooldown)' },
  { field: 'inactive',     status: 'inactive',      label: 'Inactive player (i)' },
  { field: 'longInactive', status: 'long_inactive', label: 'Long-inactive player (I)' },
  { field: 'occupied',     status: 'occupied',      label: 'Active player (occupied)' },
  { field: 'vacation',     status: 'vacation',      label: 'Vacation mode' },
  { field: 'banned',       status: 'banned',        label: 'Banned' },
]);

/** Seconds shorthands for the defaults below. */
const H = 3600;
const D = 86400;

/**
 * Factory for the built-in "free positions" config — the predefined preset
 * that reproduces OG-E's historical behaviour (positions `8`, prefer other
 * galaxies, and rescan thresholds identical to the old `RESCAN_AFTER`).
 * A fresh function each call so callers can't mutate a shared literal; also
 * the "reset to defaults" payload for the dashboard button.
 *
 * @returns {GalaxyScanConfig}
 */
export const defaultGalaxyScanConfig = () => ({
  positions: '8',
  preferOtherGalaxies: true,
  colonyMinGap: 15,
  colonyMinFields: 320,
  colonyPassword: '',
  fsEnabled: false,
  fsThreshold: 100000,
  fsMinFlightSec: 600,
  fsOffsets: '-10m, 0m, 10m',
  reminderOverrideEnabled: false,
  reminderOverride: defaultReminderGlobalConfig(),
  rescan: {
    emptySent: 4 * H,        // 4h
    empty: 0,                // never (opt-in for aggressive play)
    reserved: 24 * H,        // 24h
    inactive: 5 * D,         // 5d
    longInactive: 5 * D,     // 5d
    occupied: 30 * D,        // 30d
    vacation: 30 * D,        // 30d
    banned: 30 * D,          // 30d
    abandonedEnabled: true,
  },
});

/**
 * Coerce one stored value to a finite, non-negative integer number of
 * seconds, falling back to `fallback` for garbage / negatives. Used by
 * {@link normalizeGalaxyScanConfig} so a corrupt or partial persisted blob
 * (or an older shape) never produces NaN thresholds.
 *
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
const coerceSeconds = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Normalise an arbitrary (possibly partial / legacy / null) stored value
 * into a complete {@link GalaxyScanConfig}, filling every missing field
 * from {@link defaultGalaxyScanConfig}. Pure and total — always returns a
 * valid config. The store's hydrate path runs this on load so consumers
 * never have to defend against holes.
 *
 * @param {unknown} raw
 * @returns {GalaxyScanConfig}
 */
export const normalizeGalaxyScanConfig = (raw) => {
  const d = defaultGalaxyScanConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Partial<GalaxyScanConfig>} */ (raw);
  const rescanRaw = /** @type {Partial<GalaxyScanRescan>} */ (r.rescan ?? {});
  /** @type {GalaxyScanRescan} */
  const rescan = {
    emptySent: coerceSeconds(rescanRaw.emptySent, d.rescan.emptySent),
    empty: coerceSeconds(rescanRaw.empty, d.rescan.empty),
    reserved: coerceSeconds(rescanRaw.reserved, d.rescan.reserved),
    inactive: coerceSeconds(rescanRaw.inactive, d.rescan.inactive),
    longInactive: coerceSeconds(rescanRaw.longInactive, d.rescan.longInactive),
    occupied: coerceSeconds(rescanRaw.occupied, d.rescan.occupied),
    vacation: coerceSeconds(rescanRaw.vacation, d.rescan.vacation),
    banned: coerceSeconds(rescanRaw.banned, d.rescan.banned),
    abandonedEnabled:
      typeof rescanRaw.abandonedEnabled === 'boolean'
        ? rescanRaw.abandonedEnabled
        : d.rescan.abandonedEnabled,
  };
  return {
    positions: typeof r.positions === 'string' ? r.positions : d.positions,
    preferOtherGalaxies:
      typeof r.preferOtherGalaxies === 'boolean'
        ? r.preferOtherGalaxies
        : d.preferOtherGalaxies,
    // colonyMinGap / colonyMinFields are non-negative ints; coerceSeconds
    // does exactly that integer coercion (the "seconds" name is incidental).
    colonyMinGap: coerceSeconds(r.colonyMinGap, d.colonyMinGap),
    colonyMinFields: coerceSeconds(r.colonyMinFields, d.colonyMinFields),
    colonyPassword:
      typeof r.colonyPassword === 'string' ? r.colonyPassword : d.colonyPassword,
    // fs* are the fleet-save reminder knobs (B3). Threshold / min-flight are
    // non-negative ints (coerceSeconds does that coercion); offsets is a
    // free-form duration-list string; enabled is a boolean.
    fsEnabled: typeof r.fsEnabled === 'boolean' ? r.fsEnabled : d.fsEnabled,
    fsThreshold: coerceSeconds(r.fsThreshold, d.fsThreshold),
    fsMinFlightSec: coerceSeconds(r.fsMinFlightSec, d.fsMinFlightSec),
    fsOffsets: typeof r.fsOffsets === 'string' ? r.fsOffsets : d.fsOffsets,
    // Per-server wave/ad-hoc override: a boolean gate + a full reminder-config
    // snapshot (normalised with the shared global-config code).
    reminderOverrideEnabled:
      typeof r.reminderOverrideEnabled === 'boolean'
        ? r.reminderOverrideEnabled
        : d.reminderOverrideEnabled,
    reminderOverride: normalizeReminderGlobalConfig(r.reminderOverride),
    rescan,
  };
};

/**
 * Project a {@link GalaxyScanRescan} into the {@link RescanPolicy} that
 * {@link import('./scheduling.js').isSystemStale} consumes: each non-zero
 * duration becomes a `status → ms` threshold (zero = never, so it is
 * dropped — absent from the map means never-stale). `abandonedEnabled`
 * passes through. Pure.
 *
 * @param {GalaxyScanRescan} rescan
 * @returns {RescanPolicy}
 */
export const buildRescanPolicy = (rescan) => {
  /** @type {{ [K in PositionStatus]?: number }} */
  const rescanAfter = {};
  for (const { field, status } of RESCAN_FIELDS) {
    const secs = rescan[field];
    if (typeof secs === 'number' && secs > 0) rescanAfter[status] = secs * 1000;
  }
  return { rescanAfter, abandonedEnabled: rescan.abandonedEnabled !== false };
};

/**
 * Parse one durable-text rescan field into whole seconds. The grammar is
 * the durations one (`domain/duration.js`) but HOURS-FIRST: a bare number
 * means hours (rescan windows are hours-to-days, never minutes), an
 * explicit `m`/`h`/`d` suffix overrides. `0` (any unit) means "never".
 * Returns `null` for anything that isn't a single well-formed, non-negative
 * token, so the editor can reject garbage and keep the previous value.
 *
 * @param {string} text  e.g. `"5d"`, `"6h"`, `"90m"`, `"0"`.
 * @returns {number | null}  Whole seconds (0 = never), or null when invalid.
 */
export const parseRescanDuration = (text) => {
  const t = String(text).trim();
  if (t === '') return null;
  // Bare number → hours (append the suffix the shared parser understands).
  const token = /[a-z]$/i.test(t) ? t : `${t}h`;
  const secs = parseDuration(token);
  if (secs === null || secs < 0) return null;
  return secs;
};

/**
 * Format whole seconds back into the most compact durable text for the
 * editor field: prefers days, then hours, then minutes, then seconds, and
 * renders `0` for "never". Inverse of {@link parseRescanDuration} for the
 * canonical units it emits.
 *
 * @param {number} secs
 * @returns {string}
 */
export const formatRescanDuration = (secs) => {
  if (!Number.isFinite(secs) || secs <= 0) return '0';
  if (secs % D === 0) return `${secs / D}d`;
  if (secs % H === 0) return `${secs / H}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
};
