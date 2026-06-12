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
    { id: 'maxExpPerPlanet', label: 'Max expeditions per planet', type: 'range', min: 1, max: 20, step: 1 },
  ],
};
