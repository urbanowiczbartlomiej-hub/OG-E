// @ts-check

// Colonization section of the OG-E settings tab. Covers the colonize
// EXECUTION knobs: the scheduling guard (min gap between arrivals), the
// abandon-eligibility floor (min fields), and the abandon-flow password.
// (The Send-Col button itself is the unified FAB's 'col' module — its
// toggle and size live in the "Floating button" section.)
//
// The target-position / prefer-other-galaxies SCAN-strategy knobs moved
// OUT of here into the per-universe Galaxy-Scan config, edited in the
// dashboard's Galaxy Scan tab (see `features/dashboard/scanConfig.js`).

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
    { id: 'colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', placeholder: 'e.g. 20', disabledWhen: colLocked },
    { id: 'colMinFields', label: 'Min fields to keep colony', type: 'text', placeholder: 'e.g. 200', disabledWhen: colLocked },
    { id: 'colPassword', label: 'Account password (for abandon)', type: 'password', disabledWhen: colLocked },
  ],
};
