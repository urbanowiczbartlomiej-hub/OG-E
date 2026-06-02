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
    // `mobileMode` toggles ONLY the floating Send-Exp button — badges and
    // auto-redirect are independent features, so this is NOT a section
    // master. The one dependent is the button's own size (meaningless when
    // the button is hidden), which greys with it.
    { id: 'mobileMode', label: 'Floating Send-Exp button', type: 'checkbox' },
    { id: 'enterBtnSize', label: 'Send Exp button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: (s) => !s.mobileMode },
    { id: 'expeditionBadges', label: 'Expedition badges on planets', type: 'checkbox' },
    { id: 'autoRedirectExpedition', label: 'After sending expedition, open the next planet', type: 'checkbox' },
    { id: 'maxExpPerPlanet', label: 'Max expeditions per planet', type: 'range', min: 1, max: 20, step: 1 },
  ],
};
