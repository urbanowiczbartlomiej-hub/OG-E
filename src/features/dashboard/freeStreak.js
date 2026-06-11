// @ts-check

// Settlement-regions renderer — paints the "Free positions" block that
// lives INSIDE the Galaxy Observations tab (it was a tab of its own up
// to 1.17.0; folded in so the mobile tab bar fits one line). Shows a
// top-N table of the best confirmed-empty regions per galaxy and a
// record-line summary.
//
// Pure DOM module. Every node is built with `document.createElement`,
// classes match the rules in `dashboard.html`, and no chrome.storage
// or network access happens here. Data flow is owned by the caller
// (the page entry in `features/dashboard/index.js`):
//
//   1. The page selects a universe and loads its `scans` map.
//   2. The page parses the positions input + tolerance select.
//   3. The page calls `renderFreeRegions({ ..., scans, positions, maxGaps })`.
//   4. This module runs `findBestRegions` and paints the section.
//
// Re-rendering on a control change is the caller's job too — it hooks
// the `change` events and re-calls `renderFreeRegions`.
//
// # Generalised search (post-1.17.0 feedback)
//
// The block accepts a positions LIST/RANGE (a system matches only when
// every requested slot is confirmed empty) and a gap TOLERANCE (a region
// may bridge up to N non-matching systems instead of demanding a perfect
// streak). Defaults — single slot 15, zero gaps — reproduce the original
// Free_15_position behaviour exactly, so the simple view stays simple.
//
// @see ../../domain/regions.js — findBestRegions (pure analyzer)

import { findBestRegions } from '../../domain/regions.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../domain/regions.js').Region} Region
 */

/**
 * Maximum number of rows shown in the regions table. Matches the "TOP
 * 20" cap from the original `Free_15_position.html` tool — long enough
 * to cover all interesting candidates in a fully-scanned universe,
 * short enough to render fast and stay scannable.
 */
const TOP_N = 20;

/**
 * Build a `<table class="streak-table">` with one row per region up to
 * `TOP_N`. The table is structurally simple — header + tbody — so we
 * skip a render diff and rebuild from scratch every call. With at
 * most {@link TOP_N} rows this is comfortably under a millisecond.
 *
 * @param {Region[]} results
 * @returns {HTMLTableElement}
 */
const buildTable = (results) => {
  const table = document.createElement('table');
  table.className = 'streak-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['#', 'Galaxy', 'Start', 'End', 'Length', 'Free', 'Gaps']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label !== 'Galaxy') th.style.textAlign = 'right';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const top = results.slice(0, TOP_N);
  top.forEach((r, i) => {
    const tr = document.createElement('tr');
    /** @type {[string, boolean][]} */
    const cells = [
      [String(i + 1), true],
      [String(r.galaxy), false],
      [String(r.start), true],
      [String(r.end), true],
      [String(r.length), true],
      [String(r.matched), true],
      [r.gaps ? String(r.gaps) : '—', true],
    ];
    for (const [text, isNum] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (isNum) td.className = 'num';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  return table;
};

/**
 * Build the "record" summary card shown below the table — the single
 * best region across all galaxies, with its coordinates, span and
 * blemish count. Returned as a `<div>` ready to be appended; not
 * appended when `results` is empty (the caller paints an empty-state
 * message instead).
 *
 * @param {Region} record
 * @returns {HTMLElement}
 */
const buildRecord = (record) => {
  const el = document.createElement('div');
  el.className = 'streak-record';

  const labelLine = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Absolute record: ';
  const value = document.createElement('span');
  value.className = 'value';
  value.textContent = `${record.length} systems`;
  labelLine.append(label, value);

  const detailLine = document.createElement('div');
  detailLine.style.color = '#888';
  detailLine.style.fontSize = '12px';
  detailLine.style.marginTop = '4px';
  detailLine.textContent =
    `Galaxy ${record.galaxy}, system ${record.start} → ${record.end}`
    + (record.gaps ? ` (${record.matched} free, ${record.gaps} gap${record.gaps === 1 ? '' : 's'})` : '')
    + (record.end < record.start ? ' (wraps across the 499 → 1 boundary)' : '');
  el.append(labelLine, detailLine);

  return el;
};

/**
 * @typedef {object} RenderFreeRegionsOptions
 * @property {HTMLElement} containerEl
 *   Target wrapper — `#freeContainer` in dashboard.html. Cleared and
 *   repainted on each call.
 * @property {HTMLElement | null} countInfoEl
 *   Optional `<span>` to update with a "N regions across M galaxies"
 *   summary. `null` skips that update — supplied for `#freeCountInfo`
 *   in production, omitted in unit tests that only care about the table.
 * @property {GalaxyScans} scans
 *   Same map the rest of the dashboard reads.
 * @property {number[]} positions
 *   Slots that must ALL be empty — parsed by the caller from the
 *   positions input (`parseTargetPositions` grammar).
 * @property {number} maxGaps
 *   Non-matching systems tolerated inside a region (0 = perfect streak).
 */

/**
 * Repaint the settlement-regions block against `scans` for the requested
 * slots + tolerance. Owns the empty-state branch: when nothing matched,
 * the table area gets a single `.empty`-class line and no record card.
 *
 * @param {RenderFreeRegionsOptions} opts
 * @returns {void}
 */
export const renderFreeRegions = ({ containerEl, countInfoEl, scans, positions, maxGaps }) => {
  containerEl.innerHTML = '';

  const results = findBestRegions(scans, { positions, status: 'empty', maxGaps });
  const posLabel = positions.join(', ');

  if (countInfoEl) {
    const galaxyCount = new Set(results.map((r) => r.galaxy)).size;
    countInfoEl.textContent = results.length === 0
      ? 'No confirmed empty regions yet for these slots.'
      : `${results.length} region${results.length === 1 ? '' : 's'} across `
        + `${galaxyCount} galax${galaxyCount === 1 ? 'y' : 'ies'}`;
  }

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'Nothing to show yet. Scan more galaxy pages with slot'
      + (positions.length === 1 ? '' : 's') + ' ' + posLabel
      + ' empty, then come back here.';
    containerEl.appendChild(empty);
    return;
  }

  containerEl.appendChild(buildTable(results));
  // The record is just the first item of the already-sorted list —
  // results are sorted best-first in findBestRegions.
  containerEl.appendChild(buildRecord(results[0]));
};
