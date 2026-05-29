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

import { REMINDER_PRESETS, offsetsForSchedule } from '../../../sync/ntfyScheduler.js';
import { settingsStore } from '../../../state/settings.js';
import { isValidNtfyToken } from '../../../sync/reminders.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * The reminder sub-options (auto-wave, schedule, ad-hoc, lead time) are
 * locked until the section is switched on AND a valid token is entered —
 * the token is the credential everything rides on. Used as each
 * sub-option's `disabledWhen`.
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const sectionLocked = (s) => !s.remindersMasterEnabled || !isValidNtfyToken(s.reminderNtfyToken);

/**
 * Render a preset's offsets as a relative-minute series, e.g.
 * `"0, 10, 20, 30, 40, 50"` — the minutes (after the wave returns) at
 * which each reminder fires. All preset offsets are whole minutes.
 *
 * @param {number[]} offsetsSec
 * @returns {string}
 */
const minutesList = (offsetsSec) => offsetsSec.map((s) => s / 60).join(', ');

/**
 * Schedule choices for the picker — kept short (the explicit series times
 * live in the read-only row below, where they can't be truncated by a
 * narrow select).
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
    // Master switch + credential first. Until BOTH are set, everything
    // below is greyed out (see `sectionLocked`).
    { id: 'remindersMasterEnabled', label: 'Enable reminders', type: 'checkbox' },
    {
      id: 'reminderNtfyToken',
      label: 'ntfy.sh access token (required)',
      type: 'password',
      placeholder: 'tk_…',
      // Editable only once the section is switched on (the token is the
      // credential the whole section unlocks behind).
      disabledWhen: (s) => !s.remindersMasterEnabled,
    },
    {
      id: 'reminderEnabled',
      label: 'Auto expedition-wave reminders',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      id: 'reminderSchedule',
      label: 'Wave reminder schedule',
      type: 'select',
      selectOptions: SCHEDULE_CHOICES,
      disabledWhen: sectionLocked,
    },
    {
      // Read-only: spells out WHEN the selected schedule's reminders fire,
      // updating live as the picker changes. Not a Settings field — the id
      // is DOM-only. Always-visible + full-width, so the times can't get
      // clipped the way a long <option> label can.
      id: 'reminderScheduleTimes',
      label: 'Reminders fire at',
      type: 'static',
      getText: () =>
        `${minutesList(offsetsForSchedule(settingsStore.get().reminderSchedule))} min after the wave returns`,
    },
    {
      id: 'adhocEnabled',
      label: 'Ad-hoc fleet reminders (event list)',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      id: 'adhocOffsetSec',
      label: 'Ad-hoc lead time before arrival (seconds)',
      type: 'text',
      placeholder: '60',
      disabledWhen: sectionLocked,
    },
  ],
};
