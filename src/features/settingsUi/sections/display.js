// @ts-check

// Display section of the OG-E settings tab. Currently a single
// readability-boost toggle. New visual-only toggles (event-box tweaks,
// fleet-movement link styling, etc.) belong here.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const displaySection = {
  section: 'Display',
  options: [
    {
      id: 'readabilityBoost',
      label: 'Readability boost (event box + fleet movement link)',
      type: 'checkbox',
    },
  ],
};
