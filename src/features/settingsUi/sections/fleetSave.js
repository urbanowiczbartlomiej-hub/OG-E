// @ts-check

// "Daily Run" section of the OG-E settings tab — the unified floating
// button from `features/fsCollect` that handles daily micro-fleet distribution
// (DISPATCH) and collection (SEND ALL). `fsCollectMode` is the section master;
// size only matters when on. Routes are defined in the dashboard's
// "Daily Run" tab, not here.

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
  section: 'Daily Run',
  options: [
    { id: 'fsCollectMode', label: 'Daily Run button', type: 'checkbox' },
    { id: 'fsBtnSize', label: 'Daily Run button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: fsLocked },
  ],
};
