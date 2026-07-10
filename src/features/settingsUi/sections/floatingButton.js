// @ts-check

// The OG-E command block — the HEADERLESS first section of the settings tab:
// the Dashboard launcher riding flush on top of the FAB module bar, then the
// shared size slider. The module BAR (one toggle tile per module, each a 1:1
// preview of its satellite orb: lit = visible, dark = hidden) IS the
// visibility control — there is no master FAB switch; all four tiles off =
// no command buttons. The bar governs FAB *visibility* only — each feature
// self-gates its own mount; Colonization's hunting config stays a
// per-universe dashboard concern. Other per-module knobs live in their own
// sections, and switching the visible module happens on the button itself
// (its orbital picker), not here.

import { FAB_MODULES } from '../../shared/fabModules.js';
import { buildDashboardButton } from './data.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const floatingButtonSection = {
  // Empty title — the block leads the tab directly under the "OG-E Settings"
  // header; it explains itself (createSectionTable skips the header row).
  section: '',
  options: [
    {
      id: 'fabModules',
      label: '',
      type: 'moduleTiles',
      fullWidth: true,
      tiles: Object.values(FAB_MODULES),
      topSlot: buildDashboardButton,
    },
    // No heading — a lone slider directly under the bar reads as "size" on
    // its own (the px readout says the rest).
    {
      id: 'fabBtnSize',
      label: '',
      type: 'range',
      fullWidth: true,
      min: 40,
      max: 560,
      step: 10,
      unit: 'px',
    },
  ],
};
