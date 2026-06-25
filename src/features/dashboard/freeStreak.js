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
  findNeighbourhoodCandidates,
  spaceOutCandidates,
  systemIntentHeat,
  sortRegionsByStrategy,
  STRATEGIES,
  MIN_REGION_LENGTH,
} from '../../domain/regions.js';
import { STRIP_PRIORITY, bestStatusInSystem } from '../../domain/histogram.js';
import { occupantStrength, honorRank } from '../../domain/players.js';
import {
  STATUS_COLORS, STATUS_LABELS, STRENGTH_COLORS, STRENGTH_LABELS,
  HONOR_COLORS, HONOR_TIER_LABELS, UNSCANNED_COLOR, heatColor,
} from './palette.js';
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
 * @returns {HTMLElement}
 */
const buildSystemCard = (g, s, scan, pinned, players) => {
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

  const foot = document.createElement('div');
  foot.className = 'rp-foot';
  foot.textContent = pinned ? '📌 pinned — click the cell again to unpin' : 'click a cell to pin';
  card.appendChild(foot);
  return card;
};

/**
 * Build the interactive per-system strip. One cell per system in the region;
 * the colour story depends on the mode:
 *
 *   - `'streak'`        → canonical {@link STATUS_COLORS} (WHAT is in each system),
 *                         same palette as the galaxy map and legend.
 *   - `'neighbourhood'` → intent HEAT ({@link systemIntentHeat} → {@link heatColor}):
 *                         green = good for the current strategy, red = bad, grey
 *                         = neutral. The centre settle system is ringed.
 *
 * Hovering a cell pops a friendly {@link buildSystemCard} above it (no tooltip
 * wait); clicking PINS it so it stays while you read / compare. Hovering other
 * cells previews them; leaving the strip restores the pinned card (or hides).
 *
 * @param {Region} region
 * @param {GalaxyScans} scans
 * @param {object} o
 * @param {'streak'|'neighbourhood'} o.mode
 * @param {import('../../domain/regions.js').StrategyWeights} [o.weights]
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]
 * @returns {HTMLElement}
 */
const buildInteractiveStrip = (region, scans, { mode, weights, players }) => {
  const wrap = document.createElement('div');
  wrap.className = 'region-strip-wrap';
  const strip = document.createElement('div');
  strip.className = mode === 'neighbourhood' ? 'region-strip heat' : 'region-strip';
  const pop = document.createElement('div');
  pop.className = 'region-pop';
  const w = weights ?? {};

  /** @type {Map<number, HTMLElement>} */
  const cellBySys = new Map();
  /** @type {number | null} */
  let pinned = null;

  /** @param {number} sys */
  const showFor = (sys) => {
    const cell = cellBySys.get(sys);
    if (!cell) return;
    pop.replaceChildren(buildSystemCard(region.galaxy, sys, scans[`${region.galaxy}:${sys}`], pinned === sys, players));
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

  for (const sys of regionSystems(region)) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    const scanned = !!sysData?.positions;
    const cell = document.createElement('span');
    cell.className = 'strip-cell';
    if (mode === 'neighbourhood') {
      cell.style.backgroundColor = scanned
        ? heatColor(systemIntentHeat(scans, region.galaxy, sys, w, { players }))
        : UNSCANNED_COLOR;
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
 * One-line neighbourhood summary from a {@link RegionScore}. Shared by the
 * streak record and the neighbourhood detail panel. `coverage` prepends the
 * "N/M sys scanned" fragment — useful for a streak region (whose span is
 * partly scanned) but noise for a neighbourhood window over API-complete data.
 *
 * @param {RegionScore} s
 * @param {number} [ownRank]
 * @param {{ coverage?: boolean }} [o]
 * @returns {string}
 */
const scoreLineText = (s, ownRank, { coverage = true } = {}) => {
  const parts = [];
  if (coverage) {
    const cov = s.scanned === s.systemCount ? `all ${s.systemCount}` : `${s.scanned}/${s.systemCount}`;
    parts.push(`${cov} sys scanned`);
  }
  if (s.occupied || s.inactive || s.vacation) {
    const nbParts = [];
    if (s.occupied) nbParts.push(`${s.occupied} active`);
    if (s.inactive) nbParts.push(`${s.inactive} farmable`);
    if (s.vacation) nbParts.push(`${s.vacation} vacation`);
    parts.push(nbParts.join(' · '));
  }
  if (s.allianceCount) parts.push(`${s.allianceCount} alliance${s.allianceCount > 1 ? 's' : ''}`);
  if (s.bandits || s.honored) {
    const honor = [];
    if (s.bandits) honor.push(`${s.bandits}× bandit${s.bandits > 1 ? 's' : ''} ${'★'.repeat(s.banditMaxLevel)}`);
    if (s.honored) honor.push(`${s.honored}× honored ${'★'.repeat(s.honoredMaxLevel)}`);
    parts.push(honor.join(', '));
  }
  const threats = [];
  if (s.strong) threats.push(`${s.strong} strong`);
  if (s.activeOnVacation) threats.push(`${s.activeOnVacation} active-on-vac`);
  if (threats.length) parts.push(threats.join(', '));
  const social = [];
  if (s.allyNearby) social.push(`${s.allyNearby} ally`);
  if (s.buddy) social.push(`${s.buddy} buddy`);
  if (s.outlaw) social.push(`${s.outlaw} outlaw`);
  if (s.newbie) social.push(`${s.newbie} newbie`);
  if (social.length) parts.push(social.join(', '));
  if (s.ranks.length) {
    const top = s.ranks[0];
    let rel = '';
    if (typeof ownRank === 'number' && ownRank > 0) {
      const d = ownRank - top;
      rel = d > 0 ? ` (${d} above you)` : d < 0 ? ` (${-d} below you)` : ' (your rank)';
    }
    parts.push(`top neighbour rank #${top}${rel}`);
  }
  if (Number.isFinite(s.mineMinDist)) parts.push(`${s.mineMinDist} sys to nearest colony`);
  else parts.push('no colony in this galaxy yet');
  return parts.join(' · ');
};

/** The red↔grey↔green ramp legend for the heat strip. */
const buildHeatLegend = () => {
  const el = document.createElement('div');
  el.className = 'heat-legend';
  const bad = document.createElement('span');
  bad.textContent = 'worse for strategy';
  const ramp = document.createElement('span');
  ramp.className = 'heat-ramp';
  const good = document.createElement('span');
  good.textContent = 'better';
  el.append(bad, ramp, good);
  return el;
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
    ['Galaxy', ''],
    ['System', 'Your favourite system to colonise — the free-slot system at the centre of the window'],
    ['Window', 'Systems analysed around the settle spot'],
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
    /** @type {[string, boolean, string][]} */
    const cells = [
      [String(i + 1), true, ''],
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
 * @param {import('../../domain/regions.js').StrategyWeights} [o.weights]
 * @param {import('../../domain/regions.js').PlayerCache} [o.players]
 * @param {number} [o.ownRank]
 * @returns {HTMLElement}
 */
const buildDetail = (region, scans, { mode, weights, players, ownRank }) => {
  const nbr = mode === 'neighbourhood';
  const el = document.createElement('div');
  el.className = 'streak-record';

  const labelLine = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'label';
  const value = document.createElement('span');
  value.className = 'value';
  if (nbr) {
    label.textContent = 'Selected area: ';
    value.textContent = `G${region.galaxy}:${region.center} · ±${(region.length - 1) / 2} sys`;
  } else {
    label.textContent = 'Top region: ';
    value.textContent = `${region.length} systems`;
  }
  labelLine.append(label, value);

  const coords = document.createElement('div');
  coords.style.cssText = 'color:#888;font-size:12px;margin-top:4px;';
  coords.textContent = nbr
    ? `Galaxy ${region.galaxy}, colony at system ${region.center} · window ${region.start} → ${region.end}`
      + (region.end < region.start ? ' (wraps 499 → 1)' : '')
    : `Galaxy ${region.galaxy}, system ${region.start} → ${region.end}`
      + (region.gaps ? ` (${region.matched} free, ${region.gaps} gap${region.gaps === 1 ? '' : 's'})` : '')
      + (region.end < region.start ? ' (wraps across the 499 → 1 boundary)' : '');
  el.append(labelLine, coords);

  const s = region.score;
  if (s) {
    const scoreLine = document.createElement('div');
    scoreLine.className = 'streak-score';
    scoreLine.textContent = scoreLineText(s, ownRank, { coverage: !nbr });
    el.appendChild(scoreLine);

    // Target breakdown by NoobProtection band — honorable / weak / strong
    // occupants in range. All 0 without a joined player cache, so the line
    // simply doesn't appear then.
    const targetBits = [];
    if (s.honorable) targetBits.push(`${s.honorable} honorable`);
    if (s.normal) targetBits.push(`${s.normal} normal`);
    if (s.newbie) targetBits.push(`${s.newbie} weak`);
    if (s.strong) targetBits.push(`${s.strong} strong`);
    if (targetBits.length) {
      const targets = document.createElement('div');
      targets.style.cssText = 'color:#9fb8c9;font-size:12px;margin-top:2px;';
      targets.textContent = '🎯 Targets: ' + targetBits.join(' · ');
      el.appendChild(targets);
    }

    // Bandit (negative-honour aggressor) breakdown by tier — the danger signal
    // for a fresh colony, counted SEPARATELY from the target bands. Highest
    // tier first (Bandit King → Bandit). All from per-slot rankClass, so this
    // shows even without a player cache.
    const banditBits = [];
    let banditMaxTier = 0;
    for (const t of [3, 2, 1]) {
      const n = s.banditTiers?.[t];
      if (n) {
        banditBits.push(`${n} ${HONOR_TIER_LABELS.bandit[t]}`);
        if (!banditMaxTier) banditMaxTier = t;
      }
    }
    if (banditBits.length) {
      const bandits = document.createElement('div');
      bandits.style.cssText = `color:${HONOR_COLORS.bandit};font-weight:700;font-size:12px;margin-top:2px;`;
      // Lead with "!" marks for the WORST tier present (more = nastier), red.
      bandits.textContent = `${'!'.repeat(banditMaxTier)} Bandits: ${banditBits.join(' · ')}`;
      el.appendChild(bandits);
    }

    el.appendChild(buildInteractiveStrip(region, scans, { mode, weights, players }));

    if (nbr) {
      el.appendChild(buildHeatLegend());
      if (region.excluded && region.excluded.length) {
        el.appendChild(buildExcludedLine(region.excluded, ownRank));
      }
    } else {
      el.appendChild(buildStripLegend(region, scans));
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
 * @param {{ mode: 'streak'|'neighbourhood', weights?: import('../../domain/regions.js').StrategyWeights, players?: import('../../domain/regions.js').PlayerCache, ownRank?: number }} detailOpts
 * @param {(rows: Region[], ownRank?: number) => HTMLTableElement} tableBuilder
 * @returns {void}
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
 * @property {number} [radius]
 *   Neighbourhood strategies only: window half-width R (analysed band is
 *   `[S−R, S+R]` around each settle spot). Default 15. Ignored for 'longest'.
 * @property {number} [excludeN]
 *   Neighbourhood strategies only: how many worst stat-ruining players to drop
 *   from each window's score. Default 0. Ignored for 'longest'.
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
export const renderFreeRegions = ({ containerEl, countInfoEl, scans, positions, maxGaps, strategy, expansion, radius, excludeN, customWeights, players, ownRank }) => {
  containerEl.innerHTML = '';

  const stratKey = strategy ?? 'longest';
  const neighbourhood = stratKey !== 'longest';
  // Effective weights drive BOTH the candidate ranking and the strip heat — a
  // custom set (sliders moved) overrides the preset; else the preset's own.
  const weights = customWeights ?? (STRATEGIES[stratKey]?.weights ?? {});
  // Alliance-proximity bonus is now AUTOMATIC: the player cache carries the
  // game-truth `isAllianceMember` (→ RegionScore.allyNearby), so the old manual
  // "Ally tag" field is gone. Applied only when a cache is present, and skipped
  // for 'longest' so that preset stays pure free-slot length.
  const allyBonus = players && neighbourhood ? 1.5 : 0;
  /** @param {Region[]} list @returns {Region[]} */
  const sortByStrategy = (list) =>
    sortRegionsByStrategy(list, stratKey, { expansion: expansion ?? 0, allyBonus, customWeights });
  const stratLabel = neighbourhood && STRATEGIES[stratKey]
    ? ` · ${STRATEGIES[stratKey].label}` : '';
  const posLabel = positions.join(', ');
  /** @param {number} n @returns {string} */
  const galaxiesLabel = (n) => `${n} galax${n === 1 ? 'y' : 'ies'}`;

  // ── Neighbourhood strategies: scored settle-area windows, not slot streaks ──
  if (neighbourhood) {
    const r = radius ?? 15;
    const candidates = spaceOutCandidates(
      sortByStrategy(findNeighbourhoodCandidates(scans, {
        positions, status: 'empty', radius: r, players, ownRank, excludeN: excludeN ?? 0, weights,
      })),
      r,
    );
    if (candidates.length > 0) {
      if (countInfoEl) {
        const galaxyCount = new Set(candidates.map((c) => c.galaxy)).size;
        const showingLabel = candidates.length > TOP_N ? ` (showing top ${TOP_N})` : '';
        countInfoEl.textContent =
          `${candidates.length} settle area${candidates.length === 1 ? '' : 's'} across `
          + `${galaxiesLabel(galaxyCount)}${stratLabel}${showingLabel}`;
      }
      renderInteractive(containerEl, candidates, scans, { mode: 'neighbourhood', weights, players, ownRank }, buildCandidateTable);
      return;
    }
    if (countInfoEl) countInfoEl.textContent = 'No settle areas yet for these slots.';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      `No system has slot${positions.length === 1 ? '' : 's'} ${posLabel} free yet. `
      + 'Scan more galaxy pages (or widen the slots), then come back here.';
    containerEl.appendChild(empty);
    return;
  }

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
    renderInteractive(containerEl, results, scans, { mode: 'streak', weights, players, ownRank }, buildTable);
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
    renderInteractive(containerEl, freeSystems, scans, { mode: 'streak', weights, players, ownRank }, buildTable);
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
