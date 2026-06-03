// @ts-check

// "Transport" section of the OG-E settings tab — the unified floating button
// from `features/fsCollect` that handles daily micro-fleet distribution and
// collection. `fsCollectMode` is the section master; size only matters when on.
// Routes are defined in the dashboard's "Trasy" tab, not here.

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
  section: 'Transport',
  options: [
    { id: 'fsCollectMode', label: 'Przycisk Transport — wyślij mikrofloty i zbieraj surowce (trasy w zakładce Dashboard → Trasy)', type: 'checkbox' },
    { id: 'fsBtnSize', label: 'Rozmiar przycisku Transport', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: fsLocked },
  ],
};
