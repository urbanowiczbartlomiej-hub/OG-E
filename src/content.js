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
//      colonyFab, settingsUi, agrLogo, readabilityBoost, galaxyNavPanel.
//      Each is a standalone `install*` function that hooks into the DOM
//      / events it needs. Order is not load-bearing today — none of
//      these features depend on each other's DOM — but we follow the
//      "passive data → visible UI" mental grouping: colonyRecorder
//      (observes overview) and badges (observes planet list) first,
//      then the user-facing buttons, then the settings panel that
//      controls them all. The colony FAB module sits with the other FAB
//      buttons — it reads `#planetList` (`usedFields === 0`) + the overview
//      diameter to switch between "new colony" and "abandon" states (see
//      `features/abandon/colonyFab.js`). readabilityBoost is CSS-only and runs
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
// Note: the colony detect + abandon flow lives in `features/abandon/`:
//   - `abandon/detect.js`   — pure `#planetList` detection helpers
//                             (`findFirstFreshPlanet`, overview-cp/url).
//   - `abandon/index.js`    — the 3-step abandon stepper + safety gates
//                             (`createAbandonFlow()` + `checkAbandonState()`).
//   - `abandon/colonyFab.js`— the unified FAB module (navigate ↔ abandon
//                             states) that drives both; `installColonyFab()`.

import { installAntiFlickerBackground } from './features/antiFlickerBackground.js';
import { installReadabilityBoost } from './features/readabilityBoost.js';

installAntiFlickerBackground();
installReadabilityBoost();

import { initHistoryStore } from './state/history.js';
import { initScansStore } from './state/scans.js';
import { initPlayersStore } from './state/players.js';
import { initRegistryStore } from './state/registry.js';
import { initSettingsStore } from './state/settings.js';
import { initSharedSettings } from './state/sharedSettings.js';
import { initDailyRunRoutesStore } from './state/dailyRunRoutes.js';
import { initGalaxyScanConfigStore } from './state/galaxyScanConfig.js';
import { initAlarmClockConfigStore } from './state/alarmClockConfig.js';
import { initBodiesStore } from './state/bodies.js';
import { initColonizeDecisionsStore } from './state/colonizeDecisions.js';
import { initTargetReportsStore } from './state/targets.js';
import { initProximityReportsStore } from './state/proximityReports.js';
import { initWatchListStore } from './state/watchList.js';
import { initActivityObsStore } from './state/activityObs.js';
import { initPresenceLedgerStore } from './state/presenceLedger.js';

import { installColonyRecorder } from './features/colonyRecorder.js';
import { installPlanetBarCapture } from './features/planetBarCapture.js';
import { installOwnProfile } from './features/ownProfile.js';
import { installBadges } from './features/badges/index.js';
import { installSendExpedition } from './features/sendExpedition/index.js';
import { installSendColony } from './features/sendColony/index.js';
import { installSendSpy } from './features/sendSpy/index.js';
import { installSendLifeform } from './features/sendLifeform/index.js';
import { installDailyRun } from './features/dailyRun/index.js';
import { installColonyFab } from './features/abandon/colonyFab.js';
import { installSettingsUi } from './features/settingsUi/index.js';
import { installAgrLogo } from './features/agrLogo.js';
import { installAgrGuard } from './features/agrGuard.js';
import { installFleetdispatchShortcut } from './features/fleetdispatchShortcut.js';
import { installManualFsMark } from './features/manualFsMark/index.js';
import { installEventMenuHighlight } from './features/eventMenuHighlight.js';
import { installTraderMenuHighlight } from './features/traderMenuHighlight.js';
import { installGalaxyNavPanel } from './features/galaxyNavPanel.js';
import { installThreatHighlight } from './features/threatHighlight/index.js';
import { installRewardingWatcher } from './features/rewardingWatcher.js';
import { installWhosSpyingPanel } from './features/whosSpyingPanel.js';
import { installArtifactShopWatcher } from './features/artifactShopWatcher.js';
import { installAlarmClock } from './features/alarmClock/index.js';
import { installApiContext } from './features/apiContext/index.js';
import { installTargetsIngest } from './features/targetsIngest/index.js';
import { installAllianceClassIngest } from './features/allianceClassIngest/index.js';

import { installSync } from './sync/scheduler.js';

import { isStandalonePage } from './domain/ogameUrl.js';
import { logger } from './lib/logger.js';

// Store hydration is mixed. The localStorage-backed stores (settings,
// registry) hydrate synchronously; the chrome.storage-backed stores
// (history, scans, players, dailyRunRoutes, galaxyScanConfig,
// alarmClockConfig, bodies, colonizeDecisions, targets, watchList) load
// asynchronously via `chromeStore.get` — until their `when*Hydrated()`
// gate resolves, consumers see the initial value, so a feature that writes
// before awaiting that gate would clobber the persisted blob (the race the
// gates exist to prevent). localStorage is per-origin and the
// chrome.storage stores are namespaced per-universe (keyed on
// `location.host`), so state is isolated per OGame server.
//
// `initScansStore` also auto-installs the `oge:galaxyScanned` MAIN-world
// bridge listener internally (see `state/scans.js`), so nothing extra
// is needed here to hook the galaxy XHR observer up to the store.
initSettingsStore();
// Bridge the four dashboard-owned shared settings (cloudSync / gistToken /
// alarmClock master + ntfy token) from chrome.storage into the just-hydrated
// settings store. Async (chrome.storage), fire-and-forget — every consumer
// keeps reading settingsStore, which this keeps current. See state/sharedSettings.js.
void initSharedSettings();
initRegistryStore();
initHistoryStore();
initScansStore();
// Player-metadata cache (per-universe, chrome.storage). Subscribes to the
// same `oge:galaxyScanned` event as the scans store and de-duplicates the
// richer per-player signals (active / strong / newbie / buddy / alliance
// member / outlaw / alliance rank) by playerId for Colony Scout analysis.
initPlayersStore();
// Daily-Run routes (per-universe, chrome.storage). Without this the
// in-game dailyRun buttons never see routes authored in the dashboard
// and the ad-hoc collect target wouldn't survive a page reload.
initDailyRunRoutesStore();
// Galaxy-Scan config (per-universe, chrome.storage). Hydrated here so the
// Scan button reads the user's positions + rescan policy, and edits made
// in the dashboard (a different origin) reach the in-game button.
initGalaxyScanConfigStore();
// AlarmClock config (wave enable + schedule, ad-hoc lead time, message
// templates; per-universe, chrome.storage). Hydrated here so the in-game
// alarmClock producer + event-list badges read the user's cadence, and edits
// made in the dashboard (a different origin) reach the in-game features.
initAlarmClockConfigStore();
// Body inventory (per-universe, chrome.storage). Hydrated here so the
// planet-bar capture below can gate its first write on the hydrate and
// the dashboard route editor can read a snapshot of owned planets/moons.
initBodiesStore();
// Colonization decision log (per-universe, chrome.storage). The small
// "looks-free-but-isn't" correction set (sent/mine/abandoned/taken/reserved)
// the picker subtracts and the Scout flags — and the only colonization state
// destined for gist sync (it's what the public API can't reproduce).
initColonizeDecisionsStore();
// Espionage-report cache (per-universe, chrome.storage). The in-game ingest
// consumer (installTargetsIngest) writes opened spy reports here; the dashboard
// Targets sub-tab reads them to estimate hidden (fleet-saved) fleet.
initTargetReportsStore();
// Proximity-alert feed (per-universe, chrome.storage). The SAME ingest consumer
// writes "foreign fleet spotted near your planet" alerts here; the dashboard
// Spyglass "Who's spying on you" strip reads them.
initProximityReportsStore();
// Watch-list (per-universe, chrome.storage). Hydrated here so the in-game scan
// FAB sees the players the user starred in the dashboard Targets sub-tab.
initWatchListStore();
// Galaxy-activity rings (per-universe, chrome.storage). Auto-installs its own
// `oge:galaxyScanned` listener (like initScansStore) and records watched
// players' per-body activity markers — the routine tracker's dense, probe-free
// second source. Reads the watch list above for its watched-only write gate.
initActivityObsStore();

// Long-horizon presence ledger (months-scale day×hour memory of "seen active /
// looked & quiet" — outlives the rings' 45-day sweep). Re-folds from the two
// ring stores on a debounce; the rings' hydrate echo triggers the first fold
// of each page load, so backfill needs no explicit call here.
initPresenceLedgerStore();

// The alarmClock master switch + ntfy token live in `settings.js` (regular
// localStorage Settings, authored in the in-game OG-E settings panel) — wired
// by initSettingsStore above. The detailed alarmClock config moved to the
// dashboard: per-server fleet-save knobs in galaxyScanConfig, the per-server
// wave/ad-hoc knobs in alarmClockConfig — both inited above.

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
  // Per-feature error isolation. OG-E is a parasite on volatile game/AGR
  // DOM, so a single game-update-induced throw in one install must NOT
  // abort the rest of the bootstrap (which would silently disable every
  // feature installed after it — logger is off by default, so nothing
  // reaches the console). Each install runs inside try/catch that routes
  // the error through logger.error, degrading a one-feature breakage to a
  // one-feature outage instead of a whole-extension outage. Install order
  // is preserved exactly; the top-frame `window.top === window.self` guards
  // stay outside safeInstall so a sub-frame still skips (rather than runs)
  // the top-frame-only features.
  /**
   * @param {string} name Feature name for the error log.
   * @param {() => void} fn The feature's `install*()` entry point.
   */
  const safeInstall = (name, fn) => {
    try {
      fn();
    } catch (err) {
      logger.error(`[content] install ${name} threw`, err);
    }
  };

  // Standalone sub-pages (?page=standalone&component=empire | combatsim | …)
  // render without AGR and are self-contained tables/overlays, so OG-E's
  // floating FAB and the AGR-missing banner just clutter them (and the banner
  // would be a false positive there — AGR is installed, the sub-page simply
  // doesn't host its menu). `uiInstall` is `safeInstall` that additionally
  // skips those pages; the visible-UI features below use it, while passive
  // capture keeps plain `safeInstall`.
  const onStandalone = isStandalonePage(location.href);
  /**
   * @param {string} name Feature name for the error log.
   * @param {() => void} fn The feature's `install*()` entry point.
   */
  const uiInstall = (name, fn) => {
    if (!onStandalone) safeInstall(name, fn);
  };

  // Passive observers (data capture).
  safeInstall('colonyRecorder', installColonyRecorder);
  // Snapshot the planet bar (owned planets + moons) for the dashboard
  // route picker + route reconciliation. Top-frame only: the bar is
  // identical across OGame's iframes, so sub-frame captures would just
  // multiply storage writes.
  if (window.top === window.self) safeInstall('planetBarCapture', installPlanetBarCapture);
  // Own profile — scrape our rank / honour class off the header bar once so
  // Colony Scout can score neighbours relative to us. Top-frame only (the
  // header bar lives there; one write per page load suffices).
  if (window.top === window.self) safeInstall('ownProfile', installOwnProfile);
  safeInstall('badges', installBadges);
  safeInstall('eventMenuHighlight', installEventMenuHighlight);
  safeInstall('traderMenuHighlight', installTraderMenuHighlight);
  // Galaxy touch nav — a big-button mirror of the galaxy header's controls
  // below the system table, for mobile. Shares the readabilityBoost toggle;
  // self-gates to `component=galaxy` pages (no-op install elsewhere).
  safeInstall('galaxyNavPanel', installGalaxyNavPanel);
  // Loud under-attack alert (opt-in via Display settings). Top-frame only:
  // the `#attack_alert` flag + event box live there, and a single overlay
  // must not be multiplied across OGame's embedded iframes.
  if (window.top === window.self) safeInstall('threatHighlight', installThreatHighlight);
  // Who's-spying-on-you table — reads the proximity log + injects an OG-E table
  // at the top of the messages page's spy-report tab (above AGR's own spy
  // overview), the defensive mirror of AGR's offensive scan list. Top-frame
  // only: the messages UI is the top-level page (one MutationObserver is plenty).
  if (window.top === window.self) safeInstall('whosSpyingPanel', installWhosSpyingPanel);
  safeInstall('rewardingWatcher', installRewardingWatcher);
  safeInstall('artifactShopWatcher', installArtifactShopWatcher);
  // Espionage-report ingestion — a MutationObserver reads each report's
  // rawMessageData straight from the rendered messages DOM and records it for
  // the dashboard Targets sub-tab. DOM-based (not an XHR hook) because the
  // messages component fetches via fetch(), which observeXHR can't see. Top
  // frame only: the messages UI is the top-level page.
  if (window.top === window.self) safeInstall('targetsIngest', installTargetsIngest);
  // Alliance-CLASS harvester — reads the class token off each row of the in-game
  // ALLIANCE highscore (category=2), the only machine-readable source besides a
  // spy report (the XML API omits alliance class). Feeds the danger model's
  // 'warrior alliance' apex tell for EVERY member, no spying. DOM-based (the
  // pager loads pages via ajax) and top-frame only, same as targetsIngest.
  if (window.top === window.self) safeInstall('allianceClassIngest', installAllianceClassIngest);
  // OGame public-API context (per-device occupancy breadth for colonization).
  // Warms the per-device occupancy cache on every load (cache-gated, so the
  // multi-MB universe.xml is fetched at most weekly) and publishes the
  // occupancy index to the shared handoff for the colonize picker + Colony
  // Scout. The `oge_debugApi` flag swaps the silent build for a console probe.
  // Top-frame only: universe.xml is multi-MB and identical across the game's
  // iframes, so a per-frame fetch would just multiply traffic.
  if (window.top === window.self) safeInstall('apiContext', installApiContext);

  // AlarmClock — the producer reads expedition return-flights + present
  // fleet legs from #eventContent and reconciles both wave and ad-hoc
  // alarmClock on ntfy.sh (state cached in the gist), and the event-list
  // badge UI drives the ad-hoc arming / wave cancelling. Top-frame only:
  // it does gist IO, and running it in OGame's embedded iframes would
  // multiply that API traffic for no gain (same reasoning as installSync).
  // The event box lives in the top frame.
  if (window.top === window.self) safeInstall('alarmClock', installAlarmClock);

  // User-facing buttons — the four modules of the unified FAB
  // (features/shared/unifiedFab.js). Each gated on its own show*Button
  // setting (the settings module bar); exactly one is visible at a time and
  // the FAB's orbital picker switches between them. Install order = picker
  // order only.
  uiInstall('sendExpedition', installSendExpedition);
  uiInstall('sendColony', installSendColony);
  // Lifeforms (system-discovery) button — walks the galaxy firing lifeform
  // discoveries, one system per tap. Independent of Send-Col.
  uiInstall('sendLifeform', installSendLifeform);
  // Unified Daily Transport button (Send micro-fleets + Collect).
  uiInstall('dailyRun', installDailyRun);
  // Espionage-scan button — walks the dashboard watch-list firing probes, one
  // planet per tap, then jumps to messages. Mounts only when players are
  // starred (so it's absent until there's something to scan).
  uiInstall('sendSpy', installSendSpy);

  // Unified FAB colony module — folds the old fresh-planet banner and the
  // red abandon overlay into ONE button on the FAB: a fresh colony elsewhere
  // shows a "new colony" button that navigates to it; on that colony's
  // overview the button becomes "abandon" and its taps drive the flow
  // (features/abandon/colonyFab.js + abandon/index.js). Contextual — mounts
  // only when its flow states apply, no settings gate.
  uiInstall('colonyFab', installColonyFab);

  // Keyboard shortcut on fleetdispatch — desktop users press
  // ArrowRight to advance through AGR/OGame's send panels.
  safeInstall('fleetdispatchShortcut', installFleetdispatchShortcut);

  // Manual landed-FS mark — an inline chip on fleet1 to flag the fleet sitting
  // on this body as a fleet-save (lights the badge + arms the guardian). Top
  // frame only: fleetdispatch is the top-level page, so the MutationObserver
  // never needs to run in OGame's embedded iframes.
  if (window.top === window.self) safeInstall('manualFsMark', installManualFsMark);

  // Settings panel — hooks into AGR's options menu. AGR is a hard
  // dependency; if AGR isn't present the install skips silently
  // (no-op) and the panel simply doesn't appear.
  safeInstall('settingsUi', installSettingsUi);

  // Rewire AGR's otherwise-idle menu-logo anchor: swap its image to the
  // OG-E icon and make a click open AGR's menu + auto-expand our
  // settings tab. Same silent-no-op-without-AGR behaviour as settingsUi.
  safeInstall('agrLogo', installAgrLogo);

  // AGR-missing guard — OG-E hard-depends on AGR; if it never hydrates,
  // show a dismissible top-of-page banner prompting the user to install
  // it. The notice can't live in the settings panel (that panel lives
  // inside AGR's menu, which is exactly what's absent). Top-frame only:
  // one banner, not one per OGame iframe.
  if (window.top === window.self) uiInstall('agrGuard', installAgrGuard);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    installDomFeatures();
  }, { once: true });
} else {
  installDomFeatures();
}
