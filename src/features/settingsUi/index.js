// @ts-check

// Settings panel — OG-E's preferences UI injected as a tab at the
// bottom of the AntiGameReborn (AGR) options menu. Orchestrator +
// lifecycle. The 5 section configs live in `./sections/`, the per-row
// rendering + control builders + anti-loop write flag live in
// `./controls.js`; this file owns the tab DOM construction
// (`buildTab`), the AGR-container watch via `MutationObserver`, the
// cross-tab accordion listener, the dispose lifecycle, and the test
// reset.
//
// # Why we integrate with AGR instead of rendering a standalone panel
//
// OG-E assumes AGR is installed alongside it — AGR's own options menu
// is the canonical place users of both extensions expect toggles to
// live. Rendering a second floating panel just for OG-E would split
// the "where do I change settings" mental model across two surfaces.
// By appending to `#ago_menu_content` we get a coherent UX: one menu
// open, both extensions visible.
//
// The hard dependency on AGR is deliberate — if AGR is not installed
// there simply is no settings UI. Users who want the feature set
// without the panel can still edit localStorage directly (keys under
// `oge_` prefix — see `src/state/settings.js`), but that is not a
// supported workflow. See `src/state/settings.js` for the full
// argument on why persistence is per-key (AGR compatibility is the #1
// reason).
//
// # Lifecycle (one-shot install, not re-entrant)
//
//   1. `inject()` runs synchronously — works if AGR is already
//      hydrated.
//   2. A `MutationObserver` on `document.body` re-runs `inject()` on
//      every body mutation — survives AGR rebuilding the container,
//      and serves as the AGR-not-yet-loaded fallback (the observer
//      catches AGR's first hydration mutation).
//   3. Each row's control is wired by `controls.buildRow` to write
//      back via `controls.writeSetting`. We do NOT write to
//      localStorage directly — the settings store's own persist
//      subscription handles that, keeping this module purely a UI
//      layer.
//   4. A single `settingsStore.subscribe` calls `syncInputsFromState`,
//      which reads the `writingFromUi` flag inside `controls.js` and
//      skips the resync when WE were the writer (avoids feedback loop
//      + caret-reset on text inputs).
//   5. Dispose: disconnect observer, drop the document accordion
//      listener, unsubscribe settings, remove the tab DOM.
//
// # Why no bridges import
//
// Feature modules run in the isolated content-script world. They can
// call into state/lib/domain, but not bridges — those are page-world
// shims. The sync-status refresh + force-sync button both communicate
// via `document.dispatchEvent(new CustomEvent(...))` to sidestep the
// world boundary.
//
// @see ./controls.js — control builders + buildRow + syncInputsFromState.
// @see ./sections/   — per-section configs.
// @see ../../state/settings.js — the store this module's controls bind to.

import { settingsStore } from '../../state/settings.js';
import { SECTIONS } from './sections/index.js';
import {
  buildRow,
  syncInputsFromState,
  _clearWritingFromUiForTest,
} from './controls.js';

/**
 * DOM id of the whole AGR tab wrapper. AGR recognises `.ago_menu_tab`
 * nodes and binds its toggle behaviour to the child `ago-data` attribute
 * — our settings area must emit exactly this structure to participate
 * in the rest of the AGR accordion UX.
 */
const TAB_ID = 'oge-settings-tab';

/** DOM id of the settings tab header (the clickable "▼ OG-E Settings" strip). */
const HEADER_ID = 'oge-settings-header';

/** DOM id of the settings table element. Stable for dispose + query by tests. */
const TABLE_ID = 'oge-settings-table';

/**
 * CSS selector for the AGR menu container. AGR owns this node; we only
 * append into it. AGR renders `<div id="ago_menu_content">`, not a
 * class-attributed node — matching on `.ago_menu_content` never
 * matches and produces silent "no settings in AGR" breakage. If this
 * id ever changes upstream this module breaks — loudly (no settings
 * tab visible), which is the right failure mode.
 */
const AGR_SELECTOR = '#ago_menu_content';

/**
 * Apply the collapse/expand state to a tab by mutating the DOM in
 * place. Pure w.r.t. its argument — writes nothing to closure state —
 * so it works against whichever `tabEl` is currently in the document,
 * even after AGR rebuilds the panel and we re-inject.
 *
 * @param {HTMLElement} tab
 * @param {boolean} collapse
 * @returns {void}
 */
const applyCollapse = (tab, collapse) => {
  const headerChild = tab.querySelector('.ago_menu_tab_header');
  const arrowClose = /** @type {HTMLElement | null} */ (
    tab.querySelector('.ago_menu_tab_arrow_close')
  );
  const arrowOpen = /** @type {HTMLElement | null} */ (
    tab.querySelector('.ago_menu_tab_arrow_open')
  );
  for (const child of Array.from(tab.children)) {
    if (child === headerChild) continue;
    const el = /** @type {HTMLElement} */ (child);
    // `setProperty(..., 'important')` is the one hammer that works
    // even against `!important` rules shipped by AGR's stylesheet.
    el.style.setProperty('display', collapse ? 'none' : 'table', 'important');
  }
  if (arrowClose) arrowClose.style.display = collapse ? '' : 'none';
  if (arrowOpen) arrowOpen.style.display = collapse ? 'none' : '';
  tab.classList.toggle('ago_menu_tab_open', !collapse);
};

/**
 * Build our OG-E tab `<div>` top-to-bottom: wrapper, clickable header
 * with arrows + gold label, one `.ago_menu_section` table per section,
 * all inputs wired via {@link buildRow} from controls.js. The returned
 * element is a detached node — the caller appends it into the AGR
 * container.
 *
 * Accordion click is wired here: when the tab opens, we synthetically
 * click every other `.ago_menu_tab_open` so AGR folds them up (its
 * native menu allows only one tab open at a time). When anything else
 * in the panel is clicked, the document-level listener installed once
 * in {@link installSettingsUi} folds us up symmetrically.
 *
 * Default state is collapsed — matches the AGR UX of "all tabs closed
 * on open" and keeps our long settings list out of the user's face.
 *
 * @returns {HTMLElement} The new tab wrapper (`#oge-settings-tab`).
 */
const buildTab = () => {
  const tab = document.createElement('div');
  tab.id = TAB_ID;
  tab.className = 'ago_menu_tab';

  const header = document.createElement('div');
  header.id = HEADER_ID;
  // AGR's stylesheet handles typography/padding via this class — the
  // inline `cursor`/`userSelect` just mark it as interactive because
  // our own click handler (below) wires the toggle, not AGR's.
  header.className = 'ago_menu_tab_header';
  header.style.cursor = 'pointer';
  header.style.userSelect = 'none';

  const arrowClose = document.createElement('span');
  arrowClose.className = 'ago_menu_tab_arrow_close';
  arrowClose.textContent = '▼';
  const arrowOpen = document.createElement('span');
  arrowOpen.className = 'ago_menu_tab_arrow_open';
  arrowOpen.textContent = '▲';

  // Gold label is the single visual marker for "this row is the OG-E
  // add-on". See file header for why we avoid borders/spacing hints.
  const labelSpan = document.createElement('span');
  labelSpan.textContent = 'OG-E Settings';
  labelSpan.style.color = '#d4af37';

  header.appendChild(arrowClose);
  header.appendChild(arrowOpen);
  header.appendChild(labelSpan);
  tab.appendChild(header);

  let primaryTableSet = false;
  for (const section of SECTIONS) {
    const table = document.createElement('table');
    table.className = 'ago_menu_section';
    // Fixed layout + explicit 434/220 colgroup so inputs align between
    // sections (without this, Expeditions labels pushed their inputs
    // further right than Colonization).
    table.style.tableLayout = 'fixed';
    const colgroup = document.createElement('colgroup');
    const col1 = document.createElement('col');
    col1.style.width = '434px';
    const col2 = document.createElement('col');
    col2.style.width = '220px';
    colgroup.appendChild(col1);
    colgroup.appendChild(col2);
    table.appendChild(colgroup);
    if (!primaryTableSet) {
      table.id = TABLE_ID;
      primaryTableSet = true;
    }

    const sectionRow = document.createElement('tr');
    sectionRow.className = 'ago_menu_section_header';
    const sectionCell = document.createElement('th');
    sectionCell.className = 'ago_menu_section_title';
    sectionCell.colSpan = 2;
    sectionCell.textContent = section.section;
    sectionRow.appendChild(sectionCell);
    table.appendChild(sectionRow);

    for (const opt of section.options) {
      table.appendChild(buildRow(opt));
    }
    tab.appendChild(table);
  }

  // Default collapsed. Apply BEFORE attaching the click listener so
  // the very first click sees the "collapsed → open" transition.
  applyCollapse(tab, true);

  header.addEventListener('click', () => {
    const isOpen = tab.classList.contains('ago_menu_tab_open');
    if (!isOpen) {
      // Opening — fold up every other open AGR tab by synthetically
      // clicking its header, so AGR's own toggle handler does the
      // right cleanup. Our document-level listener will see those
      // synthetic clicks but no-op (our tab is still closed here).
      const others = document.querySelectorAll(
        '.ago_menu_tab.ago_menu_tab_open',
      );
      for (const t of others) {
        if (t === tab) continue;
        const otherHeader = t.querySelector('.ago_menu_tab_header');
        if (otherHeader) /** @type {HTMLElement} */ (otherHeader).click();
      }
    }
    applyCollapse(tab, isOpen);
  });

  return tab;
};

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make {@link installSettingsUi}
 * idempotent (second call returns the same dispose without touching
 * DOM).
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the OG-E settings panel. Injects into AGR's
 * `#ago_menu_content` and keeps re-injecting whenever AGR rebuilds
 * that container (which it does when the user closes and reopens the
 * options menu) — without re-injection our tab disappears after the
 * first close.
 *
 * Idempotent: a second call while already installed returns the same
 * dispose handle. Dispose disconnects the observer, unbinds the
 * document-level accordion listener, unsubscribes from settingsStore,
 * and removes any live tab from the DOM.
 *
 * @returns {() => void}
 */
export const installSettingsUi = () => {
  if (installed) return installed.dispose;

  /**
   * Build + append the tab inside AGR's container. No-op when (a) AGR
   * hasn't rendered its container yet, or (b) our tab is already in
   * the DOM. Called on initial install and on every body mutation
   * via the MutationObserver below.
   *
   * @returns {void}
   */
  const inject = () => {
    if (document.getElementById(TAB_ID)) return;
    const container = document.querySelector(AGR_SELECTOR);
    if (!container) return;
    container.appendChild(buildTab());
    // Sync the freshly-built inputs against the current store state.
    // A re-injection after AGR rebuild needs this to carry over the
    // user's edits — the DOM is brand new but the store is not.
    syncInputsFromState();
  };

  // Initial attempt — synchronous when AGR is already hydrated,
  // otherwise MutationObserver picks us up when it appears.
  inject();

  // Watch the whole body: AGR sometimes replaces the container node
  // (not just its children), and a scoped observer attached to the
  // old `#ago_menu_content` goes silent when that happens. Body
  // observation is noisier but survives the swap.
  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });

  /**
   * Document-level accordion listener. When the user clicks any
   * `.ago_menu_tab_header` OTHER than ours, fold our tab up. Uses
   * live DOM lookups because the tab element is recreated on every
   * re-injection — we can't hold a closure reference to "the" tab.
   *
   * @param {Event} e
   */
  const externalToggleListener = (e) => {
    const target = /** @type {HTMLElement | null} */ (e.target);
    if (!target) return;
    const clickedHeader = target.closest('.ago_menu_tab_header');
    if (!clickedHeader) return;
    const ourTab = document.getElementById(TAB_ID);
    if (!ourTab) return;
    if (ourTab.contains(clickedHeader)) return;
    if (!ourTab.classList.contains('ago_menu_tab_open')) return;
    applyCollapse(ourTab, true);
  };
  document.addEventListener('click', externalToggleListener, true);

  const unsubSettings = settingsStore.subscribe(() => {
    // Idempotent DOM lookup — if the tab is currently absent (AGR
    // panel closed), syncInputsFromState just finds no inputs and
    // returns. When the panel reopens, inject() runs another sync.
    syncInputsFromState();
  });

  const dispose = () => {
    observer.disconnect();
    document.removeEventListener('click', externalToggleListener, true);
    unsubSettings();
    const live = document.getElementById(TAB_ID);
    if (live) live.remove();
    installed = null;
  };

  installed = { dispose };
  return dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM
 * and no leaked subscribers. Exported with a `_` prefix to signal
 * "do not import from production code".
 *
 * Also clears the `writingFromUi` flag in `controls.js` defensively —
 * a test that crashes mid-write could theoretically leave the flag
 * set; clearing it here guarantees the next test starts from a clean
 * state.
 *
 * @returns {void}
 */
export const _resetSettingsUiForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  _clearWritingFromUiForTest();
};
