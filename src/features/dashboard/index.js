// @ts-check

// OG-E Dashboard page entry — bootstrap + universe selector +
// storage-change re-render.
//
// Loads data via chromeStore, invokes the render modules, and listens
// for chrome.storage.onChanged to refresh. The dashboard page is
// extension-origin and read-only: we don't wire state persistence
// (initHistoryStore / initScansStore), because that's for the
// game-origin content script's write-through. Here we simply read the
// same keys on demand and re-render when they change.
//
// # Per-universe scope
//
// `chrome.storage.local` holds one slice of data per OGame universe
// the player has played on (keys are namespaced
// `<universeId>:oge_colonyHistory` / `<universeId>:oge_galaxyScans`).
// The page exposes a server-selector dropdown so the player can flip
// between universes; every Export/Import/Clear/ResetGalaxy/Sync action
// targets the currently-selected universe. The initial selection comes
// from a `?host=<universeId>` URL param (set by the Settings "Open
// histogram" button so opening from server X auto-selects X); if the
// param is absent or names an unknown universe we fall back to the
// first universe found in storage.
//
// # Data flow
//
//   install() → wait for DOMContentLoaded → wireDom() → discoverUniverses()
//   → resolveInitialUniverse() → populateUniverseSelect() → loadAll()
//   → render{Colony, Galaxy}() → wireListeners() → chromeStore.onChanged
//   hook.
//
//   User-driven mutations (import, reset, clear) write to chromeStore,
//   which fires onChanged in this same tab, which calls loadAll() +
//   render*() again. The listener only re-renders when one of the
//   selected universe's keys changed — events for other universes are
//   ignored to avoid spurious re-renders.
//
//   Changing the universe selector resets the module-scope cache and
//   re-runs loadAll() + render*() against the new universe's keys.
//
// @see ./colony.js  — renderColonyChart + populatePositionFilter
// @see ./io.js      — Export/Import/CSV + tombstones (all universe-scoped)

import { chromeStore, safeLS } from '../../lib/storage.js';
import { debounce } from '../../lib/debounce.js';
import { parseTargetPositions } from '../../domain/histogram.js';
import { populatePositionFilter, renderColonyChart } from './colony.js';
import { renderFreeRegions, renderServerMap, selectCandidate, resetFreeSelection, highlightPin, _resetFreeStreakForTest } from './freeStreak.js';
import { chipValue, setChipValue, wireChips, setChipsEnabled, toggleChipOn, setToggleChip, wireToggleChip } from './chips.js';
import { digestProximityReports } from '../../domain/proximityDigest.js';
import { computeComposite, computeScoreField, renderPositionsMap, RELATIONSHIP_COLORS } from './mapPrimitives.js';
import { renderTargets, DEFAULT_TARGET_SORT } from './targets.js';
import { ZONES } from '../../domain/zoneScore.js';
import { buildOccupancyIndex } from '../../domain/apiOccupancy.js';
import { buildTargetCandidates } from '../../domain/targets.js';
import { buildDangerProfiles } from '../../domain/dangerScore.js';
import { buildCivilBaseline } from '../../domain/civilBaseline.js';
import { estimateHiddenFleet } from '../../domain/threatModel.js';
import { raidVerdict } from '../../domain/raidVerdict.js';
import { normalizeReportTimestamps } from '../../domain/espionageReport.js';
import { latestOf, historyOf } from '../../domain/targetReports.js';
import { summarizeRoutine } from '../../domain/routine.js';
import { readApiCacheFor, apiCacheKeyFor } from '../../state/apiCache.js';
import { targetReportsKeyFor } from '../../state/targets.js';
import { proximityReportsKeyFor } from '../../state/proximityReports.js';
import { watchListKeyFor, normalizeWatchList, DEFAULT_SPY_PROBES } from '../../state/watchList.js';
import { pointsOf } from '../../domain/unitCosts.js';
import {
  HISTORY_KEY_BASE,
  historyKeyFor,
} from '../../state/history.js';
import {
  SCANS_KEY_BASE,
  scansKeyFor,
} from '../../state/scans.js';
import { playersKeyFor } from '../../state/players.js';
import { readOwnProfile, ownProfileKeyFor } from '../../state/ownProfile.js';
import {
  GALAXY_SCAN_CONFIG_KEY_BASE,
  galaxyScanConfigKeyFor,
} from '../../state/galaxyScanConfig.js';
import {
  exportAllData,
  importAllData,
  exportColonyCsv,
} from './io.js';
import { installAlarmClock, _resetAlarmClockForTest } from './alarmClock.js';
import { installRoutes } from './routes.js';
import { installScanColonyConfig } from './scanConfig.js';
import { installAlarmClockConfig } from './alarmClockConfig.js';
import { installSync } from './sync.js';
import { installSettingsControls } from './settingsControls.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

// Colony Scout control preferences — persisted so selections survive page reload.
const SCOUT_PREFS_KEY = 'oge_colonyScoutPrefs';

// Active Colonizations sub-tab ("histogram" = Big Colony Hunting, "scout" =
// Galaxy Viewer) — device-local UI preference, so a reload reopens the view
// the user actually works in.
const COLONY_SUBTAB_LS_KEY = 'oge_colonySubtab';

// Targets sub-tab preferences (currently just the chosen column sort) —
// device-local, survives reload. Keyed separately from the Scout prefs above.
const TARGET_PREFS_KEY = 'oge_targetPrefs';

/** @type {import('./targets.js').TargetSort} */
let targetSort = { ...DEFAULT_TARGET_SORT };

// Watch-list: the player ids the user has starred in the Targets table.
// Per-universe (ids are universe-scoped). Lives in chrome.storage.local (via
// state/watchList.js) — NOT localStorage — because the in-game scan FAB (game
// origin) must read it; localStorage is per-origin. The dashboard keeps an
// in-memory Set for fast star toggles and write-throughs the array to
// chrome.storage. (Legacy safeLS data from M4 is migrated on first load.)
const WATCHED_LS_KEY_BASE = 'oge_watchedPlayers'; // legacy localStorage key (migration source)
const legacyWatchedKeyFor = (/** @type {string} */ universeId) =>
  `${universeId}:${WATCHED_LS_KEY_BASE}`;

/** @type {Set<string>} Watched player ids for the selected universe. */
const watchedPlayers = new Set();

/**
 * Re-scan flags for the selected universe: player id / "g:s:p" coord →
 * epoch-ms "treat reports older than this as needing a re-scan". Loaded with the
 * watch-list, written alongside it. @type {Record<string, number>}
 */
let rescanMap = {};

/**
 * Player id → user-assigned relationship tag (enemy/friend/neutral) for the
 * selected universe — the Spyglass map marker colour. Loaded/written with the
 * watch-list. @type {Record<string, import('../../state/watchList.js').Relationship>}
 */
let watchRelationships = {};

/**
 * Player ids whose Targets detail row (planets + spy links) is expanded.
 * Ephemeral session state — not persisted (re-deriving it on reload would mean
 * re-opening rows the user has since closed). Mutated in place so expansion
 * survives a repaint.
 * @type {Set<string>}
 */
const expandedTargets = new Set();

/**
 * Player id (string) to scroll to + highlight on the next Targets repaint,
 * then cleared — set when a Galaxy Viewer "Top threats" row deep-links into
 * Spyglass. The highlight class lives on the freshly-rendered row and clears
 * itself on the following repaint (rows are rebuilt wholesale).
 * @type {string | null}
 */
let focusedTargetId = null;

// localStorage key for the active dashboard tab. Per-device UI prefs.
// Possible values are the `data-tab` attributes from dashboard.html:
// `'colony'`, `'spyglass'`, `'alarmClock'`, `'routes'`, `'sync'`. Anything
// unrecognised — including the retired `'free'` / `'galaxy'` (folded into the
// Colonizations sub-tabs) — falls back to `'colony'` (the page's first tab). The
// key keeps its legacy `oge_histogram` name so the saved preference survives the
// rename.
const ACTIVE_TAB_LS_KEY = 'oge_histogramTab';
const DEFAULT_TAB = 'colony';

// ── Module-local caches ────────────────────────────────────────────────

/**
 * Currently-selected universe id (e.g. `'s163-pl'`). Populated by
 * `resolveInitialUniverse` at boot and updated by the selector
 * onchange handler. All `loadAll` calls and io.js delegations key off
 * this value.
 *
 * @type {string}
 */
let selectedUniverseId = '';

/**
 * Handle to the alarmClock module's refresh entrypoint, set by
 * `installAlarmClock` at boot. Called from the universe-selector change
 * handler so the alarmClock tab repaints with the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let alarmClockApi = null;

/**
 * Handle to the FS-routes tab's refresh entrypoint, set by
 * `installRoutes` at boot. Called from the universe-selector change
 * handler so the routes textarea reloads for the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let routesApi = null;

/**
 * Handle to the combined scan/colonization config editor's refresh entrypoint,
 * set by `installScanColonyConfig` at boot. It owns the per-universe
 * galaxyScanConfig slot (colonization knobs + scan re-scan policy) under the
 * Colonizations tab's ⚙ Settings; the universe-selector change handler refreshes
 * it so its fields reload for the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let scanColonyConfigApi = null;

/**
 * Handle to the fleet-save alarmClock config editor's refresh entrypoint, set by
 * `installAlarmClockConfig` at boot. Called from the universe-selector change
 * handler so the fleet-save fields reload for the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let alarmClockConfigApi = null;

/** @type {ColonyEntry[]} */
let history = [];

/** @type {GalaxyScans} */
let scans = {};

/**
 * Per-universe API occupancy index, built in `loadAll` from the local API cache
 * (`state/apiCache.js`, populated in-game by `features/apiContext`). Gives the
 * Colony Scout whole-server reach: the free-region finder runs over a composite
 * of this (breadth) overlaid by `scans` (live freshness). `null` until a
 * universe with cached API data loads — then the Scout falls back to live scans
 * alone (today's behaviour).
 * @type {import('../../domain/apiOccupancy.js').OccupancyIndex | null}
 */
let apiIndex = null;

/**
 * Grid bounds from the cached serverData, needed to enumerate fully-empty
 * systems in the synthetic scan map. `{}` until API data loads.
 * @type {{ galaxies?: number, systems?: number, donutGalaxy?: boolean, donutSystem?: boolean, domain?: string }}
 */
let apiBounds = {};
/** Our own military-highscore points (from the API), for the map's threat intensity. @type {number|undefined} */
let ownMilitary;

/**
 * Raw per-universe API cache (`state/apiCache.js`), loaded in `loadAll`. Held so
 * the Targets sub-tab can read the players/total/military feeds (own-score for
 * the noob-protection band, own-alliance for the ally exclusion). `{}` until a
 * universe with cached API data loads.
 * @type {import('../../state/apiCache.js').ApiCache}
 */
let apiCache = {};

/**
 * Candidate target rows joined from the API feeds (`domain/targets.js`), rebuilt
 * by `loadAll`. The Targets sub-tab filters/sorts this on each repaint.
 * @type {import('../../domain/targets.js').TargetCandidate[]}
 */
let targetCandidates = [];

/**
 * Opened espionage reports for the selected universe (`state/targets.js`),
 * keyed playerId → bodyKey → report. Drives the hidden-fleet estimate.
 * @type {import('../../state/targets.js').TargetReports}
 */
let targetReports = {};

/**
 * "Foreign fleet spotted near your planet" alerts for the selected universe
 * (`state/proximityReports.js`), newest-first. Drives the Spyglass
 * "🛡 Who's been near you" strip.
 * @type {import('../../domain/espionageReport.js').ProximityReport[]}
 */
let proximityReports = [];

/**
 * Planet count per player from the universe.xml snapshot — the coverage
 * denominator ("spied X / Y planets") for the hidden-fleet estimate.
 * @type {Record<string, number>}
 */
let planetCountByPlayer = {};

/**
 * Per-universe player-metadata cache (`state/players.js`), loaded alongside
 * `scans` and forwarded to Colony Scout so neighbourhood scoring can use the
 * richer strong/newbie/buddy/outlaw/ally signals. `{}` until a universe loads.
 * @type {import('../../state/players.js').PlayerCache}
 */
let players = {};

/**
 * Our own standing on the selected server (`state/ownProfile.js`), read from
 * the in-game header bar. `rank` anchors Colony Scout's relative-strength
 * display ("#11 (239 above you)"). `{}` until a universe loads.
 * @type {import('../../state/ownProfile.js').OwnProfile}
 */
let ownProfile = {};

/**
 * Per-player danger profiles (v2) for the selected universe — the threat
 * substrate the Galaxy Viewer field + occupancy map read. Rebuilt in
 * `loadAll` from the API feeds (military+ships, destroyed, honour, alliance,
 * planet dispersion) + the live player-flag cache. Empty until a universe
 * with API data loads.
 * @type {Map<number, import('../../domain/dangerScore.js').DangerProfile>}
 */
let dangerProfiles = new Map();

/**
 * Per-player civil-fleet baseline (Etap C) — expected civil ships from the
 * economy feed + the combat-ship surplus over it. Rebuilt with API data loads.
 * @type {Map<number, import('../../domain/civilBaseline.js').CivilProfile>}
 */
let civilProfiles = new Map();

/**
 * Per-player routine summary (Etap F) — hour/weekday/collection/timeline from the
 * spy-report history rings. Rebuilt on data load; empty for players with no
 * history (only watched players accrue it).
 * @type {Record<string, import('../../domain/routine.js').RoutineSummary>}
 */
let routines = {};

// ── DOM refs (filled by wireDom) ───────────────────────────────────────

/** @type {HTMLElement} */ let statsEl;
/** @type {HTMLElement} */ let chartEl;
/** @type {HTMLElement} */ let countInfoEl;
/** @type {HTMLSelectElement} */ let posFilter;
/** @type {HTMLSelectElement} */ let universeSelect;
/** @type {HTMLElement | null} */ let importStatusEl;
/** @type {HTMLInputElement} */ let freePosInput;
// Chip groups (see ./chips.js) — the containers replacing the old <select>s;
// their data-value carries the control value.
/** @type {HTMLElement | null} */ let freeGapsChips;
/** @type {HTMLElement | null} */ let freeZoneChips;
/** @type {HTMLElement | null} */ let freeFindChips;
/** @type {HTMLElement | null} */ let freeZoneHint;
/** @type {HTMLElement | null} */ let scoutDataStamp;
/** @type {HTMLElement | null} */ let freeExcludeChips;
/** @type {HTMLElement | null} */ let freeSlotsNote;
/** @type {HTMLElement | null} */ let freeGapsNote;
/** @type {HTMLElement | null} */ let freeExcludeNote;
/** @type {HTMLElement} */ let freeContainer;
/** @type {HTMLElement | null} */ let serverMapHost;
/** @type {HTMLElement | null} */ let serverMapViewChips;
/** @type {HTMLInputElement | null} */ let serverMapWindow;
/** @type {HTMLElement | null} */ let serverMapWindowV;
/** @type {HTMLInputElement | null} */ let serverMapFarm;
/** @type {HTMLElement | null} */ let serverMapFarmV;
/** @type {HTMLElement | null} */ let freeCountInfoEl;
/** @type {HTMLElement} */ let targetsContainer;
/** @type {HTMLElement | null} */ let spyglassMapHost;
/** @type {HTMLButtonElement | null} */ let spyMapToggle;
/** @type {HTMLElement | null} */ let spyMapBlock;
/** @type {HTMLElement | null} */ let spyMapLegend;
/** @type {HTMLInputElement} */ let tgtMinMilitary;
/** @type {HTMLInputElement | null} */ let tgtMaxMilitary;
/** Show-limit seg chip-group (was a <select>); `data-value` = row cap. */
/** @type {HTMLElement | null} */ let tgtLimitChips;
/** @type {HTMLInputElement | null} */ let tgtSearch;
/** Current Spyglass nickname search (Etap D); '' = no search. */
let targetSearchQuery = '';
/** Player ids force-included past the filters via search "show anyway". */
const forceIncludeIds = new Set();
// The three everyday filters are toggle PILLS (Etap H1) — `.on` is the state,
// read via toggleChipOn where `.checked` used to be.
/** @type {HTMLElement | null} */ let tgtWatchedOnly;
/** @type {HTMLInputElement | null} */ let tgtProbes;
/** @type {HTMLElement | null} */ let tgtInRange;
/** @type {HTMLElement | null} */ let tgtHideInactive;
/** @type {HTMLButtonElement | null} */ let tgtConfigToggle;
/** @type {HTMLElement | null} */ let tgtConfigCard;
/** @type {HTMLElement | null} */ let tgtCountInfoEl;
/** @type {HTMLElement | null} */ let proximityStripEl;
/** @type {HTMLElement | null} */ let proximityCountsEl;
/** @type {HTMLElement | null} */ let proximityAlertEl;

/** Guards {@link installDashboard} against a double-install. */
let installed = false;

/**
 * Bootstrap the dashboard page. Safe to call multiple times but
 * there's no reason to — the HTML entry invokes this exactly once.
 * Defers real work until DOMContentLoaded when the page is still
 * loading so `document.getElementById` lookups resolve.
 *
 * @returns {void}
 */
export const installDashboard = () => {
  if (installed) return;
  installed = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot(); });
  } else {
    void boot();
  }
};

/**
 * Main bootstrap sequence. Separated from `install` so we can await
 * the initial load without blocking the module top-level.
 *
 * @returns {Promise<void>}
 */
const boot = async () => {
  wireDom();
  wireTabs();
  wireColonySubtabs();

  // AlarmClock tab filters by the active universe (same UX as the other
  // tabs). The host passes a getter so alarmClock never has to import
  // this module's module-scope state; the universe selector's change
  // handler calls `alarmClockApi.refresh()` to repaint.
  alarmClockApi = installAlarmClock({ getUniverseId: () => selectedUniverseId });
  routesApi = installRoutes({ getUniverseId: () => selectedUniverseId });
  scanColonyConfigApi = installScanColonyConfig({ getUniverseId: () => selectedUniverseId });
  alarmClockConfigApi = installAlarmClockConfig({ getUniverseId: () => selectedUniverseId });
  // Sync tab is cross-universe (ignores the selector) and self-subscribes to
  // chrome.storage changes, so it needs no universe getter and no post-load
  // repaint — one install wires it for good.
  installSync();
  // The Multi-device-sync + alarmClock master/token controls (moved out of the
  // in-game panel) — they read/write the shared-settings chrome.storage dict.
  installSettingsControls();

  const universes = await discoverUniverses();
  selectedUniverseId = resolveInitialUniverse(universes);
  populateUniverseSelect(universes, selectedUniverseId);
  await loadWatched();

  await loadAll();
  renderAll();
  // AlarmClock + routes tabs read `selectedUniverseId` via their getter
  // when their initial paint ran inside install* — BEFORE we resolved the
  // active universe. Repaint now that it's known.
  alarmClockApi?.refresh();
  routesApi?.refresh();
  scanColonyConfigApi?.refresh();
  alarmClockConfigApi?.refresh();
  wireListeners();

  // Restore Galaxy Viewer preferences from previous session. The pre-zone
  // prefs shape carried a 6-preset `strategy`; remap it so a long-time
  // "Farmer" user lands on Farm hub instead of silently resetting to the
  // default (new keys win when both are present).
  const scoutPrefs = /** @type {any} */ (safeLS.json(SCOUT_PREFS_KEY, {}));
  /** @type {Record<string, { zone?: string, find?: string }>} */
  const LEGACY_STRATEGY_MAP = {
    longest: { find: 'streaks' },
    peaceful: { zone: 'safe' },
    safe_expansion: { zone: 'safe' },
    farmer: { zone: 'farm' },
    honor_pvp: { zone: 'pvp' },
    aggressive: { zone: 'pvp' },
  };
  const legacy = LEGACY_STRATEGY_MAP[scoutPrefs.strategy] ?? {};
  const zonePref = scoutPrefs.zone ?? legacy.zone;
  const findPref = scoutPrefs.find ?? legacy.find;
  // setChipValue rejects values no chip carries — the same guard the old
  // `querySelector('[value=…]')` checks gave the selects.
  if (zonePref) setChipValue(freeZoneChips, zonePref);
  if (findPref) setChipValue(freeFindChips, findPref);
  if (scoutPrefs.excludeN !== undefined) setChipValue(freeExcludeChips, String(scoutPrefs.excludeN));
  if (typeof scoutPrefs.slots === 'string' && scoutPrefs.slots.trim()) {
    freePosInput.value = scoutPrefs.slots;
  }
  if (scoutPrefs.gaps !== undefined) setChipValue(freeGapsChips, String(scoutPrefs.gaps));
  if (scoutPrefs.window !== undefined && serverMapWindow) {
    serverMapWindow.value = String(scoutPrefs.window);
    if (serverMapWindowV) serverMapWindowV.textContent = `${scoutPrefs.window} h`;
  }
  if (scoutPrefs.farmReach !== undefined && serverMapFarm) {
    serverMapFarm.value = String(scoutPrefs.farmReach);
    if (serverMapFarmV) serverMapFarmV.textContent = `${scoutPrefs.farmReach} sys`;
  }
  if (scoutPrefs.view) setChipValue(serverMapViewChips, String(scoutPrefs.view));
  validateSlots();
  updateModeControls();
  // The first renderAll above painted with the DOM defaults — repaint so the
  // restored zone/find/slots/window/farm actually drive the first ranking
  // (mirrors the loadTargetPrefs → repaintTargets pattern below; cheap, the
  // composite cache makes this second paint rebuild only the field).
  repaintFreeRegions();

  // Restore the Targets table sort + filter controls from the previous session,
  // then repaint so the restored sort/filters show on this first load (the
  // initial renderAll above ran before this restore).
  loadTargetPrefs();
  repaintTargets();

  chromeStore.onChanged((changes) => {
    // Filter: only re-render when one of the SELECTED universe's keys
    // changed. Events from other universes' tabs would otherwise
    // trigger a render cycle that produces identical output (we don't
    // even read those keys). Universe enumeration is similarly
    // sticky — the dropdown is built once at boot; the user opens the
    // page again to pick up a new universe.
    const keysToWatch = [
      historyKeyFor(selectedUniverseId),
      scansKeyFor(selectedUniverseId),
      playersKeyFor(selectedUniverseId),
      ownProfileKeyFor(selectedUniverseId),
      galaxyScanConfigKeyFor(selectedUniverseId),
      apiCacheKeyFor(selectedUniverseId),
      targetReportsKeyFor(selectedUniverseId),
      proximityReportsKeyFor(selectedUniverseId),
    ];
    if (keysToWatch.some((k) => k in changes)) {
      void loadAll().then(renderAll);
    }
  });
};

/**
 * Enumerate every universe with persisted data by scanning
 * `chrome.storage.local` for keys matching the `<universeId>:oge_*`
 * pattern. Returns the sorted, de-duplicated list of universe ids.
 *
 * A universe id is the prefix portion of a key that ends in one of
 * the namespaced base suffixes — typically `oge_colonyHistory` or
 * `oge_galaxyScans`. The Galaxy-Scan config (`oge_galaxyScanConfig`) is
 * also recognised so a fresh universe that has only the config written
 * (no scans / no colonies yet) still shows up.
 *
 * @returns {Promise<string[]>}
 */
const discoverUniverses = async () => {
  const all = await chromeStore.getAll();
  /** @type {Set<string>} */
  const ids = new Set();
  const suffixes = [
    `:${HISTORY_KEY_BASE}`,
    `:${SCANS_KEY_BASE}`,
    `:${GALAXY_SCAN_CONFIG_KEY_BASE}`,
  ];
  for (const key of Object.keys(all)) {
    for (const suffix of suffixes) {
      if (key.endsWith(suffix)) {
        ids.add(key.slice(0, key.length - suffix.length));
        break;
      }
    }
  }
  return [...ids].sort();
};

/**
 * Decide which universe should be active when the page first renders.
 *
 * Priority:
 *   1. `?host=<universeId>` URL param (set by the Settings panel's
 *      "Open OG-E Dashboard" button so opening from server X auto-selects
 *      X) — but only when that universe is in the discovered list, OR
 *      when the discovered list is empty (a freshly-opened universe
 *      with no data yet still deserves to show up as the active tab).
 *   2. The first universe in the alphabetically-sorted list.
 *   3. Empty string — no data on any universe yet. The selector will
 *      show an empty/placeholder option and Export/Import/etc. become
 *      effectively no-ops until data lands.
 *
 * @param {string[]} universes
 * @returns {string}
 */
const resolveInitialUniverse = (universes) => {
  const fromUrl = new URLSearchParams(location.search).get('host') ?? '';
  if (fromUrl) {
    if (universes.includes(fromUrl)) return fromUrl;
    // A fresh universe (just opened post-upgrade, no data yet) is
    // legitimate — surface it so the player can see "this server has
    // nothing recorded yet" rather than silently falling back to a
    // different universe's data.
    return fromUrl;
  }
  return universes[0] ?? '';
};

/**
 * Render the universe-selector `<option>` list. Includes every
 * discovered universe plus, if the URL-param universe isn't already
 * in the list, the URL-param entry as a "(no data yet)" placeholder.
 *
 * @param {string[]} universes
 * @param {string} active
 * @returns {void}
 */
const populateUniverseSelect = (universes, active) => {
  // Ensure the active universe is in the option list. resolveInitialUniverse
  // can return a URL-param universe that has no data yet, in which case
  // it would not appear in `universes`. We splice it in so the selector
  // can show it as the active row.
  const list = universes.slice();
  if (active && !list.includes(active)) list.push(active);
  list.sort();

  // Clear and repopulate. The element starts empty; rebuilding from
  // scratch is simpler than diffing and the option count is tiny
  // (typically 1-5).
  universeSelect.innerHTML = '';
  if (list.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no servers recorded yet)';
    universeSelect.appendChild(opt);
    universeSelect.disabled = true;
    return;
  }
  universeSelect.disabled = false;
  for (const id of list) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === active) opt.selected = true;
    universeSelect.appendChild(opt);
  }
};

/**
 * Resolve every DOM reference the page needs in one place. The IDs
 * here must match `dashboard.html`; a missing node returns null and
 * typechecks as HTMLElement via cast — we'd crash on first use, which
 * is the right failure mode (a missing ID is a build-time issue, not
 * a runtime one worth paying defensive null checks for).
 *
 * @returns {void}
 */
const wireDom = () => {
  statsEl = /** @type {HTMLElement} */ (document.getElementById('statsContainer'));
  chartEl = /** @type {HTMLElement} */ (document.getElementById('chart'));
  countInfoEl = /** @type {HTMLElement} */ (document.getElementById('countInfo'));
  posFilter = /** @type {HTMLSelectElement} */ (document.getElementById('posFilter'));
  universeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('universeSelect'));
  importStatusEl = document.getElementById('importStatus');
  freePosInput = /** @type {HTMLInputElement} */ (document.getElementById('freePosInput'));
  freeGapsChips = document.getElementById('freeGapsChips');
  freeZoneChips = document.getElementById('freeZoneChips');
  freeFindChips = document.getElementById('freeFindChips');
  freeZoneHint = document.getElementById('freeZoneHint');
  scoutDataStamp = document.getElementById('scoutDataStamp');
  freeExcludeChips = document.getElementById('freeExcludeChips');
  freeSlotsNote = document.getElementById('freeSlotsNote');
  freeGapsNote = document.getElementById('freeGapsNote');
  freeExcludeNote = document.getElementById('freeExcludeNote');
  freeContainer = /** @type {HTMLElement} */ (document.getElementById('freeContainer'));
  serverMapHost = document.getElementById('serverMapHost');
  serverMapViewChips = document.getElementById('serverMapViewChips');
  serverMapWindow = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapWindow'));
  serverMapWindowV = document.getElementById('serverMapWindowV');
  serverMapFarm = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapFarm'));
  serverMapFarmV = document.getElementById('serverMapFarmV');
  freeCountInfoEl = document.getElementById('freeCountInfo');
  targetsContainer = /** @type {HTMLElement} */ (document.getElementById('targetsContainer'));
  tgtMinMilitary = /** @type {HTMLInputElement} */ (document.getElementById('tgtMinMilitary'));
  tgtMaxMilitary = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtMaxMilitary'));
  tgtLimitChips = document.getElementById('tgtLimitChips');
  tgtSearch = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtSearch'));
  tgtWatchedOnly = document.getElementById('tgtWatchedOnly');
  tgtProbes = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtProbes'));
  tgtInRange = document.getElementById('tgtInRange');
  tgtHideInactive = document.getElementById('tgtHideInactive');
  tgtConfigToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('tgtConfigToggle'));
  tgtConfigCard = document.getElementById('tgtConfigCard');
  tgtCountInfoEl = document.getElementById('tgtCountInfo');
  proximityStripEl = document.getElementById('proximityStrip');
  proximityCountsEl = document.getElementById('proximityCounts');
  proximityAlertEl = document.getElementById('proximityAlert');
  spyglassMapHost = document.getElementById('spyglassMapHost');
  spyMapToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('spyMapToggle'));
  spyMapBlock = document.getElementById('spyMapBlock');
  spyMapLegend = document.getElementById('spyMapLegend');
};

/**
 * Apply the active class to one tab + section pair and strip it from
 * the others. The DOM is the source of truth for which tab is visible;
 * we persist the requested tab key to localStorage so a refresh
 * restores the same view.
 *
 * Falls back to `DEFAULT_TAB` for any unknown `tabKey` (e.g. a corrupt
 * localStorage value or a stale key from a build that had different
 * tab names).
 *
 * @param {string} tabKey  `data-tab` value of the target button.
 * @returns {void}
 */
const setActiveTab = (tabKey) => {
  const buttons = document.querySelectorAll('.tab-btn');
  const sections = document.querySelectorAll('.tab-section');

  // Resolve the actual key we will use (input may not match any button).
  /** @type {string} */
  let resolved = DEFAULT_TAB;
  for (const btn of buttons) {
    if (/** @type {HTMLElement} */ (btn).dataset.tab === tabKey) {
      resolved = tabKey;
      break;
    }
  }

  for (const btn of buttons) {
    const key = /** @type {HTMLElement} */ (btn).dataset.tab;
    btn.classList.toggle('active', key === resolved);
  }
  for (const section of sections) {
    // section ids end in `Section` — strip that to get the tab key.
    const id = section.id;
    const key = id.endsWith('Section') ? id.slice(0, -'Section'.length) : id;
    section.classList.toggle('active', key === resolved);
  }
  safeLS.set(ACTIVE_TAB_LS_KEY, resolved);
};

/**
 * Wire the tab bar: read the last-active tab from localStorage,
 * apply it, and attach a click handler to each `.tab-btn` so future
 * clicks update both the DOM and the persisted preference.
 *
 * @returns {void}
 */
const wireTabs = () => {
  // A `?tab=<data-tab>` URL param deep-links a specific tab (e.g. the
  // in-game "no route" Daily Transport button opens `?tab=routes`). It
  // wins over the persisted preference when present; `setActiveTab` falls
  // back to DEFAULT_TAB for an unknown value, so a bad param is harmless.
  const fromUrl = new URLSearchParams(location.search).get('tab');
  const initial = fromUrl || safeLS.get(ACTIVE_TAB_LS_KEY) || DEFAULT_TAB;
  setActiveTab(initial);

  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.tab ?? DEFAULT_TAB;
      setActiveTab(key);
      // The server map skips painting while its host is hidden (width 0) —
      // entering the Colonizations tab is the moment it becomes measurable.
      if (key === 'colony') repaintFreeRegions();
      // Same for the Spyglass watchlist map (only when it's open).
      if (key === 'spyglass') repaintSpyglassMap();
    });
  }
};

/**
 * Wire the Colonizations sub-tabs ("Big Colony Hunting" / "Galaxy Viewer").
 * All panes stay mounted (the inactive ones are `display:none`) so both
 * renderers keep painting into their containers regardless of which sub-tab
 * is showing — clicking flips the `active` classes and persists the choice
 * so a reload reopens the same view. (The histogram tolerates being hidden at
 * render time: its width-based binning falls back to a viewport estimate when
 * `clientWidth` is 0 — see colony.js `estimateChartWidth`.)
 *
 * @returns {void}
 */
const wireColonySubtabs = () => {
  const buttons = document.querySelectorAll('#colonySubtabs .subtab');
  const panes = document.querySelectorAll('#colonySection .subtabpane');
  /** @param {string | undefined} key @returns {boolean} */
  const activate = (key) => {
    if (!key || ![...buttons].some((b) => /** @type {HTMLElement} */ (b).dataset.subtab === key)) {
      return false;
    }
    for (const b of buttons) {
      b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.subtab === key);
    }
    for (const pane of panes) {
      pane.classList.toggle('active', /** @type {HTMLElement} */ (pane).dataset.subtab === key);
    }
    return true;
  };
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.subtab;
      if (!activate(key)) return;
      safeLS.set(COLONY_SUBTAB_LS_KEY, key ?? '');
      // The map sizes itself from its host's width, which reads 0 while the
      // pane is hidden — entering the Galaxy Viewer repaints so it measures
      // for real (cheap: composite/field/find caches all hit).
      if (key === 'scout') repaintFreeRegions();
    });
  }
  // Reopen the sub-tab the user last worked in (falls back to the HTML
  // default, Big Colony Hunting, when nothing valid is stored).
  activate(safeLS.get(COLONY_SUBTAB_LS_KEY) || undefined);
};

/**
 * (Re)load the watch-list for the selected universe into {@link watchedPlayers},
 * replacing whatever was there. Reads chrome.storage.local (shared with the
 * in-game scan FAB) and, on a one-time basis, migrates any legacy M4 data that's
 * still in localStorage. Called on boot and on universe switch (ids are
 * universe-scoped).
 *
 * @returns {Promise<void>}
 */
const loadWatched = async () => {
  watchedPlayers.clear();
  watchRelationships = {};
  if (!selectedUniverseId) return;
  // Snapshot the universe: this async load can be interleaved with a universe
  // switch, and we must key every read/write to the universe we started with
  // (and bail before mutating shared state if it changed underneath us).
  const uni = selectedUniverseId;
  let raw = await chromeStore.get(watchListKeyFor(uni));
  // One-time migration: M4 stored a bare watch-list array in localStorage
  // (per-origin, invisible in-game). If chrome.storage is empty but the legacy
  // key has data, adopt it and write the normalised config through.
  if (raw == null) {
    const legacy = safeLS.json(legacyWatchedKeyFor(uni), null);
    if (Array.isArray(legacy) && legacy.length) {
      raw = normalizeWatchList(legacy);
      await chromeStore.set(watchListKeyFor(uni), raw);
    }
  }
  const cfg = normalizeWatchList(raw);
  if (uni !== selectedUniverseId) return;
  for (const id of cfg.players) watchedPlayers.add(id);
  rescanMap = cfg.rescan;
  watchRelationships = cfg.relationships ?? {};
  // chrome.storage is authoritative for the probe count (the FAB reads it too).
  if (tgtProbes) tgtProbes.value = String(cfg.probes);
};

/**
 * Write the watch-list config ({players, probes}) for the selected universe to
 * chrome.storage.local so the in-game scan FAB sees the same players + probe
 * count. Fire-and-forget (the in-memory Set / control are the source of truth
 * for the current paint).
 *
 * @returns {void}
 */
const writeWatchConfig = () => {
  if (!selectedUniverseId) return;
  void chromeStore.set(watchListKeyFor(selectedUniverseId), {
    players: [...watchedPlayers],
    probes: Number(tgtProbes?.value) || DEFAULT_SPY_PROBES,
    rescan: rescanMap,
    relationships: watchRelationships,
  });
};

/**
 * Set (or clear → neutral) a watched player's relationship tag, persist it, and
 * repaint the Targets sub-tab + the map so the marker colour updates.
 * @param {string} pid
 * @param {import('../../state/watchList.js').Relationship} rel
 * @returns {void}
 */
const setRelationship = (pid, rel) => {
  if (rel === 'neutral') delete watchRelationships[pid];
  else watchRelationships[pid] = rel;
  writeWatchConfig();
  repaintTargets();
  repaintSpyglassMap();
};

/**
 * Flag a player (key = player id) or a single planet (key = "g:s:p" coord) as
 * needing a re-scan: records "now" so the scan FAB treats any report older than
 * this moment as stale and re-targets it. Clears itself when a newer report
 * lands. Persists + repaints the sub-tab.
 *
 * @param {string} key  player id or "g:s:p" coord.
 * @returns {void}
 */
const markRescan = (key) => {
  rescanMap = { ...rescanMap, [key]: Date.now() };
  writeWatchConfig();
  repaintTargets();
};

/**
 * Toggle a player's watch-list membership, persist the config, and repaint just
 * the Targets sub-tab. Mutates {@link watchedPlayers} in place.
 *
 * @param {string} id
 * @returns {void}
 */
const toggleWatched = (id) => {
  if (watchedPlayers.has(id)) watchedPlayers.delete(id);
  else watchedPlayers.add(id);
  writeWatchConfig();
  repaintTargets();
};

/**
 * Refresh module-local caches (`history`, `scans`, `players`, API layer)
 * from chrome.storage.local for the currently-selected universe.
 * Single Promise.all so a cold start only pays one round-trip. With
 * no universe selected we resolve to empty collections so the render
 * cycle can paint an "empty state" without branching.
 *
 * @returns {Promise<void>}
 */
const loadAll = async () => {
  if (!selectedUniverseId) {
    history = [];
    scans = {};
    players = {};
    ownProfile = {};
    apiIndex = null;
    apiBounds = {};
    apiCache = {};
    targetCandidates = [];
    targetReports = {};
    proximityReports = [];
    planetCountByPlayer = {};
    dangerProfiles = new Map();
    civilProfiles = new Map();
    routines = {};
    return;
  }
  const [h, s, p, op, api, tr, pr] = await Promise.all([
    chromeStore.get(historyKeyFor(selectedUniverseId)),
    chromeStore.get(scansKeyFor(selectedUniverseId)),
    chromeStore.get(playersKeyFor(selectedUniverseId)),
    readOwnProfile(selectedUniverseId),
    readApiCacheFor(selectedUniverseId),
    chromeStore.get(targetReportsKeyFor(selectedUniverseId)),
    chromeStore.get(proximityReportsKeyFor(selectedUniverseId)),
  ]);
  history = Array.isArray(h) ? /** @type {ColonyEntry[]} */ (h) : [];
  scans = s && typeof s === 'object' ? /** @type {GalaxyScans} */ (s) : {};
  players = p && typeof p === 'object'
    ? /** @type {import('../../state/players.js').PlayerCache} */ (p)
    : {};
  ownProfile = op;

  // Build the API occupancy index (breadth layer) for the Colony Scout. Empty
  // when the in-game side hasn't populated the cache yet → Scout uses live
  // scans alone. ownPlayerId flags our own colonies (excluded as occupied).
  if (api && api.universe) {
    apiIndex = buildOccupancyIndex({
      universe: { planets: api.universe.planets, timestamp: api.universe.timestamp },
      players: { players: api.players ? api.players.players : {} },
      highscore: { ranks: api.total ? api.total.ranks : {} },
      military: { ranks: api.military ? api.military.ranks : {} },
      honor: { ranks: api.honor ? api.honor.ranks : {} },
      ownPlayerId: op.id,
    });
    apiBounds = {
      galaxies: api.server ? api.server.data.galaxies : undefined,
      systems: api.server ? api.server.data.systems : undefined,
      donutGalaxy: api.server ? api.server.data.donutGalaxy : undefined,
      donutSystem: api.server ? api.server.data.donutSystem : undefined,
      domain: api.server ? api.server.data.domain : undefined,
    };
    ownMilitary = api.military && op.id != null && api.military.ranks[String(op.id)]
      ? api.military.ranks[String(op.id)].score
      : undefined;
  } else {
    apiIndex = null;
    apiBounds = {};
    ownMilitary = undefined;
  }

  // Targets sub-tab: join the already-cached API feeds (players + total +
  // military) into candidate rows. Empty when the in-game side hasn't populated
  // the cache yet → the sub-tab shows its "open the galaxy view" hint.
  apiCache = api && typeof api === 'object' ? /** @type {import('../../state/apiCache.js').ApiCache} */ (api) : {};
  targetCandidates = buildTargetCandidates({
    players: apiCache.players ? apiCache.players.players : undefined,
    total: apiCache.total ? apiCache.total.ranks : undefined,
    military: apiCache.military ? apiCache.military.ranks : undefined,
    destroyed: apiCache.destroyed ? apiCache.destroyed.ranks : undefined,
  });

  // Unit repair (same as the store's hydrate path): reports persisted before
  // the timestamp fix carry ms values that read as perpetually fresh.
  targetReports = tr && typeof tr === 'object'
    ? normalizeReportTimestamps(/** @type {import('../../state/targets.js').TargetReports} */ (tr))
    : {};
  // Proximity "spotted near you" feed — a plain newest-first array (no unit
  // repair needed; it's written only by the post-fix ingest path).
  proximityReports = Array.isArray(pr)
    ? /** @type {import('../../domain/espionageReport.js').ProximityReport[]} */ (pr)
    : [];
  // Coverage denominator: count each player's spiable BODIES in the universe.xml
  // snapshot — planets PLUS their moons (`hasMoon` from the <moon> parse; a moon
  // is a second body of the same owner). §9bis: without moons here a fully-planet-
  // spied player reads as "complete" while unspied moon defence still hides in the
  // military score. (Stale caches predating the <moon> parse lack hasMoon → count
  // as planets-only until the 7-day universe feed refreshes; graceful.)
  /** @type {Record<string, number>} */
  const counts = {};
  const uniPlanets = apiCache.universe ? apiCache.universe.planets : [];
  for (const pl of uniPlanets) {
    if (pl && pl.player != null) {
      const pid = String(pl.player);
      counts[pid] = (counts[pid] || 0) + 1 + (pl.hasMoon ? 1 : 0);
    }
  }
  planetCountByPlayer = counts;

  // Per-player danger profiles (v2) — the threat substrate for the Galaxy
  // Viewer field + occupancy map. Built from the API feeds (ships/destroyed/
  // honour/alliance/dispersion) + the live flag cache; the own-alliance test
  // reads our own players.xml row.
  const ownId = ownProfile.id != null ? String(ownProfile.id) : undefined;
  const apiPlayersMap = apiCache.players ? apiCache.players.players : undefined;
  const militaryRanks = apiCache.military ? apiCache.military.ranks : undefined;
  // Spy refinement (E4): per player, the defence we've seen + whether coverage
  // is complete — fully spied collapses the fleet bound to military − defence
  // EXACTLY, partial coverage just tightens the upper bound.
  /** @type {Record<string, {defensePts:number, coverageComplete:boolean, spiedCount:number, planetCount?:number}>} */
  const spiedByPlayer = {};
  for (const pid of Object.keys(targetReports)) {
    const bucket = targetReports[pid];
    const reports = bucket ? Object.values(bucket).map(latestOf) : [];
    if (!reports.length) continue;
    const est = estimateHiddenFleet({
      militaryPoints: militaryRanks && militaryRanks[pid] ? militaryRanks[pid].score : undefined,
      reports,
      planetCount: planetCountByPlayer[pid],
    });
    spiedByPlayer[pid] = {
      defensePts: est.defensePoints,
      coverageComplete: est.coverageComplete,
      spiedCount: est.spiedCount,
      planetCount: est.planetCount,
    };
  }
  dangerProfiles = buildDangerProfiles({
    military: militaryRanks,
    destroyed: apiCache.destroyed ? apiCache.destroyed.ranks : undefined,
    honor: apiCache.honor ? apiCache.honor.ranks : undefined,
    honorTotal: apiCache.honor ? Object.keys(apiCache.honor.ranks).length : 0,
    apiPlayers: apiPlayersMap,
    players,
    universePlanets: uniPlanets,
    spied: spiedByPlayer,
    ownMilitary,
    ownId,
    ownAlliance: ownId && apiPlayersMap ? apiPlayersMap[ownId]?.alliance : undefined,
  });
  // Etap C: server civil-fleet baseline from the (previously unused) economy
  // feed — expected civil ships per player + the combat-ship surplus over it.
  civilProfiles = buildCivilBaseline({
    economy: apiCache.economy ? apiCache.economy.ranks : undefined,
    military: militaryRanks,
  });
  // Etap F: per-player routine from the spy-report history rings (watched players
  // accrue history; the rest summarise to empty). Built from reports the user
  // opened — see domain/routine.js. The bodyKey's ":type" is stripped to a coord.
  const routineNowMs = Date.now();
  /** @type {Record<string, import('../../domain/routine.js').RoutineSummary>} */
  const routinesAcc = {};
  for (const pid of Object.keys(targetReports)) {
    const bucket = targetReports[pid];
    const bodies = Object.entries(bucket).map(([key, entry]) => {
      const lastColon = key.lastIndexOf(':');
      return { coord: lastColon >= 0 ? key.slice(0, lastColon) : key, history: historyOf(entry) };
    });
    routinesAcc[pid] = summarizeRoutine(bodies, routineNowMs);
  }
  routines = routinesAcc;
};

/**
 * Current filter value from the position-filter select.
 *
 * @returns {string}
 */
const getFilter = () => posFilter?.value ?? 'all';

/**
 * Re-render both the colony section and the galaxy section from the
 * current caches.
 *
 * @returns {void}
 */
const renderAll = () => {
  populatePositionFilter(posFilter, history);
  const filterValue = getFilter();
  const entries = filterValue === 'all'
    ? history
    : history.filter((e) => e.position === parseInt(filterValue, 10));

  renderColonyChart({
    statsEl,
    chartEl,
    countInfoEl,
    entries,
    filterLabel: filterValue,
  });

  // Analyzer block (Galaxy Viewer) — runs over the same `scans` data with the
  // current controls. Repainting on every renderAll keeps it in sync with
  // universe changes / storage updates; the controls also have their own
  // onchange listeners that re-paint only this block without paying for the
  // colony pass.
  repaintFreeRegions();
  repaintTargets();
  renderProximityStrip();
  repaintSpyglassMap();
};

/**
 * Repaint only the Targets sub-tab from the joined candidate list + the
 * active-target filter controls. Cheap (DOM-only over an already-loaded
 * candidate list), so control changes don't pay the colony / galaxy passes.
 *
 * The noob-protection band and ally exclusion need OUR own numbers: own total
 * score (from the total highscore) and own alliance id (from players.xml),
 * both keyed by our own player id from the profile. Absent until the in-game
 * header read lands — then those two filters simply don't apply.
 *
 * @returns {void}
 */
const repaintTargets = () => {
  const ownId = ownProfile.id != null ? String(ownProfile.id) : undefined;
  const totalRanks = apiCache.total ? apiCache.total.ranks : undefined;
  const apiPlayers = apiCache.players ? apiCache.players.players : undefined;
  const ownTotalScore = ownId && totalRanks ? totalRanks[ownId]?.score : undefined;
  const ownAlliance = ownId && apiPlayers ? apiPlayers[ownId]?.alliance : undefined;

  // Per-player hidden-fleet estimate + the per-planet report data the table
  // reads: coord → { ts, defPts, fleetPts } (timestamp drives the freshness /
  // re-scan status; defense + visible-fleet POINTS feed the expanded per-planet
  // rows). The report key is a bodyKey "g:s:p:type"; strip ":type" for the coord.
  const military = apiCache.military ? apiCache.military.ranks : {};
  /** @type {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} */
  const estimates = {};
  /** @type {Record<string, Record<string, {ts:number, defPts:number, fleetPts:number}>>} */
  const reportsByPlayer = {};
  for (const pid of Object.keys(targetReports)) {
    const bucket = targetReports[pid];
    const reports = bucket ? Object.values(bucket).map(latestOf) : [];
    if (!reports.length) continue;
    estimates[pid] = estimateHiddenFleet({
      militaryPoints: military[pid] ? military[pid].score : undefined,
      reports,
      planetCount: planetCountByPlayer[pid],
    });
    /** @type {Record<string, {ts:number, defPts:number, fleetPts:number}>} */
    const byCoord = {};
    for (const [key, entry] of Object.entries(bucket)) {
      const report = latestOf(entry);
      // Skip moon reports here: once ":type" is stripped their bodyKey shares the
      // planet's "g:s:p", so a moon would clobber the planet's per-planet row. A
      // moon still feeds the hidden-fleet estimate above (bodyKey keeps it
      // distinct) — it just isn't a planet-grid row.
      if (report.planetType === 3) continue;
      const lastColon = key.lastIndexOf(':');
      const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
      byCoord[coord] = {
        ts: report.timestamp ?? 0,
        defPts: pointsOf(report.defenseValue ?? 0),
        fleetPts: pointsOf(report.fleetValue ?? 0),
      };
    }
    reportsByPlayer[pid] = byCoord;
  }

  // Per-player raid verdict + legal-attack-band flag for the dossier (Etap B).
  // Cheap arithmetic over the candidate list, computed for all so an expanded
  // never-spied player still reads "scan first". inBand uses OGame's ±5× noob-
  // protection on TOTAL score (undefined when our own score is unknown).
  const nowMs = Date.now();
  /** @type {Record<string, import('../../domain/raidVerdict.js').RaidVerdict>} */
  const verdicts = {};
  /** @type {Record<string, boolean|undefined>} */
  const inBandById = {};
  for (const c of targetCandidates) {
    const inBand = typeof ownTotalScore === 'number' && ownTotalScore > 0
      && typeof c.totalScore === 'number'
      ? c.totalScore >= ownTotalScore / 5 && c.totalScore <= ownTotalScore * 5
      : undefined;
    inBandById[c.id] = inBand;
    const bucket = targetReports[c.id];
    verdicts[c.id] = raidVerdict({
      profile: dangerProfiles.get(Number(c.id)),
      estimate: estimates[c.id],
      reports: bucket ? Object.values(bucket).map(latestOf) : [],
      inBand,
      nowMs,
    });
  }

  renderTargets({
    containerEl: targetsContainer,
    candidates: targetCandidates,
    opts: {
      ownPlayerId: ownId,
      ownTotalScore,
      ownAlliance,
      minMilitary: Number(tgtMinMilitary?.value) || 0,
      maxMilitary: Number(tgtMaxMilitary?.value) || 0,
      // "In range only" opt-in: apply OGame's noob-protection band (game default
      // 5x) so only legally-attackable players show; default off = show every score.
      protectionFactor: toggleChipOn(tgtInRange) ? 5 : 0,
      excludeVacation: true,
      excludeInactive: tgtHideInactive ? toggleChipOn(tgtHideInactive) : true,
      excludeBanned: true,
      forceInclude: forceIncludeIds,
    },
    limit: Number(chipValue(tgtLimitChips)) || 0,
    estimates,
    sort: targetSort,
    onSort: handleTargetSort,
    watchedIds: watchedPlayers,
    onToggleWatch: toggleWatched,
    onRescan: markRescan,
    rescan: rescanMap,
    watchedOnly: toggleChipOn(tgtWatchedOnly),
    universePlanets: apiCache.universe ? apiCache.universe.planets : [],
    reportsByPlayer,
    nowMs,
    expandedIds: expandedTargets,
    onToggleExpand: (id) => {
      if (expandedTargets.has(id)) expandedTargets.delete(id);
      else expandedTargets.add(id);
    },
    countInfoEl: tgtCountInfoEl,
    // The free whole-server fleet-finder columns/sorts (Danger D + mobile
    // fleet ceiling) — computed from the API feeds, no spy needed.
    danger: dangerProfiles,
    // Per-player raid verdict + in-band flag for the expanded dossier (Etap B).
    verdicts,
    inBand: inBandById,
    // Per-player civil-fleet baseline for the dossier (Etap C).
    civil: civilProfiles,
    routines,
    relationships: watchRelationships,
    onSetRelationship: setRelationship,
    // Nickname search (Etap D): reveals name-matches incl. excluded players.
    searchQuery: targetSearchQuery,
    onShowAnyway: (/** @type {string} */ id) => { forceIncludeIds.add(id); repaintTargets(); },
    // Spyglass → map reverse deep-link: spotlight this player's planets on the
    // Galaxy Viewer occupancy lens.
    onShowOnMap: showPlayerOnSpyglassMap,
  });

  // Deep-link focus: scroll to + highlight the player a Galaxy Viewer "Top
  // threats" row asked for. The row was just rendered; the highlight class
  // clears on the next repaint (rows rebuild wholesale). No-op when the player
  // is filtered out of the current Targets view.
  if (focusedTargetId != null) {
    const row = targetsContainer?.querySelector(`tr[data-player-id="${focusedTargetId}"]`);
    if (row) {
      row.classList.add('target-focus');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    focusedTargetId = null;
  }
};

/**
 * Compact human age ("<1h" / "3h" / "2d" / "5w") for a proximity alert's epoch-
 * SECONDS timestamp, '' when unknown. Mirrors the small formatAge/ageMs helpers
 * in dossier.js / targets.js (kept inline — the strip is the only caller here).
 * @param {number|undefined} tsSeconds
 * @param {number} nowMs
 * @returns {string}
 */
const proximityAge = (tsSeconds, nowMs) => {
  const ms = typeof tsSeconds === 'number' && tsSeconds > 0 ? nowMs - tsSeconds * 1000 : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = ms / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
};

/**
 * Fill the Spyglass "🛡 Who's been near you" strip from {@link proximityReports},
 * digested to ONE row per prober (Etap H3, `domain/proximityDigest.js`): count,
 * last-seen age, which of our bodies, origin — with a 💀 flag + hot-first sort
 * when the origin sits in our own system (even RIPs reach us fast from there).
 * Live counts land in the collapsed `<summary>` so the picture reads unopened.
 * Each row offers ⭐ watch (the existing toggle) and a dossier deep-link; the
 * name still seeds the nickname search. The raw per-alert log stays reachable
 * behind a nested <details>. Device-local, read-only — no sends, purely a
 * passive view of opened alerts.
 * @returns {void}
 */
const renderProximityStrip = () => {
  if (!proximityStripEl) return;
  proximityStripEl.textContent = '';
  const digest = digestProximityReports(proximityReports);
  const nowMs = Date.now();
  if (proximityCountsEl) {
    proximityCountsEl.textContent = digest.totalReports
      ? ` — ${digest.playerCount} ${digest.playerCount === 1 ? 'prober' : 'probers'}`
        + ` · ${digest.totalReports} ${digest.totalReports === 1 ? 'alert' : 'alerts'}`
        + (digest.lastTs != null ? ` · last ${proximityAge(digest.lastTs, nowMs)}` : '')
      : '';
  }
  if (proximityAlertEl) {
    proximityAlertEl.textContent = digest.sameSystemCount > 0
      ? ` · ⚠ ${digest.sameSystemCount} from your system`
      : '';
  }
  if (!digest.totalReports) {
    const note = document.createElement('div');
    note.style.cssText = 'color:#667;font-size:12px;';
    note.textContent = 'No fleets spotted near you yet.';
    proximityStripEl.appendChild(note);
    return;
  }

  /** @param {string} label */
  const seedSearch = (label) => {
    if (!tgtSearch) return;
    tgtSearch.value = label;
    tgtSearch.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const MAX_ROWS = 10;
  for (const e of digest.players.slice(0, MAX_ROWS)) {
    const line = document.createElement('div');
    line.style.cssText =
      'font-size:12px;color:#9aa;margin-bottom:4px;line-height:1.6;'
      + 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;'
      + (e.sameSystem ? 'border-left:2px solid #e06c5f;padding-left:7px;' : 'padding-left:9px;');

    const label = e.name || `#${e.byPlayerId}`;
    const who = document.createElement('span');
    who.textContent = label;
    who.style.cssText = 'cursor:pointer;color:#8fb8e0;font-weight:600;';
    who.title = 'Find this player in the search above';
    who.addEventListener('click', () => seedSearch(label));
    line.appendChild(who);

    const at = e.atCoords.slice(0, 2).join(', ')
      + (e.atCoords.length > 2 ? ` +${e.atCoords.length - 2}` : '');
    const age = e.lastTs != null ? proximityAge(e.lastTs, nowMs) : '';
    const facts = (e.count > 1 ? `×${e.count} · ` : '')
      + (age ? `last ${age} · ` : '')
      + `at ${at}`
      + (e.fromCoords ? ` · from ${e.fromCoords}` : '');
    line.appendChild(document.createTextNode(facts));

    if (e.sameSystem) {
      const hot = document.createElement('span');
      hot.textContent = '💀 your system';
      hot.style.cssText = 'color:#e06c5f;font-weight:600;';
      hot.title =
        'Probed you from a body in the same system as yours — even Death Stars '
        + '(the slowest ships in the game) reach you quickly from there.';
      line.appendChild(hot);
    }

    const watched = watchedPlayers.has(String(e.byPlayerId));
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.textContent = watched ? '✓ watching' : '⭐ watch';
    watch.style.cssText =
      'font-size:11px;border-radius:999px;padding:1px 8px;cursor:pointer;'
      + (watched
        ? 'border:1px solid #2f6f4f;background:#16352a;color:#7fd6a8;'
        : 'border:1px solid #2b3a4d;background:#18222e;color:#9fb4c4;');
    watch.title = watched ? 'On your watchlist — click to remove' : 'Add to your watchlist / scan list';
    watch.addEventListener('click', () => {
      toggleWatched(String(e.byPlayerId));
      renderProximityStrip();
    });
    line.appendChild(watch);

    const dossier = document.createElement('button');
    dossier.type = 'button';
    dossier.textContent = 'dossier ▸';
    dossier.style.cssText =
      'font-size:11px;border:1px solid #2b3a4d;background:#18222e;color:#9fb4c4;'
      + 'border-radius:999px;padding:1px 8px;cursor:pointer;';
    dossier.title = 'Open this player in the table below';
    dossier.addEventListener('click', () => openSpyglassFor(e.byPlayerId));
    line.appendChild(dossier);

    proximityStripEl.appendChild(line);
  }
  if (digest.players.length > MAX_ROWS) {
    const more = document.createElement('div');
    more.style.cssText = 'color:#667;font-size:11px;margin:2px 0 4px 9px;';
    more.textContent = `+${digest.players.length - MAX_ROWS} more probers in the raw log`;
    proximityStripEl.appendChild(more);
  }

  // The undigested per-alert log, for when the exact sequence matters.
  const raw = document.createElement('details');
  raw.style.cssText = 'margin:6px 0 0 9px;';
  const rawSum = document.createElement('summary');
  rawSum.style.cssText = 'cursor:pointer;color:#667;font-size:11px;list-style:none;';
  rawSum.textContent = `show raw log (${digest.totalReports} ${digest.totalReports === 1 ? 'alert' : 'alerts'}) ▸`;
  raw.appendChild(rawSum);
  for (const r of proximityReports) {
    const line = document.createElement('div');
    line.style.cssText = 'font-size:11px;color:#788;margin-top:3px;line-height:1.4;';
    const age = proximityAge(r.ts, nowMs);
    line.textContent =
      `${r.byPlayerName || `#${r.byPlayerId}`} · near ${r.atCoords}`
      + `${age ? ` · ${age} ago` : ''}${r.fromCoords ? ` · from ${r.fromCoords}` : ''}`;
    raw.appendChild(line);
  }
  proximityStripEl.appendChild(raw);
};

/**
 * Open the Spyglass tab, optionally focused on one player: expand that player's
 * detail row and scroll/highlight it on the repaint. Wired to the Galaxy
 * Viewer "Top threats" panel (row click → this player; panel link → no id).
 * @param {number} [playerId]
 * @returns {void}
 */
const openSpyglassFor = (playerId) => {
  setActiveTab('spyglass');
  if (playerId != null) {
    focusedTargetId = String(playerId);
    expandedTargets.add(String(playerId));
    repaintTargets();
  }
};

/**
 * The per-row ⌖ "show on map": open the Spyglass positions map (if collapsed)
 * and scroll it into view. The map already plots every watched player + you
 * (coloured by relationship), so there's no single-player highlight to set — the
 * player's own marker is right there. Takes no args (the caller passes id/name,
 * harmlessly ignored).
 * @returns {void}
 */
const showPlayerOnSpyglassMap = () => {
  if (!spyMapOpen) toggleSpyMap(); // opens + repaints
  else repaintSpyglassMap();
  spyMapBlock?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

/**
 * Default sort direction for a freshly-picked column: ranks read best-first
 * (ascending, #1 on top); score-like columns read biggest-first (descending).
 * @param {import('./targets.js').TargetSortKey} key
 * @returns {'asc'|'desc'}
 */
const defaultTargetDir = (key) => (key === 'totalRank' ? 'asc' : 'desc');

/**
 * Header-click handler for the Targets table: clicking the active column flips
 * its direction, clicking a new column switches to it at its natural default.
 * Persists the choice (device-local) and repaints just the sub-tab.
 * @param {import('./targets.js').TargetSortKey} key
 * @returns {void}
 */
const handleTargetSort = (key) => {
  targetSort = targetSort.key === key
    ? { key, dir: targetSort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: defaultTargetDir(key) };
  saveTargetPrefs();
  repaintTargets();
};

/**
 * Snapshot the Targets sort + filter controls to device-local storage so they
 * survive a reload. Called on every sort/filter change.
 * @returns {void}
 */
const saveTargetPrefs = () => {
  safeLS.setJSON(TARGET_PREFS_KEY, {
    sort: targetSort,
    minMilitary: tgtMinMilitary?.value,
    maxMilitary: tgtMaxMilitary?.value,
    inRange: toggleChipOn(tgtInRange),
    hideInactive: tgtHideInactive ? toggleChipOn(tgtHideInactive) : true,
    showLimit: chipValue(tgtLimitChips),
  });
};

/**
 * Restore the persisted Targets sort + filter controls. Tolerates the older
 * flat `{key,dir}` sort shape. Setting a control's `.value` programmatically
 * does NOT fire a change event, so this never triggers a spurious repaint.
 * @returns {void}
 */
const loadTargetPrefs = () => {
  const p = /** @type {any} */ (safeLS.json(TARGET_PREFS_KEY, {}));
  const sort = p.sort || p; // pre-redesign prefs stored the flat sort directly.
  if (sort && ['hiddenFleet', 'military', 'totalRank', 'ships', 'destroyed', 'danger', 'fleet'].includes(sort.key)) {
    targetSort = { key: sort.key, dir: sort.dir === 'asc' ? 'asc' : 'desc' };
  }
  if (p.minMilitary != null && tgtMinMilitary) tgtMinMilitary.value = String(p.minMilitary);
  if (p.maxMilitary != null && tgtMaxMilitary) tgtMaxMilitary.value = String(p.maxMilitary);
  setToggleChip(tgtInRange, !!p.inRange);
  setToggleChip(tgtHideInactive, p.hideInactive !== false); // default ON
  // setChipValue refuses values no chip carries — the phantom-option guard the
  // old `<select>` restore had via querySelector('[value=…]').
  if (p.showLimit != null) setChipValue(tgtLimitChips, String(p.showLimit));
};

/**
 * Slots the settlement-regions block analyses, parsed from the positions
 * input (same `parsePositions` grammar as the colonize-targets setting:
 * lists and ranges, e.g. `"8"` / `"12-15"`). Out-of-range entries are
 * dropped; an empty/invalid input falls back to the classic slot 15.
 *
 * @returns {number[]}
 */
const freeRegionPositions = () => {
  const list = [...parseTargetPositions(freePosInput.value)]
    .filter((p) => p >= 1 && p <= 15);
  return list.length ? list : [15];
};

/**
 * Inline validity feedback for the Slots input. The fallback in
 * {@link freeRegionPositions} is silent by design (the analysis must always
 * run against SOMETHING) — but without this marker a typo like "16" kept
 * showing the user's text while every result quietly described slot 15.
 * Idempotent; safe before the refs exist (tests).
 *
 * @returns {void}
 */
const validateSlots = () => {
  if (!freePosInput) return;
  const raw = freePosInput.value.trim();
  const list = [...parseTargetPositions(raw)].filter((p) => p >= 1 && p <= 15);
  const invalid = raw !== '' && list.length === 0;
  freePosInput.classList.toggle('invalid', invalid);
  if (freeSlotsNote) freeSlotsNote.textContent = invalid ? 'invalid — using slot 15' : '';
};

/**
 * Match the mode-dependent controls to the Find shape: Longest streaks hunts
 * a free-slot run (Tolerance applies), Best spots analyses the area around
 * each free-slot system (Ignore worst applies). Ignore worst is also off
 * under the PvP zone — there exclusion is conceptually wrong (those players
 * are the point). The inapplicable group stays IN PLACE, greyed out with the
 * reason beside it — controls that vanish shift the row and hide the "why".
 * Idempotent; safe before the refs exist (tests).
 */
const updateModeControls = () => {
  const streaks = chipValue(freeFindChips) === 'streaks';
  const pvp = chipValue(freeZoneChips) === 'pvp';
  setChipsEnabled(freeGapsChips, streaks, freeGapsNote, 'streaks only');
  setChipsEnabled(freeExcludeChips, !streaks && !pvp, freeExcludeNote,
    streaks ? 'spots only' : 'not applied in the PvP zone');
  // One line under the Zone/Find chips explaining what the active zone
  // optimises — the hint text lives with the zone definitions in
  // domain/zoneScore.js.
  if (freeZoneHint) {
    freeZoneHint.textContent = ZONES[chipValue(freeZoneChips) || 'safe']?.hint ?? '';
  }
};

/**
 * Composite cache: `buildScanMapFromIndex` allocates ~galaxies×systems (≈4.5k)
 * system entries per call, but most repaints (sliders, strategy switches)
 * don't change its inputs. Keyed by the identity of `apiIndex`/`scans` (both
 * reassigned wholesale by loadAll) + the positions the synthetic map marks
 * empty.
 *
 * @type {{apiIndex: unknown, scans: unknown, posKey: string, value: GalaxyScans} | null}
 */
let compositeCache = null;

/**
 * Composite the API breadth layer (whole-server occupancy) with the live
 * scan map — live wins per system (fresher, carries honor rankClass /
 * empty_sent). When there's no cached API data the composite is just the
 * live scans.
 *
 * @param {number[]} positions
 * @returns {GalaxyScans}
 */
const buildComposite = (positions) => {
  if (!(apiIndex && apiBounds.galaxies && apiBounds.systems)) return scans;
  const posKey = positions.join(',');
  if (compositeCache
    && compositeCache.apiIndex === apiIndex
    && compositeCache.scans === scans
    && compositeCache.posKey === posKey) {
    return compositeCache.value;
  }
  const value = computeComposite({ apiIndex, apiBounds, scans, positions });
  compositeCache = { apiIndex, scans, posKey, value };
  return value;
};

/**
 * Scoring-field cache: the per-system threat/farm field costs ~galaxies×499
 * convolution columns per build; controls that don't change its inputs
 * (zone, find, slots when the composite is cached) shouldn't pay it again.
 * Keyed by composite identity + the physical knobs + the threat anchor.
 *
 * @type {{composite: unknown, windowH: number, farmReach: number, ownMilitary: number | undefined, danger: unknown, value: import('../../domain/heatField.js').ThreatFarmField} | null}
 */
let scoreFieldCache = null;

/**
 * The threat/farm field at PER-SYSTEM resolution over the current composite —
 * the analyzer's ranking substrate (the map paints its own coarser build).
 * `null` without API bounds; zone scoring then degrades gracefully.
 *
 * @param {GalaxyScans} composite
 * @returns {import('../../domain/heatField.js').ThreatFarmField | null}
 */
const buildScoreField = (composite) => {
  if (!apiBounds.galaxies || !apiBounds.systems) return null;
  const windowH = parseInt(serverMapWindow?.value ?? '', 10) || 8;
  const farmReach = parseInt(serverMapFarm?.value ?? '', 10) || 30;
  if (scoreFieldCache
    && scoreFieldCache.composite === composite
    && scoreFieldCache.windowH === windowH
    && scoreFieldCache.farmReach === farmReach
    && scoreFieldCache.ownMilitary === ownMilitary
    && scoreFieldCache.danger === dangerProfiles) {
    return scoreFieldCache.value;
  }
  const value = /** @type {import('../../domain/heatField.js').ThreatFarmField} */ (
    computeScoreField({ composite, apiBounds, ownMilitary, danger: dangerProfiles, windowH, farmReach })
  );
  scoreFieldCache = { composite, windowH, farmReach, ownMilitary, danger: dangerProfiles, value };
  return value;
};

/**
 * Last map paint's inputs — the map is the pane's always-visible canvas now,
 * so it repaints ONLY when its actual inputs changed (field identity, view,
 * pins, host width). A zone switch re-sorts the list but must not rebuild
 * the 9×N map DOM.
 *
 * @type {{field: unknown, composite: unknown, view: string, candKey: string, width: number} | null}
 */
let lastMapPaint = null;

/**
 * Index of the currently-selected candidate row (−1 = none) — mirrored onto
 * the map as the highlighted pin, so the row↔pin link reads in BOTH
 * directions (pin click selects the row; row click lights the pin). Re-applied
 * after every map repaint (the pin DOM is rebuilt wholesale).
 */
let scoutSelectedPin = -1;


/**
 * Game origin for "Open in game" links + click-to-galaxy — prefer serverData's
 * own domain, else reconstruct the canonical host from the universe id; `''`
 * when neither is available (links then omitted). Shared by the GV + Spyglass maps.
 * @returns {string}
 */
const gameLinkBase = () => {
  const dom = apiBounds.domain;
  const host = (typeof dom === 'string' && dom.includes('.'))
    ? dom
    : (/^s\d+-[a-z]+$/i.test(selectedUniverseId) ? `${selectedUniverseId}.ogame.gameforge.com` : '');
  return host ? `https://${host}` : '';
};

/** Repaint ONLY the analyzer block from current controls. */
const repaintFreeRegions = () => {
  const positions = freeRegionPositions();
  const composite = buildComposite(positions);
  const field = buildScoreField(composite);
  // Pane-level data contract: how old the occupancy snapshot is (universe.xml
  // regenerates weekly server-side) and whether the threat channel is anchored
  // to OUR fleet — without ownMilitary every active reads a flat base threat,
  // and the ranking silently looks identical to a calibrated one.
  if (scoutDataStamp) {
    const ts = apiCache.universe?.timestamp;
    if (typeof ts === 'number' && ts > 0) {
      const now = Date.now();
      const days = Math.max(0, Math.floor((now - ts) / 86_400_000));
      const age = days === 0 ? 'from today' : days === 1 ? '1 day old' : `${days} days old`;
      // TWO clocks, because they answer different questions: the snapshot age
      // is OGame's regeneration time (the file's own timestamp — how old the
      // occupancy truth is), "checked" is OUR last download (is the extension
      // still refreshing?). Showing only one made "10 days old" unexplainable.
      const fAt = apiCache.universe?.fetchedAt;
      const checkedH = typeof fAt === 'number' ? Math.max(0, (now - fAt) / 3_600_000) : null;
      const checked = checkedH == null ? ''
        : checkedH < 1 ? ' · checked <1 h ago'
          : checkedH < 48 ? ` · checked ${Math.round(checkedH)} h ago`
            : ` · checked ${Math.round(checkedH / 24)} d ago`;
      // `> 0` — classifyCell only applies the anchor for a positive score, so
      // a fresh account listed with military 0 is NOT calibrated either. The
      // anchor is our military-highscore POINTS (fleet + defence) — say so;
      // the old "calibrated to your fleet" overpromised.
      const calibrated = typeof ownMilitary === 'number' && ownMilitary > 0;
      scoutDataStamp.textContent = `Server snapshot: ${age}${checked}`
        + (calibrated
          ? ' · threat anchored to your military points (fleet + defence)'
          : ' · threat NOT calibrated — open the game once in this universe to anchor it');
      // Uncalibrated / stale states CHANGE what every Fit number means — they
      // read as a visible warning chip, not near-invisible grey micro-copy
      // (universe.xml regenerates weekly, hence the 7-day staleness bar).
      scoutDataStamp.classList.toggle('warn', !calibrated || days > 7);
    } else {
      scoutDataStamp.textContent = '';
      scoutDataStamp.classList.remove('warn');
    }
  }
  // Game origin for the popovers' "Open in game" links + the occupancy lens's
  // click-to-galaxy (shared with the Spyglass watchlist map).
  const linkBase = gameLinkBase();
  const shown = renderFreeRegions({
    containerEl: freeContainer,
    countInfoEl: freeCountInfoEl,
    scans: composite,
    positions,
    maxGaps: parseInt(chipValue(freeGapsChips), 10) || 0,
    zone: chipValue(freeZoneChips) || 'safe',
    find: chipValue(freeFindChips) || 'spots',
    // The Ignore-worst chips are disabled under the PvP zone (those players
    // are the point there) — force the exclusion off too, or a value saved
    // under Safe zone would silently censor the PvP target census.
    excludeN: (chipValue(freeZoneChips) || 'safe') === 'pvp' ? 0 : (parseInt(chipValue(freeExcludeChips), 10) || 0),
    field,
    galaxyMax: apiBounds.systems,
    linkBase,
    ownMilitary,
    players,
    danger: dangerProfiles,
    // Players we hold at least one spy report for — the Top-threats panel's
    // coverage readout (which of the window's actives we have intel on).
    spied: new Set(
      Object.keys(targetReports)
        .filter((id) => targetReports[id] && Object.keys(targetReports[id]).length)
        .map(Number),
    ),
    onOpenSpyglass: openSpyglassFor,
    ownRank: ownProfile.rank,
    onSelect: (i) => {
      scoutSelectedPin = i;
      highlightPin(serverMapHost, i);
    },
  });
  if (serverMapHost) {
    const view = chipValue(serverMapViewChips) || 'field';
    const width = serverMapHost.clientWidth || 0;
    // Hidden pane (tab/sub-tab not showing) → width 0 → both renderers would
    // lay out against a 700px guess; the occupancy canvas then maps hover and
    // pin clicks to the WRONG systems once stretched to the real width.
    // Skip and drop the memo instead — the tab/sub-tab click handlers repaint
    // as soon as the host is measurable.
    if (width === 0) {
      lastMapPaint = null;
      return;
    }
    // Candidate pins overlay BOTH views (they share the pin grammar).
    const pins = shown;
    // Occupancy ignores the field, so its identity must not force a canvas
    // rebuild on every Offline/Farm drag tick there — its pin key also skips
    // the fit number (a drag re-annotates fit every frame; repainting the
    // ~67k-cell canvas per tick for a tooltip digit isn't worth it). The
    // field view is DOM-cheap and keeps fit in the key so pin tooltips track
    // a re-annotation with unchanged order exactly.
    const fieldKey = view === 'field' ? field : null;
    const candKey = pins.map((r) => `${r.galaxy}:${r.center ?? r.start}`
      + (view === 'field' ? `:${Math.round((r.fit ?? 0) * 100)}` : '')).join(',');
    if (!lastMapPaint
      || lastMapPaint.field !== fieldKey
      || lastMapPaint.composite !== composite
      || lastMapPaint.view !== view
      || lastMapPaint.candKey !== candKey
      || lastMapPaint.width !== width) {
      lastMapPaint = { field: fieldKey, composite, view, candKey, width };
      renderServerMap({
        hostEl: serverMapHost,
        scans: composite,
        galaxies: apiBounds.galaxies,
        systems: apiBounds.systems,
        donutGalaxy: apiBounds.donutGalaxy,
        donutSystem: apiBounds.donutSystem,
        view,
        offlineWindow: parseInt(serverMapWindow?.value ?? '', 10) || 8,
        farmReach: parseInt(serverMapFarm?.value ?? '', 10) || 30,
        ownMilitary,
        linkBase,
        players,
        danger: dangerProfiles,
        field,
        candidates: pins,
        onPinClick: (i) => {
          selectCandidate(freeContainer, i);
          // Scroll the ROW the pin just selected into view — scrolling the
          // container stopped at its nearest edge, leaving the highlighted
          // row and its expanded detail below the fold (the pin looked dead).
          const sel = freeContainer.querySelector('tbody tr.selected');
          (sel ?? freeContainer).scrollIntoView({ behavior: 'smooth', block: sel ? 'center' : 'nearest' });
        },
      });
    }
    // The map paint (memoised or not) rebuilds/keeps pin DOM — re-assert the
    // selected row's pin so the row↔pin link survives repaints.
    highlightPin(serverMapHost, scoutSelectedPin);
  }
};

/**
 * rAF-coalesced variant for high-frequency `input` events (range sliders fire
 * on every pixel of a drag): at most one repaint per frame, always reading the
 * freshest control values when it runs.
 */
let repaintQueued = false;
const repaintFreeRegionsThrottled = () => {
  if (repaintQueued) return;
  repaintQueued = true;
  requestAnimationFrame(() => {
    repaintQueued = false;
    repaintFreeRegions();
  });
};

// ── Spyglass positions map (attack-planning / player-tracking) ──────────────
// A DEDICATED renderer (`renderPositionsMap`), NOT the Galaxy Viewer's occupancy
// lens: an empty grid with a marker only at your planets + your watched players',
// coloured by RELATIONSHIP (enemy/friend/neutral/you) and sized by danger. Keeps
// its OWN composite cache so it never stomps the GV's (mapPrimitives is stateless).
// The composite is only used to LOCATE each tracked player's planets.

/** All 15 colonizable positions — used to synthesise the composite we scan for planets. */
const SPY_MAP_POSITIONS = Array.from({ length: 15 }, (_, i) => i + 1);

/** Spyglass map composite cache — SEPARATE from the GV `compositeCache`. @type {{apiIndex: unknown, scans: unknown, posKey: string, value: GalaxyScans} | null} */
let spyCompositeCache = null;
/** Whether the Spyglass map section is expanded. */
let spyMapOpen = false;

/** Composite for the Spyglass map — own cache (mirrors `buildComposite`). */
const buildSpyComposite = () => {
  if (!(apiIndex && apiBounds.galaxies && apiBounds.systems)) return scans;
  const posKey = SPY_MAP_POSITIONS.join(',');
  if (spyCompositeCache
    && spyCompositeCache.apiIndex === apiIndex
    && spyCompositeCache.scans === scans
    && spyCompositeCache.posKey === posKey) {
    return spyCompositeCache.value;
  }
  const value = computeComposite({ apiIndex, apiBounds, scans, positions: SPY_MAP_POSITIONS });
  spyCompositeCache = { apiIndex, scans, posKey, value };
  return value;
};

/**
 * A player's map relationship: own = 'you', else the user's tag (untagged =
 * 'neutral').
 * @param {string} pid
 * @param {string|null} ownId
 * @returns {import('../../state/watchList.js').Relationship | 'you'}
 */
const relationshipOf = (pid, ownId) => (pid === ownId ? 'you' : (watchRelationships[pid] || 'neutral'));

/**
 * Render the Spyglass map's RELATIONSHIP legend into #spyMapLegend (you / enemy /
 * friend / neutral) — only the categories actually on the map. Hidden when empty.
 * @param {boolean} hasOwn
 */
const renderSpyMapLegend = (hasOwn) => {
  if (!spyMapLegend) return;
  const present = new Set([...watchedPlayers].map((pid) => watchRelationships[pid] || 'neutral'));
  /** @type {Array<[import('../../state/watchList.js').Relationship|'you', string]>} */
  const rows = [];
  if (hasOwn) rows.push(['you', 'You']);
  if (present.has('enemy')) rows.push(['enemy', 'Enemy']);
  if (present.has('friend')) rows.push(['friend', 'Friend']);
  if (present.has('neutral')) rows.push(['neutral', 'Neutral / untagged']);
  spyMapLegend.replaceChildren();
  for (const [rel, text] of rows) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
    const sw = document.createElement('span');
    sw.style.cssText = `width:10px;height:10px;border-radius:50%;background:${RELATIONSHIP_COLORS[rel]};border:1px solid #0008;flex:0 0 auto;`;
    chip.append(sw, document.createTextNode(text));
    spyMapLegend.appendChild(chip);
  }
  spyMapLegend.style.display = rows.length ? 'flex' : 'none';
};

/** Repaint the Spyglass positions map. No-op while closed/hidden. */
const repaintSpyglassMap = () => {
  if (!spyglassMapHost || !spyMapOpen) return;
  // Hidden pane → width 0 → markers land at the wrong systems; repaint on the
  // next tab/toggle open instead.
  if ((spyglassMapHost.clientWidth || 0) === 0) return;
  const ownId = ownProfile && ownProfile.id != null ? String(ownProfile.id) : null;
  const composite = buildSpyComposite();
  const nameOf = (/** @type {string} */ pid) => apiCache.players?.players?.[pid]?.name || `player ${pid}`;
  // Plot ONLY the bodies you care about: your planets + your watched players'.
  // (The whole occupancy palette is the Galaxy Viewer's job, not this map's.)
  /** @type {import('./mapPrimitives.js').MapBody[]} */
  const bodies = [];
  for (const key of /** @type {(keyof GalaxyScans)[]} */ (Object.keys(composite))) {
    const positions = composite[key]?.positions;
    if (!positions) continue;
    const [g, s] = String(key).split(':').map(Number);
    for (let p = 1; p <= 15; p++) {
      const player = positions[p]?.player;
      if (!player || player.id == null) continue;
      const pid = String(player.id);
      const isOwn = pid === ownId;
      if (!isOwn && !watchedPlayers.has(pid)) continue;
      bodies.push({
        galaxy: g,
        system: s,
        position: p,
        playerId: pid,
        name: player.name || nameOf(pid),
        relationship: relationshipOf(pid, ownId),
        danger: (dangerProfiles.get(Number(pid))?.danger ?? 0) * 100,
      });
    }
  }
  renderSpyMapLegend(!!ownId);
  renderPositionsMap({
    hostEl: spyglassMapHost,
    galaxies: apiBounds.galaxies,
    systems: apiBounds.systems,
    bodies,
    onPlayerClick: (pid) => openSpyglassFor(Number(pid)),
  });
};

/** Toggle the Spyglass map section open/closed. */
const toggleSpyMap = () => {
  spyMapOpen = !spyMapOpen;
  if (spyMapBlock) spyMapBlock.style.display = spyMapOpen ? '' : 'none';
  if (spyMapToggle) {
    spyMapToggle.textContent = spyMapOpen ? '🗺 Hide map' : '🗺 Show map';
    spyMapToggle.setAttribute('aria-expanded', String(spyMapOpen));
  }
  if (spyMapOpen) repaintSpyglassMap();
};

/**
 * Update the status line under the Export/Import row.
 *
 * @param {string} msg
 * @returns {void}
 */
const setStatus = (msg) => {
  if (importStatusEl) importStatusEl.textContent = msg;
};

/**
 * Hook every button / input on the page up to its action. Called once
 * at boot; never re-wires (so a single click listener per button).
 *
 * @returns {void}
 */
const wireListeners = () => {
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFile = /** @type {HTMLInputElement | null} */ (
    document.getElementById('importFile')
  );
  const exportCsvBtn = document.getElementById('exportCsvBtn');

  exportBtn?.addEventListener('click', () => {
    if (!selectedUniverseId) {
      setStatus('No server selected.');
      return;
    }
    void exportAllData(selectedUniverseId).then(() => {
      setStatus(
        'Exported ' + history.length + ' colonies, '
        + Object.keys(scans).length + ' scans (' + selectedUniverseId + ')',
      );
    });
  });

  importBtn?.addEventListener('click', () => importFile?.click());

  importFile?.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    if (!selectedUniverseId) {
      setStatus('No server selected.');
      importFile.value = '';
      return;
    }
    const res = await importAllData(file, selectedUniverseId);
    if (res.warning) {
      setStatus('Error: ' + res.warning);
    } else {
      setStatus(
        'Imported into ' + selectedUniverseId + ': +' + res.colonies
        + ' colonies, +' + res.scans + ' scans',
      );
    }
    // Clear the input so re-selecting the same file fires `change`.
    importFile.value = '';
  });

  exportCsvBtn?.addEventListener('click', () => {
    if (!selectedUniverseId) {
      setStatus('No server selected.');
      return;
    }
    exportColonyCsv(history, selectedUniverseId);
  });

  posFilter.addEventListener('change', () => renderAll());

  // Targets controls only repaint the Targets sub-tab (the candidate list is
  // already loaded; only the filter/limit we apply to it changed). Filter
  // controls also persist so the choice survives a reload.
  const onTargetFilterChange = () => { saveTargetPrefs(); repaintTargets(); };
  tgtMinMilitary.addEventListener('change', onTargetFilterChange);
  tgtMaxMilitary?.addEventListener('change', onTargetFilterChange);
  wireToggleChip(tgtInRange, onTargetFilterChange);
  wireToggleChip(tgtHideInactive, onTargetFilterChange);
  // Probe count is shared with the in-game scan FAB via chrome.storage, so it
  // persists through the watch-config write rather than the localStorage prefs.
  tgtProbes?.addEventListener('change', () => { writeWatchConfig(); repaintTargets(); });
  wireChips(tgtLimitChips, onTargetFilterChange);
  tgtSearch?.addEventListener('input', () => {
    targetSearchQuery = tgtSearch ? tgtSearch.value : '';
    repaintTargets();
  });
  wireToggleChip(tgtWatchedOnly, () => repaintTargets());
  // ⚙ show/hide for the rarely-touched numeric filters (military range, probes).
  tgtConfigToggle?.addEventListener('click', () => {
    const opening = tgtConfigCard ? tgtConfigCard.style.display === 'none' : false;
    if (tgtConfigCard) tgtConfigCard.style.display = opening ? '' : 'none';
    tgtConfigToggle?.setAttribute('aria-expanded', String(opening));
  });
  spyMapToggle?.addEventListener('click', toggleSpyMap);

  // Region controls only repaint the settlement-regions block. The
  // underlying `scans` cache hasn't changed — only the slots/tolerance
  // we query against have — so the colony / galaxy passes would be
  // wasted work.
  const saveScoutPrefs = () => {
    safeLS.setJSON(SCOUT_PREFS_KEY, {
      zone: chipValue(freeZoneChips),
      find: chipValue(freeFindChips),
      excludeN: chipValue(freeExcludeChips),
      slots: freePosInput.value,
      gaps: chipValue(freeGapsChips),
      window: serverMapWindow?.value,
      farmReach: serverMapFarm?.value,
      view: chipValue(serverMapViewChips),
    });
  };

  freePosInput.addEventListener('change', () => { validateSlots(); saveScoutPrefs(); repaintFreeRegions(); });
  wireChips(freeGapsChips, () => { saveScoutPrefs(); repaintFreeRegions(); });
  wireChips(freeZoneChips, () => {
    updateModeControls();
    saveScoutPrefs();
    repaintFreeRegions();
  });
  wireChips(freeFindChips, () => {
    updateModeControls();
    saveScoutPrefs();
    repaintFreeRegions();
  });
  wireChips(serverMapViewChips, () => {
    saveScoutPrefs();
    repaintFreeRegions();
  });
  // Offline window / farm reach drive the RANKING field, not just the map —
  // repaint unconditionally. Persist on release ('change'), not per drag tick.
  // Readouts carry their unit — a bare "30" said nothing about systems.
  serverMapWindow?.addEventListener('input', () => {
    if (serverMapWindowV && serverMapWindow) serverMapWindowV.textContent = `${serverMapWindow.value} h`;
    repaintFreeRegionsThrottled();
  });
  serverMapWindow?.addEventListener('change', saveScoutPrefs);
  serverMapFarm?.addEventListener('input', () => {
    if (serverMapFarmV && serverMapFarm) serverMapFarmV.textContent = `${serverMapFarm.value} sys`;
    repaintFreeRegionsThrottled();
  });
  serverMapFarm?.addEventListener('change', saveScoutPrefs);
  wireChips(freeExcludeChips, () => { saveScoutPrefs(); repaintFreeRegions(); });

  universeSelect.addEventListener('change', () => {
    selectedUniverseId = universeSelect.value;
    // Region keys carry no universe component — a coincidentally matching
    // region in the next universe would auto-expand as "your selection".
    resetFreeSelection();
    void loadWatched().then(() => loadAll()).then(renderAll);
    alarmClockApi?.refresh();
    routesApi?.refresh();
    scanColonyConfigApi?.refresh();
    alarmClockConfigApi?.refresh();
  });

  // Re-render on window resize so the colony chart's adaptive binning
  // re-evaluates against the new chart width. Debounced (150 ms quiet
  // window) because resize events fire at ~60 Hz during a drag — a
  // bare listener would call renderAll dozens of times per second for
  // no visible benefit. Galaxy map and Free Positions also repaint
  // here but they're width-agnostic and the render is DOM-only
  // (no storage round-trip), so the cost is negligible.
  window.addEventListener('resize', debounce(() => renderAll(), 150));
};

/**
 * Test-only reset: return the module to its just-loaded state so a fresh
 * {@link installDashboard} in a new test starts clean. Re-inits the
 * module-level `let`s, drops the DOM refs cached by {@link wireDom} (so a
 * stale node from a previous test's DOM can't leak in), and resets the child
 * tab modules. `_`-prefixed: not for production.
 *
 * @returns {void}
 */
export const _resetDashboardForTest = () => {
  selectedUniverseId = '';
  alarmClockApi = null;
  routesApi = null;
  scanColonyConfigApi = null;
  alarmClockConfigApi = null;
  history = [];
  scans = {};
  proximityReports = [];
  compositeCache = null;
  scoreFieldCache = null;
  lastMapPaint = null;
  scoutSelectedPin = -1;
  dangerProfiles = new Map();
  civilProfiles = new Map();
  routines = {};
  focusedTargetId = null;
  spyMapOpen = false;
  spyCompositeCache = null;
  // DOM refs filled by wireDom(); wireDom re-resolves them on the next
  // install, but null them now so nothing reads a detached node in between.
  statsEl =
    chartEl =
    countInfoEl =
    posFilter =
    universeSelect =
    importStatusEl =
    freePosInput =
    freeGapsChips =
    freeZoneChips =
    freeFindChips =
    freeZoneHint =
    scoutDataStamp =
    freeExcludeChips =
    freeSlotsNote =
    freeGapsNote =
    freeExcludeNote =
    serverMapViewChips =
    serverMapHost =
    serverMapWindow =
    serverMapWindowV =
    serverMapFarm =
    serverMapFarmV =
    targetsContainer =
    tgtMinMilitary =
    tgtMaxMilitary =
    tgtLimitChips =
    tgtSearch =
    tgtWatchedOnly =
    tgtProbes =
    tgtInRange =
    tgtHideInactive =
    tgtConfigToggle =
    tgtConfigCard =
    tgtCountInfoEl =
    proximityStripEl =
    proximityCountsEl =
    proximityAlertEl =
    freeContainer =
    freeCountInfoEl =
      /** @type {any} */ (undefined);
  // Session-only state that boot() does not re-establish: clear it so a
  // re-install starts clean (watch-list Set, rescan flags, expanded target
  // rows, target sort, and the pending-repaint flag).
  watchedPlayers.clear();
  rescanMap = {};
  expandedTargets.clear();
  targetSort = { ...DEFAULT_TARGET_SORT };
  repaintQueued = false;
  installed = false;
  _resetAlarmClockForTest();
  _resetFreeStreakForTest();
};
