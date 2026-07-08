// @ts-check

// Expeditions section of the OG-E settings tab: the per-module FAB toggle
// (hide the Expeditions button without killing the whole FAB), post-send
// auto-redirect and the per-planet expedition cap. (The planet status
// markers — formerly "Expedition badges" — now live in the Display section,
// since they cover every fleet mission, not just expeditions. The FAB's
// master toggle and size live in the "Floating button" section.)

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const expeditionsSection = {
  section: 'Expeditions',
  options: [
    { id: 'showExpeditionButton', label: 'Show the Expeditions button on the floating button', type: 'checkbox' },
    { id: 'autoRedirectExpedition', label: 'After sending expedition, open the next planet', type: 'checkbox' },
    // Capped at 2 on purpose: as a rule you shouldn't run more than two
    // expeditions from a single planet, so a 1/2 radio beats a 1–20 slider.
    { id: 'maxExpeditionsPerPlanet', label: 'Max expeditions per planet', type: 'radio', radioOptions: [{ value: 1, label: '1' }, { value: 2, label: '2' }] },
  ],
};
