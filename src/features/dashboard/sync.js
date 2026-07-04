// @ts-check
//
// Dashboard "Sync" tab — a cross-universe diagnostics view. For every universe
// with data or a recorded sync attempt it shows a freshness chip, the last
// ↑ upload / ↓ download times (plus any error / rate-limit backoff), and an
// inventory of what's stored (per category: item count + approx size, with a
// per-universe total).
//
// Cross-universe BY DESIGN: unlike the other tabs it ignores the universe
// selector — the point is to answer "what's synced where" at a glance (e.g.
// "why does my other device have half the scans"). It reads chrome.storage.local
// only; the data crunching lives in syncInventory.js (pure). The game side
// keeps the `<id>:oge_syncStatus` mirror current via sync/gist.js.

import { chromeStore } from '../../lib/storage.js';
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
      tr.appendChild(el('td', null, c.label));
      tr.appendChild(el('td', 'num', c.count == null ? '—' : String(c.count)));
      tr.appendChild(el('td', 'num', formatBytes(c.bytes)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = el('tfoot');
    const ftr = el('tr');
    ftr.appendChild(el('td', null, 'Total'));
    ftr.appendChild(el('td', 'num', ''));
    ftr.appendChild(el('td', 'num', formatBytes(u.totalBytes)));
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    card.appendChild(table);
  }

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
