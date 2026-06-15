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
//   2. Galaxy-Scan config — a per-universe chrome.storage store holding
//      the target positions + rescan policy, edited from the dashboard
//      (extension origin) and read in-game by the Scan button.
//
//   3. Feature installs — colonyRecorder, badges, sendExpedition, sendColony,
//      abandonOverview, freshPlanetDetector, settingsUi, agrLogo,
//      readabilityBoost.
//      Each is a standalone `install*` function that hooks into the DOM
//      / events it needs. Order is not load-bearing today — none of
//      these features depend on each other's DOM — but we follow the
//      "passive data → visible UI" mental grouping: colonyRecorder
//      (observes overview) and badges (observes planet list) first,
//      then the user-facing buttons, then the settings panel that
//      controls them all. The small-planet banner sits with the
//      user-facing overlays — it is a pure tooltip read on `#planetList`
//      that paints a banner for the first freshly-colonized planet
//      (`usedFields === 0`, no persisted state, see
//      `freshPlanetDetector.js`). readabilityBoost is CSS-only and runs
//      at the very top of the file next to antiFlickerBackground — both inject a
//      stylesheet and need no DOM beyond `documentElement`.
//
//   4. Sync scheduler — top-frame only. Gist calls are HTTP requests
//      to api.github.com; firing them from every iframe would multiply
//      that traffic by the number of embedded frames the game uses.
//      The `window.top === window.self` guard is the canonical way to
//      identify the top frame. The scheduler itself is idempotent but
//      we short-circuit at the entry so iframe instances don't even
//      import it when not needed (rollup can tree-shake the guarded
//      branch in theory; in practice the early return is what keeps
//      runtime simple).
//
// Note: the abandon flow is split across two files inside
// `features/abandon/`:
//   - `abandon/index.js`    — the 3-click flow with overlay buttons
//                             injected inside game popups. Exports
//                             `abandonPlanet()` + `checkAbandonState()`.
//   - `abandon/overview.js` — the UI entry point: a big red overlay on
//                             the `#planet` div on overview pages that
//                             triggers `abandonPlanet()`. Independent
//                             from sendColony.

import { installAntiFlickerBackground } from './features/antiFlickerBackground.js';
import { installReadabilityBoost } from './features/readabilityBoost.js';

installAntiFlickerBackground();
installReadabilityBoost();

import { initHistoryStore } from './state/history.js';
import { initScansStore } from './state/scans.js';
import { initRegistryStore } from './state/registry.js';
import { initSettingsStore } from './state/settings.js';
import { initDailyRunRoutesStore } from './state/dailyRunRoutes.js';
import { initGalaxyScanConfigStore } from './state/galaxyScanConfig.js';
import { initBodiesStore } from './state/bodies.js';
import { initSharedSettingsStore } from './state/sharedSettings.js';

import { installColonyRecorder } from './features/colonyRecorder.js';
import { installPlanetBarCapture } from './features/planetBarCapture.js';
import { installBadges } from './features/badges.js';
import { installSendExpedition } from './features/sendExpedition/index.js';
import { installSendColony } from './features/sendColony/index.js';
import { installSendLifeform } from './features/sendLifeform/index.js';
import { installDailyRun } from './features/dailyRun/index.js';
import { installAbandonOverview } from './features/abandon/overview.js';
import { installFreshPlanetDetector } from './features/freshPlanetDetector.js';
import { installSettingsUi } from './features/settingsUi/index.js';
import { installAgrLogo } from './features/agrLogo.js';
import { installFleetdispatchShortcut } from './features/fleetdispatchShortcut.js';
import { installEventMenuHighlight } from './features/eventMenuHighlight.js';
import { installTraderMenuHighlight } from './features/traderMenuHighlight.js';
import { installRewardingWatcher } from './features/rewardingWatcher.js';
import { installReminders } from './features/reminders/index.js';

import { installSync } from './sync/scheduler.js';

// All stores hydrate synchronously. localStorage is per-origin and the
// chrome.storage stores are namespaced per-universe (keyed on
// `location.host`), so settings/registry/history/scans are naturally
// isolated per OGame server.
//
// `initScansStore` also auto-installs the `oge:galaxyScanned` MAIN-world
// bridge listener internally (see `state/scans.js`), so nothing extra
// is needed here to hook the galaxy XHR observer up to the store.
initSettingsStore();
initRegistryStore();
initHistoryStore();
initScansStore();
// Daily-Run routes (per-universe, chrome.storage). Without this the
// in-game dailyRun buttons never see routes authored in the dashboard
// and the ad-hoc collect target wouldn't survive a page reload.
initDailyRunRoutesStore();
// Galaxy-Scan config (per-universe, chrome.storage). Hydrated here so the
// Scan button reads the user's positions + rescan policy, and edits made
// in the dashboard (a different origin) reach the in-game button.
initGalaxyScanConfigStore();
// Body inventory (per-universe, chrome.storage). Hydrated here so the
// planet-bar capture below can gate its first write on the hydrate and
// the dashboard route editor can read a snapshot of owned planets/moons.
initBodiesStore();
// Shared settings (GLOBAL, chrome.storage). The dashboard-editable subset of
// preferences (colonization thresholds, reminder schedules — see
// REFRESH-PLAN.md). Hydrated here so in-game features read the same values the
// dashboard writes, across the origin boundary localStorage can't cross.
initSharedSettingsStore();

// Reminder config lives in `settings.js` (regular localStorage Settings,
// authored in the in-game OG-E settings panel). Nothing extra to wire
// here — initSettingsStore was hydrated synchronously above.

// Top-frame-only: sync scheduler. OGame embeds several iframes;
// running the gist round-trip in each would multiply API traffic
// for no gain (the data is identical across frames). Sync doesn't
// touch the DOM (only chrome.storage + HTTP + store subscriptions),
// so it's safe to install before DOMContentLoaded.
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
  // Snapshot the planet bar (owned planets + moons) for the dashboard
  // route picker + route reconciliation. Top-frame only: the bar is
  // identical across OGame's iframes, so sub-frame captures would just
  // multiply storage writes.
  if (window.top === window.self) installPlanetBarCapture();
  installBadges();
  installEventMenuHighlight();
  installTraderMenuHighlight();
  installRewardingWatcher();

  // Reminders — the producer reads expedition return-flights + present
  // fleet legs from #eventContent and reconciles both wave and ad-hoc
  // reminders on ntfy.sh (state cached in the gist), and the event-list
  // badge UI drives the ad-hoc arming / wave cancelling. Top-frame only:
  // it does gist IO, and running it in OGame's embedded iframes would
  // multiply that API traffic for no gain (same reasoning as installSync).
  // The event box lives in the top frame.
  if (window.top === window.self) installReminders();

  // User-facing buttons — the four modules of the unified FAB
  // (features/shared/unifiedFab.js). All gated on the single fabMode
  // setting; exactly one is visible at a time and the FAB's orbital
  // picker switches between them. Install order = picker order only.
  installSendExpedition();
  installSendColony();
  // Lifeforms (system-discovery) button — walks the galaxy firing lifeform
  // discoveries, one system per tap. Independent of Send-Col.
  installSendLifeform();
  // Unified Daily Transport button (Send micro-fleets + Collect).
  installDailyRun();

  // Standalone overlay on overview for fresh-small colonies.
  // Independent from sendColony; reuses `abandonPlanet()` from
  // `features/abandon/index.js`.
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
  // dependency; if AGR isn't present the install skips silently
  // (no-op) and the panel simply doesn't appear.
  installSettingsUi();

  // Rewire AGR's otherwise-idle menu-logo anchor: swap its image to the
  // OG-E icon and make a click open AGR's menu + auto-expand our
  // settings tab. Same silent-no-op-without-AGR behaviour as settingsUi.
  installAgrLogo();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    installDomFeatures();
  }, { once: true });
} else {
  installDomFeatures();
}
