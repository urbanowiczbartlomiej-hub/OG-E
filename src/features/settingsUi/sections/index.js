// @ts-check

// Composes the per-section configs into the SECTIONS array consumed by
// `../controls.js` (for syncInputsFromState's iteration) and
// `../index.js` (for buildTab's table rendering). Order matters —
// top-to-bottom in the AGR settings tab.

import { expeditionsSection } from './expeditions.js';
import { colonizationSection } from './colonization.js';
import { displaySection } from './display.js';
import { syncSection } from './sync.js';
import { dataSection } from './data.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * Declarative layout of the entire settings panel. Grouped by section
 * for readability; each section renders a full-width header row followed
 * by one row per option.
 *
 * Every data-bound option's `id` MUST match a field of `Settings` —
 * typecheck catches the mismatch via the index read in
 * `controls.js#buildRow`.
 *
 * @type {SettingsSection[]}
 */
export const SECTIONS = [
  expeditionsSection,
  colonizationSection,
  displaySection,
  syncSection,
  dataSection,
];
