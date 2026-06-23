// @ts-check

import {
  defaultAlarmClockTemplates,
  normalizeAlarmClockTemplates,
} from './alarmClockTemplates.js';
import { formatDuration } from './duration.js';

// AlarmClock configuration — the PER-UNIVERSE knobs that drive expedition-wave
// auto-alarmClock and the ad-hoc lead time, plus the per-kind message templates.
//
// # Why per-universe
//
// AlarmClock cadence, ad-hoc lead time, and message wording are configured per
// OGame server: the dashboard's top server-switcher already scopes everything
// else per universe, so alarmClock follow suit (there is no global slot and no
// per-server "override" any more — every server simply has its own config).
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// This config is edited from TWO origins: in-game (game origin) and the
// dashboard's AlarmClock tab (extension origin). localStorage is per-origin, so
// it can't be shared; `chrome.storage.local` is the one store both origins see.
// The per-universe slot syncs whole-slot newest-wins through the gist (see
// `sync/merge.mergeAlarmClockConfig`), exactly like `galaxyScanConfig`.
//
// Everything here is PURE: no DOM, no storage, no clock. The shape, its
// defaults, and normalisation live here so they are unit-testable in Node and
// shared verbatim across the game/dashboard origins.

/**
 * The full per-universe alarmClock config.
 *
 * @typedef {object} AlarmClockConfig
 * @property {boolean} alarmClockEnabled  Expedition-wave auto-alarmClock on/off.
 * @property {string} alarmClockSchedule  Wave alarmClock cadence — a free-form
 *   minutes-first offset list AFTER the wave returns (e.g. `"0m, 10m, 30m, 60m"`).
 * @property {string} adhocSchedule  Ad-hoc alarmClock cadence — a free-form
 *   minutes-first SIGNED offset list relative to arrival, same convention as
 *   the fleet-save schedule (`-` before, `0` at, `+` after; e.g.
 *   `"-1h, -10m, 0m"`). Applied live to every armed entry (see `domain/adhoc.js`).
 * @property {Record<import('./alarmClockTemplates.js').AlarmClockKind, import('./alarmClockTemplates.js').AlarmClockTemplate>} templates
 *   Per-kind message customisation (body / icon / priority) for wave, ad-hoc,
 *   and fleet-save. The fleet-save BEHAVIOURAL knobs (`fs*`) stay in
 *   `galaxyScanConfig`; only its message presentation lives here.
 */

/**
 * Factory for the built-in defaults. A fresh object each call so callers can't
 * mutate a shared literal; also the "reset to defaults" payload for the
 * dashboard button.
 *
 * @returns {AlarmClockConfig}
 */
export const defaultAlarmClockConfig = () => ({
  alarmClockEnabled: false,
  alarmClockSchedule: '0m, 10m, 30m, 60m',
  // 1 minute before arrival — reproduces the historical single 60s lead time.
  adhocSchedule: '-1m',
  templates: defaultAlarmClockTemplates(),
});

/**
 * Resolve the ad-hoc schedule string, MIGRATING the legacy single
 * `adhocOffsetSec` (seconds BEFORE arrival) to the new signed offset list
 * (before = negative). A present `adhocSchedule` string wins; otherwise a
 * finite legacy lead time becomes a one-entry "before" schedule
 * (`60 ⇒ "-1m"`); otherwise the default. Total.
 *
 * @param {{ adhocSchedule?: unknown, adhocOffsetSec?: unknown }} r
 * @param {string} fallback
 * @returns {string}
 */
const adhocScheduleOf = (r, fallback) => {
  if (typeof r.adhocSchedule === 'string') return r.adhocSchedule;
  const legacy = Math.floor(Number(r.adhocOffsetSec));
  if (Number.isFinite(legacy) && legacy >= 0) return formatDuration(-legacy);
  return fallback;
};

/**
 * Normalise an arbitrary (possibly partial / legacy / null) stored value into
 * a complete {@link AlarmClockConfig}, filling every missing field from
 * {@link defaultAlarmClockConfig}. Pure and total — always returns a valid
 * config. The store's hydrate path runs this on load so consumers never have
 * to defend against holes.
 *
 * @param {unknown} raw
 * @returns {AlarmClockConfig}
 */
export const normalizeAlarmClockConfig = (raw) => {
  const d = defaultAlarmClockConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Partial<AlarmClockConfig>} */ (raw);
  return {
    alarmClockEnabled:
      typeof r.alarmClockEnabled === 'boolean' ? r.alarmClockEnabled : d.alarmClockEnabled,
    alarmClockSchedule:
      typeof r.alarmClockSchedule === 'string' ? r.alarmClockSchedule : d.alarmClockSchedule,
    adhocSchedule: adhocScheduleOf(r, d.adhocSchedule),
    templates: normalizeAlarmClockTemplates(r.templates),
  };
};
