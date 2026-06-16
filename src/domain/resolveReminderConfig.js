// @ts-check

// Per-server override resolution for the GLOBAL reminder config.
//
// Expedition-wave + ad-hoc reminders default to ONE global config (same on
// every universe — see `domain/reminderGlobalConfig`). A server may opt to
// OVERRIDE that whole group: when `reminderOverrideEnabled` is set on a
// universe's `galaxyScanConfig`, this universe uses its own snapshot instead
// of the global one. The override is WHOLE-GROUP (all of: wave enable +
// schedule, ad-hoc lead time, and the wave/ad-hoc MESSAGE templates) — there
// is no per-field inheritance, which keeps the model and the dashboard UI
// simple.
//
// Fleet-save is unaffected: its behavioural knobs are already per-universe
// (`fs*` in `galaxyScanConfig`), and its message template is PRESENTATION, so
// it always comes from the global config — even when a wave/ad-hoc override is
// active. The override snapshot reuses the full `ReminderGlobalConfig` shape
// (so it normalises with the same code); its own `templates.fleetSave` is
// therefore carried but deliberately ignored here.
//
// Pure: no DOM, no storage, no clock.

/**
 * @typedef {import('./reminderGlobalConfig.js').ReminderGlobalConfig} ReminderGlobalConfig
 * @typedef {import('./galaxyScanConfig.js').GalaxyScanConfig} GalaxyScanConfig
 */

/**
 * The EFFECTIVE reminder config for one universe: the global config, unless
 * that universe enabled a whole-group override, in which case its wave/ad-hoc
 * portion (incl. their message templates) wins. The fleet-save template is
 * always taken from the global config.
 *
 * @param {ReminderGlobalConfig} global  Normalised global reminder config.
 * @param {Pick<GalaxyScanConfig, 'reminderOverrideEnabled' | 'reminderOverride'>} perServer
 *   The universe's galaxy-scan config (only the override fields are read).
 * @returns {ReminderGlobalConfig}  A complete, ready-to-use reminder config.
 */
export const resolveReminderConfig = (global, perServer) => {
  if (!perServer || !perServer.reminderOverrideEnabled) return global;
  const o = perServer.reminderOverride;
  return {
    reminderEnabled: o.reminderEnabled,
    reminderSchedule: o.reminderSchedule,
    adhocOffsetSec: o.adhocOffsetSec,
    templates: {
      wave: o.templates.wave,
      adhoc: o.templates.adhoc,
      // Fleet-save presentation is never overridden per server.
      fleetSave: global.templates.fleetSave,
    },
  };
};
