// @ts-check

// Targets sub-tab renderer (dashboard, "Colonizations" section). Pure DOM
// factory: given the joined candidate list + the active-target filter options,
// it filters via the pure domain `buildTargetList`, re-sorts by the active
// column via `sortTargetList`, and paints a ranked table. The hidden-fleet
// column carries the per-player estimate (from espionage-report ingestion) and
// is heat-coloured by magnitude; its header (plus Rank / Military) is a
// clickable sort control. Read-only and self-contained (inline styles in the
// dashboard's dark palette).

import { buildTargetList, sortTargetList, playerPlanets } from '../../domain/targets.js';
import { spyMissionUrl } from '../../domain/ogameUrl.js';
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

// A spy report older than this is "stale": defenses/fleet move, so the
// hidden-fleet estimate (and the spied ✓) shouldn't be trusted — re-spy.
const STALE_MS = 7 * 24 * 3600 * 1000;

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
 * hidden points, then a muted coverage suffix ("spied/total", ⏱ = provisional
 * coverage, ⚠ = some report is stale), with the full breakdown in the tooltip.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate | undefined} est
 * @param {number} maxHidden   Largest hidden-fleet estimate in view (for the heat ramp).
 * @param {boolean} [stale]    At least one underlying report is older than STALE_MS.
 * @returns {HTMLTableCellElement}
 */
function hiddenCell(est, maxHidden, stale) {
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
  if (stale) {
    const warn = document.createElement('span');
    warn.textContent = ' ⚠';
    warn.style.color = '#e0a020';
    warn.style.fontSize = '11px';
    td.appendChild(warn);
  }
  td.title =
    `military ${fmt(est.militaryPoints)} − defense ${fmt(Math.round(est.defensePoints))} `
    + `− visible fleet ${fmt(Math.round(est.visibleFleetPoints))}`
    + (est.provisional ? ' · coverage incomplete (provisional)' : '')
    + (stale ? ' · some report > 7d old (stale) — re-spy' : '');
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
 * Build the Player cell as an expand toggle: a ▸/▾ triangle + name. Clicking
 * flips the linked detail row's visibility (instant — no repaint) and notifies
 * the caller so it can remember the open/closed state across repaints.
 * @param {string} name
 * @param {boolean} open
 * @param {HTMLTableRowElement} detail   The detail row this toggle controls.
 * @param {() => void} [onToggle]
 * @returns {HTMLTableCellElement}
 */
function playerCell(name, open, detail, onToggle) {
  const td = cell('');
  td.style.cursor = 'pointer';
  td.title = 'Show planets / spy links';
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
 * One "Spy" deep-link anchor — opens the in-game fleet dispatch pre-armed with
 * probes (user presses send; no auto-dispatch). Degrades to muted plain text
 * when we can't build a target-origin URL yet (game address unknown).
 * @param {import('../../domain/targets.js').PlanetPos} p
 * @param {number} probes
 * @param {string} gameHref
 * @param {string} label
 * @returns {HTMLElement}
 */
function spyLink(p, probes, gameHref, label) {
  const coords = `${p.galaxy}:${p.system}:${p.position}`;
  if (!gameHref) {
    const span = document.createElement('span');
    span.textContent = label;
    span.style.color = '#555';
    span.title = 'Open the in-game galaxy view once so OG-E learns this server’s address.';
    return span;
  }
  const a = document.createElement('a');
  a.href = spyMissionUrl(gameHref, p, probes);
  a.textContent = label;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.color = '#7fb0ff';
  a.style.textDecoration = 'none';
  a.title = `Opens the fleet dispatch with ${probes} probes pre-armed to ${coords} — you press send.`;
  return a;
}

/**
 * Build the expandable detail row for one target: a quick "next action" link
 * plus a per-planet list. Un-spied planets carry a "Spy N" deep-link; spied
 * planets show ✓ with the report age — amber + a re-spy link once the report is
 * stale (> 7d). Hidden unless `open`.
 * @param {object} args
 * @param {string} args.playerId
 * @param {import('../../domain/targets.js').PlanetPos[]} args.planets
 * @param {Record<string, number> | undefined} args.spied  "g:s:p" → newest report ts (epoch SECONDS).
 * @param {number} args.nowMs
 * @param {number} args.probes
 * @param {string} args.gameHref
 * @param {number} args.colspan
 * @param {boolean} args.open
 * @returns {HTMLTableRowElement}
 */
function detailRow({ playerId, planets, spied, nowMs, probes, gameHref, colspan, open }) {
  const tr = document.createElement('tr');
  tr.dataset.detailFor = playerId;
  tr.style.display = open ? '' : 'none';
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.style.padding = '4px 8px 12px 28px';
  td.style.borderBottom = '1px solid #222';
  td.style.background = '#141414';
  tr.appendChild(td);

  if (!planets.length) {
    const note = document.createElement('div');
    note.style.color = '#888';
    note.style.fontSize = '12px';
    note.textContent = 'No planets in the cached universe snapshot for this player.';
    td.appendChild(note);
    return tr;
  }

  const coordStr = (/** @type {import('../../domain/targets.js').PlanetPos} */ p) =>
    `${p.galaxy}:${p.system}:${p.position}`;
  const reportTs = (/** @type {import('../../domain/targets.js').PlanetPos} */ p) =>
    (spied ? spied[coordStr(p)] : undefined);
  const isSpied = (/** @type {import('../../domain/targets.js').PlanetPos} */ p) =>
    reportTs(p) !== undefined;
  const isStale = (/** @type {import('../../domain/targets.js').PlanetPos} */ p) =>
    ageMs(reportTs(p), nowMs) > STALE_MS;

  // Quick action header: send to the first un-spied planet, else re-spy the
  // oldest stale one, else confirm everything is fresh — so the user can chain
  // sends without hunting the list.
  const head = document.createElement('div');
  head.style.fontSize = '12px';
  head.style.marginBottom = '6px';
  const next = planets.find((p) => !isSpied(p));
  const stalest = planets
    .filter((p) => isStale(p))
    .sort((a, b) => (reportTs(a) ?? 0) - (reportTs(b) ?? 0))[0];
  if (next) {
    head.style.color = '#888';
    head.appendChild(document.createTextNode('Next un-spied: '));
    head.appendChild(spyLink(next, probes, gameHref, `Spy ${coordStr(next)} →`));
  } else if (stalest) {
    head.style.color = '#e0a020';
    head.appendChild(document.createTextNode('All spied · re-spy oldest: '));
    head.appendChild(spyLink(stalest, probes, gameHref, `Spy ${coordStr(stalest)} →`));
  } else {
    head.style.color = '#5a8f5a';
    head.textContent = `All ${planets.length} planet(s) spied, fresh ✓`;
  }
  td.appendChild(head);

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '4px 14px';
  for (const p of planets) {
    const spiedHere = isSpied(p);
    const staleHere = spiedHere && isStale(p);
    const item = document.createElement('span');
    item.style.fontSize = '12px';
    item.style.whiteSpace = 'nowrap';
    const tag = document.createElement('span');
    tag.textContent = `${coordStr(p)} `;
    let tagColor = '#ccc';
    if (spiedHere) tagColor = staleHere ? '#e0a020' : '#5a8f5a';
    tag.style.color = tagColor;
    item.appendChild(tag);
    if (spiedHere) {
      const age = formatAge(ageMs(reportTs(p), nowMs));
      const chk = document.createElement('span');
      chk.textContent = `✓${age ? ` ${age}` : ''}`;
      chk.style.color = staleHere ? '#e0a020' : '#5a8f5a';
      chk.title = staleHere
        ? `Spy report ${age} old — stale (> 7d), re-spy for an accurate estimate`
        : `Spy report on file (${age || 'age unknown'})`;
      item.appendChild(chk);
      if (staleHere) {
        item.appendChild(document.createTextNode(' '));
        item.appendChild(spyLink(p, probes, gameHref, '↻'));
      }
    } else {
      item.appendChild(spyLink(p, probes, gameHref, `Spy ${probes}`));
    }
    wrap.appendChild(item);
  }
  td.appendChild(wrap);
  return tr;
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
 * @param {Array<{coords: string, player?: number}>} [args.universePlanets]
 *   universe.xml occupancy rows — source for a target's planet list (spy links).
 * @param {Record<string, Record<string, number>>} [args.spiedByPlayer]
 *   playerId → ("g:s:p" coord → newest report ts in epoch SECONDS).
 * @param {number} [args.nowMs]                   Clock for report-age display (default 0 = ageless).
 * @param {number} [args.probes]                 Probe count for the Spy links (default 20).
 * @param {string} [args.gameHref]               Target-origin in-game URL base for spy links.
 * @param {Set<string>} [args.expandedIds]       Player ids whose detail row starts open.
 * @param {(id: string) => void} [args.onToggleExpand]  Notified when a row expands/collapses.
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
  universePlanets = [],
  spiedByPlayer,
  nowMs = 0,
  probes = 20,
  gameHref = '',
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
    const open = !!(expandedIds && expandedIds.has(c.id));
    const spied = spiedByPlayer ? spiedByPlayer[c.id] : undefined;
    let stale = false;
    if (spied) {
      for (const ts of Object.values(spied)) {
        if (ageMs(ts, nowMs) > STALE_MS) { stale = true; break; }
      }
    }
    const detail = detailRow({
      playerId: c.id,
      planets: playerPlanets(universePlanets, c.id),
      spied,
      nowMs,
      probes,
      gameHref,
      colspan: 8,
      open,
    });

    const tr = document.createElement('tr');
    tr.appendChild(starCell(c.id, !!(watchedIds && watchedIds.has(c.id)), onToggleWatch));
    tr.appendChild(cell(String(i), { align: 'right', color: '#666' }));
    tr.appendChild(playerCell(c.name || `#${c.id}`, open, detail, () => {
      if (onToggleExpand) onToggleExpand(c.id);
    }));
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
    tr.appendChild(hiddenCell(estimates ? estimates[c.id] : undefined, maxHidden, stale));
    tbody.appendChild(tr);
    tbody.appendChild(detail);
  }
  table.appendChild(tbody);
  containerEl.appendChild(table);

  if (countInfoEl) {
    const noun = watchedOnly ? 'watched' : 'targets in range';
    countInfoEl.textContent = `${list.length} ${noun} · showing ${shown.length}`;
  }
}
