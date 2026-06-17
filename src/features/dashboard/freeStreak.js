// @ts-check

// Settlement-regions renderer — paints the "Free positions" block that
// lives INSIDE the Colonizations → "Colony Scout" sub-tab (it was a tab of
// its own up to 1.17.0; folded in so the mobile tab bar fits one line). Shows
// a top-N table of the best confirmed-empty regions per galaxy and a
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

import {
  findBestRegions,
  findFreeSystems,
  sortRegionsByStrategy,
  STRATEGIES,
  MIN_REGION_LENGTH,
} from '../../domain/regions.js';
import { STRIP_PRIORITY, bestStatusInSystem } from '../../domain/histogram.js';
import { STATUS_COLORS, STATUS_LABELS, UNSCANNED_COLOR } from './palette.js';
import { buildSystemTooltip } from './systemTooltip.js';
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
 * Enumerate the system numbers a region spans, honouring wrap-around at the
 * 499 → 1 boundary. Shared by the strip and its legend so they always
 * describe the exact same systems.
 *
 * @param {Region} region
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
 * Build the pixel-strip `<div>` visualising every system in the region —
 * one cell per system, coloured from the CANONICAL {@link STATUS_COLORS}
 * palette (the same key the galaxy pixel map and dashboard legend use) so
 * the strip never tells a different colour story than the rest of the app.
 * Each cell's hover is the full per-system breakdown
 * ({@link buildSystemTooltip}), not just the bare system number.
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @returns {HTMLElement}
 */
const buildStrip = (region, scans) => {
  const el = document.createElement('div');
  el.className = 'region-strip';

  for (const sys of regionSystems(region)) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    const st = stripCellStatus(sysData?.positions);
    const cell = document.createElement('span');
    cell.className = 'strip-cell';
    cell.style.backgroundColor = st ? STATUS_COLORS[st] : UNSCANNED_COLOR;
    cell.title = buildSystemTooltip(region.galaxy, sys, sysData);
    el.appendChild(cell);
  }

  return el;
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
 * @returns {HTMLElement}
 */
const buildStripLegend = (region, scans) => {
  /** @type {Set<string>} */
  const present = new Set();
  let anyUnscanned = false;
  for (const sys of regionSystems(region)) {
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
 * Build the tooltip text for the "Nbrs" table cell.
 * Shows active/dormant split plus the highest bandit tier as a
 * quick danger indicator — a single bandit3 is more alarming than
 * three bandit1s, so the max level is surfaced explicitly.
 *
 * @param {import('../../domain/regions.js').RegionScore} s
 * @returns {string}
 */
const buildNbrsTip = (s) => {
  const parts = [`${s.occupied} active, ${s.inactive} farmable, ${s.vacation} vacation (${s.scanned}/${s.systemCount} scanned)`];
  if (s.bandits) {
    parts.push(`⚠ ${s.bandits} bandit${s.bandits > 1 ? 's' : ''}, max tier ${s.banditMaxLevel}/3`);
  }
  if (s.honored) {
    parts.push(`${s.honored} honored, max tier ${s.honoredMaxLevel}/3`);
  }
  if (s.strong || s.activeOnVacation) {
    const t = [];
    if (s.strong) t.push(`${s.strong} strong`);
    if (s.activeOnVacation) t.push(`${s.activeOnVacation} active-on-vacation`);
    parts.push(`⚠ ${t.join(', ')}`);
  }
  const social = [];
  if (s.allyNearby) social.push(`${s.allyNearby} allied`);
  if (s.buddy) social.push(`${s.buddy} buddy`);
  if (s.outlaw) social.push(`${s.outlaw} outlaw`);
  if (s.newbie) social.push(`${s.newbie} newbie (protected)`);
  if (social.length) parts.push(social.join(', '));
  return parts.join('\n');
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
      [nbrs, true, s ? buildNbrsTip(s) : 'No scan data in range'],
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
 * @param {number} [ownRank] Our own highscore rank, for the relative-strength
 *   annotation on the top neighbour ("#11 (239 above you)").
 * @returns {HTMLElement}
 */
const buildRecord = (record, scans, ownRank) => {
  const el = document.createElement('div');
  el.className = 'streak-record';

  const labelLine = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Top region: ';
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
    if (s.occupied || s.inactive || s.vacation) {
      const nbParts = [];
      if (s.occupied) nbParts.push(`${s.occupied} active`);
      if (s.inactive) nbParts.push(`${s.inactive} farmable`);
      if (s.vacation) nbParts.push(`${s.vacation} vacation`);
      parts.push(nbParts.join(' · '));
    }
    if (s.allianceCount) {
      parts.push(`${s.allianceCount} alliance${s.allianceCount > 1 ? 's' : ''}`);
    }
    if (s.bandits || s.honored) {
      const honor = [];
      if (s.bandits) {
        const lvl = '★'.repeat(s.banditMaxLevel);
        honor.push(`${s.bandits}× bandit${s.bandits > 1 ? 's' : ''} ${lvl}`);
      }
      if (s.honored) {
        const lvl = '★'.repeat(s.honoredMaxLevel);
        honor.push(`${s.honored}× honored ${lvl}`);
      }
      parts.push(honor.join(', '));
    }
    // Threats the player cache surfaces that the status colour alone hides:
    // strong neighbours and "active on vacation" (a live player, not a farm).
    const threats = [];
    if (s.strong) threats.push(`${s.strong} strong`);
    if (s.activeOnVacation) threats.push(`${s.activeOnVacation} active-on-vac`);
    if (threats.length) parts.push(threats.join(', '));
    // Social signals: allied neighbours (game-truth), buddies, outlaws
    // (fair game), newbies (protected, no farm value).
    const social = [];
    if (s.allyNearby) social.push(`${s.allyNearby} ally`);
    if (s.buddy) social.push(`${s.buddy} buddy`);
    if (s.outlaw) social.push(`${s.outlaw} outlaw`);
    if (s.newbie) social.push(`${s.newbie} newbie`);
    if (social.length) parts.push(social.join(', '));
    if (s.ranks.length) {
      const top = s.ranks[0];
      // Relative to us: a LOWER rank number is a STRONGER player, so
      // ownRank - top > 0 means the neighbour outranks (is above) us.
      let rel = '';
      if (typeof ownRank === 'number' && ownRank > 0) {
        const d = ownRank - top;
        rel = d > 0 ? ` (${d} above you)` : d < 0 ? ` (${-d} below you)` : ' (your rank)';
      }
      parts.push(`top neighbour rank #${top}${rel}`);
    }
    // Distance to our nearest colony in this galaxy — context for whether
    // the region is fresh territory or backyard expansion. Infinity means
    // we hold nothing in this galaxy yet, so we say so rather than "∞ sys".
    if (Number.isFinite(s.mineMinDist)) {
      parts.push(`${s.mineMinDist} sys to nearest colony`);
    } else {
      parts.push('no colony in this galaxy yet');
    }
    scoreLine.textContent = parts.join(' · ');
    el.appendChild(scoreLine);

    el.appendChild(buildStrip(record, scans));
    el.appendChild(buildStripLegend(record, scans));
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
 * @property {string} [strategy]
 *   Key of {@link STRATEGIES} — re-sorts regions after finding them.
 *   Defaults to `'longest'` (pure length sort, existing behaviour).
 * @property {number} [expansion]
 *   Placement modifier: `> 0` = spread (prefer 100+ sys from own colonies);
 *   `< 0` = cluster (prefer near own colonies); `0` = no preference.
 * @property {import('../../domain/regions.js').StrategyWeights} [customWeights]
 *   When set, overrides the named strategy's weights with user-customised
 *   values from the weight sliders.
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
 * Repaint the settlement-regions block against `scans` for the requested
 * slots + tolerance. Owns the empty-state branch: when nothing matched,
 * the table area gets a single `.empty`-class line and no record card.
 *
 * @param {RenderFreeRegionsOptions} opts
 * @returns {void}
 */
export const renderFreeRegions = ({ containerEl, countInfoEl, scans, positions, maxGaps, strategy, expansion, customWeights, players, ownRank }) => {
  containerEl.innerHTML = '';

  const stratKey = strategy ?? 'longest';
  // Alliance-proximity bonus is now AUTOMATIC: the player cache carries the
  // game-truth `isAllianceMember` (→ RegionScore.allyNearby), so the old manual
  // "Ally tag" field is gone. Applied only when a cache is present, and skipped
  // for 'longest' so that preset stays pure free-slot length.
  const allyBonus = players && stratKey !== 'longest' ? 1.5 : 0;
  /** @param {Region[]} list @returns {Region[]} */
  const sortByStrategy = (list) =>
    sortRegionsByStrategy(list, stratKey, { expansion: expansion ?? 0, allyBonus, customWeights });
  const stratLabel = stratKey !== 'longest' && STRATEGIES[stratKey]
    ? ` · ${STRATEGIES[stratKey].label}` : '';
  const posLabel = positions.join(', ');
  /** @param {number} n @returns {string} */
  const galaxiesLabel = (n) => `${n} galax${n === 1 ? 'y' : 'ies'}`;

  const results = sortByStrategy(
    findBestRegions(scans, { positions, status: 'empty', maxGaps, players }),
  );

  // Happy path: contiguous regions of length ≥ MIN_REGION_LENGTH exist.
  if (results.length > 0) {
    if (countInfoEl) {
      const galaxyCount = new Set(results.map((r) => r.galaxy)).size;
      const showingLabel = results.length > TOP_N ? ` (showing top ${TOP_N})` : '';
      countInfoEl.textContent =
        `${results.length} region${results.length === 1 ? '' : 's'} across `
        + `${galaxiesLabel(galaxyCount)}${stratLabel}${showingLabel}`;
    }
    containerEl.appendChild(buildTable(results));
    containerEl.appendChild(buildRecord(results[0], scans, ownRank));
    return;
  }

  // Fallback: no run of MIN_REGION_LENGTH, but individual free systems may
  // still exist — the common single-slot-colonisation case (scattered free
  // "8"s never form a streak; see findFreeSystems). List them, scored and
  // strategy-ranked, instead of a bare "nothing here".
  const freeSystems = sortByStrategy(
    findFreeSystems(scans, { positions, status: 'empty', players }),
  );
  if (freeSystems.length > 0) {
    if (countInfoEl) {
      const galaxyCount = new Set(freeSystems.map((r) => r.galaxy)).size;
      const showingLabel = freeSystems.length > TOP_N ? ` (showing top ${TOP_N})` : '';
      countInfoEl.textContent =
        `No region ≥${MIN_REGION_LENGTH} — ${freeSystems.length} individual free `
        + `system${freeSystems.length === 1 ? '' : 's'} across `
        + `${galaxiesLabel(galaxyCount)}${stratLabel}${showingLabel}`;
    }
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent =
      `No run of ${MIN_REGION_LENGTH}+ systems has slot${positions.length === 1 ? '' : 's'} `
      + `${posLabel} all free — here are the individual free systems instead `
      + '(best neighbourhood first):';
    containerEl.appendChild(note);
    containerEl.appendChild(buildTable(freeSystems));
    return;
  }

  // Truly nothing for these slots yet.
  if (countInfoEl) {
    countInfoEl.textContent = 'No confirmed empty regions yet for these slots.';
  }
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent =
    'Nothing to show yet. Scan more galaxy pages with slot'
    + (positions.length === 1 ? '' : 's') + ' ' + posLabel
    + ' empty, then come back here.';
  containerEl.appendChild(empty);
};
