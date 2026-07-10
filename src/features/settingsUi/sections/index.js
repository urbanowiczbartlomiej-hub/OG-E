// @ts-check

// Composes the per-section configs into the SECTIONS array consumed by
// `../controls.js` (for syncInputsFromState's iteration) and
// `../index.js` (for buildTab's table rendering). Order matters —
// top-to-bottom in the AGR settings tab.

import { floatingButtonSection } from './floatingButton.js';
import { preferencesSection } from './preferences.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * Declarative layout of the entire settings panel: the FAB command block,
 * then the preferences panel. Both sections are headerless — each block
 * carries its own captions.
 *
 * Every data-bound option's `id` (and every prefTiles `key`) MUST match a
 * field of `Settings` — typecheck catches the mismatch via the index read
 * in `controls.js`.
 *
 * @type {SettingsSection[]}
 */
export const SECTIONS = [
  floatingButtonSection,
  preferencesSection,
];
