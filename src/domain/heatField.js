// Server "threat / farm field" — the strategy-INDEPENDENT temperature layer of
// the server map. Two channels, each a signal EMITTED by its sources and spread
// to the neighbourhood by real OGame reach mechanics, over a black void:
//
//  • THREAT (red): every active player emits danger weighted by how much
//    stronger-than-me they are + bandit/honour tier ({@link classifyCell}).
//    It spreads by the MOON-DESTRUCTION (NISZCZ) reach — the only way to break
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

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 */

// Verified OGame flight-distance constants (galaxy / system terms).
const GALAXY_STEP = 20000;
const SYSTEM_BASE = 2700;
const SYSTEM_STEP = 95;
// Same-vicinity (a source in the target's own bin) reads as an in-system RIP.
const SAME_SYSTEM_D = 1005;
// Systems-of-distance a galaxy hop costs (20000 = 2700 + 95·183) — for the farm
// system-radius so it barely crosses galaxies.
const GALAXY_IN_SYSTEMS = 183;

/** @param {number} x */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Wrap-aware absolute difference on a circular axis (the donut `min()`).
 * @param {number} a @param {number} b @param {number} total @param {boolean} donut
 * @returns {number}
 */
const axisDelta = (a, b, total, donut) => {
  const d = Math.abs(a - b);
  return donut ? Math.min(d, total - d) : d;
};

/** NISZCZ flight time (hours) for an OGame flight-distance `d`. @param {number} d */
const niszczHours = (d) => (3500 * Math.sqrt(d / 31) + 10) / 3600;

/**
 * Threat reach 0..1 for distance `d` and offline window (hours): 1 while a RIP
 * arrives inside the window, fading to 0 by 1.5× the window.
 * @param {number} d @param {number} windowH
 */
const reachThreat = (d, windowH) => clamp01(3 - 2 * (niszczHours(d) / windowH));

/** Nearest-rank percentile of an ASCENDING-sorted array. @param {number[]} a @param {number} p */
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

/**
 * @typedef {object} FieldCell
 * @property {number} threat  0..1 (relative), red channel.
 * @property {number} farm    0..1 (relative), gold channel.
 */

/**
 * @typedef {object} ThreatFarmField
 * @property {FieldCell[][]} grid  Indexed by 1-based galaxy then column.
 * @property {number} cols
 * @property {number} galaxies
 * @property {number} binWidth
 */

/**
 * Build the two-channel threat/farm field.
 *
 * @param {GalaxyScans} scans   Composite (API + live) scan map, keyed `"g:s"`.
 * @param {{galaxies:number, systems:number, donutGalaxy?:boolean, donutSystem?:boolean}} dims
 * @param {{ownMilitary?:number, cols?:number, window?:number, farmReach?:number}} [opts]
 *   `window` = offline hours (default 8) — the threat radius. `farmReach` =
 *   farm system radius (default 30). `ownMilitary` anchors threat intensity.
 * @returns {ThreatFarmField}
 */
export const buildThreatFarmField = (scans, dims, opts = {}) => {
  const { galaxies, systems } = dims;
  const donutGalaxy = !!dims.donutGalaxy;
  const donutSystem = !!dims.donutSystem;
  const N = Math.max(1, Math.min(opts.cols ?? 64, systems));
  const windowH = opts.window ?? 8;
  const farmReach = opts.farmReach ?? 30;
  const clsCtx = { ownMilitary: opts.ownMilitary };
  const binWidth = systems / N;
  /** @param {number} c */
  const centroid = (c) => Math.round((c + 0.5) * binWidth);

  // 1) Per-bin sources: threat = strongest active occupant; farm = summed points.
  /** @type {number[][]} */
  const threatSrc = [];
  /** @type {number[][]} */
  const farmSrc = [];
  for (let g = 1; g <= galaxies; g++) {
    threatSrc[g] = new Array(N).fill(0);
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
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const positions = scans[`${g}:${s}`]?.positions;
      if (!positions) continue;
      let st = 0;
      let fm = 0;
      for (let p = 1; p <= 15; p++) {
        const pos = positions[p];
        if (!pos) continue;
        const cls = classifyCell(pos.status, pos.player, clsCtx);
        if (cls.bucket === 'threat') st = Math.max(st, cls.intensity);
        else if (cls.bucket === 'farm' && pos.player && typeof pos.player.score === 'number') {
          const pc = pos.player.id != null ? (farmPlanets.get(pos.player.id) || 1) : 1;
          fm += pos.player.score / pc;
        }
      }
      const c = Math.min(N - 1, Math.floor(((s - 1) * N) / systems));
      if (st > threatSrc[g][c]) threatSrc[g][c] = st;
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

  /** @type {number[][]} */
  const threatF = [];
  /** @type {number[][]} */
  const farmF = [];
  for (let g = 1; g <= galaxies; g++) {
    threatF[g] = new Array(N).fill(0);
    farmF[g] = new Array(N).fill(0);
    for (let c = 0; c < N; c++) {
      let tv = 0;
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
          const ts = threatSrc[g2][c2];
          const fs = farmSrc[g2][c2];
          if (ts === 0 && fs === 0) continue;
          const ag = axisDelta(g, g2, galaxies, donutGalaxy);
          const dSys = axisDelta(centroid(c), centroid(c2), systems, donutSystem);
          if (ts > 0) {
            const d = ag > 0 ? GALAXY_STEP * ag : (dSys === 0 ? SAME_SYSTEM_D : SYSTEM_BASE + SYSTEM_STEP * dSys);
            tv += ts * reachThreat(d, windowH);
          }
          if (fs > 0) fv += fs * clamp01(1 - (dSys + ag * GALAXY_IN_SYSTEMS) / farmReach);
        }
      }
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
      grid[g][c] = { threat: clamp01(threatF[g][c] / tScale), farm: clamp01(farmF[g][c] / fScale) };
    }
  }
  return { grid, cols: N, galaxies, binWidth };
};
