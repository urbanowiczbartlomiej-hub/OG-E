// @ts-check

// "Daily Transport" section of the OG-E settings tab — the unified floating
// button from `features/fsCollect` that handles daily micro-fleet distribution
// (Send) and collection (Collect). `fsCollectMode` is the section master; size
// only matters when on. Routes are defined in the dashboard's "Daily Transport"
// tab, not here.

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
  section: 'Daily Transport',
  options: [
    { id: 'fsCollectMode', label: 'Daily Transport button (routes set in Dashboard → Daily Transport Routes)', type: 'checkbox' },
    { id: 'fsBtnSize', label: 'Daily Transport button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: fsLocked },
  ],
};
