// @ts-check

// Multi-device sync section of the OG-E settings tab.
//
// The editable controls — the master switch, GitHub token, "Sync now", and the
// status readout — MOVED to the OG-E Dashboard's Sync tab. That page runs at
// the extension origin and can reach chrome.storage, so a token entered there
// applies to EVERY universe at once instead of being re-typed per server. The
// four fields still live in `state/settings.js`; `state/sharedSettings.js`
// bridges them from chrome.storage back into each game origin, so the scheduler
// and everything else keep reading them unchanged. This section is now just a
// signpost — the Dashboard launch button already leads the panel.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const syncSection = {
  section: 'Multi-device sync',
  options: [
    {
      // DOM-only id (not a Settings field) — a standalone note, full width.
      id: 'syncMovedNote',
      label: '',
      type: 'static',
      fullWidth: true,
      getText: () =>
        'Cross-device sync — the on/off switch, your GitHub token, “Sync now”, '
        + 'and the per-universe sync status now live in the OG-E Dashboard ▸ Sync '
        + 'tab (open it from the Dashboard button above). Set the token once there '
        + 'and it applies to all your universes.',
    },
  ],
};
