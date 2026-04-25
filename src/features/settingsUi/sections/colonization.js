// @ts-check

// Colonization section of the OG-E settings tab. Eight options spanning
// the Send Col button (visibility, size), the target-pick policy
// (positions, prefer-other-galaxies, post-send redirect), the
// scheduling guard (min gap between arrivals), the abandon-eligibility
// floor (min fields), and the abandon-flow password.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const colonizationSection = {
  section: 'Colonization',
  options: [
    { id: 'colonizeMode', label: 'Send Col button (floating)', type: 'checkbox' },
    { id: 'colBtnSize', label: 'Send Col button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px' },
    { id: 'colPositions', label: 'Required target positions (only these will be colonized)', type: 'text', placeholder: 'e.g. 8,9,7,10,6' },
    { id: 'colPreferOtherGalaxies', label: 'Prefer neighbouring galaxies first (more predictable arrival times)', type: 'checkbox' },
    { id: 'autoRedirectColonize',   label: 'After sending colonize, open the next target', type: 'checkbox' },
    { id: 'colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', placeholder: 'e.g. 20' },
    { id: 'colMinFields', label: 'Min fields to keep colony', type: 'text', placeholder: 'e.g. 200' },
    { id: 'colPassword', label: 'Account password (for abandon)', type: 'password' },
  ],
};
