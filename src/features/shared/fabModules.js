// @ts-check

// Identity table for the four COMMAND modules the unified FAB hosts
// (sendExpedition / sendColony / sendLifeform / dailyRun) — the single source
// of truth for each module's (name, signature colour, glyph, visibility
// settings key) tuple. Everything that renders a module's identity reads it
// from here so the representations can never diverge:
//
//   • the feature passes `FAB_MODULES.<id>` as its `module` meta to
//     createButton → the satellite orb / in-button oczko (unifiedFab.js),
//   • the feature's pure.js re-exports `.color` as its idle rim constant
//     (the orb deliberately wears the module's IDLE rim colour),
//   • the settings "module bar" (settingsUi) draws one toggle tile per entry
//     — the tile's dome is pixel-identical to the module's orb.
//
// Spy / Guardian / Abandon also ride the FAB but are NOT here: their
// visibility is not governed by the settings module bar (own toggle /
// alert-driven / contextual), so they keep inline `module` meta.
//
// Pure data (strings only) — safe for pure.js imports.

import {
  COMET_GLYPH,
  LANDER_GLYPH,
  DNA_GLYPH,
  PLANET_ARROW_GLYPH,
} from './buttonGlyphs.js';

/**
 * One command-module identity. The `id`/`name`/`color`/`glyph` quartet is
 * shape-compatible with unifiedFab's `FabModuleMeta`, so an entry is passed
 * to `createButton({ module })` as-is; `settingKey` is the extra field the
 * settings module bar binds its tile to.
 *
 * @typedef {object} FabModule
 * @property {string} id    stable module id ('exp' | 'col' | 'lf' | 'fs').
 * @property {string} name  module name — orb aria-label AND the tile caption.
 * @property {string} color signature colour (orb dome, oczko, tile accent);
 *                          by design the module's IDLE rim colour.
 * @property {string} glyph inner SVG markup (buttonGlyphs.js).
 * @property {keyof import('../../state/settings.js').Settings} settingKey
 *                          boolean Settings field toggling the module's
 *                          visibility on the FAB.
 */

/**
 * The four command modules, in FAB menu / settings-bar order. Keyed for the
 * features (`FAB_MODULES.exp`); iterate `Object.values(...)` for the bar.
 *
 * @type {{ exp: FabModule, col: FabModule, lf: FabModule, fs: FabModule }}
 */
export const FAB_MODULES = {
  exp: {
    id: 'exp',
    name: 'Expeditions',
    color: '#4aa8ff',
    glyph: COMET_GLYPH,
    settingKey: 'showExpeditionButton',
  },
  col: {
    id: 'col',
    name: 'Colonization',
    color: '#12b3c2',
    glyph: LANDER_GLYPH,
    settingKey: 'showColonizeButton',
  },
  lf: {
    id: 'lf',
    name: 'Lifeforms',
    color: '#a78bfa',
    glyph: DNA_GLYPH,
    settingKey: 'showLifeformButton',
  },
  fs: {
    id: 'fs',
    name: 'Daily Run',
    color: '#34d96e',
    glyph: PLANET_ARROW_GLYPH,
    settingKey: 'showDailyRunButton',
  },
};
