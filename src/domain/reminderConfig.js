// @ts-check

import {
  defaultReminderTemplates,
  normalizeReminderTemplates,
} from './reminderTemplates.js';

// Reminder configuration — the PER-UNIVERSE knobs that drive expedition-wave
// auto-reminders and the ad-hoc lead time, plus the per-kind message templates.
//
// # Why per-universe
//
// Reminder cadence, ad-hoc lead time, and message wording are configured per
// OGame server: the dashboard's top server-switcher already scopes everything
// else per universe, so reminders follow suit (there is no global slot and no
// per-server "override" any more — every server simply has its own config).
//
// # Why chrome.storage (not the localStorage settingsStore)
//
// This config is edited from TWO origins: in-game (game origin) and the
// dashboard's Reminders tab (extension origin). localStorage is per-origin, so
// it can't be shared; `chrome.storage.local` is the one store both origins see.
// The per-universe slot syncs whole-slot newest-wins through the gist (see
// `sync/merge.mergeReminderConfig`), exactly like `galaxyScanConfig`.
//
// Everything here is PURE: no DOM, no storage, no clock. The shape, its
// defaults, and normalisation live here so they are unit-testable in Node and
// shared verbatim across the game/dashboard origins.

/**
 * The full per-universe reminder config.
 *
 * @typedef {object} ReminderConfig
 * @property {boolean} reminderEnabled  Expedition-wave auto-reminders on/off.
 * @property {string} reminderSchedule  Wave reminder cadence — a free-form
 *   minutes-first offset list AFTER the wave returns (e.g. `"0m, 10m, 30m, 60m"`).
 * @property {number} adhocOffsetSec  Ad-hoc reminder lead time: seconds BEFORE
 *   arrival a one-shot ad-hoc ping fires (captured per reminder at arm time).
 * @property {Record<import('./reminderTemplates.js').ReminderKind, import('./reminderTemplates.js').ReminderTemplate>} templates
 *   Per-kind message customisation (body / icon / priority) for wave, ad-hoc,
 *   and fleet-save. The fleet-save BEHAVIOURAL knobs (`fs*`) stay in
 *   `galaxyScanConfig`; only its message presentation lives here.
 */

/**
 * Factory for the built-in defaults. A fresh object each call so callers can't
 * mutate a shared literal; also the "reset to defaults" payload for the
 * dashboard button.
 *
 * @returns {ReminderConfig}
 */
export const defaultReminderConfig = () => ({
  reminderEnabled: false,
  reminderSchedule: '0m, 10m, 30m, 60m',
  adhocOffsetSec: 60,
  templates: defaultReminderTemplates(),
});

/**
 * Coerce one stored value to a finite, non-negative integer number of
 * seconds, falling back to `fallback` for garbage / negatives.
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
 * Normalise an arbitrary (possibly partial / legacy / null) stored value into
 * a complete {@link ReminderConfig}, filling every missing field from
 * {@link defaultReminderConfig}. Pure and total — always returns a valid
 * config. The store's hydrate path runs this on load so consumers never have
 * to defend against holes.
 *
 * @param {unknown} raw
 * @returns {ReminderConfig}
 */
export const normalizeReminderConfig = (raw) => {
  const d = defaultReminderConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Partial<ReminderConfig>} */ (raw);
  return {
    reminderEnabled:
      typeof r.reminderEnabled === 'boolean' ? r.reminderEnabled : d.reminderEnabled,
    reminderSchedule:
      typeof r.reminderSchedule === 'string' ? r.reminderSchedule : d.reminderSchedule,
    adhocOffsetSec: coerceSeconds(r.adhocOffsetSec, d.adhocOffsetSec),
    templates: normalizeReminderTemplates(r.templates),
  };
};
