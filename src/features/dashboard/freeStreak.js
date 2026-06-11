// @ts-check

// Settlement-regions renderer — paints the "Free positions" block that
// lives INSIDE the Galaxy Observations tab (it was a tab of its own up
// to 1.17.0; folded in so the mobile tab bar fits one line). Shows a
// top-N table of the best confirmed-empty regions per galaxy and a
// record-line summary with neighbourhood intel.
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
// # Neighbourhood scoring (post-1.17.x feedback)
//
// `findBestRegions` now attaches a `score` object to every region that
// summarises the players seen in the range: active/inactive counts, rank
// distribution, bandit / honour flags, alliance presence. The top region's
// record card renders this as a line of stats plus a pixel-strip showing
// each system in the range coloured by its dominant status.
//
// @see ../../domain/regions.js — findBestRegions / scoreRegion (pure)

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
 * Map a system's position map to a background colour for the strip.
 * Priority: mine > occupied > inactive/long_inactive > vacation > unscanned >
 * empty. Called once per system cell.
 *
 * @param {Region['score']} _score unused (reserved for future per-cell rank tint)
 * @param {import('../../state/scans.js').SystemScan['positions'] | undefined} positions
 * @returns {string} CSS colour string.
 */
const systemColor = (_score, positions) => {
  if (!positions) return '#1e1e1e'; // unscanned — dark neutral
  const statuses = Object.values(positions).map((p) => p.status);
  if (statuses.includes('mine')) return '#4466cc';           // our colony — blue
  if (statuses.includes('occupied')) return '#b83010';       // active player — red
  if (statuses.some((s) => s === 'inactive' || s === 'long_inactive')) return '#775500'; // dormant — amber
  if (statuses.includes('vacation')) return '#1a4477';       // vacation — navy
  return '#0a4420';                                          // empty/abandoned — dark green
};

/**
 * Build a pixel-strip `<div>` visualising every system in the region.
 * One cell per system, coloured by dominant status. Long regions (100+
 * systems) use 1px-min cells so the strip never overflows its container.
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @returns {HTMLElement}
 */
const buildStrip = (region, scans) => {
  const el = document.createElement('div');
  el.className = 'region-strip';

  const galaxyMax = 499;
  const systems = [];
  if (region.end >= region.start) {
    for (let s = region.start; s <= region.end; s++) systems.push(s);
  } else {
    for (let s = region.start; s <= galaxyMax; s++) systems.push(s);
    for (let s = 1; s <= region.end; s++) systems.push(s);
  }

  for (const sys of systems) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    const cell = document.createElement('span');
    cell.className = 'strip-cell';
    cell.style.backgroundColor = systemColor(region.score, sysData?.positions);
    cell.title = `S${sys}`;
    el.appendChild(cell);
  }

  return el;
};

/**
 * Build a `<table class="streak-table">` with one row per region up to
 * `TOP_N`. The "Nbrs" column shows the total player count (active +
 * inactive) derived from the region's neighbourhood score — a quick
 * signal of how crowded the area is. '?' means no scan data in range.
 *
 * @param {Region[]} results
 * @returns {HTMLTableElement}
 */
const buildTable = (results) => {
  const table = document.createElement('table');
  table.className = 'streak-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [label, title] of [
    ['#', ''],
    ['Galaxy', ''],
    ['Start', ''],
    ['End', ''],
    ['Length', 'Total systems spanned (including gap systems)'],
    ['Free', 'Systems where every requested slot is confirmed empty'],
    ['Gaps', 'Non-matching systems tolerated inside the region'],
    ['Nbrs', 'Players seen in range (active + dormant) — neighbourhood crowdedness'],
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    if (title) th.title = title;
    if (label !== 'Galaxy') th.style.textAlign = 'right';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.slice(0, TOP_N).forEach((r, i) => {
    const tr = document.createElement('tr');
    const s = r.score;
    const nbrs = s ? String(s.occupied + s.inactive) : '?';
    /** @type {[string, boolean, string][]} */
    const cells = [
      [String(i + 1), true, ''],
      [String(r.galaxy), false, ''],
      [String(r.start), true, ''],
      [String(r.end), true, ''],
      [String(r.length), true, ''],
      [String(r.matched), true, ''],
      [r.gaps ? String(r.gaps) : '—', true, ''],
      [nbrs, true, s ? `${s.occupied} active, ${s.inactive} inactive (${s.scanned}/${s.systemCount} scanned)` : 'No scan data in range'],
    ];
    for (const [text, isNum, tip] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (isNum) td.className = 'num';
      if (tip) td.title = tip;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  return table;
};

/**
 * Build the "record" summary card shown below the table — the single
 * best region across all galaxies, with its coordinates, span, blemish
 * count, neighbourhood stats and a pixel strip of the range. Not
 * appended when `results` is empty.
 *
 * @param {Region} record
 * @param {GalaxyScans} scans
 * @returns {HTMLElement}
 */
const buildRecord = (record, scans) => {
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

  const s = record.score;
  if (s) {
    const scoreLine = document.createElement('div');
    scoreLine.className = 'streak-score';
    const coverage = s.scanned === s.systemCount ? `all ${s.systemCount}` : `${s.scanned}/${s.systemCount}`;
    const parts = [`${coverage} sys scanned`];
    if (s.occupied || s.inactive) {
      parts.push(`${s.occupied} active · ${s.inactive} dormant`);
    }
    if (s.allianceCount) {
      parts.push(`${s.allianceCount} alliance${s.allianceCount > 1 ? 's' : ''}`);
    }
    if (s.bandits || s.honored) {
      const honor = [];
      if (s.bandits) honor.push(`${s.bandits} bandit${s.bandits > 1 ? 's' : ''}`);
      if (s.honored) honor.push(`${s.honored} honored`);
      parts.push(honor.join(', '));
    }
    if (s.ranks.length) {
      parts.push(`top neighbour rank #${s.ranks[0]}`);
    }
    scoreLine.textContent = parts.join(' · ');
    el.appendChild(scoreLine);

    el.appendChild(buildStrip(record, scans));
  }

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
  containerEl.appendChild(buildRecord(results[0], scans));
};
