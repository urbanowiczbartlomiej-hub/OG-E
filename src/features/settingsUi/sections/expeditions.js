// @ts-check

// Expeditions section of the OG-E settings tab. Five options: button
// visibility, button size, badges toggle, post-send auto-redirect, and
// the per-planet expedition cap.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const expeditionsSection = {
  section: 'Expeditions',
  options: [
    { id: 'mobileMode', label: 'Send Exp button (floating)', type: 'checkbox' },
    { id: 'enterBtnSize', label: 'Send Exp button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px' },
    { id: 'expeditionBadges', label: 'Expedition badges on planets', type: 'checkbox' },
    { id: 'autoRedirectExpedition', label: 'After sending expedition, open the next planet', type: 'checkbox' },
    { id: 'maxExpPerPlanet', label: 'Max expeditions per planet', type: 'text', placeholder: 'e.g. 1' },
  ],
};
