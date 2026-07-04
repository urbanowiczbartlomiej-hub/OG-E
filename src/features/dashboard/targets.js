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

import {
  buildTargetList, sortTargetList, playerPlanets, targetExclusionReason,
} from '../../domain/targets.js';
import { scanStatus, rescanAtFor } from '../../domain/spyScan.js';
import { DANGER_LABELS } from '../../domain/dangerScore.js';
import { dangerColor } from '../../lib/dangerColor.js';
import { buildDossier } from './dossier.js';

/**
 * @typedef {'hiddenFleet'|'military'|'totalRank'|'ships'|'destroyed'|'danger'|'fleet'} TargetSortKey
 * @typedef {{ key: TargetSortKey, dir: 'asc'|'desc' }} TargetSort
 */

/** Default sort: most dangerous first — the free, whole-server fleet-finder
 * ranking (works before any spy report; hidden-fleet is the spied refinement).
 * @type {TargetSort} */
export const DEFAULT_TARGET_SORT = { key: 'danger', dir: 'desc' };

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
 * Human label for a `targetExclusionReason` cause (search "hidden: …" rows).
 * @param {string} reason
 * @returns {string}
 */
function reasonLabel(reason) {
  switch (reason) {
    case 'self': return "that's you";
    case 'vacation': return 'on vacation';
    case 'inactive': return 'inactive';
    case 'banned': return 'banned';
    case 'admin': return 'admin account';
    case 'ownAlliance': return 'your alliance';
    case 'tooStrong': return 'too strong (out of your band)';
    case 'tooWeak': return 'too weak (out of your band)';
    case 'rankWindow': return 'outside the rank window';
    case 'minMilitary': return 'below your military filter';
    case 'maxMilitary': return 'above your military filter';
    default: return reason;
  }
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
 * Ship-count cell — the free mobility signal (`ships` attribute of the
 * military feed, hourly). An explicit 0 = pure defense: this player's whole
 * military score CANNOT fly an attack — rendered green, the single hardest
 * "safe" fact the API gives us. '—' = player absent from the military feed.
 * The rough resources-per-ship figure rides as a dim second LINE (Etap H2):
 * it's the fleet-composition tell (2.8K/ship = cargo/probe swarm, 54K/ship =
 * capital ships) and was too load-bearing to leave tooltip-only. Its
 * contamination caveat (defense inflates, swarms dilute) stays in the tooltip.
 * @param {TargetCandidate} c
 * @returns {HTMLTableCellElement}
 */
function shipsCell(c) {
  if (typeof c.ships !== 'number') return cell('—', { align: 'right', color: '#5f6b75' });
  const td = cell('', { align: 'right' });
  const count = document.createElement('span');
  count.textContent = c.ships === 0 ? '0 🛡' : compact(c.ships);
  count.style.color = c.ships === 0 ? '#7fd6a8' : '#cfd6dd';
  td.appendChild(count);
  const sub = document.createElement('span');
  sub.style.cssText = 'display:block;font-size:11px;line-height:1.3;';
  if (c.ships === 0) {
    td.title = '0 ships — pure defense; this military score cannot attack anyone';
    sub.textContent = 'pure defense';
    sub.style.color = '#4f8f6f';
    td.appendChild(sub);
  } else {
    const rps = typeof c.militaryScore === 'number' ? Math.round((c.militaryScore * 1000) / c.ships) : null;
    td.title = `${fmt(c.ships)} ships (military highscore, hourly)`
      + (rps != null ? ` · ≈ ${fmt(rps)} res/ship (defense inflates, probe swarms dilute)` : '');
    if (rps != null) {
      // Rough composition bands: destroyers ~125K res, battleships ~60K,
      // light fighters ~4K, probes ~1K — so ≥50K reads "capital-heavy",
      // ≥1M reads "RIP-scale", <5K reads "swarm".
      sub.textContent = `≈ ${compact(rps)} res/ship${rps < 5_000 ? ' · swarm' : ''}`;
      sub.style.color = rps >= 1_000_000 ? '#ff9d8a'
        : rps >= 50_000 ? '#e0b45f'
        : rps < 5_000 ? '#5f6b75'
        : '#8b95a0';
      td.appendChild(sub);
    }
  }
  return td;
}

/**
 * Danger cell (v2) — the free whole-server verdict: D 0–100 (green → amber →
 * red) + the archetype label, from the danger profile (no spy needed). The
 * headline the fleet-finder sorts by; the tooltip spells out WHY.
 * @param {import('../../domain/dangerScore.js').DangerProfile | undefined} prof
 * @returns {HTMLTableCellElement}
 */
function dangerCell(prof) {
  if (!prof) return cell('—', { align: 'right', color: '#5f6b75' });
  const d = Math.round(prof.danger * 100);
  const col = dangerColor(d);
  const td = cell('', { align: 'right' });
  const val = document.createElement('span');
  val.textContent = prof.friendly ? 'friendly' : String(d);
  val.style.color = col;
  val.style.fontWeight = '600';
  td.append(val);
  // Archetype label rides alongside the number — but not for friendlies,
  // whose value already reads "friendly" (else "friendly Friendly").
  if (!prof.friendly) {
    const lab = document.createElement('span');
    lab.textContent = ` ${DANGER_LABELS[prof.label]}`;
    lab.style.color = '#8a97a3';
    lab.style.fontSize = '11px';
    td.append(lab);
  }
  td.title = `Danger ${d}/100 — ${[DANGER_LABELS[prof.label], ...prof.reasons].filter(Boolean).join(' · ')}`;
  return td;
}

/**
 * Mobile-fleet cell (v2) — the ATTACK-CAPABLE military (defense excluded): the
 * exact figure when fully spied, else the ceiling (`≤`) with the estimate in
 * the tooltip. This is the "worth watching / worth spying" signal — a high
 * ceiling on estimated data is a prime spy target. Sorted by that ceiling.
 * @param {import('../../domain/dangerScore.js').DangerProfile | undefined} prof
 * @returns {HTMLTableCellElement}
 */
function fleetCell(prof) {
  if (!prof || prof.friendly) return cell('—', { align: 'right', color: '#5f6b75' });
  if (prof.provenance === 'spied') {
    const td = cell(compact(prof.mobileMil), { align: 'right', color: '#cfd6dd' });
    td.title = `${fmt(prof.mobileMil)} mobile military — exact (fully spied), defense excluded`;
    return td;
  }
  const td = cell(`≤ ${compact(prof.mobileHi)}`, { align: 'right', color: '#9aa6b0' });
  td.title = `mobile-military ceiling ${fmt(prof.mobileHi)} — est. ~${fmt(prof.mobileMil)} `
    + `(${prof.provenance === 'ships' ? 'ship-bounded' : 'no ship count'}); spy to firm up`;
  return td;
}

/**
 * Intel cell — one glyph merging scan-freshness with coverage into a single
 * "how much do we know?" read: grey ○ = never scanned, amber ⚠ = stale/re-scan
 * (data may be wrong), green ● = complete (every planet spied), blue ◐ =
 * partial. The tooltip carries the coverage fraction and the oldest report age.
 * @param {'none'|'fresh'|'stale'|'rescan'} worst
 * @param {number} spied
 * @param {number} total
 * @param {number} oldestAgeMs
 * @returns {HTMLTableCellElement}
 */
function intelCell(worst, spied, total, oldestAgeMs) {
  const td = cell('', { align: 'center' });
  const age = formatAge(oldestAgeMs);
  const agePart = age ? ` · ${age} old` : '';
  const glyph = document.createElement('span');
  glyph.style.fontSize = '13px';
  if (worst === 'none' || spied <= 0) {
    glyph.textContent = '○';
    glyph.style.color = '#666';
    td.title = 'Never scanned';
  } else if (worst === 'stale' || worst === 'rescan') {
    glyph.textContent = '⚠';
    glyph.style.color = '#e0b020';
    td.title = `Stale · spied ${spied}/${total}${agePart}`;
  } else if (total > 0 && spied >= total) {
    glyph.textContent = '●';
    glyph.style.color = '#7fd6a8';
    td.title = `Complete · ${spied}/${total}${agePart}`;
  } else {
    glyph.textContent = '◐';
    glyph.style.color = '#8bb0d0';
    td.title = `Partial · ${spied}/${total}${agePart}`;
  }
  td.appendChild(glyph);
  return td;
}

/**
 * Build the Player cell as an expand toggle: a ▸/▾ triangle + name. Clicking
 * flips the linked detail row's visibility (instant) and notifies the caller.
 * @param {string} name
 * @param {boolean} open
 * @param {HTMLTableRowElement} detail
 * @param {() => void} [onToggle]
 * @param {() => void} [onShowOnMap]  Spyglass → map spotlight (⌖).
 * @returns {HTMLTableCellElement}
 */
function playerCell(name, open, detail, onToggle, onShowOnMap) {
  const td = cell('');
  const nameWrap = document.createElement('span');
  nameWrap.style.cursor = 'pointer';
  nameWrap.title = 'Show planets / scan status';
  const tri = document.createElement('span');
  tri.textContent = open ? '▾ ' : '▸ ';
  tri.style.color = '#888';
  const label = document.createElement('span');
  label.textContent = name;
  nameWrap.append(tri, label);
  nameWrap.addEventListener('click', () => {
    const nowOpen = detail.style.display === 'none';
    detail.style.display = nowOpen ? '' : 'none';
    tri.textContent = nowOpen ? '▾ ' : '▸ ';
    if (onToggle) onToggle();
  });
  td.appendChild(nameWrap);
  // Spyglass → map: spotlight this player's planets on the Galaxy Viewer
  // occupancy lens. A separate control (not the name) so it never fights the
  // expand toggle.
  if (onShowOnMap) {
    const mapLink = document.createElement('span');
    mapLink.textContent = ' ⌖';
    mapLink.style.cssText = 'cursor:pointer;color:#c07ad0;user-select:none;';
    mapLink.title = 'Show this player’s planets on the map';
    mapLink.addEventListener('click', (e) => { e.stopPropagation(); onShowOnMap(); });
    td.appendChild(mapLink);
  }
  return td;
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
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [args.danger]
 *   Per-player danger profiles (v2) — the free whole-server fleet-finder
 *   columns (Danger D + mobile-fleet ceiling) and their sort axes.
 * @param {(playerId: string, name?: string) => void} [args.onShowOnMap]
 *   Spyglass → map reverse deep-link (⌖ per row).
 * @param {Record<string, import('../../domain/raidVerdict.js').RaidVerdict>} [args.verdicts]
 *   Per-player raid verdict (label + loot) shown in the expanded dossier.
 * @param {Record<string, boolean|undefined>} [args.inBand]
 *   Per-player legal-attack-band flag for the dossier header.
 * @param {Map<number, import('../../domain/civilBaseline.js').CivilProfile>} [args.civil]
 * @param {Record<string, import('../../domain/routine.js').RoutineSummary>} [args.routines]
 * @param {Record<string, import('../../state/watchList.js').Relationship>} [args.relationships]
 * @param {(pid: string, rel: import('../../state/watchList.js').Relationship) => void} [args.onSetRelationship]
 *   Per-player civil-fleet baseline shown in the dossier (Etap C).
 * @param {string} [args.searchQuery]  Nickname search (Etap D); when set, the
 *   table shows every name-match INCLUDING excluded players (with the reason).
 * @param {(id: string) => void} [args.onShowAnyway]  "Show anyway" override for
 *   an excluded search hit (force-include the player).
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
  danger,
  verdicts,
  inBand,
  civil,
  routines,
  relationships,
  onSetRelationship,
  onShowOnMap,
  searchQuery = '',
  onShowAnyway,
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

  // Hidden-fleet magnitude per id (feeds the `hiddenFleet` sort key).
  /** @type {Record<string, number>} */
  const hiddenById = {};
  if (estimates) {
    for (const id of Object.keys(estimates)) {
      const pts = estimates[id].hiddenFleetPoints;
      if (typeof pts === 'number' && Number.isFinite(pts)) {
        hiddenById[id] = pts;
      }
    }
  }

  // Danger / mobile-fleet-ceiling per id — the free fleet-finder sort axes.
  /** @type {Record<string, {danger:number, fleet:number}>} */
  const dangerById = {};
  if (danger) {
    for (const [id, prof] of danger) {
      dangerById[String(id)] = { danger: prof.danger, fleet: prof.mobileHi };
    }
  }

  // Search mode overrides the filter: match by name across the WHOLE candidate
  // set (incl. excluded players), so a hidden player is findable — with the
  // reason it's hidden + a "show anyway" override. Empty query = the normal
  // filter / watched-scope / limit flow.
  const query = searchQuery.trim().toLowerCase();
  /** @type {Array<{ c: TargetCandidate, reason: string }>} */
  const excludedMatches = [];
  /** @type {TargetCandidate[]} */
  let list;
  if (query) {
    /** @type {TargetCandidate[]} */
    const kept = [];
    for (const c of candidates) {
      if (!(c.name || '').toLowerCase().includes(query) && String(c.id) !== query) continue;
      const reason = targetExclusionReason(c, opts); // opts carries forceInclude
      if (reason === null) kept.push(c);
      else excludedMatches.push({ c, reason });
    }
    list = sortTargetList(kept, sort.key, sort.dir, hiddenById, dangerById);
  } else {
    const filtered = buildTargetList(candidates, opts);
    const scoped = watchedOnly && watchedIds
      ? filtered.filter((c) => watchedIds.has(c.id))
      : filtered;
    list = sortTargetList(scoped, sort.key, sort.dir, hiddenById, dangerById);
  }
  const shown = !query && limit > 0 ? list.slice(0, limit) : list;

  if (query && shown.length === 0 && excludedMatches.length === 0) {
    const p = document.createElement('p');
    p.style.color = '#888';
    p.style.fontSize = '13px';
    p.textContent = `No player matches “${searchQuery.trim()}”.`;
    containerEl.appendChild(p);
    if (countInfoEl) countInfoEl.textContent = '';
    return;
  }

  if (!query && watchedOnly && list.length === 0) {
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
  hr.appendChild(headCell('⭐'));
  hr.appendChild(headCell('Player'));
  hr.appendChild(headCell('Danger', 'right', sortable('danger')));
  hr.appendChild(headCell('Fleet', 'right', sortable('fleet')));
  hr.appendChild(headCell('Military', 'right', sortable('military')));
  hr.appendChild(headCell('Ships', 'right', sortable('ships')));
  hr.appendChild(headCell('Intel'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const COLSPAN = 7;
  const tbody = document.createElement('tbody');
  for (const c of shown) {
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
    const prof = danger ? danger.get(Number(c.id)) : undefined;
    const detail = buildDossier({
      playerId: c.id,
      name: c.name || `#${c.id}`,
      profile: prof,
      estimate: est,
      verdict: verdicts ? verdicts[c.id] : undefined,
      inBand: inBand ? inBand[c.id] : undefined,
      civilProfile: civil ? civil.get(Number(c.id)) : undefined,
      routine: routines ? routines[c.id] : undefined,
      relationship: relationships ? relationships[c.id] : undefined,
      onSetRelationship,
      planets,
      reports,
      rescan,
      nowMs,
      onRescan,
      colspan: COLSPAN,
      open,
    });

    const tr = document.createElement('tr');
    // Anchor for the Galaxy Viewer → Spyglass deep-link (scroll + highlight).
    tr.dataset.playerId = c.id;
    tr.appendChild(chipCell(c.id, !!(watchedIds && watchedIds.has(c.id)), onToggleWatch, onRescan));
    tr.appendChild(playerCell(c.name || `#${c.id}`, open, detail, () => {
      if (onToggleExpand) onToggleExpand(c.id);
    }, onShowOnMap ? () => onShowOnMap(c.id, c.name) : undefined));
    tr.appendChild(dangerCell(prof));
    tr.appendChild(fleetCell(prof));
    tr.appendChild(militaryCell(c));
    tr.appendChild(shipsCell(c));
    tr.appendChild(intelCell(worst, spied, total, oldestAgeMs));
    tbody.appendChild(tr);
    tbody.appendChild(detail);
  }
  // Search hits that are normally hidden — shown dimmed with WHY + a "show
  // anyway" override, so the search never silently drops a matching player.
  for (const { c, reason } of excludedMatches) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = COLSPAN;
    td.style.cssText =
      'padding:4px 8px;color:#6b7782;font-size:12px;border-bottom:1px solid #161c24;';
    const name = document.createElement('span');
    name.textContent = c.name || `#${c.id}`;
    name.style.color = '#8b95a0';
    td.appendChild(name);
    const why = document.createElement('span');
    why.textContent = ` — hidden: ${reasonLabel(reason)}`;
    td.appendChild(why);
    if (onShowAnyway) {
      const link = document.createElement('span');
      link.textContent = 'show anyway';
      link.style.cssText = 'color:#6b97c4;cursor:pointer;user-select:none;margin-left:8px;';
      link.addEventListener('click', () => onShowAnyway(c.id));
      td.appendChild(link);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  // Horizontal-scroll containment: on a narrow viewport the (nowrap) table
  // scrolls inside this wrapper instead of stretching the whole page.
  const scroller = document.createElement('div');
  scroller.style.overflowX = 'auto';
  scroller.appendChild(table);
  containerEl.appendChild(scroller);

  if (countInfoEl) {
    if (query) {
      const hid = excludedMatches.length;
      countInfoEl.textContent = `${shown.length} match${shown.length === 1 ? '' : 'es'}`
        + (hid ? ` · ${hid} hidden` : '');
    } else {
      const noun = watchedOnly ? 'on scan list' : 'targets in range';
      countInfoEl.textContent = `${list.length} ${noun} · showing ${shown.length}`;
    }
  }
}
