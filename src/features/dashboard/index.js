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
import { logger } from '../../lib/logger.js';
import { refreshApiCache } from '../shared/apiRefresh.js';
import { parseSvg } from '../../lib/dom.js';
import { EYE_GLYPH } from '../shared/buttonGlyphs.js';
import { parseTargetPositions } from '../../domain/histogram.js';
import { populatePositionFilter, renderColonyChart } from './colony.js';
import { renderFreeRegions, renderServerMap, selectCandidate, resetFreeSelection, highlightPin, _resetFreeStreakForTest } from './freeStreak.js';
import { chipValue, setChipValue, wireChips, setChipsEnabled, toggleChipOn, setToggleChip, wireToggleChip } from './chips.js';
import { digestProximityReports } from '../../domain/proximityDigest.js';
import { bodyNameIndex, bodyNameFor, nearestBodyDistance } from '../../domain/bodies.js';
import { renderWatchlistCards } from './cards.js';
import { computeComposite, computeScoreField, renderPositionsMap, MAP_YOU_COLOR, WATCH_DEFAULT_COLOR, WATCH_COLOR_PALETTE } from './mapPrimitives.js';
import { axisDelta, flightDistance, niszczHours } from '../../domain/geometry.js';
import { renderTargets, DEFAULT_TARGET_SORT, TARGETS_NARROW_MQ } from './targets.js';
import { ZONES } from '../../domain/zoneScore.js';
import { buildOccupancyIndex } from '../../domain/apiOccupancy.js';
import { buildTargetCandidates, playerPlanets } from '../../domain/targets.js';
import { joinDangerProfiles } from '../../domain/dangerJoin.js';
import { buildCivilBaseline, collectCivilCalibration } from '../../domain/civilBaseline.js';
import { estimateHiddenFleet, estimateCombatShare } from '../../domain/threatModel.js';
import { raidVerdict } from '../../domain/raidVerdict.js';
import { normalizeReportTimestamps } from '../../domain/espionageReport.js';
import { latestOf, historyOf } from '../../domain/targetReports.js';
import { bodyLootStats } from '../../domain/lootRhythm.js';
import { summarizeRoutine, routineBodies } from '../../domain/routine.js';
import { summarizePresence } from '../../domain/presence.js';
import { detectAllLandings } from '../../domain/fleetLanding.js';
import { patrolSystemKeys, patrolOccupants, patrolPlayers } from '../../domain/patrol.js';
import { renderPatrolCard } from './patrol.js';
import { bracketFsArcs } from '../../domain/fsBracket.js';
import { probeActivityObs } from '../../domain/activityObs.js';
import { readApiCacheFor, apiCacheKeyFor } from '../../state/apiCache.js';
import { targetReportsKeyFor } from '../../state/targets.js';
import { allianceClassKeyFor } from '../../state/allianceClass.js';
import { proximityReportsKeyFor } from '../../state/proximityReports.js';
import { bodiesKeyFor } from '../../state/bodies.js';
import { activityObsKeyFor } from '../../state/activityObs.js';
import { presenceLedgerKeyFor } from '../../state/presenceLedger.js';
import { mergePresenceLedgers } from '../../domain/presenceLedger.js';
import { allianceIntelKeyFor } from '../../state/allianceShare.js';
import { normalizeAllianceDoc, allianceLedgerForPid } from '../../domain/allianceIntel.js';
import { watchListKeyFor, normalizeWatchList, writeWatchListConfig, DEFAULT_SPY_PROBES, DEFAULT_CADENCE, DEFAULT_MOON_STRIKE, DEFAULT_PROBE_SOURCE, normalizeCadence } from '../../state/watchList.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import { formatBytes, parsePerUniverseKey } from './syncInventory.js';
import { galaxyStaleMs } from '../../domain/galaxyWatch.js';
import { pointsOf, pointsToResources } from '../../domain/unitCosts.js';
import {
  HISTORY_KEY_BASE,
  historyKeyFor,
} from '../../state/history.js';
import {
  SCANS_KEY_BASE,
  scansKeyFor,
} from '../../state/scans.js';
import { playersKeyFor } from '../../state/players.js';
import { readOwnProfile, ownProfileKeyFor, OWN_PROFILE_KEY_BASE } from '../../state/ownProfile.js';
import { API_CACHE_KEY_BASE } from '../../state/apiCache.js';
import { BODIES_KEY_BASE } from '../../state/bodies.js';
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
import { installAllianceShare } from './allianceShare.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

// Colony Scout control preferences — persisted so selections survive page reload.
const SCOUT_PREFS_KEY = 'oge_colonyScoutPrefs';
/** Device-local last-selected Big Colony Hunting position filter — persists
 *  the `#posFilter` choice across reloads (restored once in renderAll after
 *  the Position-N options exist). Device-local like the other colony prefs. */
const COLONY_POS_FILTER_KEY = 'oge_colonyPosFilter';

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
 * Player id → user-picked map marker colour (`#rrggbb`) for the selected
 * universe — the Spyglass map's per-player hue, edited on the map's player
 * chips. Absent = the default grey. Loaded/written with the watch-list.
 * @type {Record<string, string>}
 */
let watchColors = {};
/**
 * Watched players muted on the positions map (id → true) — map-only, they stay
 * in the table scope + the FAB's scan walk. Mirrors `WatchListConfig.mapHidden`.
 * @type {Record<string, true>}
 */
let mapHiddenIds = {};
/**
 * Scan-mode map (player id / body override key → 'on'|'off') for the selected
 * universe. Mirrors `WatchListConfig.scanMode`; resolution lives in
 * domain/scanMode.effectiveScan. Galaxy activity is NOT in here.
 * @type {Record<string, import('../../domain/scanMode.js').ScanMode>}
 */
let scanModeMap = {};
/**
 * Per-player galaxy-watch toggle (player id → 'on'|'off'; absent = on) for the
 * selected universe — mutes the galaxy-LOOK plan for that player (recording
 * stays always-on). Mirrors `WatchListConfig.galaxyMode`.
 * @type {Record<string, import('../../domain/scanMode.js').ScanMode>}
 */
let galaxyModeMap = {};
/**
 * Re-scan cadences for the selected universe (probe re-scan hours + galaxy
 * hours). Mirrors `WatchListConfig.cadence`. @type {import('../../state/watchList.js').Cadence}
 */
let cadenceCfg = { ...DEFAULT_CADENCE };

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

/**
 * Handle to the alliance-share panel's refresh entrypoint, set by
 * {@link boot}. Same universe-getter contract as the siblings above.
 *
 * @type {{ refresh: () => void } | null}
 */
let allianceShareApi = null;

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
 * Alliance id → class slug ('warrior' | 'trader' | 'explorer' | 'none') for the
 * selected universe (`state/allianceClass.js`), harvested from the ALLIANCE
 * highscore DOM. Feeds the danger model's warrior-alliance tell + the
 * unknown-class hint.
 * @type {Record<string, string>}
 */
let allianceClasses = {};

/**
 * "Foreign fleet spotted near your planet" alerts for the selected universe
 * (`state/proximityReports.js`), newest-first. Drives the Spyglass
 * "Who's spying on you" strip.
 * @type {import('../../domain/espionageReport.js').ProximityReport[]}
 */
let proximityReports = [];
/** Our owned bodies (planets + moons) for the selected universe — powers the
 *  proximity strip's coords/names toggle + distance lines.
 *  @type {import('../../domain/bodies.js').Body[]} */
let ownBodies = [];
/** Device-local coords↔names toggle for the proximity strip (localStorage). */
const PROX_NAMES_KEY = 'oge_proxNames';
let proximityShowNames = safeLS.get(PROX_NAMES_KEY) === '1';

/**
 * Date-range filter for the proximity strip — a radio chip beside the
 * coords/names toggle. Value → look-back window in SECONDS (ts-less alerts,
 * which can't be aged, always pass). '1m' is the default (the strip's prior
 * hard-coded 30-day cutoff); matches the in-game panel's chip.
 * @type {Array<[value: string, label: string, seconds: number]>}
 */
const PROX_RANGES = [
  ['1d', '1d', 86400],
  ['7d', '7d', 604800],
  ['1m', '1m', 2592000],
  ['3m', '3m', 7776000],
];
const PROX_RANGE_KEY = 'oge_proxRange';
/** Device-local: remember whether the Spyglass scan-settings block is open. */
const SPY_SCAN_PREFS_OPEN_KEY = 'oge_spyScanPrefsOpen';
let proximityRange = PROX_RANGES.some(([v]) => v === safeLS.get(PROX_RANGE_KEY))
  ? /** @type {string} */ (safeLS.get(PROX_RANGE_KEY))
  : '1m';

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
 * spy-report history rings + the galaxy-activity rings (F3). Rebuilt on data
 * load; empty for players with no history (only watched players accrue it).
 * @type {Record<string, import('../../domain/routine.js').RoutineSummary>}
 */
let routines = {};

/**
 * Per-player presence summary (SPYGLASS-PASSIVE-PLAN §4) — the offline-window
 * heatmap inputs (scale + grid + recommended window), from the SAME per-body
 * intel routines use. Rebuilt on data load; empty for players with no history.
 * @type {Record<string, ReturnType<typeof summarizePresence>>}
 */
let presences = {};

/**
 * Galaxy-activity rings for the selected universe (F3): playerId → bodyKey →
 * observation ring. Written in-game by `state/activityObs.js` (watched players
 * only); the dashboard reads the raw per-universe key, like targetReports.
 * @type {import('../../state/activityObs.js').ActivityObsMap}
 */
let activityObs = {};

/**
 * Per-player pooled presence-HISTORY for the selected universe — the
 * months-scale day×hour ledger (domain/presenceLedger.js), POOLED from this
 * device's local ledger AND every alliance member's shared ledger (union by
 * bitwise OR). This is the long-horizon fuel for the dossier's presence
 * explorer; distinct from `presences` (the short-window statistical
 * offline-window engine). Rebuilt on data load.
 * @type {Record<string, { ledger: import('../../domain/presenceLedger.js').PresenceLedger, allianceMembers: string[] }>}
 */
let presenceHistories = {};

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
/** @type {HTMLElement | null} */ let serverMapProtWrap;
/** @type {HTMLElement | null} */ let serverMapProtected;
/** @type {HTMLInputElement | null} */ let serverMapWindow;
/** @type {HTMLInputElement | null} */ let serverMapWindowV;
/** @type {HTMLInputElement | null} */ let serverMapFarm;
/** @type {HTMLInputElement | null} */ let serverMapFarmV;
/** @type {HTMLInputElement | null} */ let serverMapSep;
/** @type {HTMLInputElement | null} */ let serverMapSepV;
/** @type {HTMLElement | null} */ let serverMapSepNote;
/** @type {HTMLElement | null} */ let freeCountInfoEl;
/** @type {HTMLElement} */ let targetsContainer;
/** @type {HTMLElement | null} */ let spyglassMapHost;
/** @type {HTMLButtonElement | null} */ let spyMapToggle;
/** @type {HTMLElement | null} */ let spyMapBlock;
/** @type {HTMLElement | null} */ let spyMapYouEl;
/** Reach overlay toggle — a chip pill (`.on` is its state), not a checkbox. */
/** @type {HTMLElement | null} */ let spyMapReach;
/** @type {HTMLElement | null} */ let spyMapPlayersEl;
/** @type {HTMLInputElement} */ let tgtMinMilitary;
/** @type {HTMLInputElement | null} */ let tgtMaxMilitary;
/** Show-limit seg chip-group (was a <select>); `data-value` = row cap. */
/** @type {HTMLElement | null} */ let tgtLimitChips;
/** @type {HTMLInputElement | null} */ let tgtSearch;
/** Current Spyglass nickname search (Etap D); '' = no search. */
let targetSearchQuery = '';
/** Player ids force-included past the filters via search "show anyway". */
const forceIncludeIds = new Set();
/**
 * Player ids PINNED into the table by a deep-link click (watchlist card,
 * "dossier ▸", map chip, `?spy=`). A pinned player renders even
 * when the top-N row cap / watched-only scope would drop them — the click
 * means "show me this player", so a silent no-op row is a UX dead end. The
 * row is appended after the capped list with a "beyond the cap" note.
 * @type {Set<string>}
 */
const pinnedTargetIds = new Set();
// The three everyday filters are toggle PILLS (Etap H1) — `.on` is the state,
// read via toggleChipOn where `.checked` used to be.
/** @type {HTMLElement | null} */ let tgtWatchedOnly;
/** @type {HTMLInputElement | null} */ let tgtProbes;
/** @type {HTMLElement | null} */ let tgtScanBodies;
/** @type {HTMLElement | null} */ let tgtMoonStrike;
/** @type {HTMLElement | null} */ let tgtProbeSource;
/** @type {HTMLInputElement | null} */ let cadRescanHours;
/** @type {HTMLInputElement | null} */ let tgtPatrolSystems;
/** @type {HTMLElement | null} */ let patrolCardEl;
/** @type {HTMLElement | null} */ let patrolSummaryEl;
/** @type {HTMLElement | null} */ let patrolStrikesEl;
/** @type {HTMLInputElement | null} */ let cadGalaxyHours;
/** @type {HTMLElement | null} */ let tgtHideInactive;
/** @type {HTMLButtonElement | null} */ let tgtConfigToggle;
/** @type {HTMLElement | null} */ let tgtConfigCard;
/** @type {HTMLElement | null} */ let tgtCountInfoEl;
/** @type {HTMLElement | null} */ let proximityStripEl;
/** @type {HTMLElement | null} */ let proximityCountsEl;
/** @type {HTMLElement | null} */ let proximityAlertEl;
/** @type {HTMLElement | null} */ let proximityHeadToolsEl;
/** @type {HTMLElement | null} */ let watchCardsEl;
/** @type {HTMLButtonElement | null} */ let spyApiRefreshEl;

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
  wireTopTools();
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
  // Alliance Spyglass share: config card on the Sync tab + the title-level
  // Alliance button and intel panel on the Spyglass tab.
  allianceShareApi = installAllianceShare({ getUniverseId: () => selectedUniverseId });

  const universes = await discoverUniverses();
  selectedUniverseId = resolveInitialUniverse(universes);
  populateUniverseSelect(universes, selectedUniverseId);
  updateToolsPill();
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
  allianceShareApi?.refresh();
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
    if (serverMapWindowV) serverMapWindowV.value = serverMapWindow.value;
  }
  if (scoutPrefs.farmReach !== undefined && serverMapFarm) {
    serverMapFarm.value = String(scoutPrefs.farmReach);
    if (serverMapFarmV) serverMapFarmV.value = serverMapFarm.value;
  }
  if (scoutPrefs.spotGap !== undefined && serverMapSep) {
    serverMapSep.value = String(scoutPrefs.spotGap);
    if (serverMapSepV) serverMapSepV.value = serverMapSep.value;
  }
  if (scoutPrefs.view) setChipValue(serverMapViewChips, String(scoutPrefs.view));
  // Protected visibility (occupancy view): absent/legacy prefs default to shown.
  if (serverMapProtected) setToggleChip(serverMapProtected, scoutPrefs.mapProtected !== false);
  syncMapProtVisibility();
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
      allianceClassKeyFor(selectedUniverseId),
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
 * (no scans / no colonies yet) still shows up — and so are the
 * every-page-load bases (`oge_ownProfile`, `oge_bodies`, `oge_apiCache`):
 * after an extension reinstall wipes chrome.storage, those are the FIRST
 * keys a game visit recreates, and without them the selector stayed empty,
 * which silently no-op'd every config editor (the "reminders can't be set
 * after reinstall" trap — the editors need a universe id to write under).
 *
 * Built on the shared {@link parsePerUniverseKey} (the one parser for
 * `<id>:oge_*` keys), then narrowed by an EXPLICIT base whitelist: the
 * selector deliberately surfaces only universes with evidence of real play
 * on this device, not any lone `oge_*` bookkeeping key. That narrower
 * policy is the intent here (unlike `requestSyncAll`, which pokes every
 * `oge_*` universe).
 *
 * @returns {Promise<string[]>}
 */
const discoverUniverses = async () => {
  const all = await chromeStore.getAll();
  /** @type {Set<string>} */
  const ids = new Set();
  const bases = new Set([
    HISTORY_KEY_BASE,
    SCANS_KEY_BASE,
    GALAXY_SCAN_CONFIG_KEY_BASE,
    OWN_PROFILE_KEY_BASE,
    BODIES_KEY_BASE,
    API_CACHE_KEY_BASE,
  ]);
  for (const key of Object.keys(all)) {
    const parsed = parsePerUniverseKey(key);
    if (parsed && bases.has(parsed.base)) ids.add(parsed.universeId);
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
  serverMapProtWrap = document.getElementById('serverMapProtWrap');
  serverMapProtected = document.getElementById('serverMapProtected');
  serverMapWindow = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapWindow'));
  serverMapWindowV = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapWindowV'));
  serverMapFarm = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapFarm'));
  serverMapFarmV = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapFarmV'));
  serverMapSep = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapSep'));
  serverMapSepV = /** @type {HTMLInputElement | null} */ (document.getElementById('serverMapSepV'));
  serverMapSepNote = document.getElementById('serverMapSepNote');
  freeCountInfoEl = document.getElementById('freeCountInfo');
  targetsContainer = /** @type {HTMLElement} */ (document.getElementById('targetsContainer'));
  tgtMinMilitary = /** @type {HTMLInputElement} */ (document.getElementById('tgtMinMilitary'));
  tgtMaxMilitary = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtMaxMilitary'));
  tgtLimitChips = document.getElementById('tgtLimitChips');
  tgtSearch = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtSearch'));
  tgtWatchedOnly = document.getElementById('tgtWatchedOnly');
  tgtProbes = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtProbes'));
  tgtScanBodies = document.getElementById('tgtScanBodies');
  tgtMoonStrike = document.getElementById('tgtMoonStrike');
  tgtProbeSource = document.getElementById('tgtProbeSource');
  cadRescanHours = /** @type {HTMLInputElement | null} */ (document.getElementById('cadRescanHours'));
  tgtPatrolSystems = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtPatrolSystems'));
  patrolCardEl = document.getElementById('patrolCard');
  patrolSummaryEl = document.getElementById('patrolSummary');
  patrolStrikesEl = document.getElementById('patrolStrikes');
  cadGalaxyHours = /** @type {HTMLInputElement | null} */ (document.getElementById('cadGalaxyHours'));
  tgtHideInactive = document.getElementById('tgtHideInactive');
  tgtConfigToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('tgtConfigToggle'));
  tgtConfigCard = document.getElementById('tgtConfigCard');
  tgtCountInfoEl = document.getElementById('tgtCountInfo');
  proximityStripEl = document.getElementById('proximityStrip');
  proximityCountsEl = document.getElementById('proximityCounts');
  proximityAlertEl = document.getElementById('proximityAlert');
  proximityHeadToolsEl = document.getElementById('proximityHeadTools');
  watchCardsEl = document.getElementById('watchCards');
  spyApiRefreshEl = /** @type {HTMLButtonElement | null} */ (document.getElementById('spyApiRefresh'));
  spyglassMapHost = document.getElementById('spyglassMapHost');
  spyMapToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('spyMapToggle'));
  spyMapBlock = document.getElementById('spyMapBlock');
  spyMapYouEl = document.getElementById('spyMapYou');
  spyMapReach = document.getElementById('spyMapReach');
  spyMapPlayersEl = document.getElementById('spyMapPlayers');
  // Paint the Spyglass title eye from the shared EYE_GLYPH (one art source,
  // mirrors the in-game Who's-spying panel's header eye).
  const spyEyeHost = document.getElementById('spyTitleEye');
  if (spyEyeHost && !spyEyeHost.firstChild) {
    spyEyeHost.appendChild(parseSvg(
      `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false">${EYE_GLYPH}</svg>`));
  }
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
    // The tab row is a one-row sideways scroller on phones — pull the
    // active tab into view so it can never sit hidden past the edge.
    // (Guarded: happy-dom has no scrollIntoView.)
    if (key === resolved && typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
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
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('tab');
  const initial = fromUrl || safeLS.get(ACTIVE_TAB_LS_KEY) || DEFAULT_TAB;
  setActiveTab(initial);

  // `?spy=<playerId>` deep-links one player's Spyglass dossier (the in-game
  // "Who's spying on you" table sends it). Same path as every in-dashboard
  // deep-link click — expand + focus + pin past the filters/row cap; data
  // hasn't loaded yet at wire time, so the focus consumer in repaintTargets
  // (which retries until the row exists) does the scrolling.
  const spyPid = params.get('spy');
  if (spyPid && /^\d+$/.test(spyPid)) openSpyglassFor(Number(spyPid));

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
 * Top-bar tools disclosure (phone only). The Server/Export/Import cluster
 * hides behind the codename pill below 520px; tapping the pill toggles
 * `.tools-open` on the bar, which CSS turns into the tools' own full-width
 * second row. aria-expanded mirrors the class (same pattern as ⚙ Filters).
 * On wide viewports CSS shows the tools inline and hides the pill — this
 * listener is simply inert there.
 *
 * @returns {void}
 */
const wireTopTools = () => {
  const pill = document.getElementById('topToolsPill');
  const bar = pill?.closest('.top-bar');
  if (!pill || !bar) return;
  pill.addEventListener('click', () => {
    const open = bar.classList.toggle('tools-open');
    pill.setAttribute('aria-expanded', String(open));
  });
};

/**
 * Paint the ACTIVE universe's codename (`s163-pl`) on the top-bar Tools
 * pill — the pill both says which server the page is showing and opens the
 * row that changes it. Falls back to "Tools" when no universe has data yet.
 * Called at boot and on every universe switch.
 *
 * @returns {void}
 */
const updateToolsPill = () => {
  const pill = document.getElementById('topToolsPill');
  if (pill) pill.textContent = selectedUniverseId || 'Tools';
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
  watchColors = {};
  mapHiddenIds = {};
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
  watchColors = cfg.colors ?? {};
  mapHiddenIds = cfg.mapHidden ?? {};
  scanModeMap = cfg.scanMode ?? {};
  galaxyModeMap = cfg.galaxyMode ?? {};
  cadenceCfg = cfg.cadence ?? { ...DEFAULT_CADENCE };
  // chrome.storage is authoritative for the probe count (the FAB reads it too).
  if (tgtProbes) tgtProbes.value = String(cfg.probes);
  if (tgtScanBodies) setChipValue(tgtScanBodies, cfg.scanBodies ?? 'planets');
  if (tgtMoonStrike) setChipValue(tgtMoonStrike, cfg.moonStrike ?? DEFAULT_MOON_STRIKE);
  if (tgtProbeSource) setChipValue(tgtProbeSource, cfg.probeSource ?? DEFAULT_PROBE_SOURCE);
  updateMoonStrikeNote();
  if (tgtPatrolSystems) tgtPatrolSystems.value = String(cfg.patrolSystems ?? 0);
  hydrateCadenceInputs();
};

/**
 * Per-mode one-liners for the Moon strike cell's visible note (the scan-prefs
 * block) — what the SELECTED mode flags, in the cell itself, since a tooltip
 * doesn't exist on touch. The long form (all modes) stays in the `title=`.
 * @type {Record<string, string>}
 */
const MOON_STRIKE_NOTES = {
  off: 'off — no parked-fleet flags on moons',
  lone: 'flags a lit moon while every other body is quiet — likely parked fleet',
  newest: 'flags the moon holding the account’s newest activity — likely parked fleet',
  any: 'flags any lit moon, even beside active planets — owner may be around',
};

/** Reflect the selected moon-strike mode into its note line (fill + click). */
const updateMoonStrikeNote = () => {
  const note = document.getElementById('tgtMoonStrikeNote');
  if (note) note.textContent = MOON_STRIKE_NOTES[chipValue(tgtMoonStrike) || DEFAULT_MOON_STRIKE] ?? '';
};

/**
 * Trailing debounce for the post-edit sync poke: rapid star/tag/toggle
 * clicks coalesce into ONE `<uni>:oge_syncRequestAt` tombstone (each poke
 * costs any open game tab a full forced sync round-trip). The DATA writes
 * stay immediate — the poke fires last, and the round it triggers reads the
 * then-freshest chrome.storage state, so coalescing loses nothing.
 */
let pokeSyncTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

/** @param {string} uni @returns {void} */
const pokeSyncSoon = (uni) => {
  if (pokeSyncTimer) clearTimeout(pokeSyncTimer);
  pokeSyncTimer = setTimeout(() => {
    pokeSyncTimer = null;
    void chromeStore.set(syncRequestKeyFor(uni), Date.now());
  }, 4000);
};

/**
 * Write the watch-list config for the selected universe so the in-game scan
 * FAB sees the same players + probe count. Goes through
 * `writeWatchListConfig` — the stamping funnel that diffs against the stored
 * config and records per-key LWW timestamps (+ removal tombstones) in the
 * `oge_watchListTs` ledger — then pokes any open game tab to push the change
 * to the gist (harmless no-op when cloud sync is off; same pattern as
 * dashboard/scanConfig.js). Fire-and-forget (the in-memory Set / control are
 * the source of truth for the current paint).
 *
 * @returns {void}
 */
const writeWatchConfig = () => {
  if (!selectedUniverseId) return;
  const uni = selectedUniverseId;
  void writeWatchListConfig(uni, {
    players: [...watchedPlayers],
    probes: Number(tgtProbes?.value) || DEFAULT_SPY_PROBES,
    scanBodies: chipValue(tgtScanBodies) || 'planets',
    moonStrike: chipValue(tgtMoonStrike) || DEFAULT_MOON_STRIKE,
    probeSource: chipValue(tgtProbeSource) || DEFAULT_PROBE_SOURCE,
    patrolSystems: Number(tgtPatrolSystems?.value) || 0,
    rescan: rescanMap,
    colors: watchColors,
    mapHidden: mapHiddenIds,
    scanMode: scanModeMap,
    galaxyMode: galaxyModeMap,
    cadence: cadenceCfg,
  }).then(() => pokeSyncSoon(uni));
};

/** Reflect the current cadence into the two number inputs (hydrate/reset). */
const hydrateCadenceInputs = () => {
  if (cadRescanHours) cadRescanHours.value = String(cadenceCfg.rescanHours);
  if (cadGalaxyHours) cadGalaxyHours.value = String(cadenceCfg.galaxyHours);
};

/**
 * Read the two cadence inputs into {@link cadenceCfg} (clamped/validated by
 * `normalizeCadence`), reflect the clamped values back, persist, repaint.
 * @returns {void}
 */
const commitCadence = () => {
  cadenceCfg = normalizeCadence({
    rescanHours: Number(cadRescanHours?.value),
    galaxyHours: Number(cadGalaxyHours?.value),
  });
  hydrateCadenceInputs();
  writeWatchConfig();
  repaintTargets();
};

/**
 * Per-system newest scan time ("g:s" → epoch s) from the loaded scans — the
 * full-sweep gate's system-level coverage source (see domain/fleetLanding).
 * @returns {Record<string, number>}
 */
const sysLookSecFromScans = () => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(scans)) {
    const t = v ? Number(v.scannedAt) : 0;
    if (Number.isFinite(t) && t > 0) out[k] = Math.floor(t / 1000);
  }
  return out;
};

/**
 * Recompute + repaint the Patrol card (territory mode, domain/patrol) from
 * the per-universe loads already in scope: own bodies → territory; API
 * occupancy → occupants/prey (filtered by API status and galaxy
 * meta); activity rings → strikes, at the configured moon-strike
 * mode. Hidden entirely while the radius input is 0 — no view is multiplied
 * for users who don't hunt.
 *
 * @param {number} nowMs
 * @returns {void}
 */
const repaintPatrol = (nowMs) => {
  if (!patrolCardEl) return;
  const radius = Number(tgtPatrolSystems?.value) || 0;
  const planets = apiCache.universe ? apiCache.universe.planets : [];
  if (radius <= 0 || !ownBodies.length || !planets.length) {
    patrolCardEl.style.display = 'none';
    return;
  }
  patrolCardEl.style.display = '';
  const systems = patrolSystemKeys(ownBodies, radius, {
    systems: apiBounds.systems,
    donutSystem: apiBounds.donutSystem,
  });
  const occupants = patrolOccupants(planets, systems, ownProfile.id ?? null);
  const apiPlayers = apiCache.players ? apiCache.players.players : {};
  const prey = patrolPlayers(occupants, {
    apiPlayers,
    meta: players,
  }).filter((pid) => !watchedPlayers.has(pid));
  const strikes = detectAllLandings(prey, planets, activityObs, nowMs, {
    mode: /** @type {import('../../domain/fleetLanding.js').MoonStrikeMode} */ (
      chipValue(tgtMoonStrike) || DEFAULT_MOON_STRIKE),
    sysLookSec: sysLookSecFromScans(),
  });
  renderPatrolCard({
    summaryEl: patrolSummaryEl,
    hostEl: patrolStrikesEl,
    radius,
    systems,
    occupants,
    strikes,
    names: apiPlayers || {},
    scans,
    staleMs: (cadenceCfg.galaxyHours || 24) * 3600 * 1000,
    nowMs,
    linkBase: gameLinkBase() || undefined,
    watchedIds: watchedPlayers,
    onToggleWatch: toggleWatched,
  });
};

/**
 * Set (or clear back to inherited) a body/player scan mode, persist, repaint.
 * A per-body key sets an override; a player id sets the whole-player default.
 * Passing `null` deletes the key so it falls back through
 * domain/scanMode.effectiveScan (body ?? player ?? 'on').
 * @param {string} key   player id, "g:s:p" planet, or "g:s:p:3" moon.
 * @param {import('../../domain/scanMode.js').ScanMode | null} mode
 * @returns {void}
 */
const setScanMode = (key, mode) => {
  const next = { ...scanModeMap };
  if (mode == null) delete next[key];
  else next[key] = mode;
  scanModeMap = next;
  writeWatchConfig();
  repaintTargets();
};

/**
 * Set (or clear back to the 'on' default) a player's galaxy-watch toggle —
 * the "Watch via → galaxy" button. 'off' mutes the galaxy-LOOK plan for the
 * player (passive sighting recording continues regardless). Persist, repaint.
 * @param {string} pid
 * @param {import('../../domain/scanMode.js').ScanMode | null} mode
 * @returns {void}
 */
const setGalaxyMode = (pid, mode) => {
  const next = { ...galaxyModeMap };
  if (mode == null) delete next[pid];
  else next[pid] = mode;
  galaxyModeMap = next;
  writeWatchConfig();
  repaintTargets();
};

/**
 * Set (or clear → the default grey) a watched player's map marker colour,
 * persist it, and repaint the Targets sub-tab + the map so the marker (and
 * the cards' mirror dot) updates.
 * @param {string} pid
 * @param {string | null} hex  A `WATCH_COLOR_PALETTE` hue; null = default.
 * @returns {void}
 */
const setWatchColor = (pid, hex) => {
  if (!hex) delete watchColors[pid];
  else watchColors[pid] = hex;
  writeWatchConfig();
  repaintTargets();
  repaintSpyglassMap();
};

/**
 * Mute/unmute a watched player on the positions map (map-only — they stay
 * watched, in the table scope and in the FAB's scan walk). Persists through
 * the same watch-config write as the map colours.
 * @param {string} pid
 * @returns {void}
 */
const toggleMapHidden = (pid) => {
  if (mapHiddenIds[pid]) delete mapHiddenIds[pid];
  else mapHiddenIds[pid] = true;
  writeWatchConfig();
  repaintSpyglassMap();
};

/**
 * Flag a player (key = player id — covers every body), a single planet (key =
 * "g:s:p") or a single moon (key = "g:s:p:3", the bodyKey shape) as needing a
 * re-scan: records "now" so the scan FAB treats any report older than this
 * moment as stale and re-targets it. Clears itself when a newer report lands.
 * Persists + repaints the sub-tab.
 *
 * @param {string} key  player id, "g:s:p" planet coord, or "g:s:p:3" moon key.
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
  if (watchedPlayers.has(id)) {
    watchedPlayers.delete(id);
  } else {
    watchedPlayers.add(id);
    // New watches start RED (the palette's first hue) — an all-grey map hid
    // fresh threats, and red is what "just watched" almost always means here.
    if (!watchColors[id]) watchColors[id] = WATCH_COLOR_PALETTE[0].hex;
  }
  writeWatchConfig();
  repaintTargets();
  // Membership IS the map's body set — keep the open map + its chips honest.
  repaintSpyglassMap();
  // The proximity digest shows a per-prober watch toggle (✓ / ⭐); an unwatch from
  // the card / map / anywhere must refresh it too, or its button state goes stale.
  renderProximityStrip();
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
    allianceClasses = {};
    proximityReports = [];
    ownBodies = [];
    activityObs = {};
    presenceHistories = {};
    planetCountByPlayer = {};
    dangerProfiles = new Map();
    civilProfiles = new Map();
    routines = {};
    return;
  }
  const [h, s, p, op, api, tr, pr, ao, ac, bd, pl, ai] = await Promise.all([
    chromeStore.get(historyKeyFor(selectedUniverseId)),
    chromeStore.get(scansKeyFor(selectedUniverseId)),
    chromeStore.get(playersKeyFor(selectedUniverseId)),
    readOwnProfile(selectedUniverseId),
    readApiCacheFor(selectedUniverseId),
    chromeStore.get(targetReportsKeyFor(selectedUniverseId)),
    chromeStore.get(proximityReportsKeyFor(selectedUniverseId)),
    chromeStore.get(activityObsKeyFor(selectedUniverseId)),
    chromeStore.get(allianceClassKeyFor(selectedUniverseId)),
    chromeStore.get(bodiesKeyFor(selectedUniverseId)),
    chromeStore.get(presenceLedgerKeyFor(selectedUniverseId)),
    chromeStore.get(allianceIntelKeyFor(selectedUniverseId)),
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
  // Our owned bodies for this universe (planet-bar snapshot) — feeds the
  // proximity strip's coords/names toggle + distance-to-prober lines.
  const bdBodies = bd && typeof bd === 'object' ? /** @type {any} */ (bd).bodies : null;
  ownBodies = Array.isArray(bdBodies) ? bdBodies : [];
  // Galaxy-activity rings (F3) — the routine tracker's dense probe-free source.
  activityObs = ao && typeof ao === 'object'
    ? /** @type {import('../../state/activityObs.js').ActivityObsMap} */ (ao)
    : {};
  // Alliance-class map (allianceId → slug) harvested from the ALLIANCE highscore.
  allianceClasses = ac && typeof ac === 'object' ? /** @type {Record<string, string>} */ (ac) : {};
  // Danger substrate (v2): per-player profiles (the Galaxy Viewer field /
  // occupancy map / Spyglass threat columns) + the spiable-bodies coverage
  // denominator (planets + moons, §9bis) + the spy refinement — all via the ONE
  // shared recipe in domain/dangerJoin.js. The in-game side (features/apiContext)
  // runs the SAME join for the scan planner, so the Spy FAB and this dashboard
  // rank targets from identical profiles.
  const ownId = ownProfile.id != null ? String(ownProfile.id) : undefined;
  const joined = joinDangerProfiles({
    apiCache,
    livePlayers: players,
    targetReports,
    allianceClasses,
    ownId,
  });
  planetCountByPlayer = joined.planetCountByPlayer;
  dangerProfiles = joined.dangerProfiles;
  // Etap C: server civil-fleet baseline from the (previously unused) economy
  // feed — expected civil ships per player + the combat-ship surplus over it.
  // The spy calibration (IDEAS #1) rides along: players whose scans close the
  // military-points identity teach the model a civil-per-eco CEILING and get
  // their own seen composition stated verbatim.
  civilProfiles = buildCivilBaseline({
    economy: apiCache.economy ? apiCache.economy.ranks : undefined,
    military: apiCache.military ? apiCache.military.ranks : undefined,
    calibration: collectCivilCalibration({
      reports: targetReports,
      military: apiCache.military ? apiCache.military.ranks : undefined,
      economy: apiCache.economy ? apiCache.economy.ranks : undefined,
    }),
  });
  // Etap F: per-player routine from the spy-report history rings + the galaxy-
  // activity rings (F3; both accrue for watched players only — the rest
  // summarise to empty). Built from reports the user opened + galaxy views they
  // browsed — see domain/routine.js. A player may exist in either store alone
  // (browsed but never spied), so iterate the UNION of the two key sets.
  const routineNowMs = Date.now();
  /** @type {Record<string, import('../../domain/routine.js').RoutineSummary>} */
  const routinesAcc = {};
  /** @type {Record<string, ReturnType<typeof summarizePresence>>} */
  const presencesAcc = {};
  const routinePids = new Set([...Object.keys(targetReports), ...Object.keys(activityObs)]);
  for (const pid of routinePids) {
    // Build the per-body intel once; routine + presence are two readings of it.
    const bodies = routineBodies(targetReports[pid], activityObs[pid]);
    routinesAcc[pid] = summarizeRoutine(bodies, routineNowMs);
    presencesAcc[pid] = summarizePresence(bodies, routineNowMs);
  }
  routines = routinesAcc;
  presences = presencesAcc;

  // Long-horizon presence HISTORY — pool this device's local ledger with the
  // alliance-shared ledgers (union by day-mask OR). Its pid set is the UNION
  // of the local ledger and every alliance member's coverage, so it holds
  // players this device never watched (alliance-only intel — the whole point
  // of the pool). Display-only, like the alliance doc it draws from.
  const localLedgerMap = pl && typeof pl === 'object'
    ? /** @type {Record<string, import('../../domain/presenceLedger.js').PresenceLedger>} */ (pl)
    : {};
  const allianceCache = ai && typeof ai === 'object' ? /** @type {any} */ (ai) : null;
  const allianceDoc = allianceCache && allianceCache.doc != null
    ? normalizeAllianceDoc(allianceCache.doc, selectedUniverseId)
    : null;
  const allianceMemberPids = new Set();
  if (allianceDoc) {
    for (const m of Object.values(allianceDoc.members)) {
      for (const pid of Object.keys(m.players)) allianceMemberPids.add(pid);
    }
  }
  /** @type {Record<string, { ledger: import('../../domain/presenceLedger.js').PresenceLedger, allianceMembers: string[] }>} */
  const historiesAcc = {};
  for (const pid of new Set([...Object.keys(localLedgerMap), ...allianceMemberPids])) {
    const ally = allianceDoc ? allianceLedgerForPid(allianceDoc, pid) : { ledger: {}, members: [] };
    const { merged } = mergePresenceLedgers(localLedgerMap[pid] || {}, ally.ledger);
    if (Object.keys(merged).length) {
      historiesAcc[pid] = { ledger: merged, allianceMembers: ally.members };
    }
  }
  presenceHistories = historiesAcc;
};

/**
 * Current filter value from the position-filter select.
 *
 * @returns {string}
 */
const getFilter = () => posFilter?.value ?? 'all';

/** One-shot latch so the persisted position filter is restored only on the
 *  first render (later renders must respect the user's live selection). */
let posFilterRestored = false;

/**
 * Re-render both the colony section and the galaxy section from the
 * current caches.
 *
 * @returns {void}
 */
const renderAll = () => {
  populatePositionFilter(posFilter, history);
  // Restore the persisted Position filter once — only after the first populate
  // has built the Position-N options (setting it earlier wouldn't stick). If
  // the saved position no longer exists in the data we leave the select on
  // "all". Later renders skip this so a live user change is never overridden;
  // the select preserves its own value across re-populates.
  if (!posFilterRestored) {
    posFilterRestored = true;
    const savedPos = safeLS.get(COLONY_POS_FILTER_KEY);
    if (savedPos && [...posFilter.options].some((o) => o.value === savedPos)) {
      posFilter.value = savedPos;
    }
  }
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
  // reads: coord → { ts, defPts, fleetPts, act } (timestamp drives the freshness /
  // re-scan status; defense + visible-fleet POINTS feed the expanded per-planet
  // rows; `act` = the reports' activity markers as probe LOOKS for the Activity
  // column). The report key is a bodyKey "g:s:p:type"; strip ":type" for the coord.
  const military = apiCache.military ? apiCache.military.ranks : {};
  /** @type {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} */
  const estimates = {};
  /** @type {Record<string, Record<string, {ts:number, defPts:number, fleetPts:number, act?: import('../../domain/activityObs.js').ActivityObs[]}>>} */
  const reportsByPlayer = {};
  // Moon reports, keyed by the SAME "g:s:p" coord as their planet but in their
  // own map (a shared map would let a moon clobber its planet's row). Feeds the
  // dossier's per-planet 🌙 scan status + moon def/fleet line and the coverage
  // header's "moons M/N".
  /** @type {Record<string, Record<string, {ts:number, defPts:number, fleetPts:number, act?: import('../../domain/activityObs.js').ActivityObs[]}>>} */
  const moonsByPlayer = {};
  const nowMs = Date.now();
  const universePlanets = apiCache.universe ? apiCache.universe.planets : [];
  /** @type {Record<string, import('../../domain/fsBracket.js').FsArc[]>} */
  const fsArcsAcc = {};
  for (const pid of Object.keys(targetReports)) {
    const bucket = targetReports[pid];
    const reports = bucket ? Object.values(bucket).map(latestOf) : [];
    if (!reports.length) continue;
    estimates[pid] = estimateHiddenFleet({
      militaryPoints: military[pid] ? military[pid].score : undefined,
      reports,
      planetCount: planetCountByPlayer[pid],
    });
    // FS-window bracketing (domain/fsBracket) — lives HERE, beside the freshly
    // computed estimate, because the present-gate anchors on the player's
    // TOTAL mobile fleet (visible + hidden; stable — unlike hidden alone,
    // which swings with whether the fleet was home when we probed). The API
    // anchor is trusted only when coverage is complete (`!provisional`) —
    // otherwise unseen DEFENSE inflates it and the gate would go blind.
    // Visible is exact (spied fleet resources); hidden is MILITARY points
    // (civil ships weigh ×0.5 there), inverted through the spied-composition
    // prior — a flat ×1000 understated cargo-heavy fleets by up to 2×.
    const est = estimates[pid];
    const fleetScaleRes = est && !est.provisional
      ? est.visibleFleetRes + pointsToResources(
        est.hiddenFleetPoints,
        estimateCombatShare({ visibleCombatShare: est.visibleCombatShare }),
      )
      : 0;
    const known = playerPlanets(universePlanets, pid);
    const arcs = bracketFsArcs(bucket, activityObs[pid], nowMs, {
      moonCount: known.filter((p) => p.hasMoon).length,
      totalBodies: known.length + known.filter((p) => p.hasMoon).length,
      fleetScaleRes,
    });
    if (arcs.length) fsArcsAcc[pid] = arcs;
    /** @type {Record<string, {ts:number, defPts:number, fleetPts:number}>} */
    const byCoord = {};
    /** @type {Record<string, {ts:number, defPts:number, fleetPts:number}>} */
    const moonsByCoord = {};
    for (const [key, entry] of Object.entries(bucket)) {
      const report = latestOf(entry);
      const lastColon = key.lastIndexOf(':');
      const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
      // Probe-look activity for the dossier's Activity column: every report is
      // also a LOOK at the body (its activity marker), so the column can speak
      // even for bodies never browsed in the galaxy. History when present
      // (watched players accrue it), else the lone latest report.
      const hist = historyOf(entry);
      const act = probeActivityObs(hist.length
        ? hist
        : [{ ts: report.timestamp, activityMin: report.activityMin }]);
      // Moon reports land in their own map: once ":type" is stripped their
      // bodyKey shares the planet's "g:s:p", so the shared map would clobber
      // the planet's row. They still feed the hidden-fleet estimate above.
      if (report.planetType === 3) {
        moonsByCoord[coord] = {
          ts: report.timestamp ?? 0,
          defPts: pointsOf(report.defenseValue ?? 0),
          fleetPts: pointsOf(report.fleetValue ?? 0),
          ...(act.length ? { act } : {}),
        };
        continue;
      }
      // Loot rhythm from the body's history ring (watched players accrue it): the
      // avg / peak on-planet resources feed the dossier's per-planet loot line and
      // the hoard ("mother") detection.
      const loot = bodyLootStats(report, hist);
      byCoord[coord] = {
        ts: report.timestamp ?? 0,
        defPts: pointsOf(report.defenseValue ?? 0),
        fleetPts: pointsOf(report.fleetValue ?? 0),
        ...(loot ? { avgLoot: loot.avg, maxLoot: loot.max, lastLoot: loot.last, lootSamples: loot.samples } : {}),
        ...(act.length ? { act } : {}),
      };
    }
    reportsByPlayer[pid] = byCoord;
    if (Object.keys(moonsByCoord).length) moonsByPlayer[pid] = moonsByCoord;
  }

  // Per-player raid verdict + legal-attack-band flag for the dossier (Etap B).
  // Cheap arithmetic over the candidate list, computed for all so an expanded
  // never-spied player still reads "scan first". inBand uses OGame's ±5× noob-
  // protection on TOTAL score (undefined when our own score is unknown).
  /** @type {Record<string, import('../../domain/raidVerdict.js').RaidVerdict>} */
  const verdicts = {};
  // Attack-band ("in range") gating was removed — we treat every player as
  // reachable, so `inBand` is never asserted (no "can't hit" verdict, no ⚔).
  /** @type {Record<string, boolean|undefined>} */
  const inBandById = {};
  for (const c of targetCandidates) {
    const bucket = targetReports[c.id];
    verdicts[c.id] = raidVerdict({
      profile: dangerProfiles.get(Number(c.id)),
      estimate: estimates[c.id],
      reports: bucket ? Object.values(bucket).map(latestOf) : [],
      inBand: undefined,
      nowMs,
    });
  }

  // Fresh fleet-landing signals (domain/fleetLanding) — computed per repaint
  // (NOW-sensitive: the moon marker fades in ~1 h). No session sent-map on the
  // dashboard (it never sends probes; the ring append already discounted ours).
  const landingSignals = detectAllLandings(
    [...watchedPlayers],
    apiCache.universe ? apiCache.universe.planets : [],
    activityObs,
    nowMs,
    {
      mode: /** @type {import('../../domain/fleetLanding.js').MoonStrikeMode} */ (chipValue(tgtMoonStrike) || DEFAULT_MOON_STRIKE),
      sysLookSec: sysLookSecFromScans(),
    },
  );

  // Patrol card — the territory mode's dashboard face (same signals the
  // in-game FAB flags for the grounds' prey; see features/dashboard/patrol.js).
  // Hidden entirely while the radius is 0.
  repaintPatrol(nowMs);

  // Watchlist cards — the landing strip (Etap H4). Same per-repaint data the
  // table + dossier read, so a card can never disagree with the row below it.
  renderWatchlistCards({
    hostEl: watchCardsEl,
    watchedIds: watchedPlayers,
    candidates: targetCandidates,
    verdicts,
    estimates,
    danger: dangerProfiles,
    routines,
    colors: watchColors,
    reportsByPlayer,
    inBand: inBandById,
    nowMs,
    linkBase: gameLinkBase(),
    onOpen: (pid) => openSpyglassFor(Number(pid)),
    onToggleWatch: (pid) => toggleWatched(pid),
    // Command footer — the dossier header's own Watch-via chips + ↻, pinned
    // to every card's bottom edge (no settings face to open any more).
    scanMode: scanModeMap,
    galaxyMode: galaxyModeMap,
    rescan: rescanMap,
    onSetScanMode: setScanMode,
    onSetGalaxyMode: setGalaxyMode,
    onRescan: markRescan,
  });

  renderTargets({
    containerEl: targetsContainer,
    candidates: targetCandidates,
    opts: {
      ownPlayerId: ownId,
      ownTotalScore,
      ownAlliance,
      minMilitary: Number(tgtMinMilitary?.value) || 0,
      maxMilitary: Number(tgtMaxMilitary?.value) || 0,
      // No attack-band filter — every player is treated as reachable.
      protectionFactor: 0,
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
    moonsByPlayer,
    // Scan-chip value — the dossier gates its per-body ↻ links on it (a flag
    // for a body the FAB never proposes would be a dead switch).
    scanBodies: /** @type {'planets'|'moons'|'both'} */ (chipValue(tgtScanBodies) || 'planets'),
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
    // Per-body / per-player scan mode (probe on/off) + the per-player galaxy
    // toggle + the activity-ring inputs for the Activity column.
    scanMode: scanModeMap,
    onSetScanMode: setScanMode,
    galaxyMode: galaxyModeMap,
    onSetGalaxyMode: setGalaxyMode,
    activityRings: activityObs,
    galaxyLookMs: galaxyStaleMs(cadenceCfg),
    presences,
    presenceHistories,
    fsArcs: fsArcsAcc,
    landingSignals,
    // Nickname search (Etap D): reveals name-matches incl. excluded players.
    searchQuery: targetSearchQuery,
    onShowAnyway: (/** @type {string} */ id) => { forceIncludeIds.add(id); repaintTargets(); },
    pinIds: pinnedTargetIds,
    linkBase: gameLinkBase(),
  });

  // Deep-link focus: scroll to + highlight the player a Galaxy Viewer "Top
  // threats" row (or a `?spy=` URL) asked for. The highlight class clears on
  // the next repaint (rows rebuild wholesale). The focus is consumed when the
  // row is found — or once data HAS loaded and the player still isn't in the
  // view (filtered out); an early empty repaint (URL deep-link lands before
  // the async data) keeps it pending so the scroll fires when the row exists.
  if (focusedTargetId != null) {
    const row = targetsContainer?.querySelector(`tr[data-player-id="${focusedTargetId}"]`);
    if (row) {
      row.classList.add('target-focus');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusedTargetId = null;
    } else if (targetCandidates.length > 0) {
      focusedTargetId = null;
    }
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
 * Format an epoch-SECONDS scan time as a compact local `YYYY-MM-DD HH:MM`
 * (mirrors the in-game Who's-spying panel's `fmtScanTime`).
 * @param {number} tsSec
 * @returns {string}
 */
const fmtScanTime = (tsSec) => {
  const d = new Date(tsSec * 1000);
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Hover for one of OUR scanned bodies: its scan history as newest-first
 * datetimes (one per line). Replaces the old "Moon" label — the lunar tint
 * already marks a moon, so the tooltip carries the timeline instead. Falls
 * back to the raw coords when no timestamped scan is on record.
 * @param {number[] | undefined} scans
 * @param {string} coords
 * @returns {string}
 */
const scanHistoryTitle = (scans, coords) =>
  scans && scans.length ? scans.map(fmtScanTime).join('\n') : coords;

/**
 * One coord span for one of OUR scanned bodies. The lunar tint marks a moon;
 * the hover carries the scan history (newest first), for moons and planets
 * alike. Same hex as the in-game Who's-spying panel's `.coord.moon`.
 * @param {string} coords
 * @param {boolean} moon
 * @param {number[]} [scans]  Scan timestamps (epoch seconds), newest first.
 * @returns {HTMLSpanElement}
 */
const proximityBodyEl = (coords, moon, scans) => {
  const s = document.createElement('span');
  s.textContent = coords;
  s.style.cssText = `cursor:help;${moon ? 'color:#c9a9e8;' : ''}`;
  s.title = scanHistoryTitle(scans, coords);
  return s;
};

/**
 * A "Near you" body rendered as our OWN body name (moon keeps the lunar tint);
 * the hover carries the scan history, newest first.
 * @param {string} name @param {string} coords @param {boolean} moon
 * @param {number[]} [scans]  Scan timestamps (epoch seconds), newest first.
 * @returns {HTMLElement}
 */
const proximityNamedEl = (name, coords, moon, scans) => {
  const s = document.createElement('span');
  s.textContent = name;
  s.style.cssText = `color:${moon ? '#c9a9e8' : '#a9c4de'};cursor:help;`;
  s.title = scanHistoryTitle(scans, coords);
  return s;
};

/**
 * The scanner's ORIGIN coords as a click-through to its system in the in-game
 * galaxy view — the same deep-link the dossier offers on a body's coords. A
 * plain span (no link) when the game origin is unknown or the coords malformed.
 * @param {string} coords
 * @param {boolean} moon
 * @param {string} [linkBase]  Game origin (e.g. https://s1-en.ogame.gameforge.com).
 * @returns {HTMLElement}
 */
const proximityFromEl = (coords, moon, linkBase) => {
  const parts = coords.split(':');
  const href = linkBase && parts.length === 3
    ? `${linkBase}/game/index.php?page=ingame&component=galaxy`
      + `&galaxy=${parts[0]}&system=${parts[1]}&position=${parts[2]}`
    : null;
  const s = document.createElement(href ? 'a' : 'span');
  s.textContent = coords;
  s.style.cssText = (moon ? 'color:#c9a9e8;' : 'color:#8fb8e0;')
    + (href ? 'cursor:pointer;text-decoration:underline dotted;' : '');
  if (href) {
    const a = /** @type {HTMLAnchorElement} */ (s);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = 'Open this system in the in-game galaxy view';
  } else if (moon) {
    s.title = 'Moon';
  }
  return s;
};

/**
 * Fill the Spyglass "Who's spying on you" strip from {@link proximityReports},
 * digested to ONE row per prober (Etap H3, `domain/proximityDigest.js`): count,
 * last-seen age, which of our bodies, origin — with a 💀 flag + hot-first sort
 * when the origin sits in our own system (even RIPs reach us fast from there).
 * Live counts land in the collapsed `<summary>` so the picture reads unopened.
 * Each row offers ⭐ watch (the existing toggle) and a dossier deep-link; the
 * name still seeds the nickname search. The raw per-alert log stays reachable
 * behind a nested <details>. Device-local, read-only — no sends, purely a
 * passive view of opened alerts.
 *
 * Only the last 30 days are shown (a months-old probe says nothing about
 * today's threat); the count-capped log can reach further back. Every row in
 * the window renders — the card scrolls (CSS max-height) instead of capping.
 * @returns {void}
 */
const renderProximityStrip = () => {
  if (!proximityStripEl) return;
  proximityStripEl.textContent = '';
  // Head tool slot (Coords/Names) — cleared with the strip so an emptied
  // digest never leaves a stale toggle riding the title line.
  if (proximityHeadToolsEl) proximityHeadToolsEl.textContent = '';
  const nowMs = Date.now();
  // Ts-less alerts stay (they can't be aged); `ts` is epoch seconds. The window
  // comes from the date-range chip (default '1m' = the prior 30-day cutoff).
  const windowSec = PROX_RANGES.find(([v]) => v === proximityRange)?.[2] ?? 30 * 86400;
  const cutoffSec = Math.floor(nowMs / 1000) - windowSec;
  const recentReports = proximityReports.filter(
    (r) => !(typeof r.ts === 'number' && r.ts > 0) || r.ts >= cutoffSec,
  );
  const digest = digestProximityReports(recentReports);
  // Game origin for the "from" click-through to the in-game galaxy view.
  const linkBase = gameLinkBase();
  if (proximityCountsEl) {
    // No leading dash — the card head's flex gap already separates this from
    // the title.
    proximityCountsEl.textContent = digest.totalReports
      ? `${digest.playerCount} ${digest.playerCount === 1 ? 'prober' : 'probers'}`
        + ` · ${digest.totalReports} ${digest.totalReports === 1 ? 'alert' : 'alerts'}`
        + (digest.lastTs != null ? ` · last ${proximityAge(digest.lastTs, nowMs)}` : '')
      : '';
  }
  if (proximityAlertEl) {
    proximityAlertEl.textContent = digest.sameSystemCount > 0
      ? ` · ⚠ ${digest.sameSystemCount} from your system`
      : '';
  }
  // Head tools ride the card head's right-edge slot. Built whenever ANY alert
  // exists in the raw log (not just the filtered window) so the date-range chip
  // stays reachable to widen back after a narrow window empties the strip.
  if (proximityReports.length && proximityHeadToolsEl) {
    // Date-range radio (1d/7d/1m/3m) — the shared segmented-chip look.
    const rangeGroup = document.createElement('div');
    rangeGroup.className = 'chip-group seg';
    rangeGroup.title = 'Show probers seen within this window';
    for (const [value, lbl] of PROX_RANGES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = lbl;
      if (value === proximityRange) b.className = 'on';
      b.addEventListener('click', () => {
        if (value === proximityRange) return;
        proximityRange = value;
        safeLS.set(PROX_RANGE_KEY, value);
        renderProximityStrip();
      });
      rangeGroup.appendChild(b);
    }
    proximityHeadToolsEl.appendChild(rangeGroup);

    // Coords/names toggle (device-local): swap the "at <our bodies>" coords for
    // our planet/moon names. Only when we actually have a body snapshot.
    if (ownBodies.length) {
      const tgl = document.createElement('button');
      tgl.type = 'button';
      tgl.textContent = proximityShowNames ? 'Names' : 'Coords';
      tgl.title = 'Coords / names';
      tgl.style.cssText = 'font-size:11px;border:1px solid #2b3a4d;background:#18222e;color:#9fb4c4;'
        + 'border-radius:999px;padding:1px 9px;cursor:pointer;';
      tgl.addEventListener('click', () => {
        proximityShowNames = !proximityShowNames;
        safeLS.set(PROX_NAMES_KEY, proximityShowNames ? '1' : '0');
        renderProximityStrip();
      });
      proximityHeadToolsEl.appendChild(tgl);
    }
  }

  if (!digest.totalReports) {
    const note = document.createElement('div');
    note.style.cssText = 'color:#667;font-size:12px;';
    // Distinguish "no data at all" from "nothing in this window" — the latter is
    // fixable by widening the range chip above.
    note.textContent = proximityReports.length
      ? 'No scans in this window.'
      : 'No scans on you yet.';
    proximityStripEl.appendChild(note);
    return;
  }

  const nameIdx = bodyNameIndex(ownBodies);

  /** @param {string} label */
  const seedSearch = (label) => {
    if (!tgtSearch) return;
    tgtSearch.value = label;
    tgtSearch.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // A 2-column grid (facts | actions) so the watch/dossier buttons line up in a
  // fixed right-hand column across every row — no ragged, un-justified rows.
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 10px;align-items:center;';

  for (const e of digest.players) {
    const facts = document.createElement('div');
    // Hot (same-system) rows wear the red rule + a fading tint, echoing the
    // in-game Who's-spying panel's hot-row treatment.
    facts.style.cssText = 'font-size:12px;color:#9aa;line-height:1.4;min-width:0;'
      + (e.sameSystem
        ? 'border-left:2px solid #e06c5f;padding-left:7px;'
          + 'background:linear-gradient(90deg,#241413,transparent 75%);'
        : '');

    // Line 1 — the glance summary: who + how many + 💀 + how close + how recent.
    const label = e.name || `#${e.byPlayerId}`;
    const who = document.createElement('span');
    who.textContent = label;
    who.style.cssText = 'cursor:pointer;color:#8fb8e0;font-weight:600;';
    who.title = 'Find this player in the table below';
    who.addEventListener('click', () => seedSearch(label));
    facts.appendChild(who);
    if (e.count > 1) facts.appendChild(document.createTextNode(` ×${e.count}`));
    if (e.sameSystem) {
      const hot = document.createElement('span');
      hot.textContent = ' 💀';
      hot.style.color = '#e06c5f';
      hot.title =
        'Probed you from a body in the same system as yours — even Death Stars '
        + '(the slowest ships in the game) reach you quickly from there.';
      facts.appendChild(hot);
    }

    // Distance + last-seen ride INLINE on the name line (each was its own
    // stacked line before) so a row is 2 lines, not 3 — more probers fit at
    // the same height. Distance colour carries the severity (0 sys = in-empire
    // strike range); the age stays muted.
    const dist = nearestBodyDistance(e.fromCoords, ownBodies, apiBounds);
    if (dist) {
      facts.appendChild(document.createTextNode(' · '));
      const d = document.createElement('span');
      d.textContent = dist.label;
      d.style.cssText = 'font-family:monospace;font-size:11px;color:'
        + (dist.cls === 'hot' ? '#e06c5f' : dist.cls === 'near' ? '#e0b45f' : '#6b7782') + ';';
      facts.appendChild(d);
    }
    const age = e.lastTs != null ? proximityAge(e.lastTs, nowMs) : '';
    if (age) {
      const a = document.createElement('span');
      a.textContent = ` · ${age}`;
      a.style.cssText = 'font-size:11px;color:#6b7782;';
      facts.appendChild(a);
    }

    // Line 2 — the geometry: `from <origin> · at <our bodies>`. `from` LEADS
    // because it's almost always a SINGLE coord (the prober's origin), while
    // `at` fans out over the several bodies of ours they probed — so the long
    // list trails. (Matches the in-game panel's From-before-Near-you column
    // order.) Wraps so EVERY probed body of ours shows.
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#6b7782;line-height:1.5;';
    if (e.fromCoords) {
      sub.appendChild(document.createTextNode('from '));
      sub.appendChild(proximityFromEl(e.fromCoords, e.fromMoon, linkBase));
      if (e.atBodies.length) sub.appendChild(document.createTextNode(' · '));
    }
    if (e.atBodies.length) {
      sub.appendChild(document.createTextNode('at '));
      // Moon bodies carry the lunar tint (a planet and its moon share coords);
      // the hover lists every scan of that body, newest first.
      e.atBodies.forEach((b, i) => {
        if (i) sub.appendChild(document.createTextNode(', '));
        const nm = proximityShowNames ? bodyNameFor(nameIdx, b.coords, b.moon) : null;
        sub.appendChild(nm
          ? proximityNamedEl(nm, b.coords, b.moon, b.scans)
          : proximityBodyEl(b.coords, b.moon, b.scans));
      });
    }
    facts.appendChild(sub);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const watched = watchedPlayers.has(String(e.byPlayerId));
    // Same watch-chip affordance as the table's chipCell (`+ watch` ⇄ `✓ watch`)
    // — the bare ⭐ icon-button read as decoration, not as the same action.
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.textContent = watched ? '✓ watch' : '+ watch';
    watch.style.cssText =
      'font-size:11px;border-radius:999px;padding:1px 9px;cursor:pointer;white-space:nowrap;'
      + (watched
        ? 'border:1px solid #2f6f4f;background:#16352a;color:#7fd6a8;'
        : 'border:1px solid #2a3a45;background:transparent;color:#8b95a0;');
    watch.title = watched
      ? 'Watching (on your scan list + the map) — click to remove'
      : 'Watch this player (adds to the scan list + the map)';
    watch.addEventListener('click', () => {
      toggleWatched(String(e.byPlayerId));
      renderProximityStrip();
    });
    actions.appendChild(watch);

    const dossier = document.createElement('button');
    dossier.type = 'button';
    dossier.textContent = 'dossier ▸';
    dossier.style.cssText =
      'font-size:11px;border:1px solid #2b3a4d;background:#18222e;color:#9fb4c4;'
      + 'border-radius:999px;padding:1px 8px;cursor:pointer;white-space:nowrap;';
    dossier.title = 'Open this player in the table below';
    dossier.addEventListener('click', () => openSpyglassFor(e.byPlayerId));
    actions.appendChild(dossier);

    grid.append(facts, actions);
  }
  proximityStripEl.appendChild(grid);

  // 💀 legend — only when a same-system prober is actually on screen (a legend
  // for a glyph that isn't shown is clutter). Mirrors the in-game panel's foot.
  if (digest.sameSystemCount > 0) {
    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:8px;font-size:10px;color:#5f6b76;';
    const k = document.createElement('span');
    k.textContent = '💀';
    k.style.color = '#e06c5f';
    foot.appendChild(k);
    foot.appendChild(document.createTextNode(
      ' = a scout with a body in your system — can strike at moon/RIP speed. From alerts you opened.'));
    proximityStripEl.appendChild(foot);
  }

  // The undigested per-alert log, for when the exact sequence matters.
  const raw = document.createElement('details');
  raw.style.cssText = 'margin:6px 0 0 9px;';
  const rawSum = document.createElement('summary');
  rawSum.style.cssText = 'cursor:pointer;color:#667;font-size:11px;list-style:none;';
  rawSum.textContent = `show raw log (${digest.totalReports} ${digest.totalReports === 1 ? 'alert' : 'alerts'}) ▸`;
  raw.appendChild(rawSum);
  // Bound the disclosed log so 100+ alerts scroll inside a box instead of
  // pushing the whole page down when expanded.
  const rawBody = document.createElement('div');
  rawBody.style.cssText = 'max-height:320px;overflow-y:auto;';
  for (const r of recentReports) {
    const line = document.createElement('div');
    line.style.cssText = 'font-size:11px;color:#788;margin-top:3px;line-height:1.4;';
    const age = proximityAge(r.ts, nowMs);
    line.appendChild(document.createTextNode(`${r.byPlayerName || `#${r.byPlayerId}`} · near `));
    line.appendChild(proximityBodyEl(r.atCoords, r.atPlanetType === 3));
    if (age) line.appendChild(document.createTextNode(` · ${age} ago`));
    if (r.fromCoords) {
      line.appendChild(document.createTextNode(' · from '));
      line.appendChild(proximityBodyEl(r.fromCoords, r.fromPlanetType === 3));
    }
    rawBody.appendChild(line);
  }
  raw.appendChild(rawBody);
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
    const pid = String(playerId);
    focusedTargetId = pid;
    expandedTargets.add(pid);
    // The click means "show me this player" — bypass the filters (existing
    // force-include machinery) AND the top-N row cap (the pin, appended past
    // the capped list). Without this, opening e.g. a prober outside the
    // top-50 view silently did nothing.
    forceIncludeIds.add(pid);
    pinnedTargetIds.add(pid);
    repaintTargets();
  }
};

/** Guards the manual API refresh against overlapping clicks. */
let apiRefreshInFlight = false;

/**
 * Manually re-download the public-API feeds for the selected universe and
 * rebuild the cache in place (item 9). The dashboard runs on the EXTENSION
 * origin, so — unlike the in-game path — it fetches the universe's own host
 * directly (`https://s<num>-<lang>.ogame.gameforge.com`, permitted by the
 * manifest's `host_permissions`) via the shared {@link refreshApiCache}, writing
 * that universe's cache slice, then reloads + repaints. `force` re-fetches every
 * feed, including the multi-MB universe.xml — the point of a manual refresh.
 * @returns {Promise<void>}
 */
const refreshApiData = async () => {
  if (apiRefreshInFlight) return;
  const btn = spyApiRefreshEl;
  const id = selectedUniverseId;
  // Only the canonical s<num>-<lang> id maps to a fetchable game host; a fallback
  // namespace (dev/edge host) can't be turned into an origin, so bail visibly.
  if (!id || !/^s\d+-[a-z]{2,4}$/.test(id)) {
    if (btn) btn.textContent = '⟳ no universe';
    return;
  }
  apiRefreshInFlight = true;
  if (btn) { btn.disabled = true; btn.textContent = '⟳ refreshing…'; }
  try {
    const origin = `https://${id}.ogame.gameforge.com`;
    const { fetched } = await refreshApiCache({ force: true, origin, universeId: id });
    // The user may have switched universes mid-fetch — only repaint if we're
    // still on the one we refreshed (its cache is what loadAll would read).
    if (selectedUniverseId === id) {
      await loadAll();
      renderAll();
    }
    if (btn) btn.textContent = fetched.length ? '⟳ Refreshed' : '⟳ up to date';
  } catch (err) {
    logger.warn('spyglass: manual API refresh failed', err);
    if (btn) btn.textContent = '⟳ failed';
  } finally {
    apiRefreshInFlight = false;
    if (btn) {
      btn.disabled = false;
      // Let the outcome word linger, then restore the resting label.
      setTimeout(() => { if (spyApiRefreshEl === btn) btn.textContent = '⟳ Refresh'; }, 2500);
    }
  }
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
  // Spot gap spaces the Best-spots LIST (spaceOutCandidates) — a streak result
  // has no spots to separate, so under "Longest streaks" the slider keeps its
  // layout slot but greys out, same rule as the chip groups above.
  if (serverMapSep) {
    serverMapSep.disabled = streaks;
    serverMapSep.title = streaks
      ? 'Spots only — streak results are not spaced apart'
      : '';
  }
  if (serverMapSepV) serverMapSepV.style.opacity = streaks ? '.4' : '';
  // The "why greyed" note beside the value — same affordance as Ignore worst.
  if (serverMapSepNote) serverMapSepNote.textContent = streaks ? 'spots only' : '';
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
 * @type {{field: unknown, composite: unknown, view: string, hideBlocked: boolean, candKey: string, width: number} | null}
 */
let lastMapPaint = null;

/**
 * The 🛡 Protected toggle only means anything in the occupancy view (the
 * threat/farm field never paints blocked cells) — show its chip only there.
 * @returns {void}
 */
const syncMapProtVisibility = () => {
  if (!serverMapProtWrap) return;
  const view = chipValue(serverMapViewChips) || 'field';
  serverMapProtWrap.style.display = view === 'occupancy' ? '' : 'none';
};

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
  // Pane-level data contract as header CHIPS (Spyglass parity — the old prose
  // stamp was three lines of text): snapshot age (universe.xml regenerates
  // weekly server-side), our last download, and — only when it matters — the
  // threat-not-calibrated warning. Healthy states stay quiet; warn states
  // amber, because they change what every Fit number means.
  if (scoutDataStamp) {
    scoutDataStamp.textContent = '';
    /** @param {string} text @param {boolean} [warn] @param {string} [tip] */
    const chip = (text, warn, tip) => {
      const el = document.createElement('span');
      el.className = 'fresh-chip' + (warn ? ' warn' : '');
      el.textContent = text;
      if (tip) el.title = tip;
      scoutDataStamp?.appendChild(el);
    };
    const ts = apiCache.universe?.timestamp;
    if (typeof ts === 'number' && ts > 0) {
      const now = Date.now();
      const days = Math.max(0, Math.floor((now - ts) / 86_400_000));
      const age = days === 0 ? 'today' : days === 1 ? '1 d old' : `${days} d old`;
      // TWO clocks, because they answer different questions: the snapshot age
      // is OGame's regeneration time (how old the occupancy truth is; the file
      // regenerates weekly — hence the 7-day warn bar), "checked" is OUR last
      // download (is the extension still refreshing?).
      chip(`Snapshot ${age}`, days > 7,
        "OGame's server occupancy file (universe.xml) regenerates weekly — this is the file's own age.");
      const fAt = apiCache.universe?.fetchedAt;
      const checkedH = typeof fAt === 'number' ? Math.max(0, (now - fAt) / 3_600_000) : null;
      if (checkedH != null) {
        const checked = checkedH < 1 ? '<1 h' : checkedH < 48 ? `${Math.round(checkedH)} h` : `${Math.round(checkedH / 24)} d`;
        chip(`checked ${checked} ago`, false, 'When OG-E last downloaded the snapshot.');
      }
      // `> 0` — classifyCell only applies the anchor for a positive score, so
      // a fresh account listed with military 0 is NOT calibrated either. The
      // calibrated state is silent (the default); only the problem gets a chip.
      const calibrated = typeof ownMilitary === 'number' && ownMilitary > 0;
      if (!calibrated) {
        chip('threat not calibrated', true,
          'Open the game once in this universe so the threat channel can anchor '
          + 'to your military points (fleet + defence) — until then every active '
          + 'player reads a flat base threat.');
      }
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
    // Minimum system distance between listed spots (the Spot gap slider) —
    // spaceOutCandidates' suppression radius.
    spotGap: parseInt(serverMapSep?.value ?? '', 10) || 15,
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
    const hideBlocked = serverMapProtected ? !toggleChipOn(serverMapProtected) : false;
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
      || lastMapPaint.hideBlocked !== hideBlocked
      || lastMapPaint.candKey !== candKey
      || lastMapPaint.width !== width) {
      lastMapPaint = { field: fieldKey, composite, view, hideBlocked, candKey, width };
      renderServerMap({
        hostEl: serverMapHost,
        scans: composite,
        galaxies: apiBounds.galaxies,
        systems: apiBounds.systems,
        donutGalaxy: apiBounds.donutGalaxy,
        donutSystem: apiBounds.donutSystem,
        view,
        hideBlocked,
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
// coloured by RELATIONSHIP (enemy/friend/neutral/you) and sized by danger. The
// map plots each tracked player's planets straight from universe.xml.

/**
 * "Who can reach you" horizon (hours) — a body is ringed when a RIP launched
 * from it lands on one of your planets inside this window (anything faster
 * arrives sooner, so the ring is the conservative floor). Matches the Galaxy
 * Viewer threat kernel's default offline window.
 */
const SPY_MAP_REACH_H = 8;

/** Whether the Spyglass map section is expanded. */
let spyMapOpen = false;
/** Legend toggle: when true, your own (white) planets are hidden on the map.
 *  The reach kernel still uses their coords — only the markers are muted. */
let spyMapHideYou = false;

/**
 * A tracked player's map marker colour: the picked hue, else the default
 * grey. (Own bodies use {@link MAP_YOU_COLOR} at the call site.)
 * @param {string} pid
 * @returns {string}
 */
const watchColorOf = (pid) => watchColors[pid] || WATCH_DEFAULT_COLOR;

/**
 * Render the "You" marker chip into #spyMapYou (own-planet colour) inline with the
 * watched-player chips. Clicking it toggles your own planets on the map — a legend
 * filter, like the watched-player chips' 👁 mute — with a dimmed off-state.
 * @param {boolean} hasOwn
 */
const renderSpyMapYou = (hasOwn) => {
  if (!spyMapYouEl) return;
  spyMapYouEl.replaceChildren();
  if (!hasOwn) { spyMapYouEl.style.display = 'none'; return; }
  const sw = document.createElement('span');
  sw.className = 'dot'; // match the watched-player chips' colour dot
  sw.style.background = MAP_YOU_COLOR;
  spyMapYouEl.append(sw, document.createTextNode('You'));
  spyMapYouEl.style.display = ''; // revert to the .spy-pchip pill's inline-flex
  spyMapYouEl.classList.toggle('map-hidden', spyMapHideYou);
  spyMapYouEl.style.cursor = 'pointer';
  spyMapYouEl.title = spyMapHideYou
    ? 'Your planets are hidden on the map — click to show them'
    : 'Click to hide your own planets on the map';
  spyMapYouEl.onclick = () => { spyMapHideYou = !spyMapHideYou; repaintSpyglassMap(); };
};

/** Close every open map-colour popover (at most one exists at a time). */
const closeSpyColorPops = () => {
  document.querySelectorAll('.spy-pop').forEach((p) => p.remove());
};

/** One-time outside-click closer for the colour popovers (armed lazily on the
 * first open; idempotent across dashboard re-installs — closing is harmless
 * when nothing is open, so the listener is never torn down). */
let spyPopCloserArmed = false;
const armSpyPopCloser = () => {
  if (spyPopCloserArmed) return;
  spyPopCloserArmed = true;
  document.addEventListener('click', closeSpyColorPops);
};

/**
 * The swatch popover a chip's colour dot opens — THE place a player's map
 * colour is picked (the cards' dot and the map markers only mirror it).
 * First swatch clears back to the default grey; the rest are the fixed
 * palette. Picking persists via {@link setWatchColor}, whose repaint rebuilds
 * the chips (and thereby closes the popover).
 * @param {string} pid
 * @returns {HTMLSpanElement}
 */
const buildColorPop = (pid) => {
  const pop = document.createElement('span');
  pop.className = 'spy-pop';
  pop.addEventListener('click', (e) => e.stopPropagation());
  const current = watchColorOf(pid);
  const swatch = (/** @type {string} */ hex, /** @type {string} */ name, isDefault = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'spy-sw' + (hex === current ? ' on' : '');
    b.style.background = hex;
    b.title = isDefault ? 'default' : name;
    b.addEventListener('click', () => setWatchColor(pid, isDefault ? null : hex));
    return b;
  };
  pop.appendChild(swatch(WATCH_DEFAULT_COLOR, 'default', true));
  for (const c of WATCH_COLOR_PALETTE) pop.appendChild(swatch(c.hex, c.name));
  return pop;
};

/**
 * Render the watched-player chips under the positions map (Etap H5) — the
 * add/remove story made visible right where it matters: one pill per watched
 * player with a colour dot (tap → the swatch popover, {@link buildColorPop}),
 * the name (opens the dossier), 👁 (map-only mute via {@link toggleMapHidden})
 * and ✕ (stop watching). Empty watchlist → a ghost hint instead of a blank row.
 * @returns {void}
 */
const renderSpyMapPlayerChips = () => {
  if (!spyMapPlayersEl) return;
  spyMapPlayersEl.textContent = '';
  const ids = [...watchedPlayers];
  if (!ids.length) return;
  const nameOf = (/** @type {string} */ pid) => apiCache.players?.players?.[pid]?.name || `#${pid}`;
  ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const pid of ids) {
    const chip = document.createElement('span');
    chip.className = 'spy-pchip' + (mapHiddenIds[pid] ? ' map-hidden' : '');

    // Colour dot — a real button (the old 9-px cycle dot was its own touch
    // trap; the popover both grows the target and previews the choices).
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'spy-pdot';
    dot.title = 'Map colour — tap to pick';
    const ink = document.createElement('span');
    ink.className = 'dot';
    ink.style.background = watchColorOf(pid);
    dot.appendChild(ink);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = !!chip.querySelector('.spy-pop');
      closeSpyColorPops();
      if (wasOpen) return; // tapping the open chip's dot just closes it
      armSpyPopCloser();
      chip.appendChild(buildColorPop(pid));
    });
    chip.appendChild(dot);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = nameOf(pid);
    nm.title = 'Open this player in the table below';
    nm.addEventListener('click', () => openSpyglassFor(Number(pid)));
    chip.appendChild(nm);

    const eye = document.createElement('span');
    eye.className = 'ico';
    eye.textContent = '👁';
    eye.title = mapHiddenIds[pid]
      ? 'Hidden from the map — click to show again'
      : 'Hide from the map only (stays watched + scanned)';
    eye.addEventListener('click', () => toggleMapHidden(pid));
    chip.appendChild(eye);

    const off = document.createElement('span');
    off.className = 'ico';
    off.textContent = '✕';
    off.title = 'Stop watching — removes from the list, the scan walk and the map';
    off.addEventListener('click', () => {
      toggleWatched(pid);
      repaintSpyglassMap();
    });
    chip.appendChild(off);

    spyMapPlayersEl.appendChild(chip);
  }
};

/** Repaint the Spyglass positions map. No-op while closed/hidden. */
const repaintSpyglassMap = () => {
  if (!spyglassMapHost || !spyMapOpen) return;
  // Hidden pane → width 0 → markers land at the wrong systems; repaint on the
  // next tab/toggle open instead.
  if ((spyglassMapHost.clientWidth || 0) === 0) return;
  const ownId = ownProfile && ownProfile.id != null ? String(ownProfile.id) : null;
  const nameOf = (/** @type {string} */ pid) => apiCache.players?.players?.[pid]?.name || `player ${pid}`;
  // Plot from the AUTHORITATIVE universe.xml planet list (every planet with its
  // owner), not the sparse galaxy-scan composite — otherwise your own planets
  // (and a watched player's) only appeared for systems you had happened to
  // browse. Own bodies always plot (white) + seed the reach kernel; watched +
  // not map-muted plot in their picked map colour.
  /** @type {import('./mapPrimitives.js').MapBody[]} */
  const bodies = [];
  /** @type {Array<{g: number, s: number}>} Your own planets — the reach targets. */
  const ownCoords = [];
  const planets = apiCache.universe ? apiCache.universe.planets : [];
  for (const pl of planets || []) {
    if (!pl || pl.player == null) continue;
    const pid = String(pl.player);
    const isOwn = pid === ownId;
    if (!isOwn && (!watchedPlayers.has(pid) || mapHiddenIds[pid])) continue;
    const parts = String(pl.coords).split(':');
    if (parts.length !== 3) continue;
    const g = Number(parts[0]);
    const s = Number(parts[1]);
    const p = Number(parts[2]);
    if (!Number.isFinite(g) || !Number.isFinite(s) || !Number.isFinite(p)) continue;
    // Own coords always seed the reach kernel, even when the "You" legend chip
    // is toggled off — hiding only mutes the markers, not the distance maths.
    if (isOwn) ownCoords.push({ g, s });
    if (isOwn && spyMapHideYou) continue;
    bodies.push({
      galaxy: g,
      system: s,
      position: p,
      playerId: pid,
      name: nameOf(pid),
      color: isOwn ? MAP_YOU_COLOR : watchColorOf(pid),
      isYou: isOwn,
      danger: (dangerProfiles.get(Number(pid))?.danger ?? 0) * 100,
    });
  }
  // "Who can reach you" overlay (opt-in): the INVERTED reach kernel — instead
  // of "whom can I threaten", ring each tracked body whose RIP-speed flight to
  // your NEAREST planet fits the horizon. RIP is the slowest attacker, so the
  // ring is the conservative floor: anything faster arrives sooner. Distances
  // honour the server's donut wrap; positions come from the same public-API
  // universe list as the markers themselves.
  const reachOn = toggleChipOn(spyMapReach);
  if (reachOn && ownCoords.length && apiBounds.galaxies && apiBounds.systems) {
    const gTot = apiBounds.galaxies;
    const sTot = apiBounds.systems;
    for (const b of bodies) {
      if (b.isYou) continue;
      let minD = Infinity;
      for (const oc of ownCoords) {
        const ag = axisDelta(b.galaxy, oc.g, gTot, !!apiBounds.donutGalaxy);
        const ds = axisDelta(b.system, oc.s, sTot, !!apiBounds.donutSystem);
        const d = flightDistance(ag, ds);
        if (d < minD) minD = d;
      }
      if (Number.isFinite(minD)) {
        b.reachH = niszczHours(minD);
        b.inReach = b.reachH <= SPY_MAP_REACH_H;
      }
    }
  }
  renderSpyMapYou(!!ownId);
  renderSpyMapPlayerChips();
  renderPositionsMap({
    hostEl: spyglassMapHost,
    galaxies: apiBounds.galaxies,
    systems: apiBounds.systems,
    bodies,
    onPlayerClick: (pid) => openSpyglassFor(Number(pid)),
  });
};

/** Toggle the Spyglass map section open/closed. The toggle is a chip pill now,
 *  so `.on` marks the open state (the label stays "🗺 map"). */
const toggleSpyMap = () => {
  spyMapOpen = !spyMapOpen;
  if (spyMapBlock) spyMapBlock.style.display = spyMapOpen ? '' : 'none';
  if (spyMapToggle) {
    spyMapToggle.classList.toggle('on', spyMapOpen);
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
  // Players-table phone layout (targets.js TARGETS_NARROW_MQ) is decided at
  // render time — repaint once whenever a resize/rotation crosses the
  // breakpoint so the row packing follows the viewport.
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(TARGETS_NARROW_MQ).addEventListener('change', () => repaintTargets());
  }

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
    void exportAllData(selectedUniverseId).then((res) => {
      setStatus(
        'Exported ' + res.datasets + ' datasets, ' + formatBytes(res.bytes)
        + ' (' + selectedUniverseId + ')',
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
      const gains = res.parts.length
        ? res.parts.map((p) => `+${p.count} ${p.label}`).join(', ')
        : 'nothing new';
      const skipped = res.skipped.length
        ? ` (skipped unknown: ${res.skipped.join(', ')})`
        : '';
      setStatus(`Imported into ${selectedUniverseId}: ${gains}${skipped}`);
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

  posFilter.addEventListener('change', () => {
    safeLS.set(COLONY_POS_FILTER_KEY, posFilter.value);
    renderAll();
  });

  // Targets controls only repaint the Targets sub-tab (the candidate list is
  // already loaded; only the filter/limit we apply to it changed). Filter
  // controls also persist so the choice survives a reload.
  const onTargetFilterChange = () => { saveTargetPrefs(); repaintTargets(); };
  tgtMinMilitary.addEventListener('change', onTargetFilterChange);
  tgtMaxMilitary?.addEventListener('change', onTargetFilterChange);
  wireToggleChip(tgtHideInactive, onTargetFilterChange);
  // Probe count is shared with the in-game scan FAB via chrome.storage, so it
  // persists through the watch-config write rather than the localStorage prefs.
  tgtProbes?.addEventListener('change', () => { writeWatchConfig(); repaintTargets(); });
  // Patrol radius — same shared-config write (normalize clamps 0..50; the
  // clamped value reflects back on the next hydrate).
  tgtPatrolSystems?.addEventListener('change', () => { writeWatchConfig(); repaintTargets(); });
  // Re-scan cadence inputs — commitCadence clamps, reflects, persists, repaints.
  for (const el of [cadRescanHours, cadGalaxyHours]) {
    el?.addEventListener('change', commitCadence);
  }
  // Planet/moon/both scan filter — same shared-config write as the probes.
  wireChips(tgtScanBodies, () => { writeWatchConfig(); repaintTargets(); });
  // Moon-strike aggressiveness — same write; repaint recomputes the landing
  // signals (the 🎯 markers + dossier banners follow the new mode live).
  wireChips(tgtMoonStrike, () => { updateMoonStrikeNote(); writeWatchConfig(); repaintTargets(); });
  // Probe launch source — persist only; the FAB reads it live from the store
  // (no dashboard repaint depends on it).
  wireChips(tgtProbeSource, () => { writeWatchConfig(); });
  wireChips(tgtLimitChips, onTargetFilterChange);
  tgtSearch?.addEventListener('input', () => {
    targetSearchQuery = tgtSearch ? tgtSearch.value : '';
    repaintTargets();
  });
  wireToggleChip(tgtWatchedOnly, () => repaintTargets());
  // Scan-settings command block (Probes/Scan/Probe from/…) — a native <details>
  // that collapses to a compact bar so the watchlist card isn't dominated by
  // the knobs; the open/closed choice is remembered per device.
  const spyScanPrefs = /** @type {HTMLDetailsElement | null} */ (
    document.getElementById('spyScanPrefs'));
  if (spyScanPrefs) {
    if (safeLS.get(SPY_SCAN_PREFS_OPEN_KEY) === '1') spyScanPrefs.open = true;
    spyScanPrefs.addEventListener('toggle', () => {
      safeLS.set(SPY_SCAN_PREFS_OPEN_KEY, spyScanPrefs.open ? '1' : '0');
    });
  }
  // ⚙ show/hide for the rarely-touched numeric filters (military range, probes).
  tgtConfigToggle?.addEventListener('click', () => {
    const opening = tgtConfigCard ? tgtConfigCard.style.display === 'none' : false;
    if (tgtConfigCard) tgtConfigCard.style.display = opening ? '' : 'none';
    tgtConfigToggle?.setAttribute('aria-expanded', String(opening));
  });
  spyMapToggle?.addEventListener('click', toggleSpyMap);
  wireToggleChip(spyMapReach, () => repaintSpyglassMap());
  spyApiRefreshEl?.addEventListener('click', () => { void refreshApiData(); });

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
      spotGap: serverMapSep?.value,
      view: chipValue(serverMapViewChips),
      mapProtected: serverMapProtected ? toggleChipOn(serverMapProtected) : true,
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
    syncMapProtVisibility();
    repaintFreeRegions();
  });
  wireToggleChip(serverMapProtected, () => {
    saveScoutPrefs();
    repaintFreeRegions();
  });
  // Offline window / farm reach drive the RANKING field, not just the map —
  // repaint unconditionally. Persist on release ('change'), not per drag tick.
  // Each slider is paired with a number box bound to the same value: drag =
  // coarse sweeps, type = precision (on touch a 2–250 range on a finger-width
  // track can't hit single systems). The RANGE input stays the single source
  // the painters and saveScoutPrefs read; the box mirrors it both ways.
  /**
   * @param {HTMLInputElement | null} range
   * @param {HTMLInputElement | null} num
   * @returns {void}
   */
  const wireRangePair = (range, num) => {
    if (!range || !num) return;
    range.addEventListener('input', () => {
      num.value = range.value;
      repaintFreeRegionsThrottled();
    });
    range.addEventListener('change', saveScoutPrefs);
    num.addEventListener('change', () => {
      // Clamp typed values to the slider's own bounds; blank/garbage falls
      // back to the current slider value.
      const typed = Number(num.value) || Number(range.value);
      const v = Math.min(Number(range.max), Math.max(Number(range.min), Math.round(typed)));
      num.value = String(v);
      range.value = String(v);
      saveScoutPrefs();
      repaintFreeRegions();
    });
  };
  wireRangePair(serverMapWindow, serverMapWindowV);
  wireRangePair(serverMapFarm, serverMapFarmV);
  // Spot gap re-spaces the RANKED list (spaceOutCandidates radius) — cheap,
  // and it reuses the same pair wiring as the sibling sliders.
  wireRangePair(serverMapSep, serverMapSepV);
  wireChips(freeExcludeChips, () => { saveScoutPrefs(); repaintFreeRegions(); });

  universeSelect.addEventListener('change', () => {
    selectedUniverseId = universeSelect.value;
    updateToolsPill();
    // Region keys carry no universe component — a coincidentally matching
    // region in the next universe would auto-expand as "your selection".
    resetFreeSelection();
    void loadWatched().then(() => loadAll()).then(renderAll);
    alarmClockApi?.refresh();
    routesApi?.refresh();
    scanColonyConfigApi?.refresh();
    alarmClockConfigApi?.refresh();
    allianceShareApi?.refresh();
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
  allianceShareApi = null;
  history = [];
  scans = {};
  proximityReports = [];
  ownBodies = [];
  activityObs = {};
  compositeCache = null;
  scoreFieldCache = null;
  lastMapPaint = null;
  scoutSelectedPin = -1;
  dangerProfiles = new Map();
  civilProfiles = new Map();
  routines = {};
  focusedTargetId = null;
  spyMapOpen = false;
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
    serverMapProtWrap =
    serverMapProtected =
    serverMapHost =
    serverMapWindow =
    serverMapWindowV =
    serverMapFarm =
    serverMapFarmV =
    serverMapSep =
    serverMapSepV =
    serverMapSepNote =
    targetsContainer =
    tgtMinMilitary =
    tgtMaxMilitary =
    tgtLimitChips =
    tgtSearch =
    tgtWatchedOnly =
    tgtProbes =
    tgtScanBodies =
    tgtMoonStrike =
    tgtProbeSource =
    tgtPatrolSystems =
    patrolCardEl =
    patrolSummaryEl =
    patrolStrikesEl =
    tgtHideInactive =
    tgtConfigToggle =
    tgtConfigCard =
    tgtCountInfoEl =
    proximityStripEl =
    proximityCountsEl =
    proximityAlertEl =
    proximityHeadToolsEl =
    spyMapPlayersEl =
    watchCardsEl =
    spyApiRefreshEl =
    freeContainer =
    freeCountInfoEl =
      /** @type {any} */ (undefined);
  // Session-only state that boot() does not re-establish: clear it so a
  // re-install starts clean (watch-list Set, rescan flags, map colours +
  // map-mute tags, expanded target rows, target sort, and the
  // pending-repaint flag).
  watchedPlayers.clear();
  rescanMap = {};
  watchColors = {};
  mapHiddenIds = {};
  expandedTargets.clear();
  targetSort = { ...DEFAULT_TARGET_SORT };
  repaintQueued = false;
  installed = false;
  _resetAlarmClockForTest();
  _resetFreeStreakForTest();
};
