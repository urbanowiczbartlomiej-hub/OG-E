// @ts-check

// Reminders section of the OG-E settings tab. The umbrella for every
// ntfy.sh push OG-E can schedule — today expedition-wave auto-reminders
// and ad-hoc per-fleet reminders, with fleet-save auto-detection planned.
//
// Layout, top to bottom:
//
//   1. ntfy.sh access token — the PREREQUISITE for everything here. With
//      no (valid) token there is no push channel: the topic is derived
//      from it, the producer skips scheduling, and the event-list badges
//      stay hidden. So it leads the section.
//   2. Auto expedition-wave reminders — the original feature: detect a
//      returning expedition wave and schedule its reminder series.
//   3. Wave reminder schedule — the cadence preset for (2). One of a few
//      FIXED presets (see `REMINDER_PRESETS` in `sync/ntfyScheduler.js`),
//      not free-form tuning, to keep the panel simple and ntfy usage
//      predictable. Only affects waves.
//   4. Ad-hoc fleet reminders — the master switch for the event-list
//      badges. Off ⇒ badges hidden, no ad-hoc scheduling (armed entries
//      are kept but dormant).
//   5. Ad-hoc lead time — how many seconds before arrival an ad-hoc ping
//      fires. Captured per reminder at arm time, so changing it here only
//      affects reminders armed afterwards.
//
// The topic itself is automatic (derived from the token) and shown
// read-only on the OG-E Dashboard's Reminders tab, so it isn't repeated
// here.

import { REMINDER_PRESETS } from '../../../sync/ntfyScheduler.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * Schedule choices for the picker, built from the single source of truth
 * in `ntfyScheduler.js` so the dropdown labels can never drift from the
 * actual offsets.
 *
 * @type {{ value: string, label: string }[]}
 */
const SCHEDULE_CHOICES = Object.entries(REMINDER_PRESETS).map(([value, { label }]) => ({
  value,
  label,
}));

/** @type {SettingsSection} */
export const remindersSection = {
  section: 'Reminders (ntfy.sh)',
  options: [
    {
      id: 'reminderNtfyToken',
      label: 'ntfy.sh access token (required)',
      type: 'password',
      placeholder: 'tk_…',
    },
    { id: 'reminderEnabled', label: 'Auto expedition-wave reminders', type: 'checkbox' },
    {
      id: 'reminderSchedule',
      label: 'Wave reminder schedule',
      type: 'select',
      selectOptions: SCHEDULE_CHOICES,
    },
    { id: 'adhocEnabled', label: 'Ad-hoc fleet reminders (event list)', type: 'checkbox' },
    {
      id: 'adhocOffsetSec',
      label: 'Ad-hoc lead time before arrival',
      type: 'range',
      min: 0,
      max: 600,
      step: 15,
      unit: 's',
    },
  ],
};
