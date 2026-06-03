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
import {
  populatePositionOptions as populateFreePosOptions,
  renderFreeStreak,
} from './freeStreak.js';
import {
  HISTORY_KEY_BASE,
  historyKeyFor,
} from '../../state/history.js';
import {
  SCANS_KEY_BASE,
  scansKeyFor,
} from '../../state/scans.js';
import {
  COL_POSITIONS_KEY_BASE,
  colPositionsKeyFor,
} from '../../state/settings.js';
import {
  exportAllData,
  importAllData,
  exportColonyCsv,
  triggerClearRemote,
  triggerResetGalaxy,
} from './io.js';
import { installReminders } from './reminders.js';
import { installRoutes } from './routes.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

// localStorage key for accordion open/closed state. Per-device, not
// synced — accordion state is UI preference, not user data.
const EXPANDED_LS_KEY = 'oge_expandedGalaxies';

// localStorage key for the active dashboard tab. Per-device UI prefs.
// Possible values are the `data-tab` attributes from dashboard.html:
// `'colony'`, `'galaxy'`, `'free'`, `'reminders'`, `'routes'`. Anything
// unrecognised falls back to `'colony'` (the page's first tab). The key
// keeps its legacy `oge_histogram` name so the saved preference survives
// the rename.
const ACTIVE_TAB_LS_KEY = 'oge_histogramTab';
const DEFAULT_TAB = 'colony';

// Default target positions when no mirror is available. Matches the
// default shipped by state/settings.js so the histogram reads the same
// filter as the Send Col feature does on the game side.
const DEFAULT_COL_POSITIONS = '8';

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
 * Handle to the reminders module's refresh entrypoint, set by
 * `installReminders` at boot. Called from the universe-selector change
 * handler so the reminders tab repaints with the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let remindersApi = null;

/**
 * Handle to the FS-routes tab's refresh entrypoint, set by
 * `installRoutes` at boot. Called from the universe-selector change
 * handler so the routes textarea reloads for the newly-selected server.
 *
 * @type {{ refresh: () => void } | null}
 */
let routesApi = null;

/** @type {ColonyEntry[]} */
let history = [];

/** @type {GalaxyScans} */
let scans = {};

/** @type {Set<number>} */
let targetPositions = parseTargetPositions(DEFAULT_COL_POSITIONS);

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
/** @type {HTMLSelectElement} */ let freePosSelect;
/** @type {HTMLElement} */ let freeContainer;
/** @type {HTMLElement | null} */ let freeCountInfoEl;

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
  populateFreePosOptions(freePosSelect);
  wireTabs();

  // Reminders tab filters by the active universe (same UX as the other
  // tabs). The host passes a getter so reminders never has to import
  // this module's module-scope state; the universe selector's change
  // handler calls `remindersApi.refresh()` to repaint.
  remindersApi = installReminders({ getUniverseId: () => selectedUniverseId });
  routesApi = installRoutes({ getUniverseId: () => selectedUniverseId });

  const universes = await discoverUniverses();
  selectedUniverseId = resolveInitialUniverse(universes);
  populateUniverseSelect(universes, selectedUniverseId);

  await loadAll();
  renderAll();
  // Reminders + routes tabs read `selectedUniverseId` via their getter
  // when their initial paint ran inside install* — BEFORE we resolved the
  // active universe. Repaint now that it's known.
  remindersApi?.refresh();
  routesApi?.refresh();
  wireListeners();

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
      colPositionsKeyFor(selectedUniverseId),
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
 * `oge_galaxyScans`. The settings mirror (`oge_colPositions`) is also
 * recognised so a fresh universe that has only the mirror written
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
    `:${COL_POSITIONS_KEY_BASE}`,
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
  freePosSelect = /** @type {HTMLSelectElement} */ (document.getElementById('freePosSelect'));
  freeContainer = /** @type {HTMLElement} */ (document.getElementById('freeContainer'));
  freeCountInfoEl = document.getElementById('freeCountInfo');
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
    targetPositions = parseTargetPositions(DEFAULT_COL_POSITIONS);
    return;
  }
  const [h, s, p] = await Promise.all([
    chromeStore.get(historyKeyFor(selectedUniverseId)),
    chromeStore.get(scansKeyFor(selectedUniverseId)),
    chromeStore.get(colPositionsKeyFor(selectedUniverseId)),
  ]);
  history = Array.isArray(h) ? /** @type {ColonyEntry[]} */ (h) : [];
  scans = s && typeof s === 'object' ? /** @type {GalaxyScans} */ (s) : {};
  const colStr = typeof p === 'string' && p.length > 0 ? p : DEFAULT_COL_POSITIONS;
  targetPositions = parseTargetPositions(colStr);
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

  renderGalaxyMap({
    containerEl: scansContainer,
    scans,
    targetPositions,
    expandedGalaxies,
    onToggleExpand: () => { persistExpanded(); },
    onResetGalaxy: (g) => { void resetGalaxy(g); },
    // onClearAll is wired from the HTML-level "Clear observation data"
    // button in wireListeners; galaxy.js only holds the signature.
    onClearAll: () => {},
  });

  // Free Positions section — runs over the same `scans` data with the
  // currently-selected slot. Repainting on every renderAll keeps it in
  // sync with universe changes / storage updates; the position select
  // also has its own onchange listener that re-paints only this
  // section without paying for the colony / galaxy passes.
  renderFreeStreak({
    containerEl: freeContainer,
    countInfoEl: freeCountInfoEl,
    scans,
    position: parseInt(freePosSelect.value, 10) || 15,
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
  const clearScansBtn = document.getElementById('clearScansBtn');

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

  // Position-selector only repaints the Free Positions section. The
  // underlying `scans` cache hasn't changed — only the slot we query
  // against has — so the colony / galaxy passes would be wasted work.
  freePosSelect.addEventListener('change', () => {
    renderFreeStreak({
      containerEl: freeContainer,
      countInfoEl: freeCountInfoEl,
      scans,
      position: parseInt(freePosSelect.value, 10) || 15,
    });
  });

  universeSelect.addEventListener('change', () => {
    selectedUniverseId = universeSelect.value;
    void loadAll().then(renderAll);
    remindersApi?.refresh();
    routesApi?.refresh();
  });

  clearScansBtn?.addEventListener('click', async () => {
    if (!selectedUniverseId) return;
    if (!confirm(
      'Clear all galaxy observation data for ' + selectedUniverseId + '?\n\n'
      + 'This removes data from this device AND your cloud sync '
      + '(so it does not come back on the next page load).',
    )) return;
    await chromeStore.remove(scansKeyFor(selectedUniverseId));
    await triggerClearRemote(selectedUniverseId);
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
