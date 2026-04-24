// @ts-check

// Galaxy-observations renderer — builds the filter bar, global stats row,
// legend, and per-galaxy accordion (header + progress bar + 499-pixel
// system map) for the histogram page's "Galaxy Observations" section.
//
// Pure DOM module. Every node is produced with `document.createElement`
// and styled via `style.cssText` inline; the `.stat-card` / `.empty`
// classes come from the page stylesheet in `histogram.html`. No
// chrome.storage access, no network, no module-level state — everything
// flows through `opts`.
//
// The caller (index.js) owns:
//   - `scans` and `targetPositions` data flow (reads chromeStore, reacts
//     to change events, re-invokes `renderGalaxyMap`).
//   - `expandedGalaxies` accordion-state persistence (the Set is mutated
//     here on toggle; the caller persists it via onToggleExpand).
//   - The top-level "Clear observation data" button, wired in the HTML
//     page — not rendered here. `onClearAll` is accepted in the opts
//     signature so the consumer contract stays stable across phases.
//
// @see ./palette.js              — STATUS_COLORS / STATUS_LABELS / tooltips
// @see ../../domain/histogram.js — STATUS_PRIORITY / bestStatusInSystem / collectGalaxyStats

import {
  STATUS_PRIORITY,
  bestStatusInSystem,
  collectGalaxyStats,
} from '../../domain/histogram.js';

import {
  STATUS_COLORS,
  STATUS_LABELS,
  RESCAN_TOOLTIP,
  UNSCANNED_COLOR,
  UNSCANNED_BORDER,
} from './palette.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../state/scans.js').SystemScan} SystemScan
 * @typedef {import('../../domain/scans.js').Position} Position
 * @typedef {import('../../domain/scans.js').PositionStatus} PositionStatus
 */

// OGame universe dimensions. `MAX_GAL` mirrors the `COL_MAX_GALAXY`
// constant in the settings module (kept local here so the histogram
// feature has no dependency on settings just to learn a ceiling).
// `MAX_SYS` is the full galaxy width; we render ONE pixel per system
// regardless of whether it's been scanned, so the pixel strip has a
// stable visual shape across galaxies.
const MAX_GAL = 7;
const MAX_SYS = 499;

/**
 * Render the whole Galaxy Observations section into `containerEl`.
 *
 * Idempotent: call again after data changes and the DOM re-renders from
 * scratch (we blank `containerEl` first). Accordion open/closed state is
 * owned by the caller via the passed-in `expandedGalaxies` Set — this
 * function reads it to decide initial display, and mutates it on
 * user-driven toggles before invoking `onToggleExpand`.
 *
 * Empty data path: when there are no scanned systems at all, a single
 * `.empty` message node is appended and the function returns early —
 * the filter bar, stats row, legend, and per-galaxy sections are all
 * skipped so the section reads as "nothing to show" cleanly.
 *
 * @param {{
 *   containerEl: HTMLElement,
 *   scans: GalaxyScans,
 *   targetPositions: Set<number>,
 *   expandedGalaxies: Set<number>,
 *   onToggleExpand: (galaxy: number, expanded: boolean) => void,
 *   onResetGalaxy: (galaxy: number) => void,
 *   onClearAll: () => void,
 * }} opts
 * @returns {void}
 */
export const renderGalaxyMap = (opts) => {
  const {
    containerEl,
    scans,
    targetPositions,
    expandedGalaxies,
    onToggleExpand,
    onResetGalaxy,
  } = opts;
  // `onClearAll` is intentionally unread: the top-level "Clear observation
  // data" button lives in histogram.html and is wired by index.js, not
  // here. Keeping the parameter in the signature preserves a stable
  // consumer contract — see module header.
  void opts.onClearAll;

  containerEl.textContent = '';

  // Filter out any stray entries without a `positions` field before
  // deciding empty-state. In practice the store writer always sets
  // `positions`, but defensive filtering keeps the render robust to
  // partial writes and corrupt imports.
  const hasAnyScan = Object.values(scans).some(
    (v) => v && v.positions,
  );

  if (!hasAnyScan) {
    const msg = document.createElement('div');
    msg.className = 'empty';
    msg.textContent =
      'No galaxy observations recorded yet. Open the galaxy view in the game and navigate through systems yourself — data is recorded as the game shows you each system.';
    containerEl.appendChild(msg);
    return;
  }

  const { global, byGalaxy } = collectGalaxyStats(scans, targetPositions);

  // ── Filter bar ──────────────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.style.cssText =
    'margin-bottom:12px;padding:8px 12px;background:#111820;border:1px solid #2a4a5a;border-radius:6px;font-size:12px;color:#888;';

  const filterLabel = document.createElement('span');
  filterLabel.textContent = 'Filtering by target positions: ';

  const filterValue = document.createElement('span');
  filterValue.style.cssText = 'color:#4a9eff;font-weight:bold;';
  // Empty target set renders as "(none)" rather than an empty string so
  // the bar never looks like it's mid-render / broken.
  const sortedTargets = [...targetPositions].sort((a, b) => a - b);
  filterValue.textContent =
    sortedTargets.length === 0 ? '(none)' : sortedTargets.join(', ');

  const filterHint = document.createElement('span');
  filterHint.style.cssText = 'color:#666;margin-left:8px;';
  filterHint.textContent =
    '(change in OG-E Settings → Required target positions)';

  const rescanHelp = document.createElement('span');
  rescanHelp.textContent = ' ⓘ Rescan policy';
  rescanHelp.style.cssText =
    'margin-left:12px;cursor:help;color:#4a9eff;border-bottom:1px dotted #4a9eff;';
  rescanHelp.title = RESCAN_TOOLTIP;

  filterBar.appendChild(filterLabel);
  filterBar.appendChild(filterValue);
  filterBar.appendChild(filterHint);
  filterBar.appendChild(rescanHelp);
  containerEl.appendChild(filterBar);

  // ── Global stats row ────────────────────────────────────────────────
  const statsRow = document.createElement('div');
  statsRow.style.cssText =
    'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;';

  // Always-present "total" card first — it anchors the row and tells the
  // user how much data the rest of the numbers are drawn from.
  statsRow.appendChild(
    makeStatCard('#4a9eff', global.total, 'Target positions scanned'),
  );
  for (const status of STATUS_PRIORITY) {
    const count = global[status];
    // Hide zero-count statuses to keep the row compact; a row dense with
    // meaningless zeroes buries the actual signal.
    if (!count) continue;
    statsRow.appendChild(
      makeStatCard(STATUS_COLORS[status], count, STATUS_LABELS[status]),
    );
  }
  containerEl.appendChild(statsRow);

  // ── Legend ──────────────────────────────────────────────────────────
  const legend = document.createElement('div');
  legend.style.cssText =
    'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;font-size:11px;';
  for (const status of STATUS_PRIORITY) {
    if (!global[status]) continue;
    legend.appendChild(
      makeLegendItem(STATUS_COLORS[status], STATUS_LABELS[status], false),
    );
  }
  // "Not scanned" is always in the legend — the pixel map always shows
  // unscanned systems (gap between 1..MAX_SYS and the actually-scanned
  // subset), so a user looking at the key should always find it.
  legend.appendChild(makeLegendItem(UNSCANNED_COLOR, 'Not scanned', true));
  containerEl.appendChild(legend);

  // ── Per-galaxy sections ─────────────────────────────────────────────
  for (let g = 1; g <= MAX_GAL; g++) {
    const galStats = byGalaxy[g];
    if (!galStats) continue;

    // Count systems in THIS galaxy that have actually been scanned.
    // `galStats.total` counts target-position observations (can be ≥
    // number-of-systems), which is the wrong denominator for the
    // "N/499" label. Iterate the scans dict directly instead.
    let galCount = 0;
    for (const key of Object.keys(scans)) {
      if (key.startsWith(g + ':') && scans[/** @type {`${number}:${number}`} */ (key)]?.positions) {
        galCount++;
      }
    }
    if (galCount === 0) continue;

    containerEl.appendChild(
      renderGalaxySection({
        galaxy: g,
        galCount,
        galStats,
        scans,
        targetPositions,
        expandedGalaxies,
        onToggleExpand,
        onResetGalaxy,
      }),
    );
  }
};

/**
 * Build one stat card (coloured value + monochrome label). Relies on
 * the `.stat-card` / `.stat-value` / `.stat-label` classes already
 * defined in `histogram.html`; only the value colour is set inline
 * because it varies per status.
 *
 * @param {string} color
 * @param {number} value
 * @param {string} label
 * @returns {HTMLDivElement}
 */
const makeStatCard = (color, value, label) => {
  const card = document.createElement('div');
  card.className = 'stat-card';

  const valEl = document.createElement('div');
  valEl.className = 'stat-value';
  valEl.style.color = color;
  valEl.textContent = String(value);
  card.appendChild(valEl);

  const labEl = document.createElement('div');
  labEl.className = 'stat-label';
  labEl.textContent = label;
  card.appendChild(labEl);

  return card;
};

/**
 * Build one legend entry: coloured swatch + text. The `withBorder` flag
 * adds a subtle 1px border around the swatch — used for the "Not
 * scanned" entry whose colour is close to the page background.
 *
 * @param {string} color
 * @param {string} label
 * @param {boolean} withBorder
 * @returns {HTMLSpanElement}
 */
const makeLegendItem = (color, label, withBorder) => {
  const item = document.createElement('span');
  item.style.cssText = 'display:flex;align-items:center;gap:4px;';

  const dot = document.createElement('span');
  const border = withBorder ? ';border:1px solid #333' : '';
  dot.style.cssText =
    'width:10px;height:10px;border-radius:2px;background:' +
    color +
    border +
    ';display:inline-block;';

  const txt = document.createElement('span');
  txt.style.color = '#888';
  txt.textContent = label;

  item.appendChild(dot);
  item.appendChild(txt);
  return item;
};

/**
 * @typedef {import('../../domain/histogram.js').StatusCounts} StatusCounts
 */

/**
 * Build one full galaxy section (accordion header + collapsible pixel
 * map). Split out of `renderGalaxyMap` because the inline DOM was
 * getting hard to follow; the function is only ever called from there.
 *
 * @param {{
 *   galaxy: number,
 *   galCount: number,
 *   galStats: StatusCounts,
 *   scans: GalaxyScans,
 *   targetPositions: Set<number>,
 *   expandedGalaxies: Set<number>,
 *   onToggleExpand: (galaxy: number, expanded: boolean) => void,
 *   onResetGalaxy: (galaxy: number) => void,
 * }} args
 * @returns {HTMLDivElement}
 */
const renderGalaxySection = (args) => {
  const {
    galaxy: g,
    galCount,
    galStats,
    scans,
    targetPositions,
    expandedGalaxies,
    onToggleExpand,
    onResetGalaxy,
  } = args;

  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:12px;';

  // ── Header (accordion title + progress bar + stats + reset) ─────────
  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1a2a3a;border:1px solid #2a4a5a;border-radius:6px;cursor:pointer;user-select:none;';

  const title = document.createElement('span');
  title.style.cssText =
    'font-weight:bold;color:#4a9eff;font-size:14px;min-width:80px;';
  title.textContent = 'Galaxy ' + g;
  header.appendChild(title);

  // Progress bar: one segment per non-zero status, width proportional to
  // its share of THIS galaxy's counted target positions. When
  // `galStats.total === 0` (can't happen given the outer guard, but the
  // branch is cheap) we still append an empty wrap so the flex layout
  // doesn't shift between galaxies.
  const progressWrap = document.createElement('div');
  progressWrap.style.cssText =
    'flex:1;height:12px;background:#111;border-radius:6px;overflow:hidden;display:flex;';
  if (galStats.total > 0) {
    for (const status of STATUS_PRIORITY) {
      const count = galStats[status];
      if (!count) continue;
      const seg = document.createElement('div');
      const pct = (count / galStats.total) * 100;
      seg.style.cssText =
        'height:100%;background:' + STATUS_COLORS[status] + ';width:' + pct + '%;';
      seg.title = STATUS_LABELS[status] + ': ' + count;
      progressWrap.appendChild(seg);
    }
  }
  header.appendChild(progressWrap);

  const countLabel = document.createElement('span');
  countLabel.style.cssText =
    'font-size:12px;color:#888;min-width:70px;text-align:right;';
  countLabel.textContent = galCount + '/' + MAX_SYS;
  header.appendChild(countLabel);

  const miniStats = document.createElement('span');
  miniStats.style.cssText = 'font-size:11px;color:#666;';
  // Mini stats surface the most actionable counts only, so users who
  // glance at the header get a quick read. Other statuses (mine,
  // occupied, …) are already in the global stats row; repeating them
  // here would bloat the header.
  /** @type {string[]} */
  const parts = [];
  if (galStats.empty) parts.push(galStats.empty + ' empty');
  if (galStats.empty_sent) parts.push(galStats.empty_sent + ' sent');
  if (galStats.abandoned) parts.push(galStats.abandoned + ' aband');
  miniStats.textContent = parts.join(', ');
  header.appendChild(miniStats);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '✕';
  resetBtn.title = 'Reset all scans for Galaxy ' + g;
  resetBtn.style.cssText =
    'background:#4a2a2a;border:1px solid #6a3a3a;color:#ff8888;padding:2px 8px;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
  resetBtn.addEventListener('click', (ev) => {
    // Don't toggle the accordion when the reset button is clicked —
    // the button sits inside the header and would otherwise bubble.
    ev.stopPropagation();
    if (
      !confirm(
        'Reset all observation data for Galaxy ' +
          g +
          '?\n\nThis removes ' +
          galCount +
          ' recorded systems from this galaxy locally AND from your cloud sync.',
      )
    )
      return;
    onResetGalaxy(g);
  });
  header.appendChild(resetBtn);

  section.appendChild(header);

  // ── Pixel map (collapsible) ─────────────────────────────────────────
  const mapWrap = document.createElement('div');
  const isExpanded = expandedGalaxies.has(g);
  mapWrap.style.cssText =
    'padding:8px 0;display:' + (isExpanded ? 'block' : 'none') + ';';

  const pixelMap = document.createElement('div');
  pixelMap.style.cssText = 'display:flex;flex-wrap:wrap;gap:1px;padding:4px;';

  for (let s = 1; s <= MAX_SYS; s++) {
    pixelMap.appendChild(renderSystemPixel(g, s, scans, targetPositions));
  }

  mapWrap.appendChild(pixelMap);
  section.appendChild(mapWrap);

  header.addEventListener('click', () => {
    const open = mapWrap.style.display === 'none';
    mapWrap.style.display = open ? 'block' : 'none';
    if (open) expandedGalaxies.add(g);
    else expandedGalaxies.delete(g);
    onToggleExpand(g, open);
  });

  return section;
};

/**
 * Build one 8×8 pixel representing a single system. Coloured by the
 * best status across the user's target positions; falls back to the
 * unscanned colour (with a subtle border) when we have no data for the
 * system. The `title` is a multi-line tooltip — full per-slot breakdown
 * for scanned systems, a single "not scanned" line otherwise.
 *
 * @param {number} g
 * @param {number} s
 * @param {GalaxyScans} scans
 * @param {Set<number>} targetPositions
 * @returns {HTMLDivElement}
 */
const renderSystemPixel = (g, s, scans, targetPositions) => {
  const key = /** @type {`${number}:${number}`} */ (g + ':' + s);
  const scan = scans[key];
  const px = document.createElement('div');

  if (scan && scan.positions) {
    const best = bestStatusInSystem(scan.positions, targetPositions);
    const bg = best ? STATUS_COLORS[best] : UNSCANNED_COLOR;
    px.style.cssText =
      'width:8px;height:8px;border-radius:1px;cursor:pointer;background:' + bg + ';';

    /** @type {string[]} */
    const lines = [
      '[' + g + ':' + s + '] scanned ' + new Date(scan.scannedAt).toLocaleString(),
    ];
    for (let pos = 1; pos <= 15; pos++) {
      const p = scan.positions[pos];
      if (!p) continue;
      // Flag serialisation: comma-join only the keys whose values are
      // truthy. `PositionFlags` only ever stores `true`, but the filter
      // is cheap and keeps the renderer robust against future shape
      // drift.
      const flagStr = p.flags
        ? ' (' +
          Object.keys(p.flags)
            .filter((f) => /** @type {Record<string, unknown>} */ (p.flags)[f])
            .join(',') +
          ')'
        : '';
      const playerStr = p.player ? ' [' + p.player.name + ']' : '';
      lines.push(
        '  ' + String(pos).padStart(2, ' ') + ': ' + p.status + flagStr + playerStr,
      );
    }
    px.title = lines.join('\n');
  } else {
    px.style.cssText =
      'width:8px;height:8px;border-radius:1px;cursor:pointer;background:' +
      UNSCANNED_COLOR +
      ';border:' +
      UNSCANNED_BORDER +
      ';';
    px.title = '[' + g + ':' + s + '] not scanned';
  }

  return px;
};
