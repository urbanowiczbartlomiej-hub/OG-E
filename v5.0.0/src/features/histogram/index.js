// @ts-check

// Histogram page entry — bootstrap + storage-change re-render.
//
// Loads data via chromeStore, invokes the render modules, and listens
// for chrome.storage.onChanged to refresh. The histogram page is
// extension-origin and read-only: we don't wire state persistence
// (initHistoryStore / initScansStore), because that's for the
// game-origin content script's write-through. Here we simply read the
// same keys on demand and re-render when they change.
//
// Data flow:
//   install() → wait for DOMContentLoaded → wireDom() → loadAll() →
//   render{Colony, Galaxy}() → wireListeners() → chromeStore.onChanged
//   hook. User-driven mutations (import, reset, clear) write to
//   chromeStore, which fires onChanged in this same tab, which calls
//   loadAll() + render*() again. Single direction, no duplicate paths.
//
// Target positions: we try to read `oge5_colPositions` from
// chrome.storage.local. On the game side, Phase 10 will mirror that
// setting from localStorage (where state/settings.js owns it) so this
// page can see it across origins. Until Phase 10 lands, the read
// returns undefined and we fall back to the '8' default.
//
// @see ./colony.js  — renderColonyChart + populatePositionFilter
// @see ./galaxy.js  — renderGalaxyMap (accordion + pixel map)
// @see ./io.js      — Export/Import/CSV + tombstones
// @see ../../DESIGN.md §9.5 (sync flow) and §10 (storage layout)

import { chromeStore, safeLS } from '../../lib/storage.js';
import { parseTargetPositions } from '../../domain/histogram.js';
import { populatePositionFilter, renderColonyChart } from './colony.js';
import { renderGalaxyMap } from './galaxy.js';
import {
  exportAllData,
  importAllData,
  exportColonyCsv,
  triggerSync,
  triggerClearRemote,
  triggerResetGalaxy,
  HISTORY_KEY,
  SCANS_KEY,
} from './io.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

// chrome.storage.local key the game-side settingsStore will mirror
// `colPositions` into (Phase 10 wiring). Until then we just read it;
// nothing here writes to this key.
const COL_POSITIONS_KEY = 'oge5_colPositions';

// localStorage key for accordion open/closed state. Per-device, not
// synced — accordion state is UI preference, not user data.
const EXPANDED_LS_KEY = 'oge5_expandedGalaxies';

// Default target positions when no mirror is available. Matches the
// default shipped by state/settings.js so the histogram reads the same
// filter as the Send Col feature does on the game side.
const DEFAULT_COL_POSITIONS = '8';

// ── Module-local caches ────────────────────────────────────────────────

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
/** @type {HTMLElement} */ let scansContainer;
/** @type {HTMLElement | null} */ let importStatusEl;

/**
 * Bootstrap the histogram page. Safe to call multiple times but
 * there's no reason to — the HTML entry invokes this exactly once.
 * Defers real work until DOMContentLoaded when the page is still
 * loading so `document.getElementById` lookups resolve.
 *
 * @returns {void}
 */
export const install = () => {
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
  await loadAll();
  renderAll();
  wireListeners();

  chromeStore.onChanged((changes) => {
    // Only bother re-rendering when one of OUR keys changed. Other
    // tombstones / settings updates happen too and would otherwise
    // cause a spurious re-render cycle.
    if (
      HISTORY_KEY in changes
      || SCANS_KEY in changes
      || COL_POSITIONS_KEY in changes
    ) {
      void loadAll().then(renderAll);
    }
  });
};

/**
 * Resolve every DOM reference the page needs in one place. The IDs
 * here must match `histogram.html`; a missing node returns null and
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
  scansContainer = /** @type {HTMLElement} */ (document.getElementById('scansContainer'));
  importStatusEl = document.getElementById('importStatus');
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
 * from chrome.storage.local. Single Promise.all so a cold start only
 * pays one round-trip.
 *
 * @returns {Promise<void>}
 */
const loadAll = async () => {
  const [h, s, p] = await Promise.all([
    chromeStore.get(HISTORY_KEY),
    chromeStore.get(SCANS_KEY),
    chromeStore.get(COL_POSITIONS_KEY),
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
};

/**
 * Delete every scan whose key starts with `"${g}:"`, then flag a
 * per-galaxy remote reset so the next sync cycle (Phase 10) wipes the
 * gist's copy of this galaxy too. Without the remote-side wipe the
 * union merge would reintroduce the just-deleted local entries on the
 * next download. (Plain `triggerSync` is wrong here for the same
 * reason — it merges, it doesn't subtract.)
 *
 * @param {number} g
 * @returns {Promise<void>}
 */
const resetGalaxy = async (g) => {
  const raw = await chromeStore.get(SCANS_KEY);
  if (!raw || typeof raw !== 'object') return;
  /** @type {GalaxyScans} */
  const current = { .../** @type {GalaxyScans} */ (raw) };
  for (const key of Object.keys(current)) {
    if (key.startsWith(g + ':')) {
      delete current[/** @type {`${number}:${number}`} */ (key)];
    }
  }
  await chromeStore.set(SCANS_KEY, current);
  await triggerResetGalaxy(g);
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
  const refreshBtn = document.getElementById('refreshBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const refreshScansBtn = document.getElementById('refreshScansBtn');
  const clearScansBtn = document.getElementById('clearScansBtn');

  exportBtn?.addEventListener('click', () => {
    void exportAllData().then(() => {
      setStatus(
        'Exported ' + history.length + ' colonies, '
        + Object.keys(scans).length + ' scans',
      );
    });
  });

  importBtn?.addEventListener('click', () => importFile?.click());

  importFile?.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    const res = await importAllData(file);
    if (res.warning) {
      setStatus('Error: ' + res.warning);
    } else {
      setStatus(
        'Imported: +' + res.colonies + ' colonies, '
        + '+' + res.scans + ' scans',
      );
    }
    // Clear the input so re-selecting the same file fires `change`.
    importFile.value = '';
  });

  refreshBtn?.addEventListener('click', () => {
    void triggerSync();
    void loadAll().then(renderAll);
  });

  exportCsvBtn?.addEventListener('click', () => exportColonyCsv(history));

  posFilter.addEventListener('change', () => renderAll());

  refreshScansBtn?.addEventListener('click', () => {
    void triggerSync();
    void loadAll().then(renderAll);
  });

  clearScansBtn?.addEventListener('click', async () => {
    if (!confirm(
      'Clear all galaxy observation data?\n\n'
      + 'This removes data from this device AND your cloud sync '
      + '(so it does not come back on the next page load).',
    )) return;
    await chromeStore.remove(SCANS_KEY);
    await triggerClearRemote();
  });
};
