// @ts-check

// Entry — isolated-world content script.
//
// Loaded at `document_start` (per manifest). The FIRST thing we do is
// install the black-background anti-flicker style — any subsequent
// failures can't leave the user staring at a white flash.
//
// After that we wire every piece the rest of the extension needs to
// see a game page come alive:
//
//   1. State stores (history / scans / registry / settings) — each has
//      its own `init*Store` that hydrates from storage and starts
//      write-through. Idempotent; called exactly once here.
//
//   2. Settings mirror — writes `colPositions` into chrome.storage so
//      the extension-origin histogram page can read it across origins.
//
//   3. Feature installs — colonyRecorder, badges, sendExp, sendCol,
//      settingsUi. Each is a standalone `install*` function that hooks
//      into the DOM / events it needs. Order is not load-bearing
//      today — none of these features depend on each other's DOM —
//      but we follow the "passive data → visible UI" mental grouping:
//      colonyRecorder (observes overview) and badges (observes
//      planet list) first, then the user-facing buttons, then the
//      settings panel that controls them all.
//
//   4. Sync scheduler — top-frame only. Gist calls are HTTP requests
//      to api.github.com; firing them from every iframe would multiply
//      that traffic by the number of embedded frames the game uses.
//      The v4 convention (`window.top === window.self`) maps 1:1 to
//      v5. The scheduler itself is idempotent but we short-circuit at
//      the entry so iframe instances don't even import it when not
//      needed (rollup can tree-shake the guarded branch in theory; in
//      practice the early return is what keeps runtime simple).
//
// Open item carried forward: `features/abandon.js` exports
// `abandonPlanet()` and `checkAbandonState()` but no `installAbandon`
// yet. Nothing here mounts the floating "Abandon" button that would
// invoke them. Flagged as a Phase 16 polish task; colonies can still
// be abandoned manually through the game UI until then.

import { installBlackBackground } from './features/blackBg.js';

installBlackBackground();

import { initHistoryStore } from './state/history.js';
import { initScansStore } from './state/scans.js';
import { initRegistryStore } from './state/registry.js';
import { initSettingsStore } from './state/settings.js';
import { installSettingsMirror } from './state/settingsMirror.js';

import { installColonyRecorder } from './features/colonyRecorder.js';
import { installBadges } from './features/badges.js';
import { installSendExp } from './features/sendExp.js';
import { installSendCol } from './features/sendCol.js';
import { installSettingsUi } from './features/settingsUi.js';

import { installSync } from './sync/scheduler.js';

// State persistence — settings first so other stores and features that
// read settings at install time see the hydrated values, not defaults.
initSettingsStore();
initHistoryStore();
initScansStore();
initRegistryStore();
installSettingsMirror();

// Passive observers (data capture).
installColonyRecorder();
installBadges();

// User-facing buttons.
installSendExp();
installSendCol();

// Settings panel — hooks into AGR's options menu. AGR is a hard
// dependency per DESIGN.md §15 P3; if AGR isn't present the install
// skips silently (no-op) and the panel simply doesn't appear.
installSettingsUi();

// Top-frame-only: sync scheduler. OGame embeds several iframes; running
// the gist round-trip in each would multiply API traffic for no gain
// (the data is identical across frames).
if (window.top === window.self) {
  installSync();
}
