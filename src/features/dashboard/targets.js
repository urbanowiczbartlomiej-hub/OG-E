// @ts-check

// Targets sub-tab renderer (dashboard, "Colonizations" section). Pure DOM
// factory: filters the joined candidate list via the pure domain
// `buildTargetList`, re-sorts by the active column via `sortTargetList`, and
// paints a ranked table. Columns split the hidden-fleet estimate into its parts
// (defense / visible fleet / hidden), plus coverage and scan-freshness readouts.
// A "scan" chip drops a player onto the in-game scan FAB's watch-list; a ↻
// re-scan flag (player- or planet-level) marks data that may have changed.
// Expanding a row lists the player's planets with per-body scan status, defense,
// and visible fleet. Read-only and self-contained (inline styles, dark palette).

import { buildTargetList, sortTargetList, playerPlanets } from '../../domain/targets.js';
import { scanStatus, rescanAtFor } from '../../domain/spyScan.js';
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
 * @typedef {import('../../domain/targets.js').PlanetPos} PlanetPos
 * @typedef {{ ts: number, defPts: number, fleetPts: number }} PlanetReport
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
 * Compact magnitude ("4.57B" / "47.9M" / "880K") — keeps the numeric columns
 * narrow. Exact values stay available in cell tooltips via {@link fmt}.
 * @param {number|undefined} n
 * @returns {string}
 */
function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

/**
 * Compact human age ("3h" / "2d" / "5w") for a millisecond span, '' if unknown.
 * @param {number} ms
 * @returns {string}
 */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = ms / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * Milliseconds since a report timestamp (epoch SECONDS), or NaN if unknown.
 * @param {number|undefined} tsSeconds
 * @param {number} nowMs
 * @returns {number}
 */
function ageMs(tsSeconds, nowMs) {
  return typeof tsSeconds === 'number' && tsSeconds > 0 ? nowMs - tsSeconds * 1000 : NaN;
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
 * header becomes a clickable sort control (▲/▼, brightens while active).
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
 * Build the "scan" chip cell (replaces the old ⭐). Outline `+ scan` = not on
 * the scan list; filled `✓ scan` = on the in-game scan FAB's watch-list. A ↻
 * appears for watched players to flag a whole-player re-scan.
 * @param {string} id
 * @param {boolean} watched
 * @param {(id: string) => void} [onToggle]
 * @param {(key: string) => void} [onRescan]
 * @returns {HTMLTableCellElement}
 */
function chipCell(id, watched, onToggle, onRescan) {
  const td = cell('');
  const chip = document.createElement('span');
  chip.textContent = watched ? '✓ scan' : '+ scan';
  chip.style.cssText =
    'display:inline-block;font-size:11px;border-radius:11px;padding:2px 9px;'
    + 'cursor:pointer;user-select:none;white-space:nowrap;';
  if (watched) {
    chip.style.background = '#16352a';
    chip.style.border = '1px solid #2f6f4f';
    chip.style.color = '#7fd6a8';
    chip.title = 'On the in-game scan list — click to remove';
  } else {
    chip.style.background = 'transparent';
    chip.style.border = '1px solid #2a3a45';
    chip.style.color = '#8b95a0';
    chip.title = 'Add to the in-game scan list';
  }
  if (onToggle) chip.addEventListener('click', () => onToggle(id));
  td.appendChild(chip);
  if (watched && onRescan) {
    const rescan = document.createElement('span');
    rescan.textContent = '↻';
    rescan.style.cssText = 'color:#6b97c4;cursor:pointer;margin-left:6px;user-select:none;';
    rescan.title = 'Flag this player for re-scan (data may have changed)';
    rescan.addEventListener('click', () => onRescan(id));
    td.appendChild(rescan);
  }
  return td;
}

/**
 * Combined total-highscore cell (rank `#88` + compact score `4.57B`; exact in
 * the tooltip). Header keeps the `totalRank` sort axis.
 * @param {TargetCandidate} c
 * @returns {HTMLTableCellElement}
 */
function highscoreCell(c) {
  const td = cell('', { align: 'right' });
  if (typeof c.totalRank !== 'number' && c.totalScore == null) {
    td.textContent = '—';
    td.style.color = '#666';
    return td;
  }
  const rank = document.createElement('span');
  rank.textContent = typeof c.totalRank === 'number' ? `#${c.totalRank}` : '#—';
  rank.style.color = '#888';
  rank.style.fontSize = '11px';
  const score = document.createElement('span');
  score.textContent = ` ${compact(c.totalScore)}`;
  score.style.color = '#cfd6dd';
  td.appendChild(rank);
  td.appendChild(score);
  td.title = `total rank ${typeof c.totalRank === 'number' ? c.totalRank : '—'} · ${fmt(c.totalScore)} points`;
  return td;
}

/**
 * Combined military cell (compact score `47.9M` + rank `#88`; exact in tooltip).
 * Header keeps the `military` sort axis.
 * @param {TargetCandidate} c
 * @returns {HTMLTableCellElement}
 */
function militaryCell(c) {
  const td = cell('', { align: 'right' });
  if (c.militaryScore == null && typeof c.militaryRank !== 'number') {
    td.textContent = '—';
    td.style.color = '#666';
    return td;
  }
  const score = document.createElement('span');
  score.textContent = compact(c.militaryScore);
  score.style.color = '#e3e3e3';
  const rank = document.createElement('span');
  rank.textContent = typeof c.militaryRank === 'number' ? ` · #${c.militaryRank}` : '';
  rank.style.color = '#888';
  rank.style.fontSize = '11px';
  td.appendChild(score);
  td.appendChild(rank);
  td.title =
    `military ${fmt(c.militaryScore)}`
    + (typeof c.militaryRank === 'number' ? ` · rank ${c.militaryRank}` : '');
  return td;
}

/**
 * A muted points cell (defense / visible fleet), or '—' when not spied.
 * @param {number | null | undefined} pts
 * @returns {HTMLTableCellElement}
 */
function pointsCell(pts) {
  if (pts == null) return cell('—', { align: 'right', color: '#5f6b75' });
  return cell(compact(Math.round(pts)), { align: 'right', color: '#9aa6b0' });
}

/**
 * Hidden-fleet cell — the estimate, heat-coloured by magnitude (grey for ~0 →
 * red for the biggest in view via heatColor's negative half). Breakdown is now
 * in the adjacent Defense / Visible columns; the exact subtraction stays in the
 * tooltip. Sort axis = `hiddenFleet`.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate | undefined} est
 * @param {number} maxHidden
 * @returns {HTMLTableCellElement}
 */
function hiddenCell(est, maxHidden) {
  if (!est) return cell('—', { align: 'right', color: '#5f6b75' });
  const hidden = Math.round(est.hiddenFleetPoints);
  const td = cell(compact(hidden), { align: 'right' });
  const frac = maxHidden > 0 ? Math.max(0, Math.min(1, hidden / maxHidden)) : 0;
  td.style.color = hidden > 0 ? heatColor(-frac) : '#666';
  td.style.fontWeight = '600';
  td.title =
    `hidden = military ${fmt(est.militaryPoints)} − defense ${fmt(Math.round(est.defensePoints))} `
    + `− visible fleet ${fmt(Math.round(est.visibleFleetPoints))}`
    + (est.provisional ? ' · coverage incomplete (provisional)' : '');
  return td;
}

/**
 * Scan-freshness cell: oldest-report age coloured by the player's worst scan
 * status (green fresh / amber stale or re-scan), or '—' when nothing's spied.
 * @param {'none'|'fresh'|'stale'|'rescan'} status
 * @param {number} oldestAgeMs
 * @returns {HTMLTableCellElement}
 */
function scannedCell(status, oldestAgeMs) {
  if (status === 'none') return cell('—', { align: 'right', color: '#5f6b75' });
  const age = formatAge(oldestAgeMs) || '?';
  const td = cell('', { align: 'right' });
  const txt = document.createElement('span');
  if (status === 'fresh') {
    txt.textContent = age;
    td.style.color = '#5a8f5a';
    td.title = `oldest report ${age} old`;
  } else if (status === 'stale') {
    txt.textContent = `${age} ⚠`;
    td.style.color = '#e0a020';
    td.title = `oldest report ${age} old — stale (> 7d)`;
  } else {
    txt.textContent = `${age} ↻`;
    td.style.color = '#e0a020';
    td.title = `re-scan requested · oldest report ${age} old`;
  }
  td.appendChild(txt);
  return td;
}

/**
 * Coverage cell: `spied/total` + a thin progress bar (full = green, partial =
 * amber, none = empty).
 * @param {number} spied
 * @param {number} total
 * @returns {HTMLTableCellElement}
 */
function coverageCell(spied, total) {
  const td = cell('');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const label = document.createElement('span');
  label.textContent = `${spied}/${total}`;
  label.style.cssText = 'color:#9aa6b0;font-size:11px;';
  const bar = document.createElement('span');
  bar.style.cssText =
    'display:inline-block;width:46px;height:5px;background:#28333c;border-radius:3px;overflow:hidden;';
  const frac = total > 0 ? Math.max(0, Math.min(1, spied / total)) : 0;
  const fill = document.createElement('span');
  const colour = frac >= 1 ? '#5a8f5a' : frac > 0 ? '#caa14a' : 'transparent';
  fill.style.cssText = `display:block;width:${Math.round(frac * 100)}%;height:100%;background:${colour};`;
  bar.appendChild(fill);
  wrap.appendChild(label);
  wrap.appendChild(bar);
  td.appendChild(wrap);
  return td;
}

/**
 * Build the Player cell as an expand toggle: a ▸/▾ triangle + name. Clicking
 * flips the linked detail row's visibility (instant) and notifies the caller.
 * @param {string} name
 * @param {boolean} open
 * @param {HTMLTableRowElement} detail
 * @param {() => void} [onToggle]
 * @returns {HTMLTableCellElement}
 */
function playerCell(name, open, detail, onToggle) {
  const td = cell('');
  td.style.cursor = 'pointer';
  td.title = 'Show planets / scan status';
  const tri = document.createElement('span');
  tri.textContent = open ? '▾ ' : '▸ ';
  tri.style.color = '#888';
  const label = document.createElement('span');
  label.textContent = name;
  td.appendChild(tri);
  td.appendChild(label);
  td.addEventListener('click', () => {
    const nowOpen = detail.style.display === 'none';
    detail.style.display = nowOpen ? '' : 'none';
    tri.textContent = nowOpen ? '▾ ' : '▸ ';
    if (onToggle) onToggle();
  });
  return td;
}

/**
 * Build the expandable per-planet detail row. Each planet shows its scan status
 * (scanned + age / stale / re-scan / needs scan), defense, and visible fleet;
 * stale or re-scan-flagged bodies carry a per-planet ↻ re-scan action. Pure
 * information — no send links (the in-game scan FAB does the sending). Hidden
 * unless `open`.
 * @param {object} args
 * @param {string} args.playerId
 * @param {PlanetPos[]} args.planets
 * @param {Record<string, PlanetReport> | undefined} args.reports  coord → report data.
 * @param {Record<string, number> | undefined} args.rescan
 * @param {number} args.nowMs
 * @param {(key: string) => void} [args.onRescan]
 * @param {number} args.colspan
 * @param {boolean} args.open
 * @returns {HTMLTableRowElement}
 */
function detailRow({ playerId, planets, reports, rescan, nowMs, onRescan, colspan, open }) {
  const tr = document.createElement('tr');
  tr.dataset.detailFor = playerId;
  tr.style.display = open ? '' : 'none';
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.style.padding = '8px 8px 12px 28px';
  td.style.borderBottom = '1px solid #222';
  td.style.background = '#0b1118';
  tr.appendChild(td);

  if (!planets.length) {
    const note = document.createElement('div');
    note.style.color = '#888';
    note.style.fontSize = '12px';
    note.textContent = 'No planets in the cached universe snapshot for this player.';
    td.appendChild(note);
    return tr;
  }

  const coordStr = (/** @type {PlanetPos} */ p) => `${p.galaxy}:${p.system}:${p.position}`;
  const spied = planets.filter((p) => reports && reports[coordStr(p)]).length;

  const head = document.createElement('div');
  head.style.cssText = 'font-size:11px;color:#7c8893;margin-bottom:8px;';
  const need = planets.length - spied;
  head.textContent = `${spied} of ${planets.length} planets scanned`
    + (need > 0 ? ` · ${need} need a scan` : '');
  td.appendChild(head);

  // Responsive grid of compact per-planet cells — a player can own 20+ planets,
  // so a single vertical list would be unusably tall; auto-fill packs them into
  // as many ~190px columns as the width allows.
  const grid = document.createElement('div');
  grid.style.cssText =
    'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:7px 18px;';

  for (const p of planets) {
    const coord = coordStr(p);
    const r = reports ? reports[coord] : undefined;
    const status = scanStatus({
      reportTsSec: r ? r.ts : undefined,
      nowMs,
      rescanAtMs: rescanAtFor(rescan, playerId, coord),
    });
    const item = document.createElement('div');
    item.style.cssText = 'font-size:11px;line-height:1.4;';

    // Line 1: coords · status · (re-scan ↻ pushed to the right).
    const l1 = document.createElement('div');
    l1.style.cssText = 'display:flex;align-items:baseline;gap:6px;white-space:nowrap;';
    const coordEl = document.createElement('span');
    coordEl.textContent = coord;
    coordEl.style.color = status === 'none' ? '#8b95a0' : '#cfd6dd';
    l1.appendChild(coordEl);

    const age = formatAge(ageMs(r?.ts, nowMs));
    const st = document.createElement('span');
    st.style.fontSize = '10px';
    if (status === 'none') { st.textContent = '○ needs scan'; st.style.color = '#7c8893'; }
    else if (status === 'fresh') { st.textContent = age; st.style.color = '#5a8f5a'; }
    else if (status === 'stale') { st.textContent = `${age} stale`; st.style.color = '#e0a020'; }
    else { st.textContent = `${age} re-scan`; st.style.color = '#e0a020'; }
    l1.appendChild(st);

    if ((status === 'fresh' || status === 'stale') && onRescan) {
      const link = document.createElement('span');
      link.textContent = '↻';
      link.style.cssText = 'color:#6b97c4;cursor:pointer;user-select:none;margin-left:auto;';
      link.title = 'Flag this planet for re-scan';
      link.addEventListener('click', () => onRescan(coord));
      l1.appendChild(link);
    }
    item.appendChild(l1);

    // Line 2: defense + visible fleet (only meaningful once scanned).
    const l2 = document.createElement('div');
    l2.style.color = '#6b7782';
    l2.textContent = r
      ? `D ${compact(Math.round(r.defPts))} · F ${compact(Math.round(r.fleetPts))}`
      : ' ';
    item.appendChild(l2);

    grid.appendChild(item);
  }
  td.appendChild(grid);
  return tr;
}

/**
 * Render the ranked target table into `containerEl`.
 * @param {object} args
 * @param {HTMLElement} args.containerEl
 * @param {TargetCandidate[]} args.candidates
 * @param {TargetFilterOptions} args.opts
 * @param {number} [args.limit]
 * @param {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} [args.estimates]
 * @param {TargetSort} [args.sort]
 * @param {(key: TargetSortKey) => void} [args.onSort]
 * @param {Set<string>} [args.watchedIds]
 * @param {(id: string) => void} [args.onToggleWatch]
 * @param {(key: string) => void} [args.onRescan]
 * @param {Record<string, number>} [args.rescan]
 * @param {boolean} [args.watchedOnly]
 * @param {Array<{coords: string, player?: number}>} [args.universePlanets]
 * @param {Record<string, Record<string, PlanetReport>>} [args.reportsByPlayer]
 * @param {number} [args.nowMs]
 * @param {Set<string>} [args.expandedIds]
 * @param {(id: string) => void} [args.onToggleExpand]
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
  onRescan,
  rescan,
  watchedOnly = false,
  universePlanets = [],
  reportsByPlayer,
  nowMs = 0,
  expandedIds,
  onToggleExpand,
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

  // Hidden-fleet magnitude per id (for the sort key and the heat ramp).
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
      'No players on the scan list yet — click “+ scan” next to a target to add it.';
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
  hr.appendChild(headCell('Scan'));
  hr.appendChild(headCell('#', 'right'));
  hr.appendChild(headCell('Player'));
  hr.appendChild(headCell('Highscore', 'right', sortable('totalRank')));
  hr.appendChild(headCell('Military', 'right', sortable('military')));
  hr.appendChild(headCell('Defense', 'right'));
  hr.appendChild(headCell('Visible', 'right'));
  hr.appendChild(headCell('Hidden', 'right', sortable('hiddenFleet')));
  hr.appendChild(headCell('Scanned', 'right'));
  hr.appendChild(headCell('Coverage'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const COLSPAN = 10;
  const tbody = document.createElement('tbody');
  let i = 0;
  for (const c of shown) {
    i += 1;
    const est = estimates ? estimates[c.id] : undefined;
    const planets = playerPlanets(universePlanets, c.id);
    const reports = reportsByPlayer ? reportsByPlayer[c.id] : undefined;

    // Per-row scan summary: worst status across the player's reports (rescan >
    // stale > fresh; none = nothing spied) + the oldest report's age.
    let worst = /** @type {'none'|'fresh'|'stale'|'rescan'} */ ('none');
    let oldestTs = Infinity;
    if (reports) {
      for (const coord of Object.keys(reports)) {
        const st = scanStatus({
          reportTsSec: reports[coord].ts,
          nowMs,
          rescanAtMs: rescanAtFor(rescan, c.id, coord),
        });
        if (st === 'rescan') worst = 'rescan';
        else if (st === 'stale' && worst !== 'rescan') worst = 'stale';
        else if (st === 'fresh' && worst === 'none') worst = 'fresh';
        const ts = reports[coord].ts;
        if (ts && ts < oldestTs) oldestTs = ts;
      }
    }
    const oldestAgeMs = Number.isFinite(oldestTs) ? nowMs - oldestTs * 1000 : NaN;
    const total = est && typeof est.planetCount === 'number' ? est.planetCount : planets.length;
    const spied = est ? est.spiedCount : 0;

    const open = !!(expandedIds && expandedIds.has(c.id));
    const detail = detailRow({
      playerId: c.id, planets, reports, rescan, nowMs, onRescan, colspan: COLSPAN, open,
    });

    const tr = document.createElement('tr');
    tr.appendChild(chipCell(c.id, !!(watchedIds && watchedIds.has(c.id)), onToggleWatch, onRescan));
    tr.appendChild(cell(String(i), { align: 'right', color: '#666' }));
    tr.appendChild(playerCell(c.name || `#${c.id}`, open, detail, () => {
      if (onToggleExpand) onToggleExpand(c.id);
    }));
    tr.appendChild(highscoreCell(c));
    tr.appendChild(militaryCell(c));
    tr.appendChild(pointsCell(est ? est.defensePoints : null));
    tr.appendChild(pointsCell(est ? est.visibleFleetPoints : null));
    tr.appendChild(hiddenCell(est, maxHidden));
    tr.appendChild(scannedCell(worst, oldestAgeMs));
    tr.appendChild(coverageCell(spied, total));
    tbody.appendChild(tr);
    tbody.appendChild(detail);
  }
  table.appendChild(tbody);
  containerEl.appendChild(table);

  if (countInfoEl) {
    const noun = watchedOnly ? 'on scan list' : 'targets in range';
    countInfoEl.textContent = `${list.length} ${noun} · showing ${shown.length}`;
  }
}
