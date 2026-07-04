// Server "threat / farm field" — the strategy-INDEPENDENT temperature layer of
// the server map. Two channels, each a signal EMITTED by its sources and spread
// to the neighbourhood by real OGame reach mechanics, over a black void:
//
//  • THREAT (red): every active player emits their danger D ({@link classifyCell}
//    over the v2 per-player danger model — attack-capable military, not raw
//    points). Crucially the spread is PER PLAYER: one player's nearby planets
//    dedup into a single fleet-presence (capped ×1.3 bonus for density), never
//    n× — a fleet is one object, wherever its owner's planets sit — while
//    DIFFERENT players in reach still sum. It spreads by the MOON-DESTRUCTION
//    (NISZCZ) reach — the only way to break
//    a proper moon fleet-save. Post-v12.9.0 that mission flies at a FIXED speed
//    (independent of drive tech and server speed), so its flight time is a pure
//    function of distance: `t = 3500·√(d/31) + 10` s. We grade the reach by
//    whether a RIP arrives inside the player's offline window (default 8 h — an
//    active player is away at most a night; 12 h is the rare tail; ≥16 h ⇒ they
//    play passively and are farm anyway). At 8 h that reaches ~your own system;
//    at 12 h ~20 systems; a galaxy hop is ~24.7 h ⇒ cross-galaxy is safe. So the
//    threat is tight and local, and galaxies separate — from mechanics, not blur.
//
//  • FARM (gold): every inactive emits value = its account points (rich idler =
//    developed mines = loot). It spreads by YOUR cargo reach — fast, wide, and
//    scaling with your drive/server, so we take it as a plain system radius.
//
// Colour is RELATIVE (each channel stretched to its own p95), because on one
// server everyone shares the same scaling — the server-speed multiplier cancels
// in a relative map, so absolute minutes never enter the colouring.
//
// Pure: no DOM/timers/storage/chrome — the `domain/` contract.
//
// @ts-check

import { classifyCell } from './cellClass.js';
import {
  GALAXY_IN_SYSTEMS,
  SYSTEM_BASE,
  SYSTEM_STEP,
  axisDelta,
  clamp01,
  flightDistance,
  reachThreat,
} from './geometry.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 */

/** Nearest-rank percentile of an ASCENDING-sorted array. @param {number[]} a @param {number} p */
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

/**
 * Per-player presence bonus for the threat convolution: one player's threat at
 * a cell = `D × maxReach × presenceBonus(sumReach / maxReach)`. `eff = sum/max`
 * is the effective count of that player's planets in reach (1 for a lone
 * planet, n for n equal-reach planets); the bonus grows with density but is
 * CAPPED — n nearby planets are ONE fleet that's merely more likely to be
 * around, never n× the danger. EXPORTED so the "Ignore worst" drop-resample in
 * `zoneScore.adjustedThreatMean` subtracts an excluded player with the exact
 * same shape the field added them — the two must never drift.
 *
 * @param {number} eff  sumReach / maxReach (≥ 1).
 * @returns {number} 1 … {@link PRESENCE_CAP}.
 */
export const PRESENCE_CAP = 1.3;
/** @param {number} eff @returns {number} */
export const presenceBonus = (eff) => Math.min(PRESENCE_CAP, 1 + 0.15 * Math.log2(Math.max(1, eff)));

/**
 * @typedef {object} FieldCell
 * @property {number} threat  0..1 (relative), red channel.
 * @property {number} farm    0..1 (relative), gold channel.
 * @property {number} [threatRaw]  Pre-clamp threat in p95 units (0..∞) — a
 *   cell whose raw pressure exceeded the server p95 clamps to 1.0 in
 *   `threat`, but consumers that SUBTRACT from the sample (the zoneScore
 *   field-aware exclusion) must work in raw units or a saturated cell would
 *   read as safer than it is.
 */

/**
 * @typedef {object} ThreatFarmField
 * @property {FieldCell[][]} grid  Indexed by 1-based galaxy then column.
 * @property {number} cols
 * @property {number} galaxies
 * @property {number} systems   Systems per galaxy the field was built over —
 *   needed for the exact system→bin mapping ({@link sampleField}).
 * @property {number} binWidth
 * @property {number} windowH   Offline window (hours) the threat kernel used.
 * @property {boolean} donutSystem  System-axis wrap the build honoured.
 * @property {number} threatScale  The p95 the threat channel was normalised
 *   by — lets a consumer convert a raw emission back into grid units (the
 *   zoneScore field-aware exclusion).
 */

/**
 * Build the two-channel threat/farm field.
 *
 * @param {GalaxyScans} scans   Composite (API + live) scan map, keyed `"g:s"`.
 * @param {{galaxies:number, systems:number, donutGalaxy?:boolean, donutSystem?:boolean}} dims
 * @param {{ownMilitary?:number, cols?:number, window?:number, farmReach?:number, danger?:Map<number, import('./dangerScore.js').DangerProfile>}} [opts]
 *   `window` = offline hours (default 8) — the threat radius. `farmReach` =
 *   farm system radius (default 30). `danger` = per-player danger profiles
 *   (v2); when present each active occupant emits its precomputed `D` (defense
 *   stripped, friendlies zeroed). `ownMilitary` is the legacy anchor used only
 *   when `danger` is absent.
 * @returns {ThreatFarmField}
 */
export const buildThreatFarmField = (scans, dims, opts = {}) => {
  const { galaxies, systems } = dims;
  const donutGalaxy = !!dims.donutGalaxy;
  const donutSystem = !!dims.donutSystem;
  const N = Math.max(1, Math.min(opts.cols ?? 64, systems));
  const windowH = opts.window ?? 8;
  const farmReach = opts.farmReach ?? 30;
  const clsCtx = { ownMilitary: opts.ownMilitary, danger: opts.danger };
  const binWidth = systems / N;
  /** @param {number} c */
  const centroid = (c) => Math.round((c + 0.5) * binWidth);

  // 1) Per-bin sources. Farm = summed points (scalar). Threat = the SET of
  //    distinct players present with their danger D, kept PER PLAYER (not
  //    reduced to a scalar), so the convolution can dedup one player's nearby
  //    planets into a single fleet-presence with a capped bonus instead of
  //    counting n planets as n× threat.
  /** @type {Array<Array<Map<number|string, number> | null>>} */
  const srcPlayers = [];
  /** @type {number[][]} */
  const farmSrc = [];
  for (let g = 1; g <= galaxies; g++) {
    srcPlayers[g] = new Array(N).fill(null);
    farmSrc[g] = new Array(N).fill(0);
  }
  // Planet count per idle account: a whale's loot ≈ its account score spread
  // over its planets — NOT counted in full once per planet (a 20-planet idler
  // was 20×, drowning every other farm).
  /** @type {Map<number, number>} */
  const farmPlanets = new Map();
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      if (!positions) continue;
      for (let p = 1; p <= 15; p++) {
        const pos = positions[p];
        if (pos && (pos.status === 'inactive' || pos.status === 'long_inactive') && pos.player && pos.player.id != null) {
          farmPlanets.set(pos.player.id, (farmPlanets.get(pos.player.id) || 0) + 1);
        }
      }
    }
  }
  // Reused per system so a player's repeated planets in ONE system collapse to
  // a single danger contribution — a distinct-player map, not a running MAX.
  /** @type {Map<number|string, number>} */
  const threatByOccupant = new Map();
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      if (!positions) continue;
      threatByOccupant.clear();
      let fm = 0;
      for (let p = 1; p <= 15; p++) {
        const pos = positions[p];
        if (!pos) continue;
        const cls = classifyCell(pos.status, pos.player, clsCtx);
        if (cls.bucket === 'threat') {
          // One entry per DISTINCT player: 5 planets of one player in this
          // system are ONE fleet, not 5× threat (the user's "wszystkie planety
          // obok siebie nie może być n razy niebezpieczniejszy"). A player's D
          // is constant, so max() just guards odd duplicate rows.
          // Anon key carries the system so two player-less threats in
          // different systems can't collide when merged into a display bin.
          const key = pos.player && pos.player.id != null ? pos.player.id : `anon:${s}:${p}`;
          const prev = threatByOccupant.get(key) ?? 0;
          if (cls.intensity > prev) threatByOccupant.set(key, cls.intensity);
        } else if (cls.bucket === 'farm' && pos.player && typeof pos.player.score === 'number') {
          const pc = pos.player.id != null ? (farmPlanets.get(pos.player.id) || 1) : 1;
          fm += pos.player.score / pc;
        }
      }
      const c = Math.min(N - 1, Math.floor(((s - 1) * N) / systems));
      // Merge this system's distinct-player danger into the bin, keeping the
      // MAX D per player across systems that map to one display bin (at ranking
      // resolution N = systems this is 1:1). Per-player, not a scalar sum — the
      // convolution below dedups a player across nearby systems.
      if (threatByOccupant.size) {
        let m = srcPlayers[g][c];
        if (!m) { m = new Map(); srcPlayers[g][c] = m; }
        for (const [k, d] of threatByOccupant) {
          if (d > (m.get(k) ?? 0)) m.set(k, d);
        }
      }
      farmSrc[g][c] += fm;
    }
  }

  // 2) Convolve each source field with its reach kernel (donut-wrapped). Window
  //    is sized to the wider of the two reaches; threat fades by 1.5× the window.
  const farmBins = Math.ceil(farmReach / binWidth) + 1;
  const tMaxD = 31 * ((1.5 * windowH * 3600 - 10) / 3500) ** 2;
  const threatSys = tMaxD > SYSTEM_BASE ? (tMaxD - SYSTEM_BASE) / SYSTEM_STEP : 0;
  const threatBins = Math.ceil(threatSys / binWidth) + 1;
  const maxCols = Math.min(N, Math.max(farmBins, threatBins, 1));

  // Per-player threat accumulator, reused per target cell: key → running
  // {sum of reach, max reach, danger} over that player's source bins in range.
  // The cell's threat sums, over DISTINCT players, `d × maxReach ×
  // presenceBonus(sum/max)` (see {@link presenceBonus}).
  /** @type {Map<number|string, { sum: number, max: number, d: number }>} */
  const acc = new Map();

  /** @type {number[][]} */
  const threatF = [];
  /** @type {number[][]} */
  const farmF = [];
  for (let g = 1; g <= galaxies; g++) {
    threatF[g] = new Array(N).fill(0);
    farmF[g] = new Array(N).fill(0);
    for (let c = 0; c < N; c++) {
      acc.clear();
      let fv = 0;
      for (let dg = -1; dg <= 1; dg++) {
        let g2 = g + dg;
        if (g2 < 1 || g2 > galaxies) {
          if (!donutGalaxy) continue;
          g2 = ((g2 - 1 + galaxies) % galaxies) + 1;
        }
        for (let dc = -maxCols; dc <= maxCols; dc++) {
          let c2 = c + dc;
          if (c2 < 0 || c2 >= N) {
            if (!donutSystem) continue;
            c2 = ((c2 % N) + N) % N;
          }
          const players = srcPlayers[g2][c2];
          const fs = farmSrc[g2][c2];
          if (!players && fs === 0) continue;
          const ag = axisDelta(g, g2, galaxies, donutGalaxy);
          const dSys = axisDelta(centroid(c), centroid(c2), systems, donutSystem);
          if (fs > 0) fv += fs * clamp01(1 - (dSys + ag * GALAXY_IN_SYSTEMS) / farmReach);
          if (players) {
            const r = reachThreat(flightDistance(ag, dSys), windowH);
            if (r > 0) {
              for (const [k, d] of players) {
                const e = acc.get(k);
                if (e) { e.sum += r; if (r > e.max) e.max = r; if (d > e.d) e.d = d; }
                else acc.set(k, { sum: r, max: r, d });
              }
            }
          }
        }
      }
      // Dedup + capped presence bonus, summed across DISTINCT players (so two
      // different players in reach still add, but one player's cluster doesn't).
      let tv = 0;
      for (const e of acc.values()) tv += e.d * e.max * presenceBonus(e.sum / e.max);
      threatF[g][c] = tv;
      farmF[g][c] = fv;
    }
  }

  // 3) Relative normalisation — each channel to its own p95.
  /** @type {number[]} */
  const tvals = [];
  /** @type {number[]} */
  const fvals = [];
  for (let g = 1; g <= galaxies; g++) {
    for (let c = 0; c < N; c++) {
      if (threatF[g][c] > 0) tvals.push(threatF[g][c]);
      if (farmF[g][c] > 0) fvals.push(farmF[g][c]);
    }
  }
  tvals.sort((a, b) => a - b);
  fvals.sort((a, b) => a - b);
  const tScale = tvals.length ? Math.max(1e-6, pct(tvals, 0.95)) : 1;
  const fScale = fvals.length ? Math.max(1e-6, pct(fvals, 0.95)) : 1;

  /** @type {FieldCell[][]} */
  const grid = [];
  for (let g = 1; g <= galaxies; g++) {
    grid[g] = [];
    for (let c = 0; c < N; c++) {
      const rawT = threatF[g][c] / tScale;
      grid[g][c] = { threat: clamp01(rawT), farm: clamp01(farmF[g][c] / fScale), threatRaw: rawT };
    }
  }
  return { grid, cols: N, galaxies, systems, binWidth, windowH, donutSystem, threatScale: tScale };
};

/**
 * Exact system → bin sample of a built field. Mirrors the source binning
 * (`floor((s−1)·cols/systems)`) so any scoring consumer and the map pixels can
 * never drift on the mapping. Out-of-range coordinates read as void.
 *
 * @param {ThreatFarmField} field @param {number} g @param {number} s
 * @returns {FieldCell}
 */
export const sampleField = (field, g, s) => {
  const row = field.grid[g];
  if (!row) return { threat: 0, farm: 0 };
  const c = Math.max(0, Math.min(field.cols - 1, Math.floor(((s - 1) * field.cols) / field.systems)));
  return row[c] ?? { threat: 0, farm: 0 };
};
