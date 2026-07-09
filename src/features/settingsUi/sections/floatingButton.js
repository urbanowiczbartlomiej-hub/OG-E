// @ts-check

// Floating-button section of the OG-E settings tab — the unified FAB that
// hosts all four command modules (Expeditions / Colonization / Lifeforms /
// Daily Run). Master toggle, size, and the per-module "Show …" visibility
// toggles gathered in one place (Colonization's lives in the dashboard, since
// it's a per-universe colony-hunting setting); other per-module knobs live in
// their own sections, and switching the visible module happens on the button
// itself (its orbital picker), not here.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const floatingButtonSection = {
  section: 'Floating button',
  options: [
    { id: 'fabMode', label: 'Floating button (Expeditions / Colonization / Lifeforms / Daily Run)', type: 'checkbox' },
    { id: 'fabBtnSize', label: 'Button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px', disabledWhen: (s) => !s.fabMode },
    // Per-module visibility — which command buttons ride the FAB. All positive
    // ("Show …", ON = visible); each feature self-gates its own mount. Greyed
    // out when the FAB itself is off.
    { id: 'showExpeditionButton', label: 'Show the Expeditions button', type: 'checkbox', disabledWhen: (s) => !s.fabMode },
    { id: 'showColonizeButton', label: 'Show the Colonize button', type: 'checkbox', disabledWhen: (s) => !s.fabMode },
    { id: 'showLifeformButton', label: 'Show the Lifeforms button', type: 'checkbox', disabledWhen: (s) => !s.fabMode },
    { id: 'showDailyRunButton', label: 'Show the Daily Run button', type: 'checkbox', disabledWhen: (s) => !s.fabMode },
  ],
};
