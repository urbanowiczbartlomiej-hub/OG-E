// @ts-check

import {
  defaultReminderTemplates,
  normalizeReminderTemplates,
} from './reminderTemplates.js';

// Global reminder configuration — the GLOBAL (server-independent) reminder
// knobs that drive expedition-wave auto-reminders and the ad-hoc lead time.
//
// # Why this is its own domain module (and its own GLOBAL store)
//
// These three knobs used to live in `settingsStore` (localStorage, edited
// from the in-game AGR panel) and synced GLOBALLY (one value for every
// server). They are NOT server-scoped: a wave-reminder cadence (`0m, 10m,
// …`) and an ad-hoc lead time are equally valid on every universe — unlike
// the fleet-save knobs (B3b), whose "big fleet" cutoff is speed-dependent
// and so folded into the per-universe `galaxyScanConfig` slot.
//
// They moved out of `settings.js` (B3c) so the detailed reminder config can
// be edited from the dashboard's Reminders tab. The dashboard is a separate
// extension origin and can't see the game-origin's localStorage, so the
// config is backed by `chrome.storage.local` — the only store both origins
// see (see `state/reminderGlobalConfig.js`). Unlike `galaxyScanConfig` this
// slot is NOT keyed by universe: there is exactly one global slot, synced
// whole-slot newest-wins through the gist (see `sync/merge.mergeReminderGlobalConfig`).
//
// Everything here is PURE: no DOM, no storage, no clock. The shape, its
// defaults, and normalisation live here so they are unit-testable in Node
// and shared verbatim across the game/dashboard origins.

/**
 * The full global reminder config.
 *
 * @typedef {object} ReminderGlobalConfig
 * @property {boolean} reminderEnabled  Expedition-wave auto-reminders on/off.
 * @property {string} reminderSchedule  Wave reminder cadence — a free-form
 *   minutes-first offset list AFTER the wave returns (e.g. `"0m, 10m, 30m, 60m"`).
 * @property {number} adhocOffsetSec  Ad-hoc reminder lead time: seconds BEFORE
 *   arrival a one-shot ad-hoc ping fires (captured per reminder at arm time).
 * @property {Record<import('./reminderTemplates.js').ReminderKind, import('./reminderTemplates.js').ReminderTemplate>} templates
 *   Per-kind message customisation (body / icon / priority). The message
 *   PRESENTATION is server-independent, so all three kinds' templates live in
 *   this one global slot — even fleet-save, whose *behavioural* knobs stay
 *   per-universe in `galaxyScanConfig`. A per-server override may replace the
 *   wave/ad-hoc portion (see `domain/resolveReminderConfig`).
 */

/**
 * Factory for the built-in defaults — the values these knobs carried as
 * `settings.js` schema defaults before the move (B3c). A fresh object each
 * call so callers can't mutate a shared literal; also the "reset to defaults"
 * payload for the dashboard button.
 *
 * @returns {ReminderGlobalConfig}
 */
export const defaultReminderGlobalConfig = () => ({
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
 * Normalise an arbitrary (possibly partial / legacy / null) stored value
 * into a complete {@link ReminderGlobalConfig}, filling every missing field
 * from {@link defaultReminderGlobalConfig}. Pure and total — always returns a
 * valid config. The store's hydrate path runs this on load so consumers
 * never have to defend against holes.
 *
 * @param {unknown} raw
 * @returns {ReminderGlobalConfig}
 */
export const normalizeReminderGlobalConfig = (raw) => {
  const d = defaultReminderGlobalConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Partial<ReminderGlobalConfig>} */ (raw);
  return {
    reminderEnabled:
      typeof r.reminderEnabled === 'boolean' ? r.reminderEnabled : d.reminderEnabled,
    reminderSchedule:
      typeof r.reminderSchedule === 'string' ? r.reminderSchedule : d.reminderSchedule,
    adhocOffsetSec: coerceSeconds(r.adhocOffsetSec, d.adhocOffsetSec),
    templates: normalizeReminderTemplates(r.templates),
  };
};
