// @ts-check

// Fleet-Save section of the OG-E settings tab — the two floating buttons
// (Mikrofloty + Zbieraj) from `features/fsCollect`. `fsCollectMode` is the
// section master; the size only matters when it's on. The per-moon routes
// themselves are defined in the dashboard's "FS Routes" tab, not here.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const fsLocked = (s) => !s.fsCollectMode;

/** @type {SettingsSection} */
export const fleetSaveSection = {
  section: 'Fleet Save',
  options: [
    { id: 'fsCollectMode', label: 'Floating Mikrofloty + Zbieraj buttons (routes set in the dashboard FS Routes tab)', type: 'checkbox' },
    { id: 'fsBtnSize', label: 'Fleet-save button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: fsLocked },
  ],
};
