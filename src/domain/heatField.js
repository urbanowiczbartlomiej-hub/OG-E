// Server "temperature field" — coarsens the per-system Colony-Scout intent heat
// into a binned, metric-smoothed, adaptively-scaled grid for the server map.
//
// # Why this shape (the design, in one place)
//
// The naive map (9 galaxies × 499 system cells) is too detailed and overflows
// the panel. This collapses each galaxy's 499 systems into ~64 columns and
// renders a smooth FIELD instead of every system. Three pure transforms:
//
//  1. BIN + TRIMMED WEIGHTED MEAN. Each column aggregates its ~8 systems'
//     `systemIntentHeat`, dropping the single hottest+coldest member (kills a
//     lone outlier) and weighting the rest by occupancy so empty space
//     contributes ~0 — empty bins read faint, not falsely warm.
//
//  2. METRIC SMOOTHING. Warmth bleeds between cells by the VERIFIED OGame
//     flight metric, not a hand-tuned σ: weight = exp(−√dist / τ) where `dist`
//     is the real inter-cell flight distance (galaxy step 20000, system
//     2700+95·Δs), with donut `min()` wrap on whichever axis the server wraps.
//     Because √20000 ≈ √(2700+95·183), cross-galaxy bleed comes out naturally
//     gentle — galaxy seams SOFTEN but galaxies don't dissolve. Position is
//     dropped (≤5/step, negligible vs 95 / 20000). `√distance` (not raw) is the
//     felt/time reach: flight time ∝ √distance.
//
//  3. ADAPTIVE TWO-SIDED STRETCH. Colour spans the REALIZED data: the positive
//     side is stretched to its p95, the negative side to |p5|, with 0 pinned
//     neutral — so a uniformly mild server still paints vivid while red never
//     flips to green. The realized endpoints are returned for the legend.
//
// Pure: no DOM/timers/storage/chrome — the `domain/` contract. The renderer
// (features/dashboard) turns the returned grid into coloured cells.
//
// @ts-check

import { systemIntentHeat } from './regions.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('./regions.js').StrategyWeights} StrategyWeights
 * @typedef {import('./regions.js').PlayerCache} PlayerCache
 */

// Verified OGame flight-distance constants (galaxy / system terms). Position is
// dropped. See the module header + docs for sources.
const GALAXY_STEP = 20000;
const SYSTEM_BASE = 2700;
const SYSTEM_STEP = 95;

/**
 * Wrap-aware absolute difference on a circular axis (the donut `min()`).
 * @param {number} a @param {number} b @param {number} total @param {boolean} donut
 * @returns {number}
 */
const axisDelta = (a, b, total, donut) => {
  const d = Math.abs(a - b);
  return donut ? Math.min(d, total - d) : d;
};

/**
 * Occupancy weight = number of positions with a real occupant (a `player`) in a
 * scanned system. Empty / mine / abandoned slots have no player → 0.
 * @param {{positions?: Record<number, {player?: unknown}>}|undefined} sysData
 * @returns {number}
 */
const occWeight = (sysData) => {
  if (!sysData || !sysData.positions) return 0;
  let n = 0;
  for (const pos of Object.values(sysData.positions)) {
    if (pos && pos.player) n++;
  }
  return n;
};

/**
 * Nearest-rank percentile of an ASCENDING-sorted array. 0 for empty.
 * @param {number[]} sorted @param {number} p
 * @returns {number}
 */
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

/**
 * @typedef {object} HeatFieldCell
 * @property {number} v  Normalized heat in [-1,1], ready for `heatColor`.
 * @property {number} w  Occupancy confidence 0..1 (low = render faint).
 */

/**
 * @typedef {object} HeatField
 * @property {HeatFieldCell[][]} grid  Indexed by 1-based galaxy then column
 *   (`grid[g][c]`, g = 1..galaxies). Index 0 is unused.
 * @property {number} cols       System columns (bins).
 * @property {number} galaxies   Galaxy rows.
 * @property {number} binWidth   Systems per column.
 * @property {number} scalePos   Realized positive scale endpoint (p95 of +heat).
 * @property {number} scaleNeg   Realized negative scale magnitude (p95 of |−heat|).
 */

/**
 * Build the server temperature field.
 *
 * @param {GalaxyScans} scans   Composite (API + live) scan map, keyed `"g:s"`.
 * @param {{galaxies:number, systems:number, donutGalaxy?:boolean, donutSystem?:boolean}} dims
 *   Grid bounds + per-server wrap flags (from serverData).
 * @param {StrategyWeights} weights  Active strategy weights (the heat lens).
 * @param {{players?:PlayerCache, ownRank?:number, cols?:number, tau?:number}} [opts]
 *   `cols` default 64, `tau` default 100. `players`/`ownRank` forwarded to
 *   `systemIntentHeat`.
 * @returns {HeatField}
 */
export const buildHeatField = (scans, dims, weights, opts = {}) => {
  const { galaxies, systems } = dims;
  const donutGalaxy = !!dims.donutGalaxy;
  const donutSystem = !!dims.donutSystem;
  const N = Math.max(1, Math.min(opts.cols ?? 64, systems));
  const tau = opts.tau ?? 100;
  const ctx = { players: opts.players, ownRank: opts.ownRank };
  const binWidth = systems / N;
  /** @param {number} c Column → its centroid system number. */
  const centroid = (c) => Math.round((c + 0.5) * binWidth);

  // 1) Per-system heat + occupancy, binned per galaxy row, then reduced to a
  //    trimmed weighted mean per cell.
  /** @type {number[][]} raw[g][c] heat (1-based g). */
  const raw = [];
  /** @type {number[][]} wsum[g][c] total bin occupancy (1-based g). */
  const wsum = [];
  for (let g = 1; g <= galaxies; g++) {
    /** @type {Array<Array<{heat:number, w:number}>>} */
    const cols = Array.from({ length: N }, () => []);
    for (let s = 1; s <= systems; s++) {
      const c = Math.min(N - 1, Math.floor(((s - 1) * N) / systems));
      const w = occWeight(scans[`${g}:${s}`]);
      const heat = systemIntentHeat(scans, g, s, weights, ctx);
      cols[c].push({ heat, w });
    }
    raw[g] = [];
    wsum[g] = [];
    for (let c = 0; c < N; c++) {
      const members = cols[c];
      let val = 0;
      let tw = 0;
      if (members.length >= 3) {
        members.sort((a, b) => a.heat - b.heat); // drop hottest + coldest outlier
        for (let i = 1; i < members.length - 1; i++) {
          val += members[i].heat * members[i].w;
          tw += members[i].w;
        }
      } else {
        for (const m of members) { val += m.heat * m.w; tw += m.w; }
      }
      raw[g][c] = tw > 0 ? val / tw : 0;
      let total = 0;
      for (const m of members) total += m.w;
      wsum[g][c] = total;
    }
  }

  // 2) Metric smoothing — exp(−√dist/τ) over a small window (±2 col, ±1 row),
  //    donut-wrapped per the server flags. Self distance 0 → weight 1.
  /** @type {number[][]} */
  const sm = [];
  for (let g = 1; g <= galaxies; g++) {
    sm[g] = [];
    for (let c = 0; c < N; c++) {
      let num = 0;
      let den = 0;
      for (let dg = -1; dg <= 1; dg++) {
        let g2 = g + dg;
        if (g2 < 1 || g2 > galaxies) {
          if (!donutGalaxy) continue;
          g2 = ((g2 - 1 + galaxies) % galaxies) + 1;
        }
        for (let dc = -2; dc <= 2; dc++) {
          let c2 = c + dc;
          if (c2 < 0 || c2 >= N) {
            if (!donutSystem) continue;
            c2 = ((c2 % N) + N) % N;
          }
          let dist;
          if (g2 === g && c2 === c) {
            dist = 0;
          } else {
            const ag = axisDelta(g, g2, galaxies, donutGalaxy);
            if (ag > 0) {
              dist = GALAXY_STEP * ag; // galaxy term dominates (highest coord wins)
            } else {
              const as = axisDelta(centroid(c), centroid(c2), systems, donutSystem);
              dist = SYSTEM_BASE + SYSTEM_STEP * as;
            }
          }
          const wk = Math.exp(-Math.sqrt(dist) / tau);
          num += wk * raw[g2][c2];
          den += wk;
        }
      }
      sm[g][c] = den > 0 ? num / den : 0;
    }
  }

  // 3) Adaptive two-sided percentile stretch on the SMOOTHED values (colour what
  //    we draw). Sign-preserving, 0 pinned neutral.
  /** @type {number[]} */
  const posVals = [];
  /** @type {number[]} */
  const negVals = [];
  /** @type {number[]} */
  const wflat = [];
  for (let g = 1; g <= galaxies; g++) {
    for (let c = 0; c < N; c++) {
      const v = sm[g][c];
      if (v > 0) posVals.push(v);
      else if (v < 0) negVals.push(-v);
      wflat.push(wsum[g][c]);
    }
  }
  posVals.sort((a, b) => a - b);
  negVals.sort((a, b) => a - b);
  wflat.sort((a, b) => a - b);
  const scalePos = Math.max(1e-3, pct(posVals, 0.95));
  const scaleNeg = Math.max(1e-3, pct(negVals, 0.95));
  const wref = Math.max(1, pct(wflat, 0.8)); // a bin is "full" around p80 occupancy

  /** @type {HeatFieldCell[][]} */
  const grid = [];
  for (let g = 1; g <= galaxies; g++) {
    grid[g] = [];
    for (let c = 0; c < N; c++) {
      const h = sm[g][c];
      const v = h >= 0 ? Math.min(1, h / scalePos) : -Math.min(1, -h / scaleNeg);
      grid[g][c] = { v, w: Math.min(1, wsum[g][c] / wref) };
    }
  }

  return { grid, cols: N, galaxies, binWidth, scalePos, scaleNeg };
};
