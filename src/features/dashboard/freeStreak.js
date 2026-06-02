// @ts-check

// Free-positions renderer — populates the "Free Positions" tab of the
// histogram page with a position selector, a top-N table of confirmed
// empty runs, and a record-line summary.
//
// Pure DOM module. Every node is built with `document.createElement`,
// classes match the rules in `dashboard.html`, and no chrome.storage
// or network access happens here. Data flow is owned by the caller
// (the page entry in `features/dashboard/index.js`):
//
//   1. The page selects a universe and loads its `scans` map.
//   2. The page reads `freePosSelect.value` for the chosen slot.
//   3. The page calls `renderFreeStreak({ ..., scans, position })`.
//   4. This module runs `findLongestStreaks` and paints the section.
//
// Re-rendering on a position-selector change is the caller's job too —
// we expose a `populatePositionOptions` helper for the initial seeding,
// then the caller hooks the `change` event and re-calls `renderFreeStreak`.
//
// # Why generic in position + status under the hood
//
// The v1.2.0 UI only exposes the position selector; `status` is fixed
// to `'empty'` (matching the original Free_15_position tool that
// motivated the feature). Keeping the underlying `findLongestStreaks`
// generic in status means future tabs ("inactive farm runs", etc.)
// reuse the same domain primitive — no rewrite, just a new renderer
// that picks a different status.
//
// @see ../../domain/freeStreak.js — findLongestStreaks (pure analyzer)

import { findLongestStreaks } from '../../domain/freeStreak.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../domain/freeStreak.js').Streak} Streak
 */

/**
 * Number of slot positions (planet slots 1..15 in an OGame system).
 * Hard-coded because OGame's universe constant has been 15 since the
 * game launched; if it ever changes, this is the single place to bump.
 */
const POSITIONS = 15;

/**
 * Maximum number of rows shown in the streaks table. Matches the "TOP
 * 20" cap from the original `Free_15_position.html` tool — long enough
 * to cover all interesting candidates in a fully-scanned universe,
 * short enough to render fast and stay scannable.
 */
const TOP_N = 20;

/**
 * Populate the slot-position `<select>` once at page boot. Builds
 * options 1..{@link POSITIONS} with `15` pre-selected — the most
 * common colonisation slot and the default the feature inherits
 * from the original tool.
 *
 * Idempotent: a second call wipes existing options first so the
 * select stays at 15 numeric entries (matters for the test setup
 * where the page might be re-bootstrapped).
 *
 * @param {HTMLSelectElement} selectEl
 * @returns {void}
 */
export const populatePositionOptions = (selectEl) => {
  selectEl.innerHTML = '';
  for (let i = 1; i <= POSITIONS; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    if (i === POSITIONS) opt.selected = true;
    selectEl.appendChild(opt);
  }
};

/**
 * Build a `<table class="streak-table">` with one row per result up to
 * `TOP_N`. The table is structurally simple — header + tbody — so we
 * skip a render diff and rebuild from scratch every call. With at
 * most {@link TOP_N} rows this is comfortably under a millisecond.
 *
 * @param {Streak[]} results
 * @returns {HTMLTableElement}
 */
const buildTable = (results) => {
  const table = document.createElement('table');
  table.className = 'streak-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['#', 'Galaxy', 'Start', 'End', 'Length']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label === '#' || label === 'Length' || label === 'Start' || label === 'End') {
      th.style.textAlign = 'right';
    }
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
 * longest run across all galaxies, with its coordinates and length.
 * Returned as a `<div>` ready to be appended; not appended when
 * `results` is empty (the caller paints an empty-state message
 * instead).
 *
 * @param {Streak} record
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
    `Galaxy ${record.galaxy}, system ${record.start} → ${record.end}` +
    (record.end < record.start ? ' (wraps across the 499 → 1 boundary)' : '');
  el.append(labelLine, detailLine);

  return el;
};

/**
 * @typedef {object} RenderFreeStreakOptions
 * @property {HTMLElement} containerEl
 *   Target wrapper — typically `#freeContainer` in dashboard.html.
 *   Cleared and repainted on each call.
 * @property {HTMLElement | null} countInfoEl
 *   Optional `<span>` to update with a "Found N runs across M galaxies"
 *   summary. `null` skips that update — supplied for `#freeCountInfo`
 *   in production, omitted in unit tests that only care about the
 *   table.
 * @property {GalaxyScans} scans
 *   Same map the rest of the histogram reads.
 * @property {number} position
 *   Slot to analyse — 1..15. Comes from the position-selector value.
 */

/**
 * Repaint the Free Positions section against `scans` for the requested
 * `position`. Owns the empty-state branch: when nothing matched, the
 * table area gets a single `.empty`-class line and no record card.
 *
 * @param {RenderFreeStreakOptions} opts
 * @returns {void}
 */
export const renderFreeStreak = ({ containerEl, countInfoEl, scans, position }) => {
  containerEl.innerHTML = '';

  const results = findLongestStreaks(scans, { position, status: 'empty' });

  if (countInfoEl) {
    const galaxyCount = new Set(results.map((r) => r.galaxy)).size;
    countInfoEl.textContent = results.length === 0
      ? 'No confirmed empty runs yet for this slot.'
      : `${results.length} run${results.length === 1 ? '' : 's'} across `
        + `${galaxyCount} galax${galaxyCount === 1 ? 'y' : 'ies'}`;
  }

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'Nothing to show yet. Scan more galaxy pages with slot '
      + position + ' empty, then come back here.';
    containerEl.appendChild(empty);
    return;
  }

  containerEl.appendChild(buildTable(results));
  // The record is just the first item of the already-sorted list —
  // results are sorted by length descending in findLongestStreaks.
  containerEl.appendChild(buildRecord(results[0]));
};
