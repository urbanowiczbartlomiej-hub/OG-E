// @ts-check
//
// Dashboard "Sync" tab — a cross-universe diagnostics view. For every universe
// with data or a recorded sync attempt it shows a freshness chip, the last
// ↑ upload / ↓ download times (plus any error / rate-limit backoff), and an
// inventory of what's stored (per category: item count + approx size, with a
// per-universe total).
//
// It also owns the ABANDON flow: per card, an archive-then-delete stepper that
// drops a server you stopped playing and gives its storage back. The archive is
// not advisory — the delete control is unreachable until a full archive file
// has actually downloaded (`io.js` exportAllData in archive mode), because on
// a shared 10 MB `chrome.storage.local` quota "free some space" and "lose two
// years of intel" are one click apart. See `purgeUniverseData` for what a
// delete cannot reach (game-origin prefs, the gist).
//
// Cross-universe BY DESIGN: unlike the other tabs it ignores the universe
// selector — the point is to answer "what's synced where" at a glance (e.g.
// "why does my other device have half the scans"). It reads chrome.storage.local
// only; the data crunching lives in syncInventory.js (pure). The game side
// keeps the `<id>:oge_syncStatus` mirror current via sync/gist.js.

import { chromeStore } from '../../lib/storage.js';
import { exportAllData, purgeUniverseData, ARCHIVE_OMITS } from './io.js';
import {
  buildSyncInventory,
  classifySyncFreshness,
  formatBytes,
} from './syncInventory.js';

/** @typedef {import('./syncInventory.js').UniverseInventory} UniverseInventory */

/** @type {HTMLElement | null} */
let bodyEl = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let renderTimer = null;

/**
 * Which universe's abandon panel is expanded, or `''` for none. ONE at a time
 * on purpose: this is an irreversible admin action, and two half-filled
 * confirmations sitting side by side is exactly how the wrong server gets
 * deleted.
 *
 * @type {string}
 */
let abandonOpenFor = '';

/**
 * Per-universe abandon-flow progress, surviving the repaints that
 * `chromeStore.onChanged` triggers under the panel (a background sync round
 * must not silently reset a confirmation the user is halfway through).
 *
 * `archive` is the gate: `null` means no download has succeeded yet and the
 * delete control stays locked. It is intentionally in-memory only — a
 * yesterday's archive is not evidence that TODAY's data is safe, so reloading
 * the page makes the user take a fresh one.
 *
 * @type {Map<string, { archive: { datasets: number, bytes: number } | null, typed: string, busy: boolean, error: string }>}
 */
const abandonFlows = new Map();

/**
 * @param {string} universeId
 * @returns {{ archive: { datasets: number, bytes: number } | null, typed: string, busy: boolean, error: string }}
 */
const flowFor = (universeId) => {
  let f = abandonFlows.get(universeId);
  if (!f) {
    f = { archive: null, typed: '', busy: false, error: '' };
    abandonFlows.set(universeId, f);
  }
  return f;
};

/**
 * Tiny element factory — keeps the render readable and uses textContent
 * throughout (never innerHTML) so a stored error string can't inject markup.
 *
 * @param {string} tag
 * @param {string | null} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Time-of-day for a same-day stamp, full date+time otherwise; em-dash when absent.
 *
 * @param {string | null | undefined} iso
 * @returns {string}
 */
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
};

/**
 * Reload the page after a purge, dropping a `?host=` that points at the
 * universe we just deleted.
 *
 * Why reload at all: the dashboard's universe dropdown is built ONCE at boot
 * (`discoverUniverses` in index.js) and every tab holds module-scope caches
 * keyed to the selected universe. After deleting a universe — possibly the
 * selected one — patching all of that in place would mean a second, parallel
 * teardown path for every tab. A reload is the honest option for a rare,
 * deliberately-confirmed action: one code path, no stale cache can survive it.
 *
 * Why strip `host`: that param force-selects a universe even when it has no
 * data (index.js `resolveInitialUniverse`, so a freshly-opened server still
 * shows up), which would resurrect the deleted id as an empty placeholder in
 * the selector right after we removed it. The active TAB survives regardless —
 * it is remembered in localStorage, so the reload lands back on Sync.
 *
 * @param {string} deletedUniverseId
 * @returns {void}
 */
const reloadAfterPurge = (deletedUniverseId) => {
  const url = new URL(location.href);
  if (url.searchParams.get('host') === deletedUniverseId) url.searchParams.delete('host');
  location.replace(url.toString());
};

/**
 * The abandon flow's expanded panel: an archive-then-delete stepper.
 *
 * Shape of the gate — deletion is unreachable until BOTH hold:
 *   1. `flow.archive` is set, i.e. {@link exportAllData} in archive mode
 *      resolved and the browser took the file. That is as close to "the user
 *      has a backup" as a web page can verify; we cannot read the filesystem,
 *      so a completed download is the strongest available evidence.
 *   2. The typed text equals the universe id EXACTLY. The panel shows totals
 *      for one server while the page lists several — typing the id is what
 *      makes "which one?" impossible to get wrong on a phone.
 *
 * Everything the user needs to judge the decision is on-screen text (size,
 * category count, what the archive omits, the gist caveat) — never a
 * `title=` tooltip, which does not exist on touch.
 *
 * @param {UniverseInventory} u
 * @returns {HTMLElement}
 */
const renderAbandonPanel = (u) => {
  const flow = flowFor(u.universeId);
  const panel = el('div', 'abandon-panel');

  panel.appendChild(el(
    'div',
    'abandon-warn',
    `Deletes every OG-E record for ${u.universeId} on this device`
    + ` — ${u.categories.length} categories, ${formatBytes(u.totalBytes)}. No undo.`,
  ));

  // ── Step 1: the archive (the undo) ──────────────────────────────────
  const step1 = el('div', 'abandon-step');
  const archiveBtn = /** @type {HTMLButtonElement} */ (el('button', 'abandon-archive', 'Archive'));
  archiveBtn.type = 'button';
  archiveBtn.disabled = flow.busy;
  const archiveState = el(
    'span',
    flow.archive ? 'abandon-state ok' : 'abandon-state',
    flow.archive
      ? `${flow.archive.datasets} ${flow.archive.datasets === 1 ? 'dataset' : 'datasets'},`
        + ` ${formatBytes(flow.archive.bytes)} downloaded`
      : 'required first',
  );
  archiveBtn.addEventListener('click', () => {
    flow.busy = true;
    flow.error = '';
    void render();
    void exportAllData(u.universeId, { archive: true })
      .then((res) => { flow.archive = res; })
      .catch((err) => { flow.error = `Archive failed: ${String(err)}`; })
      .finally(() => { flow.busy = false; void render(); });
  });
  step1.appendChild(archiveBtn);
  step1.appendChild(archiveState);
  panel.appendChild(step1);

  // ── Step 2: the delete, locked until step 1 succeeded ───────────────
  const step2 = el('div', 'abandon-step');
  const confirmInput = /** @type {HTMLInputElement} */ (el('input', 'abandon-confirm'));
  confirmInput.type = 'text';
  confirmInput.placeholder = u.universeId;
  confirmInput.value = flow.typed;
  confirmInput.autocomplete = 'off';
  confirmInput.spellcheck = false;
  confirmInput.disabled = !flow.archive || flow.busy;
  const deleteBtn = /** @type {HTMLButtonElement} */ (el('button', 'abandon-delete', 'Delete'));
  deleteBtn.type = 'button';
  const syncDeleteState = () => {
    deleteBtn.disabled = !flow.archive || flow.busy || flow.typed !== u.universeId;
  };
  confirmInput.addEventListener('input', () => {
    flow.typed = confirmInput.value;
    syncDeleteState();
  });
  syncDeleteState();
  deleteBtn.addEventListener('click', () => {
    // Belt and braces: the button is disabled in both failure cases, but this
    // function deletes a universe — it re-checks rather than trusting the DOM.
    if (!flow.archive || flow.typed !== u.universeId || flow.busy) return;
    flow.busy = true;
    flow.error = '';
    void render();
    void purgeUniverseData(u.universeId)
      .then(() => { reloadAfterPurge(u.universeId); })
      .catch((err) => {
        flow.busy = false;
        flow.error = `Delete failed: ${String(err)}`;
        void render();
      });
  });
  step2.appendChild(confirmInput);
  step2.appendChild(deleteBtn);
  panel.appendChild(step2);
  if (!flow.archive) {
    panel.appendChild(el('div', 'abandon-note', 'Delete unlocks once the archive is downloaded.'));
  }
  if (flow.error) panel.appendChild(el('div', 'sync-err', flow.error));

  // ── Disclosure: what the archive does NOT carry, and what deleting
  //    locally does NOT reach. Both are on-screen, not tooltips. ───────
  const omits = el('div', 'abandon-note');
  omits.appendChild(el('div', 'abandon-note-head', 'Not in the archive'));
  const list = el('ul', 'abandon-omits');
  for (const line of ARCHIVE_OMITS) list.appendChild(el('li', null, line));
  omits.appendChild(list);
  panel.appendChild(omits);
  panel.appendChild(el(
    'div',
    'abandon-note',
    'Cloud sync keeps its own copy: reopening this server with sync on restores'
    + ' whatever the gist still holds. Frees space here, not everywhere.',
  ));
  panel.appendChild(el(
    'div',
    'abandon-note',
    'Restore later: pick the server in the selector, then Import the archive file.',
  ));

  return panel;
};

/**
 * Build one universe's card: header (id + freshness chip), the ↑/↓ status
 * line (+ error), and the inventory table with a total row.
 *
 * @param {UniverseInventory} u
 * @param {number} now  Epoch-ms for the freshness calc.
 * @returns {HTMLElement}
 */
const renderUniverseCard = (u, now) => {
  const card = el('div', 'sync-card');

  const head = el('div', 'sync-card-head');
  head.appendChild(el('span', 'sync-universe', u.universeId));
  const fresh = classifySyncFreshness(u.status, now);
  head.appendChild(el('span', `sync-chip sync-chip-${fresh.tone}`, fresh.label));
  card.appendChild(head);

  const status = u.status || {};
  const line = el('div', 'sync-status-line');
  line.appendChild(el('span', null, `↑ ${fmtTime(status.up)}`));
  line.appendChild(el('span', null, `↓ ${fmtTime(status.down)}`));
  card.appendChild(line);
  if (status.err) card.appendChild(el('div', 'sync-err', `⚠ ${status.err}`));

  if (u.categories.length) {
    const table = el('table', 'sync-table');

    const thead = el('thead');
    const htr = el('tr');
    htr.appendChild(el('th', null, 'Category'));
    htr.appendChild(el('th', 'num', 'Items'));
    htr.appendChild(el('th', 'num', 'Size'));
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const c of u.categories) {
      const tr = el('tr');
      const labelTd = el('td', null, c.label);
      // Keyword tag, not a sentence: 'local' = never leaves this device (a
      // re-fetchable cache or per-device data); 'partial' = only a subset
      // rides the gist. Fully-synced rows carry no tag — synced is the
      // expected state on a tab named "Sync", so only the exceptions speak.
      if (c.sync !== 'synced') {
        labelTd.appendChild(el('span', `sync-tag sync-tag-${c.sync}`, c.sync));
      }
      tr.appendChild(labelTd);
      tr.appendChild(el('td', 'num', c.count == null ? '—' : String(c.count)));
      tr.appendChild(el('td', 'num', formatBytes(c.bytes)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Split totals: the gist payload is built ONLY from the synced rows, so a
    // multi-MB local cache (API cache) must not read as "this much is synced".
    const tfoot = el('tfoot');
    const syncedTr = el('tr');
    syncedTr.appendChild(el('td', null, 'Synced'));
    syncedTr.appendChild(el('td', 'num', ''));
    syncedTr.appendChild(el('td', 'num', formatBytes(u.syncedBytes)));
    tfoot.appendChild(syncedTr);
    const localTr = el('tr');
    localTr.appendChild(el('td', null, 'Local only'));
    localTr.appendChild(el('td', 'num', ''));
    localTr.appendChild(el('td', 'num', formatBytes(u.localBytes)));
    tfoot.appendChild(localTr);
    const ftr = el('tr');
    ftr.appendChild(el('td', null, 'Total'));
    ftr.appendChild(el('td', 'num', ''));
    ftr.appendChild(el('td', 'num', formatBytes(u.totalBytes)));
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    card.appendChild(table);
  }

  // Abandon: the per-universe escape hatch for a server you stopped playing.
  // Lives on THIS card because the card is where the size that motivates it is
  // already shown — and because the Sync tab is the one cross-universe view,
  // so it needs no coupling to the universe selector.
  const foot = el('div', 'abandon-foot');
  const toggle = /** @type {HTMLButtonElement} */ (
    el('button', 'abandon-toggle', abandonOpenFor === u.universeId ? 'Cancel' : 'Abandon')
  );
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    if (abandonOpenFor === u.universeId) {
      // Cancel discards the half-finished confirmation, NOT the archive fact:
      // a user who downloaded and then reconsidered should not have to
      // re-download if they reopen the panel in the same session.
      abandonOpenFor = '';
      flowFor(u.universeId).typed = '';
    } else {
      abandonOpenFor = u.universeId;
    }
    void render();
  });
  foot.appendChild(toggle);
  card.appendChild(foot);
  if (abandonOpenFor === u.universeId) card.appendChild(renderAbandonPanel(u));

  return card;
};

/** Read the storage snapshot and repaint the whole Sync body. */
const render = async () => {
  if (!bodyEl) return;
  const all = await chromeStore.getAll();
  const inventory = buildSyncInventory(/** @type {Record<string, unknown>} */ (all));
  bodyEl.textContent = '';
  if (inventory.length === 0) {
    bodyEl.appendChild(el('p', 'sync-empty', 'No synced data on this device yet.'));
    return;
  }
  const now = Date.now();
  for (const u of inventory) bodyEl.appendChild(renderUniverseCard(u, now));
};

/**
 * Mount the Sync tab. Self-rendering + self-subscribing (cross-universe, so it
 * needs no universe getter). Re-renders when any per-universe key changes —
 * a fresh sync updates both the data slices and the `<id>:oge_syncStatus`
 * mirror, both of which match the `:oge_` test.
 *
 * @returns {{ refresh: () => void }}
 */
export const installSync = () => {
  bodyEl = document.getElementById('syncBody');
  void render();
  chromeStore.onChanged((changes) => {
    if (!Object.keys(changes).some((k) => k.includes(':oge_'))) return;
    if (renderTimer != null) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; void render(); }, 300);
  });
  return { refresh: () => { void render(); } };
};

/**
 * Test-only reset for this module's scope: the mount point, the pending
 * repaint timer, and — the reason this exists — the ABANDON flow state
 * (`abandonOpenFor` + `abandonFlows`). Production never needs it: the Sync tab
 * mounts once per page load, and a purge reloads the page.
 *
 * Between vitest cases it is required, not cosmetic: a leaked
 * `abandonOpenFor` makes the next case's first toggle CLOSE the panel instead
 * of opening it, and a leaked `flow.archive` would let a test see the delete
 * control already unlocked — i.e. the suite would stop testing the gate.
 *
 * @returns {void}
 */
export const _resetSyncForTest = () => {
  bodyEl = null;
  if (renderTimer != null) clearTimeout(renderTimer);
  renderTimer = null;
  abandonOpenFor = '';
  abandonFlows.clear();
};
