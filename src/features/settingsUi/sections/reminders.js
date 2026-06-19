// @ts-check

// Reminders section of the OG-E settings tab.
//
// The editable controls — the master switch and ntfy token — plus the derived
// push topic and account-status rows MOVED to the OG-E Dashboard's Reminders
// tab. The token entered there is shared across every universe via
// chrome.storage (see `state/sharedSettings.js`), and the detailed reminder
// schedules already lived on the dashboard. The fields still live in
// `state/settings.js`; the producer keeps reading them through the shared-
// settings bridge. This section is now just a signpost — the Dashboard launch
// button already leads the panel.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const remindersSection = {
  section: 'Reminders (ntfy.sh)',
  options: [
    {
      // DOM-only id (not a Settings field) — a standalone note, full width.
      id: 'remindersMovedNote',
      label: '',
      type: 'static',
      fullWidth: true,
      getText: () =>
        'Reminders — the master switch, your ntfy token, the push topic to '
        + 'subscribe to, and all schedules now live in the OG-E Dashboard ▸ '
        + 'Reminders tab (open it from the Dashboard button above). The token is '
        + 'shared across all your universes.',
    },
  ],
};
