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
import { DANGER_LABELS } from '../../domain/dangerScore.js';
import {
  STATUS_COLORS, STATUS_LABELS, STRENGTH_COLORS,
  HONOR_TIER_LABELS, UNSCANNED_COLOR,
} from './palette.js';
import { buildSystemCard, dangerBadge } from './mapPrimitives.js';
import { makeLegendSwatch } from './legend.js';

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
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [o.danger]
 * @returns {HTMLElement}
 */
const buildInteractiveStrip = (region, scans, { mode, field, players, galaxyMax, linkBase, danger }) => {
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
    pop.replaceChildren(buildSystemCard(region.galaxy, sys, scans[`${region.galaxy}:${sys}`], pinned === sys, players, linkBase, danger));
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
 * Sparse numeric axis above a map body: `count` flex spans, a representative
 * system number every 8th. Shared by BOTH map views so they read the same
 * (the occupancy canvas used to have no axis at all — a system couldn't be
 * located without hovering).
 *
 * @param {number} count  Flex columns (aligns with the view's display bins).
 * @param {number} binWidth  Systems per column.
 * @returns {HTMLElement}
 */
const buildAxis = (count, binWidth) => {
  const axis = document.createElement('div');
  axis.className = 'smap-axis';
  for (let c = 0; c < count; c++) {
    const a = document.createElement('span');
    if (c % 8 === 0) a.textContent = String(Math.round((c + 0.5) * binWidth));
    axis.appendChild(a);
  }
  return axis;
};

/**
 * Legend entry with a mini GRADIENT bar for a RAMPED bucket — a flat
 * full-intensity swatch under a "→ brighter" label contradicts itself.
 *
 * @param {(v: number) => string} colorAt  Ramp sample (0..1 → css colour).
 * @param {string} label
 * @returns {HTMLElement}
 */
const makeRampLegend = (colorAt, label) => {
  const sw = document.createElement('span');
  sw.className = 'smap-occ-leg';
  const bar = document.createElement('span');
  bar.className = 'smap-leg-ramp';
  bar.style.background = `linear-gradient(90deg, ${colorAt(0.25)}, ${colorAt(0.6)}, ${colorAt(1)})`;
  sw.append(bar, document.createTextNode(label));
  return sw;
};

/**
 * One candidate pin — shared by both map views so the interaction grammar is
 * identical: tooltip + hover readout + click/Enter selects the table row.
 * Positioning (left/top) is the caller's job.
 *
 * @param {number} i  Candidate index (row number − 1).
 * @param {Region} r
 * @param {HTMLElement} info  The map's readout line.
 * @param {((index: number) => void) | undefined} onPinClick
 * @returns {HTMLElement}
 */
const buildPin = (i, r, info, onPinClick) => {
  const sys = r.center ?? r.start;
  const pin = document.createElement('span');
  pin.className = 'smap-pin';
  pin.dataset.pinIndex = String(i);
  const summary = `#${i + 1} [${r.galaxy}:${sys}]`
    + (typeof r.fit === 'number' ? ` · fit ${Math.round(r.fit * 100)}` : '')
    + ' — click to select the row';
  pin.title = summary;
  // A pin covers the bins beneath it, so it owns the hover: feed the info
  // line the candidate summary instead of leaving a stale bin readout.
  pin.addEventListener('mouseenter', () => { info.textContent = summary; });
  if (onPinClick) {
    pin.tabIndex = 0;
    pin.setAttribute('role', 'button');
    pin.addEventListener('click', () => onPinClick(i));
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(i); }
    });
  }
  return pin;
};

/**
 * Highlight the index-th candidate pin on the server map (either view) — the
 * REVERSE of the pin→row link, so selecting a table row lights its pin too.
 * Idempotent over the host's current pin DOM; −1 clears.
 *
 * @param {HTMLElement | null} hostEl  The map host (#serverMapHost).
 * @param {number} index
 * @returns {void}
 */
export const highlightPin = (hostEl, index) => {
  if (!hostEl) return;
  for (const pin of hostEl.querySelectorAll('.smap-pin[data-pin-index]')) {
    const el = /** @type {HTMLElement} */ (pin);
    el.classList.toggle('sel', Number(el.dataset.pinIndex) === index);
  }
};

/** Occupancy map's idle readout text (also the mouseleave reset). */
const OCC_HINT = 'Hover for the exact coordinate and status · click to pin a system card.';

/**
 * Occupancy lens: a SHARP per-position texture of the whole server — every
 * galaxy as a 499 (systems) × 15 (positions) block, one cell per planet slot,
 * coloured by status ({@link STATUS_COLORS}). No binning/smoothing — occupancy
 * is categorical (a planet is there or not), so blur would only blur the truth.
 * Canvas (≈67k cells); systems scaled to panel width, positions fixed at 2px.
 *
 * Interactions mirror the field view: candidate pins select their table row,
 * and clicking a system PINS its popover card (with "Open in game" inside) —
 * never a bare deep-link, because at ~1–2px per system a click must not
 * navigate the browser away.
 *
 * @param {HTMLElement} hostEl
 * @param {GalaxyScans} scans
 * @param {{galaxies:number, systems:number}} dims
 * @param {object} o
 * @param {string} [o.linkBase]  Game origin for the card's "Open in game" link.
 * @param {number} [o.ownMilitary]  Our military-highscore points, for threat intensity.
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]  For the
 *   card's occupant strength bands.
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [o.danger]
 *   Per-player danger profiles — the per-position threat intensity (v2) and the
 *   pinned card's D badge.
 * @param {Region[]} [o.candidates]  Top listed rows, overlaid as pins.
 * @param {(index: number) => void} [o.onPinClick]
 * @param {number} [o.highlightPlayer]  Player id whose planets to spotlight —
 *   the Spyglass → map reverse deep-link. Their cells paint bright and each of
 *   their systems gets an overlay marker.
 * @param {string} [o.highlightName]  That player's name (for the banner).
 * @param {(() => void)} [o.onClearHighlight]  Clears the spotlight.
 * @param {Map<number, string>} [o.highlightColors]  Watchlist overlay (Spyglass
 *   map): player id → their stable colour; those planets paint in that colour
 *   instead of the occupancy palette. Absent for the Galaxy Viewer (unchanged).
 * @returns {void}
 */
const renderOccupancyMap = (hostEl, scans, { galaxies, systems }, { linkBase, ownMilitary, players, danger, candidates, onPinClick, highlightPlayer, highlightName, onClearHighlight, highlightColors }) => {
  const POS = 15;
  const posPx = 2;
  const gap = 4;
  // 26 = the field view's .smap-glab gutter, so both views share one left
  // edge and the shared axis aligns over either.
  const gutter = 26;
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
  const clsCtx = { ownMilitary, farmScale, danger };
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
  // Systems of the spotlighted player (Spyglass → map) — collected during the
  // draw so their cells paint bright and each system gets an overlay marker.
  /** @type {Array<{ g: number, s: number }>} */
  const highlightCells = [];
  for (let g = 1; g <= galaxies; g++) {
    const yBase = topPad + (g - 1) * stride;
    ctx.fillStyle = '#7a8a99';
    ctx.fillText(`G${g}`, 2, yBase + (POS * posPx) / 2);
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      const x = gutter + (s - 1) * cellW;
      let hitHere = false;
      for (let p = 1; p <= POS; p++) {
        const pos = positions && positions[p];
        const pid = pos && pos.player && pos.player.id != null ? pos.player.id : null;
        // Watchlist overlay: a watched player's planets paint in their OWN stable
        // colour (the Spyglass map). Off (undefined) for the Galaxy Viewer, which
        // passes no highlightColors → normal occupancy colouring, unchanged.
        const overlayCol = highlightColors && pid != null ? highlightColors.get(pid) : undefined;
        const isHi = highlightPlayer != null && pid === highlightPlayer;
        if (isHi) hitHere = true;
        ctx.fillStyle = overlayCol
          ? overlayCol
          : isHi
            ? '#ff5edb' // spotlight — bright magenta pops against the dark map
            : cellColor(classifyCell(pos ? pos.status : undefined, pos ? pos.player : undefined, clsCtx));
        ctx.fillRect(x, yBase + (p - 1) * posPx, Math.ceil(cellW) + 0.4, posPx);
      }
      if (hitHere) highlightCells.push({ g, s });
    }
  }
  // Same shared axis as the field view, aligned over the same 26px gutter.
  hostEl.appendChild(buildAxis(Math.max(64, Math.round((W - gutter) / 4)), systems / Math.max(64, Math.round((W - gutter) / 4))));

  // Canvas + pin overlay + popover share one relative wrapper so pins and the
  // pinned card can be positioned in canvas coordinates.
  const wrap = document.createElement('div');
  wrap.className = 'smap-occ-wrap';
  wrap.appendChild(canvas);

  const info = document.createElement('div');
  info.className = 'smap-info';
  info.textContent = OCC_HINT;

  const overlay = document.createElement('div');
  overlay.className = 'smap-occ-overlay';
  candidates?.forEach((r, i) => {
    if (r.galaxy < 1 || r.galaxy > galaxies) return;
    const sys = r.center ?? r.start;
    const pin = buildPin(i, r, info, onPinClick);
    pin.style.left = `${(((sys - 0.5) / systems) * 100).toFixed(2)}%`;
    pin.style.top = `${topPad + (r.galaxy - 1) * stride + (POS * posPx) / 2}px`;
    overlay.appendChild(pin);
  });
  // Spotlight markers — one diamond per system the highlighted player occupies,
  // so their planets are findable at map scale (a single 2px cell is not).
  for (const { g, s } of highlightCells) {
    const m = document.createElement('span');
    m.className = 'smap-hi-marker';
    m.style.left = `${(((s - 0.5) / systems) * 100).toFixed(2)}%`;
    m.style.top = `${topPad + (g - 1) * stride + (POS * posPx) / 2}px`;
    m.title = `${highlightName || 'player'} — ${g}:${s}`;
    overlay.appendChild(m);
  }
  wrap.appendChild(overlay);

  // Click-to-pin popover — the strip cells' grammar, not a deep-link. Unlike
  // the strip context (where the card floats over inert content and stays
  // pointer-transparent), here it floats over the CANVAS — every pixel below
  // is a live click target, so a pass-through card would silently re-pin
  // whatever system happens to sit under a body click. Solid card instead:
  // a body click unpins (matching the footer copy), the link still navigates.
  const pop = document.createElement('div');
  pop.className = 'region-pop';
  pop.style.pointerEvents = 'auto';
  wrap.appendChild(pop);
  /** @type {string | null} */
  let pinnedSys = null;
  const hideCard = () => { pinnedSys = null; pop.style.display = 'none'; };
  pop.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) return;
    hideCard();
  });
  /** @param {number} g @param {number} s @param {number} x */
  const showCard = (g, s, x) => {
    pinnedSys = `${g}:${s}`;
    pop.replaceChildren(buildSystemCard(g, s, scans[`${g}:${s}`], true, players, linkBase, danger));
    pop.classList.add('pinned');
    pop.style.bottom = 'auto';
    pop.style.display = 'block';
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const rowTop = topPad + (g - 1) * stride;
    const above = rowTop - popH - 8;
    pop.style.top = `${above >= 0 ? above : rowTop + POS * posPx + 8}px`;
    pop.style.left = `${Math.max(0, Math.min(x - popW / 2, W - popW))}px`;
  };

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < gutter) { info.textContent = OCC_HINT; return; }
    const s = Math.floor((mx - gutter) / cellW) + 1;
    const g = Math.floor((my - topPad) / stride) + 1;
    if (s < 1 || s > systems || g < 1 || g > galaxies) { info.textContent = OCC_HINT; return; }
    const within = (my - topPad) - (g - 1) * stride;
    const p = Math.floor(within / posPx) + 1;
    if (p < 1 || p > POS) { info.textContent = `G${g} · system ${s}`; return; }
    const st = scans[`${g}:${s}`]?.positions?.[p]?.status;
    info.textContent = `G${g}:${s}:${p} — ${st ? (STATUS_LABELS[st] || st) : 'empty'}`;
  });
  // Reset on leave — a frozen "G4:233:9 — Inactive" readout reads like a
  // status summary long after the pointer moved on. On the WRAP, not the
  // canvas: the pins live in a sibling overlay stacked above the canvas, so
  // a pointer exiting the map straight off a pin never fires a canvas
  // mouseleave (the field view's reset likewise sits on the row wrapper
  // that contains its pins).
  wrap.addEventListener('mouseleave', () => { info.textContent = OCC_HINT; });
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const s = Math.floor((mx - gutter) / cellW) + 1;
    const g = Math.floor((my - topPad) / stride) + 1;
    if (mx < gutter || s < 1 || s > systems || g < 1 || g > galaxies) { hideCard(); return; }
    if (pinnedSys === `${g}:${s}`) hideCard();
    else showCard(g, s, mx);
  });
  hostEl.appendChild(wrap);

  // Spotlight banner at the very top — names the highlighted player + a clear
  // action, so the magenta cells/markers are never an unexplained mystery.
  if (highlightPlayer != null && highlightCells.length) {
    const banner = document.createElement('div');
    banner.className = 'smap-hi-banner';
    banner.append(document.createTextNode(
      `Highlighting ${highlightName || `player ${highlightPlayer}`} — ${highlightCells.length} system${highlightCells.length === 1 ? '' : 's'}`,
    ));
    if (onClearHighlight) {
      banner.appendChild(document.createTextNode(' · '));
      const clr = document.createElement('a');
      clr.href = '#';
      clr.textContent = 'clear';
      clr.addEventListener('click', (e) => { e.preventDefault(); onClearHighlight(); });
      banner.appendChild(clr);
    }
    hostEl.insertBefore(banner, hostEl.firstChild);
  } else if (highlightPlayer != null) {
    // Asked to spotlight a player with no planets in the current snapshot.
    const banner = document.createElement('div');
    banner.className = 'smap-hi-banner';
    banner.textContent = `${highlightName || `player ${highlightPlayer}`} has no planets in this server snapshot`;
    if (onClearHighlight) {
      banner.appendChild(document.createTextNode(' · '));
      const clr = document.createElement('a');
      clr.href = '#';
      clr.textContent = 'clear';
      clr.addEventListener('click', (e) => { e.preventDefault(); onClearHighlight(); });
      banner.appendChild(clr);
    }
    hostEl.insertBefore(banner, hostEl.firstChild);
  }

  // Fixed footer slots — legend, then readout — the SAME order as the field
  // view, so switching views never moves where feedback appears.
  const legend = document.createElement('div');
  legend.className = 'smap-occ-legend';
  /** @param {import('../../domain/cellClass.js').CellBucket} bucket @param {string} label */
  const flatLeg = (bucket, label) => {
    const sw = document.createElement('span');
    sw.className = 'smap-occ-leg';
    const dot = document.createElement('span');
    dot.className = 'smap-occ-sw';
    dot.style.background = cellColor({ bucket, intensity: 1 });
    sw.append(dot, document.createTextNode(label));
    return sw;
  };
  legend.append(
    // Same structure as the field view's legend — ramps first (threat before
    // farm), categoricals after, pin last — so switching views reads as the
    // same vocabulary in the same order. "Empty" — the same word the strip
    // legend and popovers use (this legend used to say "Free").
    makeRampLegend((v) => cellColor({ bucket: 'threat', intensity: v }), 'Active threat (stronger → brighter)'),
    makeRampLegend((v) => cellColor({ bucket: 'farm', intensity: v }), 'Farm (rich → bright)'),
    flatLeg('free', 'Empty'),
    flatLeg('blocked', 'Protected'),
    flatLeg('mine', 'Mine'),
  );
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
 * @param {string} [o.linkBase]  Game origin (e.g. https://s1-en.ogame.gameforge.com)
 *   for the "Open in game" links inside pinned system cards. NEITHER view
 *   carries a bare cell deep-link — pins and pinned cards own the click grammar.
 * @param {number} [o.ownMilitary]  Our military-highscore points, for threat intensity.
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]  For the
 *   occupancy lens's pinned system cards (occupant strength bands).
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [o.danger]
 *   Per-player danger profiles — the occupancy lens's v2 threat intensity + the
 *   pinned card's D badge.
 * @param {import('../../domain/heatField.js').ThreatFarmField | null} [o.field]
 *   Prebuilt per-system field (the analyzer's scoring field) — reused here by
 *   aggregating per display bin, so one build serves ranking, strips AND map.
 *   Omitted → builds its own at display resolution (legacy path).
 * @param {Region[]} [o.candidates]  The listed top rows — overlaid as pins on
 *   BOTH views; click selects the matching table row via `onPinClick`.
 * @param {(index: number) => void} [o.onPinClick]
 * @param {number} [o.highlightPlayer]  Occupancy lens only — spotlight this
 *   player's planets (adds diamond markers + a banner).
 * @param {string} [o.highlightName]
 * @param {(() => void)} [o.onClearHighlight]
 * @param {Map<number, string>} [o.highlightColors]  Occupancy lens only — the
 *   Spyglass watchlist overlay (player id → stable colour). Absent for the GV.
 * @returns {void}
 */
export const renderServerMap = ({ hostEl, scans, galaxies, systems, donutGalaxy, donutSystem, view, offlineWindow, farmReach, linkBase, ownMilitary, players, danger, field, candidates, onPinClick, highlightPlayer, highlightName, onClearHighlight, highlightColors }) => {
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
    renderOccupancyMap(hostEl, scans, { galaxies, systems }, { linkBase, ownMilitary, players, danger, candidates, onPinClick, highlightPlayer, highlightName, onClearHighlight, highlightColors });
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

  const FIELD_HINT = 'Hover a cell for its system range, threat and farm.';
  const info = document.createElement('div');
  info.className = 'smap-info';
  info.textContent = FIELD_HINT;

  // Sparse top axis: a representative system number every 8 columns.
  hostEl.appendChild(buildAxis(disp.cols, disp.binWidth));

  // Rows live in one body wrapper so leaving the map can reset the readout
  // (a frozen readout reads like a status summary long after the hover).
  const body = document.createElement('div');
  body.addEventListener('mouseleave', () => { info.textContent = FIELD_HINT; });

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
        // 0–100 like the Fit column — one scale across the whole view, not
        // raw normalised decimals here and integers there.
        info.textContent = `G${g} · sys ≈ ${lo}–${hi} · threat ${Math.round(tv * 100)}/100 · farm ${Math.round(fv * 100)}/100`;
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
        const pin = buildPin(i, r, info, onPinClick);
        pin.style.left = `${(((sys - 0.5) / systems) * 100).toFixed(2)}%`;
        cellsWrap.appendChild(pin);
      });
    }
    row.appendChild(cellsWrap);
    body.appendChild(row);
  }
  hostEl.appendChild(body);

  // Legend: the two channels over the void — colour is relative to this server.
  const legend = document.createElement('div');
  legend.className = 'smap-occ-legend';
  const quiet = document.createElement('span');
  quiet.className = 'smap-occ-leg';
  const qdot = document.createElement('span');
  qdot.className = 'smap-occ-sw';
  qdot.style.background = fieldColor(0, 0);
  quiet.append(qdot, document.createTextNode('Quiet'));
  legend.append(
    makeRampLegend((v) => fieldColor(v, 0), 'Threat (RIP reach)'),
    makeRampLegend((v) => fieldColor(0, v), 'Farm (cargo reach)'),
    quiet,
  );
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
  // Channels on the same 0–100 scale as the Fit number itself — one scale
  // across the view, not 0.xx here and integers there.
  return {
    text: String(Math.round(r.fit * 100)),
    tip: `safety ${Math.round(c.safety * 100)} · farm ${Math.round(c.farm * 100)}`
      + ` · streak ${Math.round(c.streak * 100)} · targets ${Math.round(c.target * 100)} (each /100)`
      + `\nscan coverage ${Math.round(c.coverage * 100)}%`,
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
 * The neighbourhood {@link RegionScore} as a row of labelled census GROUPS —
 * Population / Threats / Targets / Social / Context — with FIXED stat slots
 * per group: a zero renders dimmed instead of disappearing, so two candidates
 * always compare slot-for-slot and "0 bandits" is visibly different from "no
 * data". Colour encodes the FAMILY (one hue each, never reused across
 * families); per-stat explanations stay as tooltips on each stat. Replaces
 * the old flat conditional tile row that reshuffled on every row selection.
 *
 * @param {RegionScore} s
 * @param {number} [ownRank]
 * @returns {HTMLElement}
 */
const buildCensusGroups = (s, ownRank) => {
  const wrap = document.createElement('div');
  wrap.className = 'census';

  /**
   * @param {string} title
   * @param {string} color
   * @param {Array<{ value: string|number, label: string, title?: string, zero?: boolean }>} stats
   * @returns {void}
   */
  const group = (title, color, stats) => {
    if (!stats.length) return;
    const g = document.createElement('div');
    g.className = 'census-group';
    const t = document.createElement('div');
    t.className = 'census-title';
    t.style.color = color;
    t.textContent = title;
    const line = document.createElement('div');
    for (const st of stats) {
      const span = document.createElement('span');
      span.className = st.zero ? 'census-stat zero' : 'census-stat';
      const b = document.createElement('b');
      b.textContent = String(st.value);
      span.append(b, document.createTextNode(' ' + st.label));
      if (st.title) span.title = st.title;
      line.appendChild(span);
    }
    g.append(t, line);
    wrap.appendChild(g);
  };

  /**
   * Fixed slot: always rendered, dimmed at zero.
   * @param {number} n @param {string} label @param {string} [title]
   */
  const slot = (n, label, title) => ({ value: n, label, title, zero: !n });

  group('Population', '#9fb4c4', [
    slot(s.occupied, 'Active', 'Active occupants in range — how crowded it is'),
    slot(s.inactive, 'Farmable', 'Inactive players — farm targets that cannot defend'),
    slot(s.vacation, 'Vacation', 'On vacation or banned — protected, neither farm nor threat'),
    slot(s.newbie, 'Weak', 'Noob-protected — cannot be raided'),
  ]);
  // Bandits collapse into one slot: total count + the worst tier's "!" marks
  // (the OG-E threat convention); the King/Lord/Bandit split is the tooltip.
  const banditTip = s.bandits
    ? [3, 2, 1].filter((t) => s.banditTiers?.[t])
      .map((t) => `${s.banditTiers?.[t]} ${HONOR_TIER_LABELS.bandit[t]}`).join(', ')
      + ' — negative-honour aggressors, the danger signal for a fresh colony'
    : 'Negative-honour aggressors — a danger for a fresh colony';
  group('Threats', STRENGTH_COLORS.strong, [
    slot(s.bandits, s.bandits ? `Bandit${s.bandits > 1 ? 's' : ''} ${'!'.repeat(s.banditMaxLevel || 1)}` : 'Bandits', banditTip),
    slot(s.strong, 'Strong', 'Outside your protection bracket — out-gun a fresh colony'),
    slot(s.activeOnVacation, 'On-vac', 'A live player hiding behind vacation mode — not a safe farm'),
  ]);
  group('Targets', STRENGTH_COLORS.honorable, [
    slot(s.honorable, 'Honorable', 'A fair fight — attacking earns honour'),
    slot(s.normal, 'Normal', 'Plain "white" farm targets'),
    slot(s.outlaw, 'Outlaw', 'Lost protection by raiding the weak — fair game'),
    slot(s.honored, s.honored ? `Honored ${'★'.repeat(s.honoredMaxLevel || 1)}` : 'Honored',
      'Positive-honour fighters — prefer stronger targets than a fresh colony'),
  ]);
  group('Social', '#4a9eff', [
    slot(s.allianceCount, s.allianceCount === 1 ? 'Alliance' : 'Alliances', 'Distinct alliance tags in range'),
    slot(s.allyNearby, 'Ally', 'Players in your alliance'),
    slot(s.buddy, 'Buddy', 'Players on your buddy list'),
  ]);
  // Context — rank / points averages; only meaningful with someone in range,
  // so this group (alone) collapses entirely when the area is empty.
  /** @type {Array<{ value: string|number, label: string, title?: string }>} */
  const ctx = [];
  if (s.ranks.length) {
    const top = s.ranks[0];
    let rel = `highscore rank #${top}`;
    if (typeof ownRank === 'number' && ownRank > 0) {
      const d = ownRank - top;
      rel = d > 0 ? `${d} ranks above you` : d < 0 ? `${-d} ranks below you` : 'the same rank as you';
    }
    ctx.push({ value: `#${top}`, label: 'top rank', title: rel });
  }
  if (s.avgTotal) {
    ctx.push({ value: fmtPts(s.avgTotal), label: 'avg points', title: 'Mean total-highscore points of neighbours in range — how strong the area is' });
  }
  if (s.avgMilitary) {
    ctx.push({ value: fmtPts(s.avgMilitary), label: 'avg military', title: 'Mean military points of neighbours — where fleets concentrate (target-rich for an aggressor)' });
  }
  group('Context', '#9fb4c4', ctx);

  return wrap;
};

/**
 * The named "who makes this region dangerous, and why" panel — the top active
 * players in the window ranked by danger D, each with their badge, label, a
 * one-line reason and data provenance, plus a spy-coverage readout. This is
 * the answer to the user's core question: WHY a region is flagged (or why a
 * seemingly-strong neighbour is actually safe). Complements the aggregate
 * census counts with the specific players behind them. `null` when there's no
 * danger layer or no active players (the census already reports the latter).
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @param {object} o
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [o.danger]
 * @param {Set<number>} [o.spied]  Player ids with at least one spy report.
 * @param {number} [o.galaxyMax]
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]
 * @param {((playerId?: number) => void)} [o.onOpenSpyglass]  Switch to the
 *   Spyglass tab; with a player id, focus that player's row there.
 * @returns {HTMLElement | null}
 */
const buildTopThreats = (region, scans, { danger, spied, galaxyMax, players, onOpenSpyglass }) => {
  if (!danger) return null;
  /** @type {Map<number, {name:string, rank?:number, ally?:string, prof?:import('../../domain/dangerScore.js').DangerProfile}>} */
  const byId = new Map();
  for (const sys of regionSystems(region, galaxyMax)) {
    const positions = scans[`${region.galaxy}:${sys}`]?.positions;
    if (!positions) continue;
    for (let pos = 1; pos <= 15; pos++) {
      const p = positions[pos];
      if (!p || p.status !== 'occupied' || !p.player || p.player.id == null || byId.has(p.player.id)) continue;
      const meta = players ? players[p.player.id] : undefined;
      byId.set(p.player.id, {
        name: p.player.name || meta?.name || `player ${p.player.id}`,
        rank: typeof p.player.rank === 'number' ? p.player.rank : undefined,
        ally: p.player.ally,
        prof: danger.get(p.player.id),
      });
    }
  }
  if (byId.size === 0) return null;

  // Players dropped by "Ignore N worst" — they still PHYSICALLY sit in the
  // window (so they belong in this "who's here" list), but the census counted
  // the area as if they were gone and the "Ignoring N worst" line below names
  // them. Mark their rows "ignored" so the panel agrees with both instead of
  // asserting an ignored player is the #1 threat.
  const excludedIds = new Set((region.excluded ?? []).map((p) => p.id));

  const active = [...byId.entries()].map(([id, v]) => ({ id, ...v, ignored: excludedIds.has(id) }));
  const total = active.length;
  const spiedCount = spied ? active.filter((a) => spied.has(a.id)).length : 0;
  active.sort((a, b) => (b.prof?.danger ?? 0) - (a.prof?.danger ?? 0));
  const top = active.slice(0, 5);
  // "None pose a threat" only counts the players we're NOT ignoring — an
  // ignored bandit at the top must not read as a live danger here.
  const maxD = Math.max(0, ...top.filter((a) => !a.ignored).map((a) => a.prof?.danger ?? 0));

  const panel = document.createElement('div');
  panel.className = 'gv-threats';

  const head = document.createElement('div');
  head.className = 'gv-threats-head';
  const title = document.createElement('span');
  title.className = 'gv-threats-title';
  title.textContent = 'Top threats in window';
  const sub = document.createElement('span');
  sub.className = 'gv-threats-sub';
  sub.textContent = maxD <= 0.1 ? 'none pose a mobile-fleet threat' : 'ranked by danger D';
  sub.title = 'Danger D 0–100 = mobile (attack-capable) military vs your anchor × hunt history. '
    + '0 = friendly, or defenceless (0 ships). Defence-only points do not count.';
  head.append(title, sub);
  panel.appendChild(head);

  // Spy coverage of the window + a nudge to firm up the estimates (E3 shows
  // the gap; folding spy defence into D lands in E4).
  const cov = document.createElement('div');
  cov.className = 'gv-cov';
  const covText = document.createElement('span');
  covText.append(
    document.createTextNode('Spy coverage: '),
    Object.assign(document.createElement('b'), { textContent: `${spiedCount}/${total}` }),
    document.createTextNode(` active player${total === 1 ? '' : 's'} spied`),
  );
  cov.appendChild(covText);
  if (onOpenSpyglass) {
    cov.appendChild(document.createTextNode(' · '));
    const a = document.createElement('a');
    a.className = 'open-spy';
    a.href = '#';
    a.textContent = 'Open Spyglass ↗';
    a.addEventListener('click', (e) => { e.preventDefault(); onOpenSpyglass(); });
    cov.appendChild(a);
  }
  panel.appendChild(cov);

  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    const row = document.createElement('div');
    row.className = a.ignored ? 'gv-threat-row ignored' : 'gv-threat-row';
    const rank = document.createElement('span');
    rank.className = 'gv-threat-rank';
    rank.textContent = `${i + 1}.`;
    row.appendChild(rank);
    const badge = a.prof ? dangerBadge(a.prof) : null;
    if (badge) { badge.style.marginLeft = '0'; row.appendChild(badge); }
    const name = document.createElement('span');
    name.className = 'gv-threat-name';
    name.textContent = a.name
      + (typeof a.rank === 'number' ? ` #${a.rank}` : '')
      + (a.ally ? ` ${a.ally}` : '');
    row.appendChild(name);
    if (a.ignored) {
      const tag = document.createElement('span');
      tag.className = 'gv-threat-ignored-tag';
      tag.textContent = 'ignored';
      tag.title = 'Dropped from this window’s score by "Ignore worst" — you’ll just avoid its systems';
      row.appendChild(tag);
    }
    if (a.prof) {
      const why = document.createElement('span');
      why.className = 'gv-threat-why';
      why.textContent = [DANGER_LABELS[a.prof.label], a.prof.reasons[0]].filter(Boolean).join(' · ');
      row.appendChild(why);
    }
    const prov = document.createElement('span');
    prov.className = 'gv-threat-prov';
    prov.textContent = a.prof?.provenance === 'spied'
      ? '🔭 spied (exact)'
      : spied && spied.has(a.id)
        ? '🔭 spied (partial)'
        : a.prof
          ? (a.prof.provenance === 'ships' ? 'ships-bounded' : '~ est.')
          : 'unranked';
    row.appendChild(prov);
    // Click a threat → jump to Spyglass focused on that player (the "found a
    // threat, go spy/analyze it" flow). Keyboard-reachable like the table rows.
    if (onOpenSpyglass) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.style.cursor = 'pointer';
      row.title = 'Open this player in Spyglass';
      row.addEventListener('click', () => onOpenSpyglass(a.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSpyglass(a.id); }
      });
    }
    panel.appendChild(row);
  }
  return panel;
};

/**
 * Field legend for the neighbourhood strip — the same three swatches as the
 * server map, generated from {@link fieldColor} itself so it can never drift
 * from the rendering.
 */
const buildFieldLegend = () => {
  const legend = document.createElement('div');
  legend.className = 'region-legend';
  // Same wording as the server-map legend — one vocabulary for one palette.
  /** @type {Array<[number, number, string]>} */
  const items = [[1, 0, 'Threat (RIP reach)'], [0, 1, 'Farm (cargo reach)'], [0, 0, 'Quiet']];
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
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [o.danger]
 * @param {Set<number>} [o.spied]  Player ids with a spy report (coverage readout).
 * @param {(() => void)} [o.onOpenSpyglass]  Switch to the Spyglass tab.
 * @param {number} [index]  Zero-based row index — the header echoes it
 *   ("#7 · …") so the click visibly landed (the old constant "Top streak:"
 *   label read as if selection did nothing).
 * @returns {HTMLElement}
 */
const buildDetail = (region, scans, { mode, field, players, ownRank, galaxyMax, linkBase, danger, spied, onOpenSpyglass }, index) => {
  const nbr = mode === 'neighbourhood';
  const el = document.createElement('div');
  el.className = 'streak-record';

  const head = document.createElement('div');
  head.className = 'record-head';
  const label = document.createElement('span');
  label.className = 'label';
  const value = document.createElement('span');
  value.className = 'value';
  const rowNo = typeof index === 'number' ? `#${index + 1} · ` : '';
  if (nbr) {
    label.textContent = `${rowNo}Selected spot: `;
    value.textContent = `G${region.galaxy}:${region.center} · ±${(region.length - 1) / 2} sys`;
  } else {
    label.textContent = `${rowNo}Selected streak: `;
    value.textContent = `G${region.galaxy}:${region.start}–${region.end} · ${region.length} systems`;
  }
  head.append(label, value);
  // A plain, always-clickable link — unlike the popover cards this panel is
  // ordinary DOM, so no pin-first dance is needed here.
  if (linkBase) {
    const a = document.createElement('a');
    a.className = 'open-link';
    a.href = `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${region.galaxy}&system=${region.center ?? region.start}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open in game ↗';
    head.appendChild(a);
  }

  const coords = document.createElement('div');
  coords.style.cssText = 'color:#888;font-size:12px;margin-top:4px;';
  coords.textContent = nbr
    ? `Window ${region.start} → ${region.end}`
      + (region.end < region.start ? ' (wraps 499 → 1)' : '')
    : `${region.matched} free`
      + (region.gaps ? `, ${region.gaps} gap${region.gaps === 1 ? '' : 's'}` : '')
      + (region.end < region.start ? ' · wraps across the 499 → 1 boundary' : '');
  el.append(head, coords);

  const s = region.score;
  if (s) {
    // Neighbourhood census as fixed labelled groups, sat right above the
    // per-system strip.
    el.appendChild(buildCensusGroups(s, ownRank));

    // The named "who / why" panel — the specific players behind the counts,
    // ranked by danger D, with spy coverage. Skipped (null) without a danger
    // layer or active players.
    const threats = buildTopThreats(region, scans, { danger, spied, galaxyMax, players, onOpenSpyglass });
    if (threats) el.appendChild(threats);

    el.appendChild(buildInteractiveStrip(region, scans, { mode, field, players, galaxyMax, linkBase, danger }));

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
 * Identity of a region row. The selection survives repaints by re-matching
 * this key against the fresh result list — a bare index would silently jump
 * to a different candidate whenever a slider drag re-orders the ranking.
 * The mode is part of the key: a streak G3:100–115 and a spot centred at 100
 * (end = 100+15) would otherwise collide, making a Find switch "restore" a
 * selection the user never made.
 *
 * @param {Region} r
 * @param {string} mode
 * @returns {string}
 */
const regionKey = (r, mode) => `${mode}:${r.galaxy}:${r.center ?? r.start}:${r.end}`;

/**
 * Identity of the row the user last expanded — carried ACROSS repaints so a
 * control tweak doesn't throw the selection back to row 0 mid-comparison
 * (the exact workflow the sliders invite). `null` = default to the top row.
 *
 * @type {string | null}
 */
let lastSelectedKey = null;

/**
 * Wire a results table into an interactive accordion: clicking a row expands
 * the candidate's detail panel INLINE, in a full-width row directly beneath
 * it (one open at a time; re-clicking the open row collapses it — the old
 * layout parked the detail at the very bottom of the pane, two scrolls away).
 * Rows are keyboard-reachable (Tab + Enter/Space). Shared by both modes;
 * `tableBuilder` differs (streak vs candidate columns).
 *
 * @param {HTMLElement} containerEl
 * @param {Region[]} results
 * @param {GalaxyScans} scans
 * @param {{ mode: 'streak'|'neighbourhood', field?: import('../../domain/heatField.js').ThreatFarmField | null, players?: import('../../domain/regions.js').PlayerCache, ownRank?: number, galaxyMax?: number, linkBase?: string, danger?: Map<number, import('../../domain/dangerScore.js').DangerProfile>, spied?: Set<number>, onOpenSpyglass?: (playerId?: number) => void, onSelect?: (index: number) => void }} detailOpts
 * @param {(rows: Region[], ownRank?: number) => HTMLTableElement} tableBuilder
 * @returns {Region[]} The rows actually shown (≤ TOP_N) — the caller overlays
 *   them as map pins.
 */
const renderInteractive = (containerEl, results, scans, detailOpts, tableBuilder) => {
  const shown = results.slice(0, TOP_N);
  const table = tableBuilder(shown, detailOpts.ownRank);
  const rows = /** @type {HTMLTableRowElement[]} */ ([...table.querySelectorAll('tbody tr')]);
  const colCount = table.querySelectorAll('thead th').length;
  /** @type {HTMLTableRowElement | null} */
  let detailRow = null;
  let selectedIdx = -1;

  const collapse = () => {
    if (detailRow) { detailRow.remove(); detailRow = null; }
    if (selectedIdx >= 0) rows[selectedIdx]?.classList.remove('selected');
    selectedIdx = -1;
    lastSelectedKey = null;
    detailOpts.onSelect?.(-1);
  };
  /** @param {number} i */
  const select = (i) => {
    if (i < 0 || i >= shown.length || i === selectedIdx) return;
    collapse();
    selectedIdx = i;
    lastSelectedKey = regionKey(shown[i], detailOpts.mode);
    rows[i].classList.add('selected');
    detailRow = /** @type {HTMLTableRowElement} */ (document.createElement('tr'));
    detailRow.className = 'streak-detail';
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.appendChild(buildDetail(shown[i], scans, detailOpts, i));
    detailRow.appendChild(td);
    rows[i].after(detailRow);
    detailOpts.onSelect?.(i);
  };
  /** Row-click semantics: toggle. Pin clicks use `select` (never collapse). @param {number} i */
  const toggle = (i) => {
    if (i === selectedIdx) collapse();
    else select(i);
  };
  rows.forEach((r, i) => {
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.addEventListener('click', () => toggle(i));
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(i); }
    });
  });
  containerEl.appendChild(table);
  if (shown.length) {
    // Restore the previous selection BY IDENTITY; fall back to the top row.
    const keep = lastSelectedKey
      ? shown.findIndex((r) => regionKey(r, detailOpts.mode) === lastSelectedKey)
      : -1;
    select(keep >= 0 ? keep : 0);
  }
  selectByContainer.set(containerEl, select);
  return shown;
};

/**
 * Forget the sticky row-selection identity. Called on universe switch —
 * region keys carry no universe component, so a coincidentally matching
 * region in the next universe would otherwise auto-expand as if the user
 * had chosen it there.
 *
 * @returns {void}
 */
export const resetFreeSelection = () => {
  lastSelectedKey = null;
};

/**
 * Test-only reset: drop the sticky selection identity and the find cache so
 * one test's clicks / fixtures can't leak into the next. `_`-prefixed: not
 * for production.
 *
 * @returns {void}
 */
export const _resetFreeStreakForTest = () => {
  resetFreeSelection();
  findCache.clear();
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
 * @property {(index: number) => void} [onSelect]
 *   Fired whenever the selected row changes (−1 = collapsed) — the caller
 *   mirrors it onto the map pins ({@link highlightPin}).
 * @property {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [danger]
 *   Per-player danger profiles — forwarded to the detail/system cards for the
 *   D badge (the strip/pin cards explain the v2 threat colours in place).
 * @property {Set<number>} [spied]  Player ids with a spy report — the
 *   Top-threats panel's coverage readout.
 * @property {((playerId?: number) => void)} [onOpenSpyglass]  Switch to the
 *   Spyglass tab (Top-threats "Open Spyglass" link); with an id, focus that
 *   player's row there (a Top-threats row click).
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
export const renderFreeRegions = ({ containerEl, countInfoEl, scans, positions, maxGaps, zone, find, excludeN, field, galaxyMax, linkBase, ownMilitary, players, ownRank, onSelect, danger, spied, onOpenSpyglass }) => {
  containerEl.innerHTML = '';

  const zoneKey = ZONES[zone ?? ''] ? /** @type {string} */ (zone) : 'safe';
  const spots = (find ?? 'spots') !== 'streaks';
  const gMax = galaxyMax ?? 499;
  /** @type {import('../../domain/zoneScore.js').ZoneContext} */
  const ctx = { field: field ?? null, scans, positions, status: 'empty', galaxyMax: gMax, ownMilitary, danger };
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
      return renderInteractive(containerEl, candidates, scans, { mode: 'neighbourhood', field, players, ownRank, galaxyMax: gMax, linkBase, danger, spied, onOpenSpyglass, onSelect }, buildCandidateTable);
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
    return renderInteractive(containerEl, results, scans, { mode: 'streak', field, players, ownRank, galaxyMax: gMax, linkBase, danger, spied, onOpenSpyglass, onSelect }, buildTable);
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
    // A compact inline notice — NOT the `.empty` banner: results follow right
    // below, and a 60px-padded "nothing here" look would read as a dead end.
    const note = document.createElement('div');
    note.className = 'gv-notice';
    note.textContent =
      `No run of ${MIN_REGION_LENGTH}+ systems has slot${positions.length === 1 ? '' : 's'} `
      + `${posLabel} all free — here are the individual free systems instead `
      + '(best zone fit first):';
    containerEl.appendChild(note);
    return renderInteractive(containerEl, freeSystems, scans, { mode: 'streak', field, players, ownRank, galaxyMax: gMax, linkBase, danger, spied, onOpenSpyglass, onSelect }, buildTable);
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
