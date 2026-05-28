// @ts-check

// Expedition reminders section of the OG-E settings tab. Two rows: the
// master enable toggle and the ntfy.sh access token field. Everything
// else (schedule, topic) is determined automatically:
//
//   - Schedule is a constant — 6 reminders, 10 minutes apart, starting
//     when each wave returns. Not user-tunable on purpose; see
//     `sync/ntfyScheduler.js`.
//   - Topic is derived from the gist id (SHA-256 prefix) and shown
//     read-only on the OG-E Dashboard's Reminders tab. We don't repeat
//     it here to keep the settings table compact.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

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
  ],
};
