// @ts-check

// Targets sub-tab renderer (dashboard, "Colonizations" section). Pure DOM
// factory: given the joined candidate list + the active-target filter options,
// it filters via the pure domain `buildTargetList`, re-sorts by the active
// column via `sortTargetList`, and paints a ranked table. The hidden-fleet
// column carries the per-player estimate (from espionage-report ingestion) and
// is heat-coloured by magnitude; its header (plus Rank / Military) is a
// clickable sort control. Read-only and self-contained (inline styles in the
// dashboard's dark palette).

import { buildTargetList, sortTargetList } from '../../domain/targets.js';
import { heatColor } from './palette.js';

/**
 * @typedef {'hiddenFleet'|'military'|'totalRank'} TargetSortKey
 * @typedef {{ key: TargetSortKey, dir: 'asc'|'desc' }} TargetSort
 */

/** Default sort: biggest known hidden fleet first. @type {TargetSort} */
export const DEFAULT_TARGET_SORT = { key: 'hiddenFleet', dir: 'desc' };

/**
 * @typedef {import('../../domain/targets.js').TargetCandidate} TargetCandidate
 * @typedef {import('../../domain/targets.js').TargetFilterOptions} TargetFilterOptions
 */

/**
 * Group-format a number, or '—' when absent.
 * @param {number|undefined} n
 * @returns {string}
 */
function fmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('pl-PL') : '—';
}

/**
 * Build one body cell.
 * @param {string} text
 * @param {{ align?: string, color?: string }} [opts]
 * @returns {HTMLTableCellElement}
 */
function cell(text, opts = {}) {
  const td = document.createElement('td');
  td.textContent = text;
  td.style.padding = '6px 8px';
  td.style.borderBottom = '1px solid #222';
  td.style.whiteSpace = 'nowrap';
  if (opts.align) td.style.textAlign = opts.align;
  if (opts.color) td.style.color = opts.color;
  return td;
}

/**
 * Build one header cell. When `opts.sortKey` + `opts.onSort` are given the
 * header becomes a clickable sort control: it shows a ▲/▼ arrow and brightens
 * while it's the active sort, and a click hands its key back to the caller
 * (which decides the new direction, persists it, and repaints).
 * @param {string} text
 * @param {string} [align]
 * @param {{ sortKey?: TargetSortKey, sort?: TargetSort, onSort?: (key: TargetSortKey) => void }} [opts]
 * @returns {HTMLTableCellElement}
 */
function headCell(text, align, opts = {}) {
  const th = document.createElement('th');
  th.style.textAlign = align || 'left';
  th.style.color = '#888';
  th.style.fontWeight = 'normal';
  th.style.padding = '6px 8px';
  th.style.borderBottom = '1px solid #333';
  th.style.whiteSpace = 'nowrap';
  if (opts.sortKey && opts.onSort) {
    const { sortKey, sort, onSort } = opts;
    const active = sort != null && sort.key === sortKey;
    th.dataset.sortKey = sortKey;
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.textContent = text + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
    if (active) th.style.color = '#bbb';
    th.title = `Sort by ${text.toLowerCase()}`;
    th.addEventListener('click', () => onSort(sortKey));
  } else {
    th.textContent = text;
  }
  return th;
}

/**
 * Build the hidden-fleet cell from a per-player estimate, or the not-spied
 * placeholder when we have no reports for that player. Shows the estimated
 * hidden points, then a muted coverage suffix ("spied/total", ⏱ = provisional),
 * with the full breakdown in the cell tooltip.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate | undefined} est
 * @param {number} maxHidden   Largest hidden-fleet estimate in view (for the heat ramp).
 * @returns {HTMLTableCellElement}
 */
function hiddenCell(est, maxHidden) {
  if (!est) return cell('— not spied', { align: 'right', color: '#666' });
  const hidden = Math.round(est.hiddenFleetPoints);
  const td = cell('', { align: 'right' });
  const val = document.createElement('span');
  val.textContent = fmt(hidden);
  // Heat by magnitude: grey for ~0, saturating to red for the biggest fleet in
  // view. heatColor's negative half (0 → −1) is exactly that grey→red ramp.
  const frac = maxHidden > 0 ? Math.max(0, Math.min(1, hidden / maxHidden)) : 0;
  val.style.color = hidden > 0 ? heatColor(-frac) : '#666';
  const cov = document.createElement('span');
  const denom = typeof est.planetCount === 'number' ? `/${est.planetCount}` : '';
  cov.textContent = ` ${est.spiedCount}${denom}${est.provisional ? ' ⏱' : ''}`;
  cov.style.color = '#888';
  cov.style.fontSize = '11px';
  td.appendChild(val);
  td.appendChild(cov);
  td.title =
    `military ${fmt(est.militaryPoints)} − defense ${fmt(Math.round(est.defensePoints))} `
    + `− visible fleet ${fmt(Math.round(est.visibleFleetPoints))}`
    + (est.provisional ? ' · coverage incomplete (provisional)' : '');
  return td;
}

/**
 * Build the ⭐ watch-toggle cell. Filled gold star = watched, hollow grey =
 * not; clicking flips it (the caller persists the set + repaints).
 * @param {string} id
 * @param {boolean} watched
 * @param {(id: string) => void} [onToggle]
 * @returns {HTMLTableCellElement}
 */
function starCell(id, watched, onToggle) {
  const td = cell('', { align: 'center' });
  const star = document.createElement('span');
  star.textContent = watched ? '★' : '☆';
  star.style.color = watched ? '#e0c060' : '#555';
  star.style.cursor = 'pointer';
  star.style.userSelect = 'none';
  star.title = watched ? 'Remove from watch-list' : 'Add to watch-list';
  if (onToggle) star.addEventListener('click', () => onToggle(id));
  td.appendChild(star);
  return td;
}

/**
 * Render the ranked target table into `containerEl`.
 * @param {object} args
 * @param {HTMLElement} args.containerEl
 * @param {TargetCandidate[]} args.candidates   Full joined candidate list.
 * @param {TargetFilterOptions} args.opts        Active-target filter options.
 * @param {number} [args.limit]                  Max rows to display (0 = all).
 * @param {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} [args.estimates]
 *   Per-player hidden-fleet estimate (keyed playerId), for players with reports.
 * @param {TargetSort} [args.sort]               Active column sort (default: hidden fleet desc).
 * @param {(key: TargetSortKey) => void} [args.onSort]  Click handler for a sortable header.
 * @param {Set<string>} [args.watchedIds]        Starred player ids (watch-list).
 * @param {(id: string) => void} [args.onToggleWatch]   Star-click handler.
 * @param {boolean} [args.watchedOnly]           Show only starred players.
 * @param {HTMLElement | null} [args.countInfoEl]
 * @returns {void}
 */
export function renderTargets({
  containerEl,
  candidates,
  opts,
  limit = 0,
  estimates,
  sort = DEFAULT_TARGET_SORT,
  onSort,
  watchedIds,
  onToggleWatch,
  watchedOnly = false,
  countInfoEl,
}) {
  containerEl.textContent = '';

  if (!candidates || candidates.length === 0) {
    const p = document.createElement('p');
    p.style.color = '#888';
    p.style.fontSize = '13px';
    p.textContent =
      'No API data for this server yet. Open the in-game galaxy view once so OG-E can fetch '
      + 'OGame’s public statistics, then reload this page.';
    containerEl.appendChild(p);
    if (countInfoEl) countInfoEl.textContent = '';
    return;
  }

  // Hidden-fleet magnitude per id (for both the sort key and the heat ramp).
  /** @type {Record<string, number>} */
  const hiddenById = {};
  let maxHidden = 0;
  if (estimates) {
    for (const id of Object.keys(estimates)) {
      const pts = estimates[id].hiddenFleetPoints;
      if (typeof pts === 'number' && Number.isFinite(pts)) {
        hiddenById[id] = pts;
        if (pts > maxHidden) maxHidden = pts;
      }
    }
  }

  const filtered = buildTargetList(candidates, opts);
  const scoped = watchedOnly && watchedIds
    ? filtered.filter((c) => watchedIds.has(c.id))
    : filtered;
  const list = sortTargetList(scoped, sort.key, sort.dir, hiddenById);
  const shown = limit > 0 ? list.slice(0, limit) : list;

  if (watchedOnly && list.length === 0) {
    const p = document.createElement('p');
    p.style.color = '#888';
    p.style.fontSize = '13px';
    p.textContent =
      'No watched players yet — click the ☆ next to a target to add it to your watch-list.';
    containerEl.appendChild(p);
    if (countInfoEl) countInfoEl.textContent = '';
    return;
  }

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '13px';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  /** @param {TargetSortKey} key */
  const sortable = (key) => ({ sortKey: key, sort, onSort });
  hr.appendChild(headCell('★', 'center'));
  hr.appendChild(headCell('#', 'right'));
  hr.appendChild(headCell('Player'));
  hr.appendChild(headCell('Rank', 'right', sortable('totalRank')));
  hr.appendChild(headCell('Points', 'right'));
  hr.appendChild(headCell('Military', 'right', sortable('military')));
  hr.appendChild(headCell('Mil. rank', 'right'));
  hr.appendChild(headCell('Hidden fleet', 'right', sortable('hiddenFleet')));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let i = 0;
  for (const c of shown) {
    i += 1;
    const tr = document.createElement('tr');
    tr.appendChild(starCell(c.id, !!(watchedIds && watchedIds.has(c.id)), onToggleWatch));
    tr.appendChild(cell(String(i), { align: 'right', color: '#666' }));
    tr.appendChild(cell(c.name || `#${c.id}`));
    tr.appendChild(
      cell(typeof c.totalRank === 'number' ? `#${c.totalRank}` : '—', {
        align: 'right',
        color: '#888',
      }),
    );
    tr.appendChild(cell(fmt(c.totalScore), { align: 'right' }));
    tr.appendChild(cell(fmt(c.militaryScore), { align: 'right', color: '#e3e3e3' }));
    tr.appendChild(
      cell(typeof c.militaryRank === 'number' ? `#${c.militaryRank}` : '—', {
        align: 'right',
        color: '#888',
      }),
    );
    tr.appendChild(hiddenCell(estimates ? estimates[c.id] : undefined, maxHidden));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  containerEl.appendChild(table);

  if (countInfoEl) {
    const noun = watchedOnly ? 'watched' : 'targets in range';
    countInfoEl.textContent = `${list.length} ${noun} · showing ${shown.length}`;
  }
}
