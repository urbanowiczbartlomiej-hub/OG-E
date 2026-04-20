// Entry — isolated-world content script.
//
// Loaded at `document_start` (per manifest), so whatever runs here runs
// before the game paints a single pixel. The FIRST thing we do is install
// the black-background anti-flicker style — any subsequent failures can't
// leave the user staring at a white flash.
//
// Feature modules will plug in here as the rewrite progresses. Keep this
// file tiny: its only job is bootstrap order. No logic lives here.

import { installBlackBackground } from './features/blackBg.js';

installBlackBackground();

// Feature bootstraps (Phase 3+) land below this line. They are expected to
// defer their own work to DOMContentLoaded / later if needed — this entry
// file simply imports and calls.
