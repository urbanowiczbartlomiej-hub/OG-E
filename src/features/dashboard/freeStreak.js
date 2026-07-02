// @ts-check

// Galaxy Viewer renderer — the server analyzer inside the Colonizations →
// "Galaxy Viewer" sub-tab (deliberately DECOUPLED from colonization: hunting
// happens in "Big Colony Hunting"; this view answers "where are the threats,
// farms and quiet space", e.g. for relocating a rolled pearl). Paints the
// threat/farm server map with candidate pins, the zone finder (Best spots /
// Longest streaks, ranked by zone fit) and the interactive detail panel.
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

import {
  findBestRegions,
  findFreeSystems,
  findNeighbourhoodCandidates,
  spaceOutCandidates,
  MIN_REGION_LENGTH,
} from '../../domain/regions.js';
import { ZONES, HARM_WEIGHTS, annotateAndSortByZone } from '../../domain/zoneScore.js';
import { buildThreatFarmField, sampleField } from '../../domain/heatField.js';
import { classifyCell, cellColor, fieldColor } from '../../domain/cellClass.js';
import { STRIP_PRIORITY, bestStatusInSystem } from '../../domain/histogram.js';
import { occupantStrength, honorRank } from '../../domain/players.js';
import {
  STATUS_COLORS, STATUS_LABELS, STRENGTH_COLORS, STRENGTH_LABELS,
  HONOR_COLORS, HONOR_TIER_LABELS, UNSCANNED_COLOR,
} from './palette.js';
import { makeLegendSwatch, makeStatCard } from './legend.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../domain/regions.js').Region} Region
 * @typedef {import('../../domain/regions.js').RegionScore} RegionScore
 */

/**
 * Maximum number of rows shown in the regions table. Matches the "TOP
 * 20" cap from the original `Free_15_position.html` tool — long enough
 * to cover all interesting candidates in a fully-scanned universe,
 * short enough to render fast and stay scannable.
 */
const TOP_N = 20;

/**
 * Fixed half-width of the Best-spots analysis window and the candidate
 * spacing. No longer a user knob: the RANKING reach is set by the physical
 * Offline-window / Farm-reach sliders (the field's decay), so this only
 * defines the census window for the popover/cards, the strip span and how
 * far apart listed spots must be.
 */
const NEIGHBOURHOOD_RADIUS = 15;

/**
 * Enumerate the system numbers a region spans, honouring wrap-around at the
 * 499 → 1 boundary. Shared by the strip and its legend so they always
 * describe the exact same systems.
 *
 * @param {Pick<Region, 'start' | 'end'>} region
 * @param {number} [galaxyMax]
 * @returns {number[]}
 */
const regionSystems = (region, galaxyMax = 499) => {
  /** @type {number[]} */
  const out = [];
  if (region.end >= region.start) {
    for (let s = region.start; s <= region.end; s++) out.push(s);
  } else {
    for (let s = region.start; s <= galaxyMax; s++) out.push(s);
    for (let s = 1; s <= region.end; s++) out.push(s);
  }
  return out;
};

/**
 * All 15 slots. The strip colours a system by the most interesting status
 * across EVERY slot (who lives in the area), not just the target ones.
 */
const ALL_SLOTS = new Set(Array.from({ length: 15 }, (_, i) => i + 1));

/**
 * The single status that colours a system's strip cell: the most
 * interesting one across all 15 slots, ranked threat/occupant-first by
 * {@link STRIP_PRIORITY}. `null` for a never-scanned system.
 *
 * @param {import('../../state/scans.js').SystemScan['positions'] | undefined} positions
 * @returns {import('../../domain/scans.js').PositionStatus | null}
 */
const stripCellStatus = (positions) =>
  positions ? bestStatusInSystem(positions, ALL_SLOTS, STRIP_PRIORITY) : null;

/**
 * Build the friendly hover/pin CARD for one system — a styled popover (à la the
 * in-game "?" help and the planet-badge legend) rather than a cramped one-liner.
 * Header coords + scan time, one coloured row per OCCUPIED slot (status · owner
 * · #rank · ally · flags), a "Free: …" line, and a pin hint. Pure DOM.
 *
 * @param {number} g
 * @param {number} s
 * @param {import('../../state/scans.js').SystemScan | null | undefined} scan
 * @param {boolean} pinned
 * @param {import('../../domain/regions.js').PlayerCache} [players]  Joined by
 *   occupant id to classify active owners into NoobProtection strength bands.
 * @param {string} [linkBase]  Game origin; when set, the card carries an
 *   explicit "Open in game" link (clickable once the card is PINNED — the
 *   hover-preview card is pointer-transparent by design).
 * @returns {HTMLElement}
 */
const buildSystemCard = (g, s, scan, pinned, players, linkBase) => {
  const card = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'rp-head';
  head.textContent = `[${g}:${s}]`;
  card.appendChild(head);

  if (!scan || !scan.positions) {
    const e = document.createElement('div');
    e.textContent = 'Not scanned.';
    card.appendChild(e);
  } else {
    if (scan.scannedAt) {
      const t = document.createElement('div');
      t.className = 'rp-time';
      t.textContent = 'scanned ' + new Date(scan.scannedAt).toLocaleString();
      card.appendChild(t);
    }
    /** @type {number[]} */
    const free = [];
    let occupants = 0;
    for (let pos = 1; pos <= 15; pos++) {
      const p = scan.positions[pos];
      if (!p) continue;
      if (p.status === 'empty') { free.push(pos); continue; }
      occupants++;
      const row = document.createElement('div');
      row.className = 'rp-row';
      // Strength band for an ACTIVE occupant, from the game's NoobProtection
      // flags in the player cache. Drives both the dot tint and the label so a
      // crowded system reads as who-you-can-fight, not a wall of grey "Occupied".
      // null (unflagged / never live-scanned) falls back to the plain status.
      const meta = p.player && players ? players[p.player.id] : undefined;
      const band = p.status === 'occupied' ? occupantStrength(meta) : null;
      const dot = document.createElement('span');
      dot.className = 'rp-dot';
      dot.style.background = band
        ? STRENGTH_COLORS[band]
        : STATUS_COLORS[/** @type {keyof typeof STATUS_COLORS} */ (p.status)] || '#888';
      row.appendChild(dot);
      // When the band label is already "Honorable", the per-slot `honorable`
      // flag is redundant — drop it to avoid "Honorable (honorable, hasMoon)".
      // Otherwise keep it (e.g. a "Strong" honorable target, or the cache-less
      // fallback) so the signal isn't lost.
      const flagKeys = p.flags
        ? Object.keys(p.flags).filter((f) =>
          (band !== 'honorable' || f !== 'honorable') && /** @type {Record<string, unknown>} */ (p.flags)[f])
        : [];
      const flags = flagKeys.length ? ` (${flagKeys.join(',')})` : '';
      // Name: prefer the per-slot scan name, fall back to the cached player name
      // (an API-derived slot often lacks it), then the bare id — never "undefined".
      const pname = p.player
        ? (p.player.name || meta?.name || (p.player.id != null ? `player ${p.player.id}` : 'unknown'))
        : '';
      const who = p.player
        ? ` — ${pname}${typeof p.player.rank === 'number' ? ' #' + p.player.rank : ''}${p.player.ally ? ' ' + p.player.ally : ''}`
        : '';
      const label = band
        ? STRENGTH_LABELS[band]
        : STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (p.status)] || p.status;
      const txt = document.createElement('span');
      txt.textContent = `${pos}: ${label}`;
      row.appendChild(txt);
      // Honour-rank chip (bandit / honoured + tier) — a SEPARATE axis from the
      // strength band: a player can be both "Strong" and a "Bandit King". A
      // banned owner is frozen, so their honour rank isn't a live danger.
      const honor = p.status !== 'banned' ? honorRank(p.player?.rankClass) : null;
      if (honor) {
        const chip = document.createElement('span');
        chip.style.cssText = `margin-left:6px;font-weight:700;color:${HONOR_COLORS[honor.kind]};`;
        // Visibility: the higher the rank, the more marks — red "!" for bandits
        // (the threat convention OG-E already uses), gold "⭐" for honoured.
        chip.textContent = honor.kind === 'bandit'
          ? `${'!'.repeat(honor.tier)} ${HONOR_TIER_LABELS.bandit[honor.tier] || 'Bandit'}`
          : `${'⭐'.repeat(honor.tier)} Honored`;
        chip.title = `${honor.kind === 'bandit' ? 'Bandit' : 'Honoured fighter'} — honour tier ${honor.tier}/3`;
        row.appendChild(chip);
      }
      const rest = document.createElement('span');
      rest.textContent = `${flags}${who}`;
      row.appendChild(rest);
      card.appendChild(row);
    }
    if (!occupants) {
      const e = document.createElement('div');
      e.textContent = 'No occupants — quiet system.';
      card.appendChild(e);
    }
    if (free.length) {
      const f = document.createElement('div');
      f.className = 'rp-free';
      f.textContent = 'Free: ' + free.join(', ');
      card.appendChild(f);
    }
  }

  if (linkBase) {
    const linkRow = document.createElement('div');
    linkRow.className = 'rp-foot';
    const a = document.createElement('a');
    a.href = `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${g}&system=${s}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open in game ↗';
    a.style.color = '#4a9eff';
    linkRow.appendChild(a);
    card.appendChild(linkRow);
  }

  const foot = document.createElement('div');
  foot.className = 'rp-foot';
  foot.textContent = pinned
    ? '📌 pinned — click the cell again to unpin'
    : (linkBase ? 'click a cell to pin — a pinned card is clickable' : 'click a cell to pin');
  card.appendChild(foot);
  return card;
};

/**
 * Build the interactive per-system strip. One cell per system in the region;
 * the colour story depends on the mode:
 *
 *   - `'streak'`        → canonical {@link STATUS_COLORS} (WHAT is in each system),
 *                         same palette as the galaxy map and legend.
 *   - `'neighbourhood'` → the SAME threat/farm field that ranks the candidates
 *                         and paints the server map ({@link fieldColor}): red =
 *                         threat pressure, gold = farm value, dark = quiet. The
 *                         centre system is ringed. Falls back to status colours
 *                         when no field is available (no API data yet).
 *
 * Hovering a cell pops a friendly {@link buildSystemCard} above it (no tooltip
 * wait); clicking PINS it so it stays while you read / compare. Hovering other
 * cells previews them; leaving the strip restores the pinned card (or hides).
 *
 * @param {Pick<Region, 'galaxy' | 'start' | 'end' | 'center'>} region
 * @param {GalaxyScans} scans
 * @param {object} o
 * @param {'streak'|'neighbourhood'} o.mode
 * @param {import('../../domain/heatField.js').ThreatFarmField | null} [o.field]
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]
 * @param {number} [o.galaxyMax]
 * @param {string} [o.linkBase]
 * @returns {HTMLElement}
 */
const buildInteractiveStrip = (region, scans, { mode, field, players, galaxyMax, linkBase }) => {
  const wrap = document.createElement('div');
  wrap.className = 'region-strip-wrap';
  const strip = document.createElement('div');
  strip.className = mode === 'neighbourhood' ? 'region-strip heat' : 'region-strip';
  const pop = document.createElement('div');
  pop.className = 'region-pop';

  /** @type {Map<number, HTMLElement>} */
  const cellBySys = new Map();
  /** @type {number | null} */
  let pinned = null;

  /** @param {number} sys */
  const showFor = (sys) => {
    const cell = cellBySys.get(sys);
    if (!cell) return;
    pop.replaceChildren(buildSystemCard(region.galaxy, sys, scans[`${region.galaxy}:${sys}`], pinned === sys, players, linkBase));
    pop.classList.toggle('pinned', pinned === sys);
    pop.style.display = 'block';
    // Centre the card over the cell, clamped inside the strip's width.
    const popW = pop.offsetWidth;
    const maxLeft = Math.max(0, wrap.clientWidth - popW);
    const left = cell.offsetLeft + cell.offsetWidth / 2 - popW / 2;
    pop.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px';
  };
  const restore = () => {
    if (pinned != null) showFor(pinned);
    else pop.style.display = 'none';
  };

  for (const sys of regionSystems(region, galaxyMax)) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    const scanned = !!sysData?.positions;
    const cell = document.createElement('span');
    cell.className = 'strip-cell';
    if (mode === 'neighbourhood') {
      if (field) {
        const fc = sampleField(field, region.galaxy, sys);
        cell.style.backgroundColor = scanned ? fieldColor(fc.threat, fc.farm) : UNSCANNED_COLOR;
      } else {
        const st = stripCellStatus(sysData?.positions);
        cell.style.backgroundColor = st ? STATUS_COLORS[st] : UNSCANNED_COLOR;
      }
      if (sys === region.center) cell.classList.add('center');
    } else {
      const st = stripCellStatus(sysData?.positions);
      cell.style.backgroundColor = st ? STATUS_COLORS[st] : UNSCANNED_COLOR;
    }
    cellBySys.set(sys, cell);
    cell.addEventListener('mouseenter', () => showFor(sys));
    cell.addEventListener('click', () => {
      if (pinned === sys) { pinned = null; pop.style.display = 'none'; }
      else { pinned = sys; showFor(sys); }
    });
    strip.appendChild(cell);
  }
  strip.addEventListener('mouseleave', restore);

  wrap.append(strip, pop);
  return wrap;
};

/**
 * Open the in-game galaxy view at g:s in a new tab. No-op without a base URL.
 * @param {string|undefined} linkBase  Game origin, e.g. https://s1-en.ogame.gameforge.com
 * @param {number} g @param {number} s
 * @returns {void}
 */
const openGalaxyView = (linkBase, g, s) => {
  if (!linkBase) return;
  window.open(`${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${g}&system=${s}`, '_blank', 'noopener');
};

/**
 * Occupancy lens: a SHARP per-position texture of the whole server — every
 * galaxy as a 499 (systems) × 15 (positions) block, one cell per planet slot,
 * coloured by status ({@link STATUS_COLORS}). No binning/smoothing — occupancy
 * is categorical (a planet is there or not), so blur would only blur the truth.
 * Canvas (≈67k cells); systems scaled to panel width, positions fixed at 2px.
 *
 * @param {HTMLElement} hostEl
 * @param {GalaxyScans} scans
 * @param {{galaxies:number, systems:number}} dims
 * @param {string} [linkBase]  Game origin; when set, clicking opens the galaxy view.
 * @param {number} [ownMilitary]  Our military-highscore points, for threat intensity.
 * @returns {void}
 */
const renderOccupancyMap = (hostEl, scans, { galaxies, systems }, linkBase, ownMilitary) => {
  const POS = 15;
  const posPx = 2;
  const gap = 4;
  const gutter = 24;
  const topPad = 2;
  const stride = POS * posPx + gap;
  const plotH = galaxies * stride - gap + topPad;
  const W = hostEl.clientWidth || 700;
  const cellW = (W - gutter) / systems;
  // Farm "full" scale: p90 of DISTINCT idle accounts' points (deduped by player,
  // so a multi-planet whale counts ONCE and can't inflate the scale and darken
  // every other farm). One pass over the composite.
  /** @type {Map<number, number>} */
  const farmByPlayer = new Map();
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      if (!positions) continue;
      for (let p = 1; p <= POS; p++) {
        const pos = positions[p];
        if (pos && (pos.status === 'inactive' || pos.status === 'long_inactive')
          && pos.player && pos.player.id != null && typeof pos.player.score === 'number') {
          farmByPlayer.set(pos.player.id, pos.player.score);
        }
      }
    }
  }
  const farmScores = [...farmByPlayer.values()].sort((a, b) => a - b);
  const farmScale = farmScores.length ? Math.max(1, farmScores[Math.floor(0.9 * farmScores.length)]) : 1;
  const clsCtx = { ownMilitary, farmScale };
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = `${plotH}px`;
  canvas.style.display = 'block';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(plotH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) { hostEl.appendChild(canvas); return; }
  ctx.scale(dpr, dpr);
  ctx.font = '10px monospace';
  ctx.textBaseline = 'middle';
  for (let g = 1; g <= galaxies; g++) {
    const yBase = topPad + (g - 1) * stride;
    ctx.fillStyle = '#7a8a99';
    ctx.fillText(`G${g}`, 2, yBase + (POS * posPx) / 2);
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      const x = gutter + (s - 1) * cellW;
      for (let p = 1; p <= POS; p++) {
        const pos = positions && positions[p];
        ctx.fillStyle = cellColor(classifyCell(pos ? pos.status : undefined, pos ? pos.player : undefined, clsCtx));
        ctx.fillRect(x, yBase + (p - 1) * posPx, Math.ceil(cellW) + 0.4, posPx);
      }
    }
  }
  hostEl.appendChild(canvas);

  const info = document.createElement('div');
  info.className = 'smap-info';
  info.textContent = 'Hover for the exact coordinate and status.';
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < gutter) { info.textContent = 'Hover for the exact coordinate and status.'; return; }
    const s = Math.floor((mx - gutter) / cellW) + 1;
    const g = Math.floor((my - topPad) / stride) + 1;
    if (s < 1 || s > systems || g < 1 || g > galaxies) { info.textContent = ''; return; }
    const within = (my - topPad) - (g - 1) * stride;
    const p = Math.floor(within / posPx) + 1;
    if (p < 1 || p > POS) { info.textContent = `G${g} · system ${s}`; return; }
    const st = scans[`${g}:${s}`]?.positions?.[p]?.status;
    info.textContent = `G${g}:${s}:${p} — ${st ? (STATUS_LABELS[st] || st) : 'empty'}`;
  });
  if (linkBase) {
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < gutter) return;
      const s = Math.floor((mx - gutter) / cellW) + 1;
      const g = Math.floor((my - topPad) / stride) + 1;
      if (s >= 1 && s <= systems && g >= 1 && g <= galaxies) openGalaxyView(linkBase, g, s);
    });
  }
  hostEl.appendChild(info);

  const legend = document.createElement('div');
  legend.className = 'smap-occ-legend';
  /** @type {Array<[import('../../domain/cellClass.js').CellBucket, string]>} */
  const items = [['free', 'Free'], ['farm', 'Farm (rich → bright)'], ['threat', 'Active threat (stronger → brighter)'], ['blocked', 'Protected'], ['mine', 'Mine']];
  for (const [bucket, label] of items) {
    const sw = document.createElement('span');
    sw.className = 'smap-occ-leg';
    const dot = document.createElement('span');
    dot.className = 'smap-occ-sw';
    dot.style.background = cellColor({ bucket, intensity: 1 });
    sw.append(dot, document.createTextNode(label));
    legend.appendChild(sw);
  }
  hostEl.appendChild(legend);
};

/**
 * Server map: the whole server at a glance, in one of two views — the smooth,
 * strategy-INDEPENDENT threat/farm FIELD (default) or the SHARP per-position
 * occupancy texture. The pane's always-visible top canvas; the caller memoises
 * paints (index.js lastMapPaint) and skips while the host is unmeasurable.
 *
 * @param {object} o
 * @param {HTMLElement} o.hostEl
 * @param {GalaxyScans} o.scans   The composite (API + live) scan map.
 * @param {number} [o.galaxies]   Grid galaxy bound (serverData.galaxies); a
 *   falsy value renders the "no API data" note instead of a map.
 * @param {number} [o.systems]    Grid system bound (serverData.systems).
 * @param {boolean} [o.donutGalaxy] Galaxy axis wraps (serverData).
 * @param {boolean} [o.donutSystem] System axis wraps (serverData).
 * @param {string} [o.view]       'field' (default, threat/farm) or 'occupancy'.
 * @param {number} [o.offlineWindow]  Threat window in hours (default 8) — the
 *   NISZCZ reach.
 * @param {number} [o.farmReach]  Farm glow radius in systems (default 30).
 * @param {string} [o.linkBase]  Game origin (e.g. https://s1-en.ogame.gameforge.com);
 *   used by the occupancy lens's click-to-galaxy. The field view carries NO
 *   bare cell deep-link any more — "Open in game" lives in the popovers and
 *   pins own the click grammar.
 * @param {number} [o.ownMilitary]  Our military-highscore points, for threat intensity.
 * @param {import('../../domain/heatField.js').ThreatFarmField | null} [o.field]
 *   Prebuilt per-system field (the analyzer's scoring field) — reused here by
 *   aggregating per display bin, so one build serves ranking, strips AND map.
 *   Omitted → builds its own at display resolution (legacy path).
 * @param {Region[]} [o.candidates]  The listed top rows — overlaid as pins on
 *   the field view; click selects the matching table row via `onPinClick`.
 * @param {(index: number) => void} [o.onPinClick]
 * @returns {void}
 */
export const renderServerMap = ({ hostEl, scans, galaxies, systems, donutGalaxy, donutSystem, view, offlineWindow, farmReach, linkBase, ownMilitary, field, candidates, onPinClick }) => {
  hostEl.innerHTML = '';
  /** @param {string} msg */
  const note = (msg) => {
    const el = document.createElement('div');
    el.className = 'server-map-empty';
    el.textContent = msg;
    hostEl.appendChild(el);
  };
  if (!galaxies || !systems) {
    note('No API data yet — the server map needs the public-API occupancy feed.');
    return;
  }
  // Two views: the sharp per-position occupancy texture, or (default) the
  // threat/farm field the zone ranking reads.
  if (view === 'occupancy') {
    renderOccupancyMap(hostEl, scans, { galaxies, systems }, linkBase, ownMilitary);
    return;
  }
  // Granularity adapts to the panel width: aim for ~4px cells so the field is
  // as fine as fits. A prebuilt per-system field is downsampled per display
  // bin by MAX (hazard reads must not average away); without one, build at
  // display resolution directly.
  const avail = (hostEl.clientWidth || 700) - 26;
  const cols = Math.max(64, Math.round(avail / 4));
  const src = field
    ?? buildThreatFarmField(scans, { galaxies, systems, donutGalaxy, donutSystem }, { ownMilitary, cols, window: offlineWindow, farmReach });
  const N = Math.min(cols, src.cols);
  /** @type {{ threat: number, farm: number }[][]} */
  const dispGrid = [];
  for (let g = 1; g <= galaxies; g++) {
    dispGrid[g] = [];
    for (let c = 0; c < N; c++) {
      const lo = Math.floor((c * src.cols) / N);
      const hi = Math.max(lo + 1, Math.floor(((c + 1) * src.cols) / N));
      let t = 0;
      let f = 0;
      for (let k = lo; k < hi; k++) {
        const cell = src.grid[g]?.[k];
        if (!cell) continue;
        if (cell.threat > t) t = cell.threat;
        if (cell.farm > f) f = cell.farm;
      }
      dispGrid[g][c] = { threat: t, farm: f };
    }
  }
  const disp = { grid: dispGrid, cols: N, galaxies, binWidth: systems / N };

  const info = document.createElement('div');
  info.className = 'smap-info';
  info.textContent = 'Hover a cell for its system range, threat and farm.';

  // Sparse top axis: a representative system number every 8 columns.
  const axis = document.createElement('div');
  axis.className = 'smap-axis';
  for (let c = 0; c < disp.cols; c++) {
    const a = document.createElement('span');
    if (c % 8 === 0) a.textContent = String(Math.round((c + 0.5) * disp.binWidth));
    axis.appendChild(a);
  }
  hostEl.appendChild(axis);

  for (let g = 1; g <= disp.galaxies; g++) {
    const row = document.createElement('div');
    row.className = 'smap-row';
    const label = document.createElement('span');
    label.className = 'smap-glab';
    label.textContent = `G${g}`;
    row.appendChild(label);
    // Cells live in their own relative wrapper so candidate pins can be
    // absolutely positioned by system fraction, independent of the G label.
    const cellsWrap = document.createElement('span');
    cellsWrap.className = 'smap-cells';
    for (let c = 0; c < disp.cols; c++) {
      const cell = disp.grid[g][c];
      const el = document.createElement('span');
      el.className = 'smap-cell';
      el.style.backgroundColor = fieldColor(cell.threat, cell.farm);
      const lo = Math.round(c * disp.binWidth) + 1;
      const hi = Math.round((c + 1) * disp.binWidth);
      const tv = cell.threat;
      const fv = cell.farm;
      el.addEventListener('mouseenter', () => {
        info.textContent = `G${g} · sys ≈ ${lo}–${hi} · threat ${tv.toFixed(2)} · farm ${fv.toFixed(2)}`;
      });
      cellsWrap.appendChild(el);
    }
    // Top-listed candidates as pins: generous ≥13px targets over the ~4px
    // bins; click selects the matching table row (no bare deep-link — a
    // 2px miss must not navigate the browser away).
    if (candidates) {
      candidates.forEach((r, i) => {
        if (r.galaxy !== g) return;
        const sys = r.center ?? r.start;
        const pin = document.createElement('span');
        pin.className = 'smap-pin';
        pin.style.left = `${(((sys - 0.5) / systems) * 100).toFixed(2)}%`;
        const summary = `#${i + 1} [${g}:${sys}]`
          + (typeof r.fit === 'number' ? ` · fit ${Math.round(r.fit * 100)}` : '')
          + ' — click to select the row';
        pin.title = summary;
        // A pin covers ~3 of the ~4px bins beneath it, so it owns the hover:
        // feed the info line the candidate summary instead of leaving a stale
        // neighbouring-bin readout.
        pin.addEventListener('mouseenter', () => { info.textContent = summary; });
        if (onPinClick) pin.addEventListener('click', () => onPinClick(i));
        cellsWrap.appendChild(pin);
      });
    }
    row.appendChild(cellsWrap);
    hostEl.appendChild(row);
  }

  // Legend: the two channels over the void — colour is relative to this server.
  const legend = document.createElement('div');
  legend.className = 'smap-occ-legend';
  /** @type {Array<[number, number, string]>} */
  const legItems = [[1, 0, 'Threat (RIP reach)'], [0, 1, 'Farm (cargo reach)'], [0, 0, 'Quiet']];
  for (const [lt, lf, lbl] of legItems) {
    const sw = document.createElement('span');
    sw.className = 'smap-occ-leg';
    const dot = document.createElement('span');
    dot.className = 'smap-occ-sw';
    dot.style.background = fieldColor(lt, lf);
    sw.append(dot, document.createTextNode(lbl));
    legend.appendChild(sw);
  }
  if (candidates && candidates.length) {
    const sw = document.createElement('span');
    sw.className = 'smap-occ-leg';
    const dot = document.createElement('span');
    dot.className = 'smap-pin';
    dot.style.cssText = 'position:static;margin:0;display:inline-block;cursor:default;pointer-events:none;';
    sw.append(dot, document.createTextNode('Top spot (click → row)'));
    legend.appendChild(sw);
  }
  hostEl.appendChild(legend);

  hostEl.appendChild(info);
};

/**
 * Build the legend for a region strip: one swatch per status actually
 * painted in THIS region (plus "Not scanned" when any cell is blank), in
 * {@link STRIP_PRIORITY} order. Without it the unified palette is just
 * unlabelled colours; with it the strip reads on its own — directly
 * addressing the "the colours don't say much" feedback.
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @param {number} [galaxyMax]
 * @returns {HTMLElement}
 */
const buildStripLegend = (region, scans, galaxyMax) => {
  /** @type {Set<string>} */
  const present = new Set();
  let anyUnscanned = false;
  for (const sys of regionSystems(region, galaxyMax)) {
    const st = stripCellStatus(scans[`${region.galaxy}:${sys}`]?.positions);
    if (st) present.add(st);
    else anyUnscanned = true;
  }

  const legend = document.createElement('div');
  legend.className = 'region-legend';
  for (const st of STRIP_PRIORITY) {
    if (present.has(st)) {
      legend.appendChild(makeLegendSwatch(STATUS_COLORS[st], STATUS_LABELS[st]));
    }
  }
  if (anyUnscanned) {
    legend.appendChild(makeLegendSwatch(UNSCANNED_COLOR, 'Not scanned', { border: true }));
  }
  return legend;
};

/**
 * Build the tooltip text for the "Nbrs" table cell — the neighbourhood at a
 * glance. Surfaces, in priority order: the population split, the danger lines
 * (bandits with max tier, strong / active-on-vacation), honoured fighters, how
 * many neighbours OUT-RANK you (stronger than you on the highscore), and the
 * social signals. No "scanned coverage" line — with the API feed every system
 * is known, so it was always "N/N" noise.
 *
 * @param {import('../../domain/regions.js').RegionScore} s
 * @param {number} [ownRank]  Our highscore rank, to count "ranked above you".
 * @returns {string}
 */
const buildNbrsTip = (s, ownRank) => {
  /** @type {string[]} */
  const parts = [];
  const pop = [];
  if (s.occupied) pop.push(`${s.occupied} active`);
  if (s.inactive) pop.push(`${s.inactive} farmable`);
  if (s.vacation) pop.push(`${s.vacation} vacation`);
  parts.push(pop.length ? pop.join(', ') : 'no players in range');

  const threat = [];
  if (s.bandits) threat.push(`${s.bandits} bandit${s.bandits > 1 ? 's' : ''} (max tier ${s.banditMaxLevel}/3)`);
  if (s.strong) threat.push(`${s.strong} strong`);
  if (s.activeOnVacation) threat.push(`${s.activeOnVacation} active-on-vacation`);
  if (threat.length) parts.push('⚠ ' + threat.join(', '));

  if (s.honored) parts.push(`${s.honored} honored (max tier ${s.honoredMaxLevel}/3)`);
  if (s.honorable) parts.push(`🎯 ${s.honorable} honorable target${s.honorable > 1 ? 's' : ''}`);

  // Rank-relative danger: how many neighbours sit ABOVE us (lower rank number =
  // stronger). The headline reason a new colony gets farmed.
  if (s.ranks.length) {
    if (typeof ownRank === 'number' && ownRank > 0) {
      const above = s.ranks.filter((r) => r < ownRank).length;
      const top = s.ranks[0];
      parts.push(above
        ? `⚠ ${above} ranked above you (strongest #${top}, ${ownRank - top} above)`
        : `none ranked above you (strongest #${top})`);
    } else {
      parts.push(`strongest neighbour #${s.ranks[0]}`);
    }
  }

  const social = [];
  if (s.outlaw) social.push(`${s.outlaw} outlaw`);
  if (s.allyNearby) social.push(`${s.allyNearby} allied`);
  if (s.buddy) social.push(`${s.buddy} buddy`);
  if (s.newbie) social.push(`${s.newbie} newbie (protected)`);
  if (social.length) parts.push(social.join(', '));

  return parts.join('\n');
};

/**
 * "Fit" cell text + tooltip for a zone-annotated region: the 0–100 number
 * broken into its bounded channels, so the ranking explains itself in place.
 *
 * @param {Region} r
 * @returns {{ text: string, tip: string }}
 */
const fitCell = (r) => {
  if (typeof r.fit !== 'number' || !r.channels) return { text: '—', tip: '' };
  const c = r.channels;
  return {
    text: String(Math.round(r.fit * 100)),
    tip: `safety ${c.safety.toFixed(2)} · farm ${c.farm.toFixed(2)} · streak ${c.streak.toFixed(2)}`
      + ` · targets ${c.target.toFixed(2)}\nscan coverage ${Math.round(c.coverage * 100)}%`,
  };
};

/** Shared header tooltip for the Fit column. */
const FIT_TIP = 'Zone fit 0–100 — weighted safety / farm / streak / targets, blended by scan coverage';

/**
 * Build a `<table class="streak-table">` with one row per region up to
 * `TOP_N`. The "Nbrs" column shows the total player count (active +
 * inactive) derived from the region's neighbourhood score — a quick
 * signal of how crowded the area is. '?' means no scan data in range.
 *
 * @param {Region[]} results
 * @param {number} [ownRank]  Forwarded to the Nbrs tooltip for "ranked above you".
 * @returns {HTMLTableElement}
 */
const buildTable = (results, ownRank) => {
  const table = document.createElement('table');
  table.className = 'streak-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [label, title] of [
    ['#', ''],
    ['Fit', FIT_TIP],
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
    const fit = fitCell(r);
    /** @type {[string, boolean, string][]} */
    const cells = [
      [String(i + 1), true, ''],
      [fit.text, true, fit.tip],
      [String(r.galaxy), false, ''],
      [String(r.start), true, ''],
      [String(r.end), true, ''],
      [String(r.length), true, ''],
      [String(r.matched), true, ''],
      [r.gaps ? String(r.gaps) : '—', true, ''],
      [nbrs, true, s ? buildNbrsTip(s, ownRank) : 'No scan data in range'],
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
 * Compact points formatter for the stat cards: 1.2M / 340k / 850.
 * @param {number} n
 * @returns {string}
 */
const fmtPts = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/**
 * The neighbourhood {@link RegionScore} as a wrapping row of stat cards (same
 * look as the galaxy "Scanned data" tab) — replaces the old dense one-liner.
 * Each meaningful metric becomes a colour-coded card (threats red/orange, farm
 * value gold/green, neutral counts grey-blue), shown only when non-zero, with
 * the detail in the card tooltip.
 *
 * @param {RegionScore} s
 * @param {number} [ownRank]
 * @returns {HTMLElement}
 */
const buildScoreCards = (s, ownRank) => {
  /** @type {Array<{ value: string|number, label: string, color: string, title?: string }>} */
  const cards = [];
  const NEUTRAL = '#9fb4c4';

  if (s.occupied) {
    cards.push({ value: s.occupied, label: 'Active', color: STRENGTH_COLORS.normal, title: 'Active occupants in range — how crowded it is' });
  }
  if (s.inactive) {
    cards.push({ value: s.inactive, label: 'Farmable', color: STATUS_COLORS.inactive, title: 'Inactive players — farm targets that cannot defend' });
  }
  if (s.vacation) {
    cards.push({ value: s.vacation, label: 'Vacation', color: STATUS_COLORS.vacation, title: 'On vacation or banned — protected, neither farm nor threat' });
  }
  if (s.allianceCount) {
    cards.push({ value: s.allianceCount, label: s.allianceCount === 1 ? 'Alliance' : 'Alliances', color: '#4a9eff', title: 'Distinct alliance tags in range' });
  }
  if (s.honored) {
    cards.push({
      value: s.honored,
      label: `Honored${s.honoredMaxLevel ? ` ${'★'.repeat(s.honoredMaxLevel)}` : ''}`,
      color: HONOR_COLORS.honored,
      title: 'Positive-honour fighters — prefer stronger targets than a fresh colony',
    });
  }
  // Bandit aggressors, broken out by tier (King → Lord → Bandit) — the danger
  // signal for a new colony.
  for (const t of [3, 2, 1]) {
    const n = s.banditTiers?.[t];
    if (n) {
      cards.push({
        value: n,
        label: HONOR_TIER_LABELS.bandit[t],
        color: HONOR_COLORS.bandit,
        title: 'Negative-honour aggressor — a danger for a fresh colony',
      });
    }
  }
  if (s.strong) {
    cards.push({ value: s.strong, label: 'Strong', color: STRENGTH_COLORS.strong, title: 'Outside your protection bracket — out-gun a fresh colony' });
  }
  if (s.activeOnVacation) {
    cards.push({ value: s.activeOnVacation, label: 'Active-on-vac', color: '#e0a020', title: 'A live player hiding behind vacation mode — not a safe farm' });
  }
  if (s.honorable) {
    cards.push({ value: s.honorable, label: 'Honorable', color: STRENGTH_COLORS.honorable, title: 'A fair fight — attacking earns honour' });
  }
  if (s.normal) {
    cards.push({ value: s.normal, label: 'Normal', color: STRENGTH_COLORS.normal, title: 'Plain "white" farm targets' });
  }
  if (s.newbie) {
    cards.push({ value: s.newbie, label: 'Weak', color: STRENGTH_COLORS.weak, title: 'Noob-protected — cannot be raided' });
  }
  if (s.allyNearby) cards.push({ value: s.allyNearby, label: 'Ally', color: '#5a8f5a', title: 'Players in your alliance' });
  if (s.buddy) cards.push({ value: s.buddy, label: 'Buddy', color: '#5a8f5a', title: 'Players on your buddy list' });
  if (s.outlaw) cards.push({ value: s.outlaw, label: 'Outlaw', color: '#e0a020', title: 'Lost protection by raiding the weak — fair game' });
  if (s.ranks.length) {
    const top = s.ranks[0];
    let rel = `highscore rank #${top}`;
    if (typeof ownRank === 'number' && ownRank > 0) {
      const d = ownRank - top;
      rel = d > 0 ? `${d} ranks above you` : d < 0 ? `${-d} ranks below you` : 'the same rank as you';
    }
    cards.push({ value: `#${top}`, label: 'Top rank', color: NEUTRAL, title: rel });
  }
  if (s.avgTotal) {
    cards.push({ value: fmtPts(s.avgTotal), label: 'Avg points', color: NEUTRAL, title: 'Mean total-highscore points of neighbours in range — how strong the area is' });
  }
  if (s.avgMilitary) {
    cards.push({ value: fmtPts(s.avgMilitary), label: 'Avg military', color: '#e0a020', title: 'Mean military points of neighbours — where fleets concentrate (target-rich for an aggressor)' });
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;';
  for (const c of cards) row.appendChild(makeStatCard(c.color, c.value, c.label, c.title));
  return row;
};

/**
 * Field legend for the neighbourhood strip — the same three swatches as the
 * server map, generated from {@link fieldColor} itself so it can never drift
 * from the rendering.
 */
const buildFieldLegend = () => {
  const legend = document.createElement('div');
  legend.className = 'region-legend';
  /** @type {Array<[number, number, string]>} */
  const items = [[1, 0, 'Threat'], [0, 1, 'Farm'], [0, 0, 'Quiet']];
  for (const [t, f, label] of items) {
    legend.appendChild(makeLegendSwatch(fieldColor(t, f), label));
  }
  legend.appendChild(makeLegendSwatch(UNSCANNED_COLOR, 'Not scanned', { border: true }));
  return legend;
};

/**
 * "Ignoring N worst: …" line listing the players the window's score dropped,
 * with their bandit tier and rank relative to us — so it's explicit WHAT the
 * user is choosing to overlook.
 *
 * @param {NonNullable<Region['excluded']>} excluded
 * @param {number} [ownRank]
 * @returns {HTMLElement}
 */
const buildExcludedLine = (excluded, ownRank) => {
  const el = document.createElement('div');
  el.className = 'region-excluded';
  const names = excluded.map((p) => {
    const tier = p.rankClass && p.rankClass.startsWith('rank_bandit')
      ? ` (bandit${p.rankClass.slice(-1)})` : '';
    let rel = '';
    if (typeof p.rank === 'number') {
      if (typeof ownRank === 'number' && ownRank > 0) {
        const d = ownRank - p.rank;
        rel = d > 0 ? ` #${p.rank}, ${d} above you` : d < 0 ? ` #${p.rank}, ${-d} below you` : ` #${p.rank}`;
      } else {
        rel = ` #${p.rank}`;
      }
    }
    return `${p.name || 'player ' + p.id}${tier}${rel}`;
  });
  el.textContent = `Ignoring ${excluded.length} worst: ${names.join('; ')}`;
  return el;
};

/**
 * Build the neighbourhood-mode candidate table: one row per scored settle area,
 * each selecting the detail panel below when clicked. Columns differ from the
 * streak table — there's no streak length / gaps, but there IS a centre system
 * and an "ignored" count.
 *
 * @param {Region[]} results  Already sorted + spaced; rendered up to TOP_N.
 * @param {number} [ownRank]  Forwarded to the Nbrs tooltip for "ranked above you".
 * @returns {HTMLTableElement}
 */
const buildCandidateTable = (results, ownRank) => {
  const table = document.createElement('table');
  table.className = 'streak-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [labelText, title] of [
    ['#', ''],
    ['Fit', FIT_TIP],
    ['Galaxy', ''],
    ['System', 'The free-slot system at the centre of the window'],
    ['Window', 'Systems analysed around the spot'],
    ['Nbrs', 'Players in the window (active + dormant)'],
    ['Ignored', "Worst players dropped from this window's score"],
  ]) {
    const th = document.createElement('th');
    th.textContent = labelText;
    if (title) th.title = title;
    if (labelText !== 'Galaxy') th.style.textAlign = 'right';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.slice(0, TOP_N).forEach((r, i) => {
    const tr = document.createElement('tr');
    const s = r.score;
    const nbrs = s ? String(s.occupied + s.inactive) : '?';
    const ignored = r.excluded && r.excluded.length ? String(r.excluded.length) : '—';
    const fit = fitCell(r);
    /** @type {[string, boolean, string][]} */
    const cells = [
      [String(i + 1), true, ''],
      [fit.text, true, fit.tip],
      [String(r.galaxy), false, ''],
      [String(r.center ?? r.start), true, ''],
      [`${r.start}–${r.end}`, true, r.end < r.start ? 'wraps across the 499 → 1 boundary' : ''],
      [nbrs, true, s ? buildNbrsTip(s, ownRank) : 'No scan data in range'],
      [ignored, true, ''],
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
 * Interactive detail panel for the SELECTED candidate (default = top row).
 * Carries the coords, the one-line score summary, the per-system strip
 * (status colours in streak mode, intent HEAT in neighbourhood mode) and an
 * always-visible detail line that updates the instant a strip cell is
 * hovered/clicked — defaulting to the centre/first system so there's never a
 * blank "hover and wait" state. Neighbourhood mode also shows the heat legend
 * and the "ignoring N worst" line.
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @param {object} o
 * @param {'streak'|'neighbourhood'} o.mode
 * @param {import('../../domain/heatField.js').ThreatFarmField | null} [o.field]
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]
 * @param {number} [o.ownRank]
 * @param {number} [o.galaxyMax]
 * @param {string} [o.linkBase]
 * @returns {HTMLElement}
 */
const buildDetail = (region, scans, { mode, field, players, ownRank, galaxyMax, linkBase }) => {
  const nbr = mode === 'neighbourhood';
  const el = document.createElement('div');
  el.className = 'streak-record';

  const labelLine = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'label';
  const value = document.createElement('span');
  value.className = 'value';
  if (nbr) {
    label.textContent = 'Selected spot: ';
    value.textContent = `G${region.galaxy}:${region.center} · ±${(region.length - 1) / 2} sys`;
  } else {
    label.textContent = 'Top streak: ';
    value.textContent = `${region.length} systems`;
  }
  labelLine.append(label, value);

  const coords = document.createElement('div');
  coords.style.cssText = 'color:#888;font-size:12px;margin-top:4px;';
  coords.textContent = nbr
    ? `Galaxy ${region.galaxy}, system ${region.center} · window ${region.start} → ${region.end}`
      + (region.end < region.start ? ' (wraps 499 → 1)' : '')
    : `Galaxy ${region.galaxy}, system ${region.start} → ${region.end}`
      + (region.gaps ? ` (${region.matched} free, ${region.gaps} gap${region.gaps === 1 ? '' : 's'})` : '')
      + (region.end < region.start ? ' (wraps across the 499 → 1 boundary)' : '');
  el.append(labelLine, coords);

  const s = region.score;
  if (s) {
    // Neighbourhood score as stat cards (same look as the galaxy Scanned-data
    // tab) instead of a dense one-liner — sat right above the per-system strip.
    el.appendChild(buildScoreCards(s, ownRank));

    el.appendChild(buildInteractiveStrip(region, scans, { mode, field, players, galaxyMax, linkBase }));

    if (nbr) {
      el.appendChild(field ? buildFieldLegend() : buildStripLegend(region, scans, galaxyMax));
      if (region.excluded && region.excluded.length) {
        el.appendChild(buildExcludedLine(region.excluded, ownRank));
      }
    } else {
      el.appendChild(buildStripLegend(region, scans, galaxyMax));
    }
  }

  return el;
};

/**
 * Wire a results table + detail panel into an interactive pair: clicking a row
 * selects which candidate the panel describes (default = top row). Shared by
 * both modes; `tableBuilder` differs (streak vs candidate columns).
 *
 * @param {HTMLElement} containerEl
 * @param {Region[]} results
 * @param {GalaxyScans} scans
 * @param {{ mode: 'streak'|'neighbourhood', field?: import('../../domain/heatField.js').ThreatFarmField | null, players?: import('../../domain/regions.js').PlayerCache, ownRank?: number, galaxyMax?: number, linkBase?: string }} detailOpts
 * @param {(rows: Region[], ownRank?: number) => HTMLTableElement} tableBuilder
 * @returns {Region[]} The rows actually shown (≤ TOP_N) — the caller overlays
 *   them as map pins.
 */
const renderInteractive = (containerEl, results, scans, detailOpts, tableBuilder) => {
  const shown = results.slice(0, TOP_N);
  const table = tableBuilder(shown, detailOpts.ownRank);
  const detailHost = document.createElement('div');
  const rows = [...table.querySelectorAll('tbody tr')];
  /** @param {number} i */
  const select = (i) => {
    rows.forEach((r, j) => r.classList.toggle('selected', j === i));
    detailHost.textContent = '';
    detailHost.appendChild(buildDetail(shown[i], scans, detailOpts));
  };
  rows.forEach((r, i) => r.addEventListener('click', () => select(i)));
  containerEl.appendChild(table);
  containerEl.appendChild(detailHost);
  if (shown.length) select(0);
  selectByContainer.set(containerEl, select);
  return shown;
};

/**
 * The current render's row-select function, keyed by container — lets the map
 * pins select a table row without threading callbacks through every repaint
 * (the entry is replaced wholesale on each renderInteractive).
 *
 * @type {WeakMap<HTMLElement, (i: number) => void>}
 */
const selectByContainer = new WeakMap();

/**
 * Select the i-th listed candidate in the container's results table (as if
 * its row was clicked). No-op when nothing is rendered there.
 *
 * @param {HTMLElement} containerEl
 * @param {number} i
 * @returns {void}
 */
export const selectCandidate = (containerEl, i) => {
  selectByContainer.get(containerEl)?.(i);
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
 * @property {string} [zone]
 *   Key of {@link ZONES} — what a good area means for the ranking. Defaults
 *   to `'safe'`; unknown keys fall back to it.
 * @property {string} [find]
 *   Search shape: `'spots'` (default — rate the window around every system
 *   with ANY listed slot free) or `'streaks'` (contiguous runs where EVERY
 *   listed slot is empty; Tolerance applies).
 * @property {number} [excludeN]
 *   Best-spots only: how many worst (most threatening) players to drop from
 *   each window's score. Default 0.
 * @property {import('../../domain/heatField.js').ThreatFarmField | null} [field]
 *   The threat/farm field built over the SAME composite at per-system
 *   resolution — the ranking substrate and the strip colouring. `null` (no
 *   API data yet) degrades gracefully (see zoneScore).
 * @property {number} [galaxyMax]
 *   Systems per galaxy from the server's API bounds. Default 499.
 * @property {string} [linkBase]
 *   Game origin (e.g. https://s1-en.ogame.gameforge.com) — puts an explicit
 *   "Open in game" link on the system popover cards.
 * @property {number} [ownMilitary]
 *   Own military points — the threat anchor for the field-aware Ignore-worst
 *   exclusion (same anchor the field was built with).
 * @property {import('../../domain/regions.js').PlayerCache} [players]
 *   Per-universe player-metadata cache (`state/players.js`). Forwarded to the
 *   region finders → `scoreRegion` to enrich neighbourhood scoring with the
 *   strong/newbie/buddy/outlaw/active-on-vacation signals and game-truth
 *   `allyNearby`. Omit to score from scan data alone.
 * @property {number} [ownRank]
 *   Our own highscore rank (`state/ownProfile.js`). When set, the Top-region
 *   record shows the strongest neighbour's rank RELATIVE to us
 *   ("#11 (239 above you)"). Omit to show the bare rank.
 */

/**
 * The last find's raw (pre-annotation) candidate list per search path. The
 * finders + scoreRegion census are the expensive half of a repaint and don't
 * depend on the zone or the field knobs — so dragging Offline/Farm-reach only
 * re-annotates and re-sorts. Keyed by input identities (a fresh scans/players
 * object — universe switch, reload, test fixture — misses naturally).
 *
 * @type {Map<string, { scansRef: unknown, playersRef: unknown, optKey: string, value: Region[] }>}
 */
const findCache = new Map();

/**
 * @param {string} pathKey
 * @param {unknown} scansRef
 * @param {unknown} playersRef
 * @param {string} optKey
 * @param {() => Region[]} compute
 * @returns {Region[]}
 */
const cachedFind = (pathKey, scansRef, playersRef, optKey, compute) => {
  const e = findCache.get(pathKey);
  if (e && e.scansRef === scansRef && e.playersRef === playersRef && e.optKey === optKey) {
    return e.value;
  }
  const value = compute();
  findCache.set(pathKey, { scansRef, playersRef, optKey, value });
  return value;
};

/**
 * Repaint the analyzer block against `scans` for the requested slots +
 * controls. Owns the empty-state branch: when nothing matched, the table area
 * gets a single `.empty`-class line and no record card.
 *
 * @param {RenderFreeRegionsOptions} opts
 * @returns {Region[]} The rows actually listed (≤ TOP_N; empty on the
 *   empty-state paths) — the caller overlays them as map pins.
 */
export const renderFreeRegions = ({ containerEl, countInfoEl, scans, positions, maxGaps, zone, find, excludeN, field, galaxyMax, linkBase, ownMilitary, players, ownRank }) => {
  containerEl.innerHTML = '';

  const zoneKey = ZONES[zone ?? ''] ? /** @type {string} */ (zone) : 'safe';
  const spots = (find ?? 'spots') !== 'streaks';
  const gMax = galaxyMax ?? 499;
  /** @type {import('../../domain/zoneScore.js').ZoneContext} */
  const ctx = { field: field ?? null, scans, positions, status: 'empty', galaxyMax: gMax, ownMilitary };
  /** @param {Region[]} list @returns {Region[]} */
  const sortByZone = (list) => annotateAndSortByZone(list, zoneKey, ctx);
  const zoneLabel = ` · ${ZONES[zoneKey].label}`;
  const posLabel = positions.join(', ');
  /** @param {number} n @returns {string} */
  const galaxiesLabel = (n) => `${n} galax${n === 1 ? 'y' : 'ies'}`;
  // Both empty causes look identical to the user, so name the action that
  // actually populates the analyzer: opening the game warms the API cache
  // (manual galaxy scanning no longer feeds the dashboard).
  const emptyAdvice =
    'Open the in-game galaxy view once so OG-E can fetch the server data, or widen the slots.';

  // ── Best spots: scored neighbourhood windows around every free-slot system ──
  if (spots) {
    const candidates = spaceOutCandidates(
      sortByZone(cachedFind('spots', scans, players, `${posLabel}|${excludeN ?? 0}|${ownRank ?? ''}|${gMax}`, () =>
        findNeighbourhoodCandidates(scans, {
          positions,
          status: 'empty',
          radius: NEIGHBOURHOOD_RADIUS,
          players,
          ownRank,
          excludeN: excludeN ?? 0,
          weights: HARM_WEIGHTS,
          galaxyMax: gMax,
        }))),
      NEIGHBOURHOOD_RADIUS,
      gMax,
    );
    if (candidates.length > 0) {
      if (countInfoEl) {
        const galaxyCount = new Set(candidates.map((c) => c.galaxy)).size;
        const showingLabel = candidates.length > TOP_N ? ` (showing top ${TOP_N})` : '';
        countInfoEl.textContent =
          `${candidates.length} spot${candidates.length === 1 ? '' : 's'} across `
          + `${galaxiesLabel(galaxyCount)}${zoneLabel}${showingLabel}`;
      }
      return renderInteractive(containerEl, candidates, scans, { mode: 'neighbourhood', field, players, ownRank, galaxyMax: gMax, linkBase }, buildCandidateTable);
    }
    if (countInfoEl) countInfoEl.textContent = 'No spots yet for these slots.';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      `No system has slot${positions.length === 1 ? '' : 's'} ${posLabel} free yet. ${emptyAdvice}`;
    containerEl.appendChild(empty);
    return [];
  }

  const results = sortByZone(
    cachedFind('streaks', scans, players, `${posLabel}|${maxGaps}|${gMax}`, () =>
      findBestRegions(scans, { positions, status: 'empty', maxGaps, players, galaxyMax: gMax })),
  );

  // Happy path: contiguous streaks of length ≥ MIN_REGION_LENGTH exist.
  if (results.length > 0) {
    if (countInfoEl) {
      const galaxyCount = new Set(results.map((r) => r.galaxy)).size;
      const showingLabel = results.length > TOP_N ? ` (showing top ${TOP_N})` : '';
      countInfoEl.textContent =
        `${results.length} streak${results.length === 1 ? '' : 's'} across `
        + `${galaxiesLabel(galaxyCount)}${zoneLabel}${showingLabel}`;
    }
    return renderInteractive(containerEl, results, scans, { mode: 'streak', field, players, ownRank, galaxyMax: gMax, linkBase }, buildTable);
  }

  // Fallback: no run of MIN_REGION_LENGTH, but individual free systems may
  // still exist — the common single-slot case (scattered free "8"s never form
  // a streak; see findFreeSystems). List them, zone-ranked, instead of a bare
  // "nothing here".
  const freeSystems = sortByZone(
    cachedFind('free-systems', scans, players, `${posLabel}|${gMax}`, () =>
      findFreeSystems(scans, { positions, status: 'empty', players, galaxyMax: gMax })),
  );
  if (freeSystems.length > 0) {
    if (countInfoEl) {
      const galaxyCount = new Set(freeSystems.map((r) => r.galaxy)).size;
      const showingLabel = freeSystems.length > TOP_N ? ` (showing top ${TOP_N})` : '';
      countInfoEl.textContent =
        `No streak ≥${MIN_REGION_LENGTH} — ${freeSystems.length} individual free `
        + `system${freeSystems.length === 1 ? '' : 's'} across `
        + `${galaxiesLabel(galaxyCount)}${zoneLabel}${showingLabel}`;
    }
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent =
      `No run of ${MIN_REGION_LENGTH}+ systems has slot${positions.length === 1 ? '' : 's'} `
      + `${posLabel} all free — here are the individual free systems instead `
      + '(best zone fit first):';
    containerEl.appendChild(note);
    return renderInteractive(containerEl, freeSystems, scans, { mode: 'streak', field, players, ownRank, galaxyMax: gMax, linkBase }, buildTable);
  }

  // Truly nothing for these slots yet.
  if (countInfoEl) {
    countInfoEl.textContent = 'No confirmed empty streaks yet for these slots.';
  }
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = `Nothing to show yet for slot${positions.length === 1 ? '' : 's'} ${posLabel}. ${emptyAdvice}`;
  containerEl.appendChild(empty);
  return [];
};
