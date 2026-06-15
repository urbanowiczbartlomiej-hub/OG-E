// @ts-check

// Expeditions section of the OG-E settings tab. Three options: badges
// toggle, post-send auto-redirect, and the per-planet expedition cap.
// (The button itself is the unified FAB's 'exp' module — its toggle and
// size live in the "Floating button" section.)

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const expeditionsSection = {
  section: 'Expeditions',
  options: [
    { id: 'expeditionBadges', label: 'Expedition badges on planets', type: 'checkbox' },
    { id: 'autoRedirectExpedition', label: 'After sending expedition, open the next planet', type: 'checkbox' },
    // Capped at 2 on purpose: as a rule you shouldn't run more than two
    // expeditions from a single planet, so a 1/2 radio beats a 1–20 slider.
    { id: 'maxExpeditionsPerPlanet', label: 'Max expeditions per planet', type: 'radio', radioOptions: [{ value: 1, label: '1' }, { value: 2, label: '2' }] },
  ],
};
