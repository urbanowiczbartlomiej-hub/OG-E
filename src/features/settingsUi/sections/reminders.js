// @ts-check

// Reminders section of the OG-E settings tab. The umbrella for every
// ntfy.sh push OG-E can schedule — expedition-wave auto-reminders, ad-hoc
// per-fleet reminders, and fleet-save (FS) auto-detection.
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
//   6. Auto fleet-save detection — flag any own fleet over the ship
//      threshold and schedule a reminder series. Off ⇒ no 🛡 badges, no FS
//      scheduling.
//   7. Fleet-save threshold — total ship count that makes a leg an FS.
//   8. Fleet-save offsets — the FS reminder schedule, RELATIVE to arrival
//      (negative = before landing, 0 = at landing, positive = after).
//
// The topic itself is automatic (derived from the token) and shown
// read-only on the OG-E Dashboard's Reminders tab, so it isn't repeated
// here.

import { REMINDER_PRESETS, offsetsForSchedule } from '../../../sync/ntfyScheduler.js';
import { settingsStore } from '../../../state/settings.js';
import { isValidNtfyToken } from '../../../sync/reminders.js';
import { parseFsOffsets } from '../../../domain/fleetSave.js';

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
 * Spell out a fleet-save offset list as a human phrase relative to landing,
 * e.g. `-600,0,600` → `"10 min before, at landing, 10 min after"`. Empty /
 * all-invalid input reads as "(none)" so the player sees that no FS push
 * would be scheduled.
 *
 * @param {number[]} offsetsSec
 * @returns {string}
 */
const fsOffsetsText = (offsetsSec) =>
  offsetsSec.length
    ? offsetsSec
        .map((o) => {
          const m = Math.round(Math.abs(o) / 60);
          return o < 0 ? `${m} min before` : o > 0 ? `${m} min after` : 'at landing';
        })
        .join(', ')
    : '(none — no FS pushes scheduled)';

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
    {
      // Fleet-save auto-detection: any of your own fleets whose total ship
      // count crosses the threshold is flagged 🛡 in the event list and gets
      // a reminder series. Not armable/cancellable — it's automatic.
      id: 'fsEnabled',
      label: 'Auto fleet-save detection (event list)',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      // The "big fleet" cutoff, right beside its toggle. Default 100 000.
      id: 'fsThreshold',
      label: 'Fleet-save threshold (total ships)',
      type: 'text',
      placeholder: '100000',
      disabledWhen: sectionLocked,
    },
    {
      // Free-form reminder schedule, RELATIVE to arrival (comma-separated
      // seconds; negative = before landing, 0 = at landing, positive =
      // after). e.g. -600,0,600 ⇒ 10 min before, at, and 10 min after.
      id: 'fsOffsets',
      label: 'Fleet-save reminder offsets (seconds, relative to arrival)',
      type: 'text',
      placeholder: '-600,0,600',
      disabledWhen: sectionLocked,
    },
    {
      // Read-only: spells out the parsed FS offsets, updating live.
      id: 'fsOffsetsTimes',
      label: 'Fleet-save reminders fire',
      type: 'static',
      getText: () => fsOffsetsText(parseFsOffsets(settingsStore.get().fsOffsets)),
    },
  ],
};
