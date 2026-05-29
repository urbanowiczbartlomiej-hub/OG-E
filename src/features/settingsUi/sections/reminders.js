// @ts-check

// Expedition reminders section of the OG-E settings tab. Three rows: the
// master enable toggle, the ntfy.sh access token field, and the schedule
// preset picker. The topic is still automatic:
//
//   - Schedule is one of a few FIXED presets (not free-form tuning) —
//     see `REMINDER_PRESETS` in `sync/ntfyScheduler.js`. We deliberately
//     offer a short list of curated cadences rather than raw count/interval
//     inputs, to keep the panel simple and the ntfy.sh quota predictable.
//   - Topic is derived from the gist id (SHA-256 prefix) and shown
//     read-only on the OG-E Dashboard's Reminders tab. We don't repeat
//     it here to keep the settings table compact.

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
  section: 'Expedition reminders (ntfy.sh)',
  options: [
    { id: 'reminderEnabled', label: 'Schedule push reminders', type: 'checkbox' },
    {
      id: 'reminderNtfyToken',
      label: 'ntfy.sh access token',
      type: 'password',
      placeholder: 'tk_…',
    },
    {
      id: 'reminderSchedule',
      label: 'Reminder schedule',
      type: 'select',
      selectOptions: SCHEDULE_CHOICES,
    },
  ],
};
