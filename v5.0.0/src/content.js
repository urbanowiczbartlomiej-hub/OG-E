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
//      abandonOverview, smallPlanetDetector, settingsUi, agrLogoRewire,
//      readabilityBoost.
//      Each is a standalone `install*` function that hooks into the DOM
//      / events it needs. Order is not load-bearing today — none of
//      these features depend on each other's DOM — but we follow the
//      "passive data → visible UI" mental grouping: colonyRecorder
//      (observes overview) and badges (observes planet list) first,
//      then the user-facing buttons, then the settings panel that
//      controls them all. The small-planet banner sits with the
//      user-facing overlays — it is a pure tooltip read on `#planetList`
//      that paints a banner for the first colony below the
//      `colMinFields` threshold (no persisted state, see
//      `smallPlanetDetector.js`). readabilityBoost is CSS-only and runs
//      at the very top of the file next to blackBg — both inject a
//      stylesheet and need no DOM beyond `documentElement`.
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
// Note: the abandon flow is split across two modules:
//   - `abandon.js`     — the 3-click flow with overlay buttons inside
//                        game popups. Exports `abandonPlanet()` + `checkAbandonState()`.
//   - `abandonOverview.js` — the UI entry point: a big red overlay on
//                        `#planet` div on overview pages that triggers
//                        `abandonPlanet()`. Independent from sendCol.

import { installBlackBackground } from './features/blackBg.js';
import { installReadabilityBoost } from './features/readabilityBoost.js';

installBlackBackground();
installReadabilityBoost();

import { initHistoryStore } from './state/history.js';
import { initScansStore } from './state/scans.js';
import { initRegistryStore } from './state/registry.js';
import { initSettingsStore } from './state/settings.js';
import { installSettingsMirror } from './state/settingsMirror.js';

import { installColonyRecorder } from './features/colonyRecorder.js';
import { installBadges } from './features/badges.js';
import { installSendExp } from './features/sendExp.js';
import { installSendCol } from './features/sendCol.js';
import { installAbandonOverview } from './features/abandonOverview.js';
import { installFreshPlanetDetector } from './features/freshPlanetDetector.js';
import { installSettingsUi } from './features/settingsUi.js';
import { installAgrLogoRewire } from './features/agrLogoRewire.js';
import { installFleetdispatchShortcut } from './features/fleetdispatchShortcut.js';

import { installSync } from './sync/scheduler.js';

// State persistence — settings first so other stores and features that
// read settings at install time see the hydrated values, not defaults.
//
// `initScansStore` also auto-installs the `oge5:galaxyScanned` MAIN-world
// bridge listener internally (see `state/scans.js`), so nothing extra is
// needed here to hook the galaxy XHR observer up to the store. Before
// that was internalised, a separate `installScansListener()` call had to
// be remembered as its own step — a bug-class that actually bit us in
// Phase 10 when the listener was forgotten and every scan fired into a
// void.
initSettingsStore();
initHistoryStore();
initScansStore();
initRegistryStore();
installSettingsMirror();

// Top-frame-only: sync scheduler. OGame embeds several iframes; running
// the gist round-trip in each would multiply API traffic for no gain
// (the data is identical across frames). Sync doesn't touch the DOM
// (only chrome.storage + HTTP + store subscriptions), so it's safe to
// install before DOMContentLoaded.
if (window.top === window.self) {
  installSync();
}

// Every feature below touches the DOM on install — at `document_start`
// the HTML parser hasn't produced `<body>` yet, so e.g. badges.js's
// `MutationObserver.observe(document.body)` throws "Argument 1 is not
// an object" and aborts the whole bootstrap (every subsequent install
// would be skipped). Defer the DOM-touching installs to
// DOMContentLoaded so `document.body` exists and `getElementById` can
// resolve live nodes.
const installDomFeatures = () => {
  // Passive observers (data capture).
  installColonyRecorder();
  installBadges();

  // User-facing buttons.
  installSendExp();
  installSendCol();

  // Standalone overlay on overview for fresh-small colonies.
  // Independent from sendCol; reuses `abandonPlanet()` from abandon.js.
  installAbandonOverview();

  // Top-center banner for a freshly-colonized planet (usedFields === 0
  // in the planetList tooltip). Stateless: one pass at mount. The
  // banner disappears the moment the user builds anything on that
  // planet (next reload will see usedFields > 0). Independent from
  // abandonOverview — both overlays can coexist (banner on planetList
  // pages, abandon overlay on the opened planet's overview).
  installFreshPlanetDetector();

  // Keyboard shortcut on fleetdispatch — desktop users press
  // ArrowRight to advance through AGR/OGame's send panels.
  installFleetdispatchShortcut();

  // Settings panel — hooks into AGR's options menu. AGR is a hard
  // dependency per DESIGN.md §15 P3; if AGR isn't present the install
  // skips silently (no-op) and the panel simply doesn't appear.
  installSettingsUi();

  // Rewire AGR's otherwise-idle menu-logo anchor: swap its image to the
  // OG-E icon and make a click open AGR's menu + auto-expand our
  // settings tab. Same silent-no-op-without-AGR behaviour as settingsUi.
  installAgrLogoRewire();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    installDomFeatures();
  }, { once: true });
} else {
  installDomFeatures();
}
