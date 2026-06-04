// @ts-check

// "Daily Resource Run" section of the OG-E settings tab — the unified floating
// button from `features/fsCollect` that handles daily micro-fleet distribution
// (DISPATCH) and collection (SEND ALL). `fsCollectMode` is the section master;
// size only matters when on. Routes are defined in the dashboard's
// "Daily Resource Run" tab, not here.

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
  section: 'Daily Resource Run',
  options: [
    { id: 'fsCollectMode', label: 'Daily Resource Run button', type: 'checkbox' },
    { id: 'fsBtnSize', label: 'Daily Resource Run button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: fsLocked },
  ],
};
