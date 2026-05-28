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
    {
      id: 'eventMenuHighlight',
      label: 'Event menu highlight (pulse animation for ephemeral event entries)',
      type: 'checkbox',
    },
    {
      id: 'traderMenuHighlight',
      label: 'Trader reminder (subtle yellow pulse, intense red 14:00–24:00 until first click)',
      type: 'checkbox',
    },
  ],
};
