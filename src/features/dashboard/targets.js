// @ts-check

// Targets sub-tab renderer (dashboard, "Colonizations" section). Pure DOM
// factory: filters the joined candidate list via the pure domain
// `buildTargetList`, re-sorts by the active column via `sortTargetList`, and
// paints a ranked table. Columns carry the free whole-server verdicts (danger,
// fleet ceiling, military, ships); coverage and scan-freshness reads live in
// the dossier's per-body rows (the Intel glyph column is retired — only its
// 🎯 fleet-landing marker survives, on the Player cell).
// A "watch" chip drops a player onto the in-game scan FAB's watch-list; the ↻
// whole-player re-scan flag lives in the dossier's "Watch via" row (next to
// the probes toggle it belongs to — it only shows while probes are on).
// Expanding a row lists the player's planets with per-body scan status, defense,
// and visible fleet. Read-only and self-contained (inline styles, dark palette).

import {
  buildTargetList, sortTargetList, playerPlanets, targetExclusionReason,
  playerMatchesQuery,
} from '../../domain/targets.js';
import { isMinerProfile } from '../../domain/dangerScore.js';
import { dangerColor } from '../../lib/dangerColor.js';
import { compact } from './format.js';
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
 * Phone breakpoint for the players table. Below it the row re-packs into the
 * stacked 3-line layout: the watch pill leaves its own column and stacks
 * ABOVE the nick in the Player cell, and the Ships composition band drops to
 * its own line — six columns just don't fit 360–430 px. The dashboard
 * re-renders on breakpoint crossings (index.js wires a matchMedia listener on
 * this exact query), so the flag is simply read at render time.
 */
export const TARGETS_NARROW_MQ = '(max-width: 640px)';

/**
 * @typedef {import('../../domain/targets.js').TargetCandidate} TargetCandidate
 * @typedef {import('../../domain/targets.js').TargetFilterOptions} TargetFilterOptions
 * @typedef {import('../../domain/targets.js').PlanetPos} PlanetPos
 * @typedef {{ ts: number, defPts: number, fleetPts: number,
 *   act?: import('../../domain/activityObs.js').ActivityObs[] }} PlanetReport
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
 * Build the "watch" pill (replaces the old ⭐). Outline `+ watch` = not on
 * the scan list; filled `✓ watch` = on the in-game scan FAB's watch-list. (The
 * ↻ whole-player re-scan moved to the dossier's Watch-via row, beside the
 * probes toggle it flags for.) On wide screens it sits in its own column
 * ({@link chipCell}); on narrow ones it stacks above the nick inside the
 * Player cell — same element either way.
 * @param {string} id
 * @param {boolean} watched
 * @param {(id: string) => void} [onToggle]
 * @returns {HTMLSpanElement}
 */
function watchChip(id, watched, onToggle) {
  const chip = document.createElement('span');
  chip.textContent = watched ? '✓ watch' : '+ watch';
  // .hit-pad: ≥36px touch hit-box (coarse pointers only) without growing
  // the visible pill.
  chip.className = 'hit-pad';
  chip.style.cssText =
    'display:inline-block;font-size:11px;border-radius:11px;padding:2px 9px;'
    + 'cursor:pointer;user-select:none;white-space:nowrap;';
  if (watched) {
    chip.style.background = '#16352a';
    chip.style.border = '1px solid #2f6f4f';
    chip.style.color = '#7fd6a8';
    chip.title = 'Watching (on your scan list + the map) — click to remove';
  } else {
    chip.style.background = 'transparent';
    chip.style.border = '1px solid #2a3a45';
    chip.style.color = '#8b95a0';
    chip.title = 'Watch this player (adds to the scan list + the map)';
  }
  // Stop the click bubbling to the row (whose click toggles the dossier).
  if (onToggle) chip.addEventListener('click', (e) => { e.stopPropagation(); onToggle(id); });
  return chip;
}

/**
 * The wide-screen watch COLUMN cell — just {@link watchChip} in a td.
 * @param {string} id
 * @param {boolean} watched
 * @param {(id: string) => void} [onToggle]
 * @returns {HTMLTableCellElement}
 */
function chipCell(id, watched, onToggle) {
  const td = cell('');
  td.appendChild(watchChip(id, watched, onToggle));
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
  td.appendChild(score);
  // Military highscore rank on a dim second line (mirrors the overall rank under
  // the nick), so score and position read as a two-row cell.
  if (typeof c.militaryRank === 'number') {
    const rank = document.createElement('span');
    rank.style.cssText = 'display:block;font-size:11px;line-height:1.3;color:#6b7782;';
    rank.textContent = `#${c.militaryRank}`;
    td.appendChild(rank);
  }
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
 * The resources-per-ship figure rides as a dim second LINE (Etap H2): it's
 * the fleet-composition tell (2.8K/ship = cargo/probe swarm, 54K/ship =
 * capital ships).
 *
 * res/ship comes from the danger profile's FLEET estimate (`resPerShip` =
 * mobileMil·1000/ships — spied defence already subtracted), NOT raw
 * military/ships: defence inflates military points without adding a single
 * ship, so military/ships painted a bunker farmer's cheap transporters as
 * "28K · combat" while the dossier's danger block (correctly) said ~7K cheap
 * hulls — the same player, two contradicting numbers. One source now. The raw
 * military/ships stays only as the no-profile fallback, flagged as an upper
 * bound in the tooltip.
 * @param {TargetCandidate} c
 * @param {import('../../domain/dangerScore.js').DangerProfile} [prof]
 * @param {boolean} [narrow]  Phone layout: the composition band drops to its
 *   own third line instead of riding beside the res/ship figure.
 * @returns {HTMLTableCellElement}
 */
function shipsCell(c, prof, narrow = false) {
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
    const fromProfile = prof && typeof prof.resPerShip === 'number';
    const rpsRaw = fromProfile
      ? /** @type {number} */ (prof.resPerShip)
      : (typeof c.militaryScore === 'number' ? (c.militaryScore * 1000) / c.ships : null);
    const rps = rpsRaw != null ? Math.round(rpsRaw) : null;
    // Fully spied ⇒ the fleet estimate collapsed to military − seen defence:
    // the figure is exact, not a share prior.
    const exact = fromProfile && prof.provenance === 'spied';
    td.title = `${fmt(c.ships)} ships (military highscore, hourly)`
      + (rps != null
        ? ` · ${fmt(rps)} res/ship of the FLEET estimate (${
          exact
            ? 'fully spied — defence subtracted exactly'
            : fromProfile
              ? 'fleet share estimated; scan the player to pin it down'
              : 'raw military/ships — defence inflates this upper bound'})`
        : '');
    if (rps != null) {
      // Composition bands (owner's read): < 20k = cheap CIVILIAN hulls (cargo /
      // probes / LF); 20k–100k = the real COMBAT window (cruisers ~29k, battleships
      // ~60k land around here); > 100k = a capital/RIP core when the fleet is
      // pinned by scans, otherwise likely defence inflating the estimate.
      // (No ≈ prefix — the tooltip already says it's an estimate; the glyph
      // only cost width on the phone's tightest column.)
      const band = rps < 20_000 ? 'civilian'
        : rps > 100_000 ? (exact ? 'capitals' : 'defence?')
        : 'combat';
      const color = rps > 100_000 ? '#c98f8f'
        : rps >= 20_000 ? '#e0b45f'
        : '#5f6b75';
      sub.textContent = narrow ? `${compact(rps)} res/ship` : `${compact(rps)} res/ship · ${band}`;
      sub.style.color = color;
      td.appendChild(sub);
      if (narrow) {
        // Line 3 (phone): the band gets its own line — beside the figure it
        // forced the column wide enough to squash Player into a sliver.
        const bandEl = document.createElement('span');
        bandEl.style.cssText = `display:block;font-size:11px;line-height:1.3;color:${color};`;
        bandEl.textContent = band;
        td.appendChild(bandEl);
      }
    }
  }
  return td;
}

/**
 * Danger cell (v2) — the free whole-server verdict: D 0–100 (green → amber →
 * red), from the danger profile (no spy needed). The headline the fleet-finder
 * sorts by; the tooltip spells out WHY.
 *
 * The archetype name that used to ride a second line here is gone: it was
 * invented vocabulary ("Bandit raider", "Turtle") in the one column the eye goes
 * to first, and it needed a hover to mean anything. The plain-words reading now
 * lives on the dossier's DANGER line, beside the reasons that produced it — one
 * click away, where there is room to explain it (see domain/dangerScore's
 * DANGER_LABELS).
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
  td.title = `Danger ${d}/100 — ${prof.reasons.join(' · ')}`;
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
 * Build the Player cell — the name plus, when fresh, the fleet-landing 🎯
 * marker (survivor of the retired Intel column: the single most actionable
 * signal — a catchable fleet may have just landed while the owner is away).
 * Coverage/staleness reads moved to the dossier's per-body rows. Expanding
 * the dossier is handled by a click anywhere on the row (no separate ▸
 * toggle, no per-row map control).
 * @param {TargetCandidate} c
 * @param {import('../../domain/fleetLanding.js').FleetLandingSignal} [landing]
 * @param {{ name?: string, tag?: string }} [ally]  The player's alliance
 *   (alliances.xml row), when the feed knows it — rendered on the dim second
 *   line after the rank, so an alliance sweep is checkable row by row without
 *   the tag pushing the nick around on the line that identifies the player.
 * @returns {HTMLTableCellElement}
 */
function playerCell(c, landing, ally) {
  const td = cell('');
  const label = document.createElement('span');
  label.textContent = c.name || `#${c.id}`;
  td.appendChild(label);
  if (landing) {
    const st = document.createElement('span');
    st.textContent = ' 🎯';
    st.style.cssText = 'font-size:12px;';
    // Claim tracks the signal's tier: 'any' concedes the owner may be around.
    st.title = landing.tier === 'any'
      ? `Moon ${landing.coord} lit ${formatAge(landing.freshAgeMs)} ago — other `
        + 'bodies active too (owner may be around). Spy to confirm.'
      : `Possible ${landing.tier === 'newest' ? 'parked' : 'fresh'} fleet — moon ${landing.coord} active `
        + `${formatAge(landing.freshAgeMs)} ago, player otherwise quiet/older `
        + `(${landing.quiet}/${landing.total} bodies). Spy to confirm.`;
    td.appendChild(st);
  }
  // Dim second line — the "who is this, server-wide" anchor: overall highscore
  // rank, then the alliance tag. Both are context for the nick above, so they
  // share one line and leave the name line to the name.
  const hasAlly = !!(ally && (ally.tag || ally.name));
  if (typeof c.totalRank === 'number' || hasAlly) {
    const sub = document.createElement('span');
    sub.style.cssText = 'display:block;font-size:11px;line-height:1.3;color:#6b7782;';
    if (typeof c.totalRank === 'number') {
      const rank = document.createElement('span');
      rank.textContent = `#${c.totalRank}`;
      rank.title = `overall highscore rank #${c.totalRank}`;
      sub.appendChild(rank);
    }
    if (hasAlly) {
      const tagEl = document.createElement('span');
      const tag = /** @type {{ name?: string, tag?: string }} */ (ally);
      tagEl.textContent = `${sub.childNodes.length ? ' ' : ''}[${tag.tag || tag.name}]`;
      tagEl.title = tag.name || '';
      sub.appendChild(tagEl);
    }
    td.appendChild(sub);
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
 * @param {(key: string) => void} [args.onRescan]  Flag a whole player for
 *   re-scan — rendered by the dossier's Watch-via row (probes-on only).
 * @param {Record<string, number>} [args.rescan]
 * @param {boolean} [args.watchedOnly]
 * @param {boolean} [args.minersOnly]  Keep only huddled "miner" empires
 *   ({@link isMinerProfile}). Skipped in search mode — a name/alliance query
 *   always reveals its match, same rule as every other filter here.
 * @param {Array<{coords: string, player?: number}>} [args.universePlanets]
 * @param {Record<string, Record<string, PlanetReport>>} [args.reportsByPlayer]
 * @param {Record<string, Record<string, PlanetReport>>} [args.moonsByPlayer]
 *   MOON reports per player, keyed by the moon's planet "g:s:p" coord (own map —
 *   a shared one would clobber the planet's row). Dossier 🌙 status + coverage.
 * @param {'planets'|'moons'|'both'} [args.scanBodies]  Scan-chip value — gates
 *   the dossier's per-body ↻ links (no flag for a body the FAB never proposes).
 * @param {number} [args.nowMs]
 * @param {Set<string>} [args.expandedIds]
 * @param {(id: string) => void} [args.onToggleExpand]
 * @param {HTMLElement | null} [args.countInfoEl]
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [args.danger]
 *   Per-player danger profiles (v2) — the free whole-server fleet-finder
 *   columns (Danger D + mobile-fleet ceiling) and their sort axes.
 * @param {Record<string, import('../../domain/raidVerdict.js').RaidVerdict>} [args.verdicts]
 *   Per-player raid verdict (label + loot) shown in the expanded dossier.
 * @param {Record<string, boolean|undefined>} [args.inBand]
 *   Per-player legal-attack-band flag for the dossier header.
 * @param {Map<number, import('../../domain/civilBaseline.js').CivilProfile>} [args.civil]
 *   Per-player civil-fleet baseline shown in the dossier (Etap C).
 * @param {Record<string, import('../../domain/routine.js').RoutineSummary>} [args.routines]
 * @param {Record<string, import('../../domain/scanMode.js').ScanMode>} [args.scanMode]
 *   Scan-mode map threaded to the dossier (per-body/-player probe on/off).
 * @param {(key: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} [args.onSetScanMode]
 *   Set a body override or the whole-player default; `null` clears to inherited.
 * @param {Record<string, import('../../domain/scanMode.js').ScanMode>} [args.galaxyMode]
 *   Per-player galaxy-watch toggle threaded to the dossier's "Watch via" row.
 * @param {(pid: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} [args.onSetGalaxyMode]
 *   Set / clear ('null' = back to on) a player's galaxy-watch toggle.
 * @param {import('../../state/activityObs.js').ActivityObsMap} [args.activityRings]
 *   Galaxy-activity rings (playerId → ringKey → ring) — the dossier's Activity
 *   column + galaxy look-coverage.
 * @param {number} [args.galaxyLookMs]  Galaxy look-coverage stale threshold (ms).
 * @param {Record<string, ReturnType<typeof import('../../domain/presence.js').summarizePresence>>} [args.presences]
 *   Per-player presence summary — the dossier's offline-window heatmap.
 * @param {Record<string, { ledger: import('../../domain/presenceLedger.js').PresenceLedger, allianceMembers: string[] }>} [args.presenceHistories]
 *   Per-player pooled long-horizon presence ledger (local ∪ alliance) — the
 *   dossier's presence-history explorer (months of day×hour coverage).
 * @param {Record<string, import('../../domain/fsBracket.js').FsArc[]>} [args.fsArcs]
 *   Per-player bracketed fleet departures/returns — the dossier's FS-windows block.
 * @param {Record<string, import('../../domain/fleetLanding.js').FleetLandingSignal>} [args.landingSignals]
 *   Per-player fresh fleet-landing signal — the 🎯 row marker + dossier banner.
 * @param {string} [args.searchQuery]  Nickname search (Etap D); when set, the
 *   table shows every name-match INCLUDING excluded players (with the reason).
 * @param {{ ids: Set<string>, labels: string[], query: string }} [args.allianceSearch]
 *   Alliance search — the resolved member ids (see `domain/targets.matchAllianceMembers`),
 *   the matched alliances' `TAG · Name` labels for the caption, and the raw
 *   query for the empty-state text. Behaves like the nickname search: hidden
 *   members surface too, with the reason + "show anyway".
 * @param {Record<string, { name?: string, tag?: string }>} [args.alliances]
 *   alliances.xml (id → {name, tag}) — the source of the `[TAG]` chip next to
 *   a player's name, so an alliance sweep is verifiable row by row.
 * @param {(id: string) => void} [args.onShowAnyway]  "Show anyway" override for
 *   an excluded search hit (force-include the player).
 * @param {Set<string>} [args.pinIds]  Players PINNED into the view by a
 *   deep-link click (dossier ▸ / card / map / ?spy=). A pin bypasses the
 *   top-N row cap and the watched-only scope: the row is appended after the
 *   capped list with a "beyond the cap" note (filters are bypassed upstream
 *   via opts.forceInclude). Without this, opening a player who sits outside
 *   the current view silently did nothing.
 * @param {string} [args.linkBase]  Game origin for the selected universe (e.g.
 *   `https://s163-pl.ogame.gameforge.com`) — turns the dossier's per-body coords
 *   into in-game galaxy links.
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
  minersOnly = false,
  universePlanets = [],
  reportsByPlayer,
  moonsByPlayer,
  scanBodies,
  nowMs = 0,
  expandedIds,
  onToggleExpand,
  countInfoEl,
  danger,
  verdicts,
  inBand,
  civil,
  routines,
  scanMode,
  onSetScanMode,
  galaxyMode,
  onSetGalaxyMode,
  activityRings,
  galaxyLookMs,
  presences,
  presenceHistories,
  fsArcs,
  landingSignals,
  searchQuery = '',
  allianceSearch,
  alliances,
  onShowAnyway,
  pinIds,
  linkBase,
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

  // Search mode overrides the filter: match across the WHOLE candidate set
  // (incl. excluded players), so a hidden player is findable — with the reason
  // it's hidden + a "show anyway" override. Empty query = the normal filter /
  // watched-scope / limit flow.
  //
  // ONE finder, two predicates unioned: the nickname/id match and alliance
  // membership (resolved upstream by domain/targets.matchAllianceMembers over
  // the same string). Two boxes used to split this, and the split was the
  // problem — the user has one question ("show me this thing") and had to know
  // in advance whether what they were typing was a nick, an alliance name or a
  // tag to pick a box.
  const query = searchQuery.trim().toLowerCase();
  const allyIds = allianceSearch?.ids;
  const inSearch = !!query;
  /** @type {Array<{ c: TargetCandidate, reason: string }>} */
  const excludedMatches = [];
  /** @type {TargetCandidate[]} */
  let list;
  if (inSearch) {
    /** @type {(c: TargetCandidate) => boolean} */
    const matches = (c) => playerMatchesQuery(c, query)
      || !!(allyIds && allyIds.has(String(c.id)));
    /** @type {TargetCandidate[]} */
    const kept = [];
    for (const c of candidates) {
      if (!matches(c)) continue;
      const reason = targetExclusionReason(c, opts); // opts carries forceInclude
      if (reason === null) kept.push(c);
      else excludedMatches.push({ c, reason });
    }
    list = sortTargetList(kept, sort.key, sort.dir, hiddenById, dangerById);
  } else {
    const filtered = buildTargetList(candidates, opts);
    let scoped = watchedOnly && watchedIds
      ? filtered.filter((c) => watchedIds.has(c.id))
      : filtered;
    // Huddled-empire scope: the geometry lives on the danger profile, so this is
    // a VIEW filter (like watched-only), not part of targetExclusionReason.
    if (minersOnly) scoped = scoped.filter((c) => isMinerProfile(danger?.get(Number(c.id))));
    list = sortTargetList(scoped, sort.key, sort.dir, hiddenById, dangerById);
  }
  const shown = !inSearch && limit > 0 ? list.slice(0, limit) : list;

  // Deep-link pins: append any pinned player the row cap (or the watched-only
  // scope) dropped, so a "show me this player" click always lands on a row.
  // Skipped in search mode (the query defines the view there). The appended
  // rows get a "beyond the cap" note via `pinnedShown`.
  /** @type {Set<string>} */
  const pinnedShown = new Set();
  if (!inSearch && pinIds && pinIds.size) {
    const have = new Set(shown.map((c) => c.id));
    for (const pid of pinIds) {
      if (have.has(pid)) continue;
      const c = candidates.find((x) => String(x.id) === String(pid));
      if (c) {
        shown.push(c);
        pinnedShown.add(c.id);
      }
    }
  }

  if (inSearch && shown.length === 0 && excludedMatches.length === 0) {
    const p = document.createElement('p');
    p.style.color = '#888';
    p.style.fontSize = '13px';
    // One box, so one message — plus the alliance caveat when the miss could be
    // a cold cache rather than a real miss (the alliances feed rides the same
    // daily cadence as players.xml, so a cache warmed before this feature
    // existed simply has no alliances in it yet).
    const noAllianceFeed = !alliances || Object.keys(alliances).length === 0;
    p.textContent = `No player or alliance matches “${searchQuery.trim()}”.`
      + (noAllianceFeed
        ? ' No alliance list is cached for this universe yet — press ⟳ Refresh above, then search again.'
        : '');
    containerEl.appendChild(p);
    if (countInfoEl) countInfoEl.textContent = '';
    return;
  }

  if (!inSearch && watchedOnly && list.length === 0) {
    const p = document.createElement('p');
    p.style.color = '#888';
    p.style.fontSize = '13px';
    p.textContent =
      'No players on the watch list yet — click “+ watch” next to a target to add it.';
    containerEl.appendChild(p);
    if (countInfoEl) countInfoEl.textContent = '';
    return;
  }

  // Phone layout (see TARGETS_NARROW_MQ): the watch column folds into the
  // Player cell, so the table is 5 columns instead of 6.
  const narrow = typeof window.matchMedia === 'function'
    && window.matchMedia(TARGETS_NARROW_MQ).matches;

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '13px';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  /** @param {TargetSortKey} key */
  const sortable = (key) => ({ sortKey: key, sort, onSort });
  // The watch column's header is the WORD, not a star: the pills below it say
  // "+ watch" / "watched", so a glyph here named nothing (CLAUDE.md iconography).
  if (!narrow) hr.appendChild(headCell('watch'));
  hr.appendChild(headCell('Player'));
  hr.appendChild(headCell('Danger', 'right', sortable('danger')));
  hr.appendChild(headCell('Fleet', 'right', sortable('fleet')));
  hr.appendChild(headCell('Military', 'right', sortable('military')));
  hr.appendChild(headCell('Ships', 'right', sortable('ships')));
  thead.appendChild(hr);
  table.appendChild(thead);

  const COLSPAN = narrow ? 5 : 6;
  const tbody = document.createElement('tbody');
  for (const c of shown) {
    const est = estimates ? estimates[c.id] : undefined;
    const planets = playerPlanets(universePlanets, c.id);
    const reports = reportsByPlayer ? reportsByPlayer[c.id] : undefined;
    const moons = moonsByPlayer ? moonsByPlayer[c.id] : undefined;

    const landing = landingSignals ? landingSignals[c.id] : undefined;

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
      planets,
      reports,
      moons,
      rescan,
      nowMs,
      onRescan,
      scanMode,
      onSetScanMode,
      galaxyMode,
      onSetGalaxyMode,
      rings: activityRings ? activityRings[c.id] : undefined,
      galaxyLookMs,
      presence: presences ? presences[c.id] : undefined,
      presenceHistory: presenceHistories ? presenceHistories[c.id] : undefined,
      fsArcs: fsArcs ? fsArcs[c.id] : undefined,
      landing,
      scanBodies,
      linkBase,
      colspan: COLSPAN,
      open,
    });

    const tr = document.createElement('tr');
    // Anchor for the Galaxy Viewer → Spyglass deep-link (scroll + highlight).
    tr.dataset.playerId = c.id;
    tr.style.cursor = 'pointer';
    // Open dossier ⇒ the row wears the panel background (dossier-open) and
    // acts as the panel's header — the panel itself repeats no name.
    if (open) tr.classList.add('dossier-open');
    // A click anywhere on the row toggles the dossier (interactive cells like
    // the watch chip stopPropagation, so they don't also fire this).
    tr.addEventListener('click', () => {
      const nowOpen = detail.style.display === 'none';
      detail.style.display = nowOpen ? '' : 'none';
      tr.classList.toggle('dossier-open', nowOpen);
      if (onToggleExpand) onToggleExpand(c.id);
    });
    const watched = !!(watchedIds && watchedIds.has(c.id));
    if (!narrow) tr.appendChild(chipCell(c.id, watched, onToggleWatch));
    const pcell = playerCell(c, landing, c.alliance ? alliances?.[String(c.alliance)] : undefined);
    // Deep-link pin marker — says WHY this row sits after the capped list
    // instead of in rank order.
    if (pinnedShown.has(c.id)) {
      const note = document.createElement('span');
      note.textContent = 'outside the cap';
      note.style.cssText = 'display:inline-block;margin-left:7px;font-size:10px;color:#8b95a0;'
        + 'border:1px solid #2a3a45;border-radius:999px;padding:0 7px;vertical-align:1px;white-space:nowrap;';
      note.title = 'Opened from a link — this player sits outside the current row cap / scope, so the row is appended here.';
      // Right after the name span (before the dim block #rank sub-line).
      pcell.insertBefore(note, pcell.firstChild ? pcell.firstChild.nextSibling : null);
    }
    if (narrow) {
      // Phone: the watch pill stacks ABOVE the nick (its column is gone) —
      // prepended AFTER the pin note so the note keeps riding the name line.
      const pillRow = document.createElement('span');
      pillRow.style.cssText = 'display:block;margin-bottom:3px;';
      pillRow.appendChild(watchChip(c.id, watched, onToggleWatch));
      pcell.insertBefore(pillRow, pcell.firstChild);
    }
    tr.appendChild(pcell);
    tr.appendChild(dangerCell(prof));
    tr.appendChild(fleetCell(prof));
    tr.appendChild(militaryCell(c));
    tr.appendChild(shipsCell(c, prof, narrow));
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
  scroller.className = 'table-scroll';
  scroller.appendChild(table);
  containerEl.appendChild(scroller);

  if (countInfoEl) {
    if (inSearch) {
      const hid = excludedMatches.length;
      // When the query hit ALLIANCES, name them — the count alone can't tell
      // "one alliance" from "three that share a substring", and with one merged
      // box it also can't tell an alliance hit from a nickname hit.
      const scope = allianceSearch && allianceSearch.labels.length
        ? `${allianceSearch.labels.join(', ')} — `
        : '';
      countInfoEl.textContent = `${scope}${shown.length} match${shown.length === 1 ? '' : 'es'}`
        + (hid ? ` · ${hid} hidden` : '');
    } else {
      const noun = watchedOnly ? 'on scan list' : 'targets in range';
      // Name the huddled scope in the count — a filter whose only trace is an
      // "on" pill inside a collapsed panel reads as missing data.
      const scope = minersOnly ? 'huddled ' : '';
      countInfoEl.textContent = `${list.length} ${scope}${noun} · showing ${shown.length}`;
    }
  }
}
