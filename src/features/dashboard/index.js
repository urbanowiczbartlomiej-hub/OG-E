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
// @see ./galaxy.js  — renderGalaxyMap (accordion + pixel map)
// @see ./io.js      — Export/Import/CSV + tombstones (all universe-scoped)

import { chromeStore, safeLS } from '../../lib/storage.js';
import { debounce } from '../../lib/debounce.js';
import { parseTargetPositions } from '../../domain/histogram.js';
import { populatePositionFilter, renderColonyChart } from './colony.js';
import { renderGalaxyMap } from './galaxy.js';
import { renderFreeRegions } from './freeStreak.js';
import { renderTargets, DEFAULT_TARGET_SORT } from './targets.js';
import { STRATEGIES } from '../../domain/regions.js';
import { buildOccupancyIndex, buildScanMapFromIndex } from '../../domain/apiOccupancy.js';
import { buildTargetCandidates } from '../../domain/targets.js';
import { estimateHiddenFleet } from '../../domain/threatModel.js';
import { readApiCacheFor, apiCacheKeyFor } from '../../state/apiCache.js';
import { targetReportsKeyFor } from '../../state/targets.js';
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
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../../domain/galaxyScanConfig.js';
import {
  exportAllData,
  importAllData,
  exportColonyCsv,
  triggerResetGalaxy,
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

// localStorage key for accordion open/closed state. Per-device, not
// synced — accordion state is UI preference, not user data.
const EXPANDED_LS_KEY = 'oge_expandedGalaxies';

// Colony Scout control preferences — persisted so selections survive page reload.
const SCOUT_PREFS_KEY = 'oge_colonyScoutPrefs';

// Targets sub-tab preferences (currently just the chosen column sort) —
// device-local, survives reload. Keyed separately from the Scout prefs above.
const TARGET_PREFS_KEY = 'oge_targetPrefs';

/** @type {import('./targets.js').TargetSort} */
let targetSort = { ...DEFAULT_TARGET_SORT };

// Watch-list: the player ids the user has starred in the Targets table.
// Per-universe (ids are universe-scoped) + device-local view-state — same
// load-on-boot / mutate-in-place / persist-on-toggle shape as expandedGalaxies,
// but keyed by universe like the spy-report cache.
const WATCHED_LS_KEY_BASE = 'oge_watchedPlayers';
const watchedKeyFor = (/** @type {string} */ universeId) =>
  `${universeId}:${WATCHED_LS_KEY_BASE}`;

/** @type {Set<string>} Watched player ids for the selected universe. */
const watchedPlayers = new Set();

/**
 * Player ids whose Targets detail row (planets + spy links) is expanded.
 * Ephemeral session state — not persisted (re-deriving it on reload would mean
 * re-opening rows the user has since closed). Mutated in place so expansion
 * survives a repaint.
 * @type {Set<string>}
 */
const expandedTargets = new Set();

// localStorage key for the active dashboard tab. Per-device UI prefs.
// Possible values are the `data-tab` attributes from dashboard.html:
// `'colony'`, `'alarmClock'`, `'routes'`. Anything unrecognised — including the
// retired `'free'` and `'galaxy'` (whose content folded into the Colonizations
// tab's sub-tabs) — falls back to `'colony'` (the page's first tab). The key
// keeps its legacy `oge_histogram` name so the saved preference survives the
// rename.
const ACTIVE_TAB_LS_KEY = 'oge_histogramTab';
const DEFAULT_TAB = 'colony';

// Default target positions when no per-universe Galaxy-Scan config is
// stored yet. Matches the default shipped by `domain/galaxyScanConfig.js`
// so the dashboard reads the same filter as the Send Col feature does on
// the game side.
const DEFAULT_COL_POSITIONS = defaultGalaxyScanConfig().positions;

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
 * @type {{ galaxies?: number, systems?: number }}
 */
let apiBounds = {};

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

/** @type {Set<number>} */
let targetPositions = parseTargetPositions(DEFAULT_COL_POSITIONS);

/**
 * The selected universe's Galaxy-Scan config (positions + rescan policy),
 * refreshed by `loadAll`. Drives both the target-positions filter and the
 * rescan policy the galaxy map's stale rings/pills are computed against.
 * @type {import('../../domain/galaxyScanConfig.js').GalaxyScanConfig}
 */
let galaxyConfig = defaultGalaxyScanConfig();

/**
 * Per-galaxy accordion open/closed state. A Set so we can mutate it
 * in-place from the galaxy renderer and persist to localStorage without
 * allocating a new collection on every toggle.
 * @type {Set<number>}
 */
const expandedGalaxies = new Set();

// ── DOM refs (filled by wireDom) ───────────────────────────────────────

/** @type {HTMLElement} */ let statsEl;
/** @type {HTMLElement} */ let chartEl;
/** @type {HTMLElement} */ let countInfoEl;
/** @type {HTMLSelectElement} */ let posFilter;
/** @type {HTMLSelectElement} */ let universeSelect;
/** @type {HTMLElement} */ let scansContainer;
/** @type {HTMLElement | null} */ let importStatusEl;
/** @type {HTMLInputElement} */ let freePosInput;
/** @type {HTMLSelectElement} */ let freeGapsSelect;
/** @type {HTMLSelectElement} */ let freeStrategySelect;
/** @type {HTMLSelectElement} */ let freeExpansionSelect;
/** @type {HTMLInputElement} */ let freeRadius;
/** @type {HTMLElement | null} */ let freeRadiusVal;
/** @type {HTMLSelectElement} */ let freeExcludeN;
/** @type {HTMLElement | null} */ let streakOnlyControls;
/** @type {HTMLElement | null} */ let nbrOnlyControls;
/** @type {HTMLElement | null} */ let freeRadiusRow;
/** @type {HTMLElement} */ let freeContainer;
/** @type {HTMLElement | null} */ let freeCountInfoEl;
/** @type {HTMLElement} */ let targetsContainer;
/** @type {HTMLInputElement} */ let tgtMinMilitary;
/** @type {HTMLSelectElement} */ let tgtLimit;
/** @type {HTMLInputElement | null} */ let tgtWatchedOnly;
/** @type {HTMLInputElement | null} */ let tgtProbes;
/** @type {HTMLElement | null} */ let tgtCountInfoEl;

/** The 5 neighbourhood factors users can tune via sliders. */
const WEIGHT_FIELDS = /** @type {const} */ (['free', 'inactive', 'occupied', 'bandit', 'honored']);
/** @type {Partial<Record<typeof WEIGHT_FIELDS[number], HTMLInputElement>>} */
const weightSliders = {};
/** @type {Partial<Record<typeof WEIGHT_FIELDS[number], HTMLElement>>} */
const weightValues = {};
// True once the user has moved any slider away from the preset values.
// Lets readCustomWeights distinguish "user explicitly set all to zero"
// from "nothing has been touched yet".
let weightsDirty = false;

/**
 * Bootstrap the dashboard page. Safe to call multiple times but
 * there's no reason to — the HTML entry invokes this exactly once.
 * Defers real work until DOMContentLoaded when the page is still
 * loading so `document.getElementById` lookups resolve.
 *
 * @returns {void}
 */
export const installDashboard = () => {
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
  loadExpanded();
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
  loadWatched();

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

  // Restore Colony Scout preferences from previous session.
  const scoutPrefs = /** @type {any} */ (safeLS.json(SCOUT_PREFS_KEY, {}));
  if (scoutPrefs.strategy && freeStrategySelect.querySelector(`[value="${scoutPrefs.strategy}"]`)) {
    freeStrategySelect.value = scoutPrefs.strategy;
  }
  if (scoutPrefs.expansion !== undefined
    && freeExpansionSelect.querySelector(`[value="${String(scoutPrefs.expansion)}"]`)) {
    freeExpansionSelect.value = String(scoutPrefs.expansion);
  }
  if (scoutPrefs.radius !== undefined && freeRadius) {
    freeRadius.value = String(scoutPrefs.radius);
    if (freeRadiusVal) freeRadiusVal.textContent = String(scoutPrefs.radius);
  }
  if (scoutPrefs.excludeN !== undefined
    && freeExcludeN?.querySelector(`[value="${String(scoutPrefs.excludeN)}"]`)) {
    freeExcludeN.value = String(scoutPrefs.excludeN);
  }
  applyPresetToSliders(freeStrategySelect.value);
  updateModeControls();

  // Restore the Targets table sort from previous session (device-local).
  const targetPrefs = /** @type {any} */ (safeLS.json(TARGET_PREFS_KEY, {}));
  if (targetPrefs.key === 'hiddenFleet' || targetPrefs.key === 'military'
    || targetPrefs.key === 'totalRank') {
    targetSort = { key: targetPrefs.key, dir: targetPrefs.dir === 'asc' ? 'asc' : 'desc' };
  }

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
  scansContainer = /** @type {HTMLElement} */ (document.getElementById('scansContainer'));
  importStatusEl = document.getElementById('importStatus');
  freePosInput = /** @type {HTMLInputElement} */ (document.getElementById('freePosInput'));
  freeGapsSelect = /** @type {HTMLSelectElement} */ (document.getElementById('freeGapsSelect'));
  freeStrategySelect = /** @type {HTMLSelectElement} */ (document.getElementById('freeStrategySelect'));
  freeExpansionSelect = /** @type {HTMLSelectElement} */ (document.getElementById('freeExpansionSelect'));
  freeRadius = /** @type {HTMLInputElement} */ (document.getElementById('freeRadius'));
  freeRadiusVal = document.getElementById('freeRadiusVal');
  freeExcludeN = /** @type {HTMLSelectElement} */ (document.getElementById('freeExcludeN'));
  streakOnlyControls = document.getElementById('streakOnlyControls');
  nbrOnlyControls = document.getElementById('nbrOnlyControls');
  freeRadiusRow = document.getElementById('freeRadiusRow');
  freeContainer = /** @type {HTMLElement} */ (document.getElementById('freeContainer'));
  freeCountInfoEl = document.getElementById('freeCountInfo');
  targetsContainer = /** @type {HTMLElement} */ (document.getElementById('targetsContainer'));
  tgtMinMilitary = /** @type {HTMLInputElement} */ (document.getElementById('tgtMinMilitary'));
  tgtLimit = /** @type {HTMLSelectElement} */ (document.getElementById('tgtLimit'));
  tgtWatchedOnly = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtWatchedOnly'));
  tgtProbes = /** @type {HTMLInputElement | null} */ (document.getElementById('tgtProbes'));
  tgtCountInfoEl = document.getElementById('tgtCountInfo');
  for (const k of WEIGHT_FIELDS) {
    const s = document.getElementById(`freeW_${k}`);
    const v = document.getElementById(`freeWV_${k}`);
    if (s instanceof HTMLInputElement) weightSliders[k] = s;
    if (v instanceof HTMLElement) weightValues[k] = v;
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
    });
  }
};

/**
 * Wire the Colonizations sub-tabs ("Planet sizes" / "Scanned data" /
 * "Colony Scout"). All panes stay mounted (the inactive ones are
 * `display:none`) so the histogram, galaxy-map and Colony-Scout renderers keep
 * painting into their containers regardless of which sub-tab is showing —
 * clicking only flips the `active` classes. (The histogram tolerates being
 * hidden at render time: its width-based binning falls back to a viewport
 * estimate when `clientWidth` is 0 — see colony.js `estimateChartWidth`.)
 * Purely presentational; no persistence (always opens on the first sub-tab),
 * matching the AlarmClock settings sub-tabs.
 *
 * @returns {void}
 */
const wireColonySubtabs = () => {
  const buttons = document.querySelectorAll('#colonySubtabs .subtab');
  const panes = document.querySelectorAll('#colonySection .subtabpane');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.subtab;
      for (const b of buttons) {
        b.classList.toggle('active', b === btn);
      }
      for (const pane of panes) {
        pane.classList.toggle('active', /** @type {HTMLElement} */ (pane).dataset.subtab === key);
      }
    });
  }
};

/**
 * Restore previously-expanded galaxy IDs from localStorage. Tolerates
 * a malformed stored value by silently skipping non-numeric entries.
 *
 * @returns {void}
 */
const loadExpanded = () => {
  const raw = safeLS.json(EXPANDED_LS_KEY, []);
  if (!Array.isArray(raw)) return;
  for (const v of raw) {
    if (typeof v === 'number') expandedGalaxies.add(v);
  }
};

/**
 * Persist the current expanded-galaxies set to localStorage. Called
 * after every toggle so the state survives a page reload.
 *
 * @returns {void}
 */
const persistExpanded = () => {
  safeLS.setJSON(EXPANDED_LS_KEY, [...expandedGalaxies]);
};

/**
 * (Re)load the watch-list for the selected universe into {@link watchedPlayers},
 * replacing whatever was there. Called on boot and on universe switch (the ids
 * are universe-scoped). Tolerates a malformed stored value.
 *
 * @returns {void}
 */
const loadWatched = () => {
  watchedPlayers.clear();
  if (!selectedUniverseId) return;
  const raw = safeLS.json(watchedKeyFor(selectedUniverseId), []);
  if (!Array.isArray(raw)) return;
  for (const v of raw) {
    if (typeof v === 'string' || typeof v === 'number') watchedPlayers.add(String(v));
  }
};

/**
 * Toggle a player's watch-list membership, persist the new set, and repaint
 * just the Targets sub-tab. Mutates {@link watchedPlayers} in place.
 *
 * @param {string} id
 * @returns {void}
 */
const toggleWatched = (id) => {
  if (watchedPlayers.has(id)) watchedPlayers.delete(id);
  else watchedPlayers.add(id);
  if (selectedUniverseId) {
    safeLS.setJSON(watchedKeyFor(selectedUniverseId), [...watchedPlayers]);
  }
  repaintTargets();
};

/**
 * Refresh module-local caches (`history`, `scans`, `targetPositions`)
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
    galaxyConfig = defaultGalaxyScanConfig();
    targetPositions = parseTargetPositions(galaxyConfig.positions);
    apiCache = {};
    targetCandidates = [];
    targetReports = {};
    planetCountByPlayer = {};
    return;
  }
  const [h, s, c, p, op, api, tr] = await Promise.all([
    chromeStore.get(historyKeyFor(selectedUniverseId)),
    chromeStore.get(scansKeyFor(selectedUniverseId)),
    chromeStore.get(galaxyScanConfigKeyFor(selectedUniverseId)),
    chromeStore.get(playersKeyFor(selectedUniverseId)),
    readOwnProfile(selectedUniverseId),
    readApiCacheFor(selectedUniverseId),
    chromeStore.get(targetReportsKeyFor(selectedUniverseId)),
  ]);
  history = Array.isArray(h) ? /** @type {ColonyEntry[]} */ (h) : [];
  scans = s && typeof s === 'object' ? /** @type {GalaxyScans} */ (s) : {};
  players = p && typeof p === 'object'
    ? /** @type {import('../../state/players.js').PlayerCache} */ (p)
    : {};
  ownProfile = op;
  galaxyConfig = normalizeGalaxyScanConfig(c);
  targetPositions = parseTargetPositions(galaxyConfig.positions);

  // Build the API occupancy index (breadth layer) for the Colony Scout. Empty
  // when the in-game side hasn't populated the cache yet → Scout uses live
  // scans alone. ownPlayerId flags our own colonies (excluded as occupied).
  if (api && api.universe) {
    apiIndex = buildOccupancyIndex({
      universe: { planets: api.universe.planets, timestamp: api.universe.timestamp },
      players: { players: api.players ? api.players.players : {} },
      highscore: { ranks: api.total ? api.total.ranks : {} },
      honor: { ranks: api.honor ? api.honor.ranks : {} },
      ownPlayerId: op.id,
    });
    apiBounds = {
      galaxies: api.server ? api.server.data.galaxies : undefined,
      systems: api.server ? api.server.data.systems : undefined,
    };
  } else {
    apiIndex = null;
    apiBounds = {};
  }

  // Targets sub-tab: join the already-cached API feeds (players + total +
  // military) into candidate rows. Empty when the in-game side hasn't populated
  // the cache yet → the sub-tab shows its "open the galaxy view" hint.
  apiCache = api && typeof api === 'object' ? /** @type {import('../../state/apiCache.js').ApiCache} */ (api) : {};
  targetCandidates = buildTargetCandidates({
    players: apiCache.players ? apiCache.players.players : undefined,
    total: apiCache.total ? apiCache.total.ranks : undefined,
    military: apiCache.military ? apiCache.military.ranks : undefined,
  });

  targetReports = tr && typeof tr === 'object'
    ? /** @type {import('../../state/targets.js').TargetReports} */ (tr)
    : {};
  // Coverage denominator: count each player's planets in the universe.xml
  // snapshot (planets only — moons are <moon> children we don't parse).
  /** @type {Record<string, number>} */
  const counts = {};
  const uniPlanets = apiCache.universe ? apiCache.universe.planets : [];
  for (const pl of uniPlanets) {
    if (pl && pl.player != null) {
      const pid = String(pl.player);
      counts[pid] = (counts[pid] || 0) + 1;
    }
  }
  planetCountByPlayer = counts;
};

/**
 * Current filter value from the position-filter select.
 *
 * @returns {string}
 */
const getFilter = () => posFilter?.value ?? 'all';

/**
 * The live-scan overlay for the API composite: only systems whose positions
 * were actually observed (this session). Excludes lf-only entries — after §5
 * the persisted scans blob keeps only lifeform markers (empty `positions`), so
 * a naive spread would clobber the API occupancy for those systems with blanks.
 *
 * @param {GalaxyScans} s
 * @returns {GalaxyScans}
 */
const liveOverlay = (s) => {
  /** @type {GalaxyScans} */
  const out = {};
  for (const k of /** @type {(keyof GalaxyScans)[]} */ (Object.keys(s))) {
    const v = s[k];
    if (v && v.positions && Object.keys(v.positions).length > 0) out[k] = v;
  }
  return out;
};

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

  // Galaxy map now renders the WHOLE server from the API occupancy index
  // (§5), with live scans overlaid (live wins per system). Falls back to raw
  // local scans when the API cache isn't populated yet for this universe.
  const mapScans =
    apiIndex && apiBounds.galaxies && apiBounds.systems
      ? /** @type {GalaxyScans} */ ({
          ...buildScanMapFromIndex(apiIndex, {
            galaxies: apiBounds.galaxies,
            systems: apiBounds.systems,
            targets: [...targetPositions],
          }),
          ...liveOverlay(scans),
        })
      : scans;
  renderGalaxyMap({
    containerEl: scansContainer,
    scans: mapScans,
    targetPositions,
    expandedGalaxies,
    onToggleExpand: () => { persistExpanded(); },
    onResetGalaxy: (g) => { void resetGalaxy(g); },
  });

  // Settlement-regions block (inside the galaxy tab) — runs over the
  // same `scans` data with the current positions + tolerance controls.
  // Repainting on every renderAll keeps it in sync with universe changes
  // / storage updates; the controls also have their own onchange
  // listeners that re-paint only this block without paying for the
  // colony / galaxy passes.
  repaintFreeRegions();
  repaintTargets();
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

  // Per-player hidden-fleet estimate (for players we've opened reports on) +
  // the set of already-spied planet coords per player (drives the ✓ marker and
  // the "next un-spied" link in the expandable detail row). The report key is a
  // bodyKey "g:s:p:type"; strip the trailing ":type" to get the "g:s:p" coord.
  const military = apiCache.military ? apiCache.military.ranks : {};
  /** @type {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} */
  const estimates = {};
  /** @type {Record<string, Set<string>>} */
  const spiedByPlayer = {};
  for (const pid of Object.keys(targetReports)) {
    const bucket = targetReports[pid];
    const reports = bucket ? Object.values(bucket) : [];
    if (!reports.length) continue;
    estimates[pid] = estimateHiddenFleet({
      militaryPoints: military[pid] ? military[pid].score : undefined,
      reports,
      planetCount: planetCountByPlayer[pid],
    });
    const coords = new Set();
    for (const key of Object.keys(bucket)) {
      const lastColon = key.lastIndexOf(':');
      coords.add(lastColon >= 0 ? key.slice(0, lastColon) : key);
    }
    spiedByPlayer[pid] = coords;
  }

  renderTargets({
    containerEl: targetsContainer,
    candidates: targetCandidates,
    opts: {
      ownPlayerId: ownId,
      ownTotalScore,
      ownAlliance,
      minMilitary: Number(tgtMinMilitary?.value) || 0,
    },
    limit: Number(tgtLimit?.value) || 0,
    estimates,
    sort: targetSort,
    onSort: handleTargetSort,
    watchedIds: watchedPlayers,
    onToggleWatch: toggleWatched,
    watchedOnly: !!tgtWatchedOnly?.checked,
    universePlanets: apiCache.universe ? apiCache.universe.planets : [],
    spiedByPlayer,
    probes: Number(tgtProbes?.value) || 20,
    gameHref: targetGameHref(),
    expandedIds: expandedTargets,
    onToggleExpand: (id) => {
      if (expandedTargets.has(id)) expandedTargets.delete(id);
      else expandedTargets.add(id);
    },
    countInfoEl: tgtCountInfoEl,
  });
};

/**
 * In-game URL base for the SELECTED universe — the origin spy deep-links must
 * point at. The dashboard runs on the extension origin, so `location.href` is
 * useless here; prefer the server's own `<domain>` from the cached serverData,
 * falling back to the canonical `<universeId>.ogame.gameforge.com` host. Returns
 * '' when neither is known (links then render as muted, non-clickable text).
 *
 * @returns {string}
 */
const targetGameHref = () => {
  const domain = apiCache.server?.data?.domain;
  const host = domain || (selectedUniverseId
    ? `${selectedUniverseId}.ogame.gameforge.com`
    : '');
  return host ? `https://${host}/game/index.php` : '';
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
  safeLS.setJSON(TARGET_PREFS_KEY, targetSort);
  repaintTargets();
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
 * Read current slider values as a StrategyWeights object.
 * Returns the current slider values as custom weights, or `undefined` when
 * the user hasn't touched the sliders since the last preset was applied —
 * in that case the caller uses the named preset unchanged.
 *
 * @returns {import('../../domain/regions.js').StrategyWeights | undefined}
 */
const readCustomWeights = () => {
  if (!weightsDirty) return undefined;
  /** @type {import('../../domain/regions.js').StrategyWeights} */
  const w = {};
  for (const k of WEIGHT_FIELDS) {
    w[k] = parseFloat(weightSliders[k]?.value ?? '0') || 0;
  }
  return w;
};

/**
 * Populate weight sliders from a named strategy preset and mark them as
 * clean (not customised). Called when the strategy select changes, on reset,
 * and on initial load.
 *
 * @param {string} strategyKey
 */
const applyPresetToSliders = (strategyKey) => {
  weightsDirty = false;
  const preset = STRATEGIES[strategyKey];
  for (const k of WEIGHT_FIELDS) {
    const val = (preset?.weights[k] ?? 0).toFixed(1);
    const slider = weightSliders[k];
    const display = weightValues[k];
    if (slider) slider.value = val;
    if (display) display.textContent = val;
  }
};

/**
 * Show the control set that matches the selected strategy: Longest streak hunts
 * a free-slot run (Slots + Tolerance), the other strategies analyse the area
 * around a settle spot (Radius + Ignore-worst + Placement). Keeping each mode's
 * irrelevant controls hidden is what stops the "why pick a slot streak for
 * Peaceful?" confusion. Idempotent; safe before the refs exist (tests).
 */
const updateModeControls = () => {
  const streak = (freeStrategySelect?.value || 'longest') === 'longest';
  if (streakOnlyControls) streakOnlyControls.style.display = streak ? '' : 'none';
  if (nbrOnlyControls) nbrOnlyControls.style.display = streak ? 'none' : '';
  // Radius lives on its own full-width row (the slider is long); flex so the
  // slider stretches across it.
  if (freeRadiusRow) freeRadiusRow.style.display = streak ? 'none' : 'flex';
};

/** Repaint ONLY the settlement-regions block from current controls. */
const repaintFreeRegions = () => {
  const positions = freeRegionPositions();
  // Composite the API breadth layer (whole-server occupancy) with the live
  // scan map — live wins per system (fresher, carries honor rankClass /
  // empty_sent). When there's no cached API data the composite is just the
  // live scans (today's behaviour). The free-region finder is unchanged; it
  // simply now sees the whole server.
  const composite =
    apiIndex && apiBounds.galaxies && apiBounds.systems
      ? /** @type {GalaxyScans} */ ({
          ...buildScanMapFromIndex(apiIndex, {
            galaxies: apiBounds.galaxies,
            systems: apiBounds.systems,
            targets: positions,
          }),
          ...liveOverlay(scans),
        })
      : scans;
  renderFreeRegions({
    containerEl: freeContainer,
    countInfoEl: freeCountInfoEl,
    scans: composite,
    positions,
    maxGaps: parseInt(freeGapsSelect.value, 10) || 0,
    strategy: freeStrategySelect.value || 'longest',
    expansion: parseInt(freeExpansionSelect.value, 10) || 0,
    radius: parseInt(freeRadius?.value, 10) || 15,
    excludeN: parseInt(freeExcludeN?.value, 10) || 0,
    customWeights: readCustomWeights(),
    players,
    ownRank: ownProfile.rank,
  });
};

/**
 * Delete every scan whose key starts with `"${g}:"` from the selected
 * universe's scans map, then flag a per-galaxy remote reset so the
 * next sync cycle wipes the gist's copy of this galaxy too. Without
 * the remote-side wipe the union merge would reintroduce the
 * just-deleted local entries on the next download. (Plain
 * triggerSync is wrong here for the same reason — it merges, it
 * doesn't subtract.)
 *
 * @param {number} g
 * @returns {Promise<void>}
 */
const resetGalaxy = async (g) => {
  if (!selectedUniverseId) return;
  const scansKey = scansKeyFor(selectedUniverseId);
  const raw = await chromeStore.get(scansKey);
  if (!raw || typeof raw !== 'object') return;
  /** @type {GalaxyScans} */
  const current = { .../** @type {GalaxyScans} */ (raw) };
  for (const key of Object.keys(current)) {
    if (key.startsWith(g + ':')) {
      delete current[/** @type {`${number}:${number}`} */ (key)];
    }
  }
  await chromeStore.set(scansKey, current);
  await triggerResetGalaxy(g, selectedUniverseId);
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
  // already loaded; only the filter/limit we apply to it changed).
  tgtMinMilitary.addEventListener('change', repaintTargets);
  tgtLimit.addEventListener('change', repaintTargets);
  tgtWatchedOnly?.addEventListener('change', repaintTargets);
  tgtProbes?.addEventListener('change', repaintTargets);

  // Region controls only repaint the settlement-regions block. The
  // underlying `scans` cache hasn't changed — only the slots/tolerance
  // we query against have — so the colony / galaxy passes would be
  // wasted work.
  freePosInput.addEventListener('change', repaintFreeRegions);
  freeGapsSelect.addEventListener('change', repaintFreeRegions);
  const saveScoutPrefs = () => {
    safeLS.setJSON(SCOUT_PREFS_KEY, {
      strategy: freeStrategySelect.value,
      expansion: freeExpansionSelect.value,
      radius: freeRadius?.value,
      excludeN: freeExcludeN?.value,
    });
  };

  freeStrategySelect.addEventListener('change', () => {
    applyPresetToSliders(freeStrategySelect.value);
    updateModeControls();
    saveScoutPrefs();
    repaintFreeRegions();
  });
  freeExpansionSelect.addEventListener('change', () => { saveScoutPrefs(); repaintFreeRegions(); });
  freeRadius?.addEventListener('input', () => {
    if (freeRadiusVal) freeRadiusVal.textContent = freeRadius.value;
    saveScoutPrefs();
    repaintFreeRegions();
  });
  freeExcludeN?.addEventListener('change', () => { saveScoutPrefs(); repaintFreeRegions(); });

  for (const k of WEIGHT_FIELDS) {
    weightSliders[k]?.addEventListener('input', () => {
      weightsDirty = true;
      const v = weightSliders[k]?.value ?? '0';
      if (weightValues[k]) weightValues[k].textContent = parseFloat(v).toFixed(1);
      repaintFreeRegions();
    });
  }

  document.getElementById('freeWeightsReset')?.addEventListener('click', () => {
    applyPresetToSliders(freeStrategySelect.value);
    repaintFreeRegions();
  });

  universeSelect.addEventListener('change', () => {
    selectedUniverseId = universeSelect.value;
    loadWatched();
    void loadAll().then(renderAll);
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
  galaxyConfig = defaultGalaxyScanConfig();
  targetPositions = parseTargetPositions(DEFAULT_COL_POSITIONS);
  weightsDirty = false;
  // DOM refs filled by wireDom(); wireDom re-resolves them on the next
  // install, but null them now so nothing reads a detached node in between.
  statsEl =
    chartEl =
    countInfoEl =
    posFilter =
    universeSelect =
    scansContainer =
    importStatusEl =
    freePosInput =
    freeGapsSelect =
    freeStrategySelect =
    freeExpansionSelect =
    freeRadius =
    freeRadiusVal =
    freeExcludeN =
    streakOnlyControls =
    nbrOnlyControls =
    freeRadiusRow =
    freeContainer =
    freeCountInfoEl =
      /** @type {any} */ (undefined);
  for (const k of Object.keys(weightSliders)) delete weightSliders[/** @type {keyof typeof weightSliders} */ (k)];
  for (const k of Object.keys(weightValues)) delete weightValues[/** @type {keyof typeof weightValues} */ (k)];
  _resetAlarmClockForTest();
};
