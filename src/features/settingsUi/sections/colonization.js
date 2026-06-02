// @ts-check

// Colonization section of the OG-E settings tab. Seven options spanning
// the Send Col button (visibility, size), the target-pick policy
// (positions, prefer-other-galaxies), the scheduling guard (min gap
// between arrivals), the abandon-eligibility floor (min fields), and
// the abandon-flow password.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * `colonizeMode` is the section master: it gates the floating Send-Col
 * button AND the abandon-overview feature, so the rest of the section only
 * matters when it's on. Greys the dependents when off (mirrors how the
 * Reminders master gates its sub-options).
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const colLocked = (s) => !s.colonizeMode;

/** @type {SettingsSection} */
export const colonizationSection = {
  section: 'Colonization',
  options: [
    { id: 'colonizeMode', label: 'Floating Send-Col button', type: 'checkbox' },
    { id: 'colBtnSize', label: 'Send Col button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: colLocked },
    { id: 'colPreferOtherGalaxies', label: 'Prefer neighbouring galaxies (more predictable arrival times)', type: 'checkbox', disabledWhen: colLocked },
    { id: 'colPositions', label: 'Required target positions (only these; ranges ok, e.g. 8,10-12,15)', type: 'text', placeholder: 'e.g. 8,10-12,15', disabledWhen: colLocked },
    { id: 'colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', placeholder: 'e.g. 20', disabledWhen: colLocked },
    { id: 'colMinFields', label: 'Min fields to keep colony', type: 'text', placeholder: 'e.g. 200', disabledWhen: colLocked },
    { id: 'colPassword', label: 'Account password (for abandon)', type: 'password', disabledWhen: colLocked },
  ],
};
