// @ts-check

// Floating-button section of the OG-E settings tab — the unified FAB that
// hosts all four command modules (Expeditions / Colonization / Lifeforms /
// Daily Run). One master toggle and one size; the per-module knobs live in
// their own sections, and switching the visible module happens on the
// button itself (its orbital picker), not here.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const floatingButtonSection = {
  section: 'Floating button',
  options: [
    { id: 'fabMode', label: 'Floating button (Expeditions / Colonization / Lifeforms / Daily Run)', type: 'checkbox' },
    { id: 'fabBtnSize', label: 'Button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: (s) => !s.fabMode },
  ],
};
