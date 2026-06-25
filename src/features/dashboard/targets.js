// @ts-check

// Targets sub-tab renderer (dashboard, "Colonizations" section). Pure DOM
// factory: given the joined candidate list + the active-target filter options,
// it filters/sorts via the pure domain `buildTargetList` and paints a ranked
// table. Read-only and self-contained (inline styles in the dashboard's dark
// palette) — the hidden-fleet column is a placeholder until espionage-report
// ingestion lands (Milestone 2).

import { buildTargetList } from '../../domain/targets.js';

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
 * Build one header cell.
 * @param {string} text
 * @param {string} [align]
 * @returns {HTMLTableCellElement}
 */
function headCell(text, align) {
  const th = document.createElement('th');
  th.textContent = text;
  th.style.textAlign = align || 'left';
  th.style.color = '#888';
  th.style.fontWeight = 'normal';
  th.style.padding = '6px 8px';
  th.style.borderBottom = '1px solid #333';
  th.style.whiteSpace = 'nowrap';
  return th;
}

/**
 * Build the hidden-fleet cell from a per-player estimate, or the not-spied
 * placeholder when we have no reports for that player. Shows the estimated
 * hidden points, then a muted coverage suffix ("spied/total", ⏱ = provisional),
 * with the full breakdown in the cell tooltip.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate | undefined} est
 * @returns {HTMLTableCellElement}
 */
function hiddenCell(est) {
  if (!est) return cell('— not spied', { align: 'right', color: '#666' });
  const hidden = Math.round(est.hiddenFleetPoints);
  const td = cell('', { align: 'right' });
  const val = document.createElement('span');
  val.textContent = fmt(hidden);
  val.style.color = hidden > 0 ? '#e3e3e3' : '#666';
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
 * Render the ranked target table into `containerEl`.
 * @param {object} args
 * @param {HTMLElement} args.containerEl
 * @param {TargetCandidate[]} args.candidates   Full joined candidate list.
 * @param {TargetFilterOptions} args.opts        Active-target filter options.
 * @param {number} [args.limit]                  Max rows to display (0 = all).
 * @param {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} [args.estimates]
 *   Per-player hidden-fleet estimate (keyed playerId), for players with reports.
 * @param {HTMLElement | null} [args.countInfoEl]
 * @returns {void}
 */
export function renderTargets({ containerEl, candidates, opts, limit = 0, estimates, countInfoEl }) {
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

  const list = buildTargetList(candidates, opts);
  const shown = limit > 0 ? list.slice(0, limit) : list;

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '13px';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(headCell('#', 'right'));
  hr.appendChild(headCell('Player'));
  hr.appendChild(headCell('Rank', 'right'));
  hr.appendChild(headCell('Points', 'right'));
  hr.appendChild(headCell('Military', 'right'));
  hr.appendChild(headCell('Mil. rank', 'right'));
  hr.appendChild(headCell('Hidden fleet', 'right'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let i = 0;
  for (const c of shown) {
    i += 1;
    const tr = document.createElement('tr');
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
    tr.appendChild(hiddenCell(estimates ? estimates[c.id] : undefined));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  containerEl.appendChild(table);

  if (countInfoEl) {
    countInfoEl.textContent = `${list.length} targets in range · showing ${shown.length}`;
  }
}
