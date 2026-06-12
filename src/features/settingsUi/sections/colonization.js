// @ts-check

// Colonization section of the OG-E settings tab. Five options spanning
// the target-pick policy (positions, prefer-other-galaxies), the
// scheduling guard (min gap between arrivals), the abandon-eligibility
// floor (min fields), and the abandon-flow password. (The Send-Col button
// itself is the unified FAB's 'col' module — its toggle and size live in
// the "Floating button" section.)

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * The unified FAB master gates this whole section: its colonize module is
 * the only consumer of these knobs (plus the abandon-overview feature,
 * gated the same way). Greys the dependents when off (mirrors how the
 * Reminders master gates its sub-options).
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const colLocked = (s) => !s.fabMode;

/** @type {SettingsSection} */
export const colonizationSection = {
  section: 'Colonization',
  options: [
    { id: 'colPreferOtherGalaxies', label: 'Prefer neighbouring galaxies (more predictable arrival times)', type: 'checkbox', disabledWhen: colLocked },
    { id: 'colPositions', label: 'Required target positions (only these; ranges ok, e.g. 8,10-12,15)', type: 'text', placeholder: 'e.g. 8,10-12,15', disabledWhen: colLocked },
    { id: 'colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', placeholder: 'e.g. 20', disabledWhen: colLocked },
    { id: 'colMinFields', label: 'Min fields to keep colony', type: 'text', placeholder: 'e.g. 200', disabledWhen: colLocked },
    { id: 'colPassword', label: 'Account password (for abandon)', type: 'password', disabledWhen: colLocked },
  ],
};
