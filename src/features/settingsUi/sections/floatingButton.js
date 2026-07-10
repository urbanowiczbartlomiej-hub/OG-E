// @ts-check

// The OG-E command block — the HEADERLESS first section of the settings tab:
// ONE bordered block reading launcher / module bar / size slider top-to-
// bottom. The module BAR (one toggle tile per module, each a 1:1 preview of
// its satellite orb: lit = visible, dark = hidden) IS the visibility control
// — there is no master FAB switch; all four tiles off = no command buttons.
// The bar governs FAB *visibility* only — each feature self-gates its own
// mount; Colonization's hunting config stays a per-universe dashboard
// concern. Other per-module knobs live in their own sections, and switching
// the visible module happens on the button itself (its orbital picker), not
// here. The slider rides INSIDE the block as its bottom segment (it sizes
// the very buttons the tiles preview, so it belongs to them — a floating
// row underneath read as attached to nothing).

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
      // No heading — a slider inside the block reads as "size" on its own
      // (the px readout says the rest).
      sizeSlider: {
        id: 'fabBtnSize',
        min: 40,
        max: 560,
        step: 10,
        unit: 'px',
      },
    },
  ],
};
