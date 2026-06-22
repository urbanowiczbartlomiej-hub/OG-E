// @ts-check

// Alarm-clock section of the OG-E settings tab.
//
// "Alarm clock" is the user-facing name for the ntfy reminders: every alarm is
// a wake-up for a time the player already knows from their OWN action (an
// expedition / fleet they sent, whose return time is computable) — like setting
// a phone alarm, never a monitor for events the player couldn't predict.
//
// The editable controls — the master switch and ntfy token — plus the derived
// push topic and account-status rows MOVED to the OG-E Dashboard's Alarm clock
// tab. The token entered there is shared across every universe via
// chrome.storage (see `state/sharedSettings.js`), and the detailed schedules
// already lived on the dashboard. The fields still live in
// `state/settings.js`; the producer keeps reading them through the shared-
// settings bridge. This section is now just a signpost — the Dashboard launch
// button already leads the panel.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const remindersSection = {
  section: 'Alarm clock (ntfy.sh)',
  options: [
    {
      // DOM-only id (not a Settings field) — a standalone note, full width.
      id: 'remindersMovedNote',
      label: '',
      type: 'static',
      fullWidth: true,
      getText: () =>
        'Alarm clock — the master switch, your ntfy token, the push topic to '
        + 'subscribe to, and all schedules now live in the OG-E Dashboard ▸ '
        + 'Alarm clock tab (open it from the Dashboard button above). Each alarm '
        + 'fires for a time you already know from your own action. The token is '
        + 'shared across all your universes.',
    },
  ],
};
