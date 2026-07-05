// @ts-check

// Pure loot-rhythm analysis from a watched body's scan history. A "collector"
// farmer ferries daily production off every producing planet onto ONE hoard
// ("mother") planet, then fleet-saves the pile between his own bodies — a safe,
// predictable daily cycle. The per-body resource history (the `resTotal` ring in
// each SpyReportLite, kept for WATCHED players) exposes both the rhythm (average
// and peak loot on a body) and WHICH body is the hoard (a peak towering over the
// empire's typical peak). Planets only — moons carry no loot.
//
// Pure: plain functions over plain data. No DOM/timers/storage/chrome.
//
// @see state/targets.js — the {latest, history} store the stats are read from.
// @see domain/raidVerdict.js — consumes the current loot to decide raid-or-skip.

/**
 * @typedef {object} BodyLoot
 * @property {number} avg      Mean on-planet resources across the samples.
 * @property {number} max      Peak on-planet resources ever seen (the hoard tell).
 * @property {number} last     Most recent on-planet resources.
 * @property {number} samples  How many resource observations back this.
 */

/**
 * Loot stats for ONE body from its scan history + newest report. Reads `resTotal`
 * off the lean history ring and `resources` off the full latest report.
 * @param {{resources?:number, timestamp?:number}} [latest]
 * @param {Array<{resTotal?:number, ts?:number}>} [history]
 * @returns {BodyLoot|null}  null when no observation carried a resource figure.
 */
export function bodyLootStats(latest, history) {
  /** @type {Array<{res:number, ts:number}>} */
  const obs = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (typeof h.resTotal === 'number' && Number.isFinite(h.resTotal)) {
        obs.push({ res: h.resTotal, ts: typeof h.ts === 'number' ? h.ts : 0 });
      }
    }
  }
  if (latest && typeof latest.resources === 'number' && Number.isFinite(latest.resources)) {
    obs.push({ res: latest.resources, ts: typeof latest.timestamp === 'number' ? latest.timestamp : 0 });
  }
  if (!obs.length) return null;
  let sum = 0;
  let max = 0;
  let last = obs[0].res;
  let lastTs = obs[0].ts;
  for (const o of obs) {
    sum += o.res;
    if (o.res > max) max = o.res;
    if (o.ts >= lastTs) { lastTs = o.ts; last = o.res; }
  }
  return { avg: sum / obs.length, max, last, samples: obs.length };
}

/**
 * Pick the HOARD ("mother") coord — the body whose PEAK loot towers over the
 * empire's typical peak (a collector's accumulation planet). Reads `maxLoot` off
 * each coord's dashboard report row (the field {@link bodyLootStats} feeds in).
 * Returns null when nothing clearly stands out — no collector pattern, or too few
 * bodies to compare against.
 * @param {Record<string, {maxLoot?:number}>} byCoord
 * @param {object} [opts]
 * @param {number} [opts.ratio]  How many × the median peak counts as a hoard. Default 5.
 * @param {number} [opts.floor]  Absolute minimum peak to qualify, in resources. Default 50M.
 * @returns {string|null}
 */
export function motherPlanetOf(byCoord, opts = {}) {
  const ratio = opts.ratio ?? 5;
  const floor = opts.floor ?? 50_000_000;
  const rows = Object.entries(byCoord)
    .filter(([, v]) => typeof v.maxLoot === 'number' && Number.isFinite(v.maxLoot) && v.maxLoot > 0);
  if (rows.length < 3) return null; // need an empire to stand out FROM
  const peaks = rows.map(([, v]) => /** @type {number} */ (v.maxLoot)).sort((a, b) => a - b);
  const median = peaks[Math.floor(peaks.length / 2)] || 1;
  let best = null;
  let bestMax = 0;
  for (const [coord, v] of rows) {
    const mx = /** @type {number} */ (v.maxLoot);
    if (mx > bestMax) { bestMax = mx; best = coord; }
  }
  return best && bestMax >= floor && bestMax >= ratio * median ? best : null;
}
