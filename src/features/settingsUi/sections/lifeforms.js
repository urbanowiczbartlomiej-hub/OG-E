// @ts-check

// Lifeforms section of the OG-E settings tab. Two options: the master
// toggle for the floating Lifeforms (system-discovery) button and its size.
// Mirrors the structure of `colonization.js`.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * `lifeformMode` is the section master — it gates the floating button, so
 * the size row is greyed out when it's off.
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const lfLocked = (s) => !s.lifeformMode;

/** @type {SettingsSection} */
export const lifeformsSection = {
  section: 'Lifeforms',
  options: [
    { id: 'lifeformMode', label: 'Floating Lifeforms button', type: 'checkbox' },
    { id: 'lfBtnSize', label: 'Lifeforms button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: lfLocked },
  ],
};
