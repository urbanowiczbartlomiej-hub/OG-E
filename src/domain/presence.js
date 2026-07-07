// @ts-check

// Presence analysis (SPYGLASS-PASSIVE-PLAN §4) — the OFFLINE-window engine.
// Where domain/routine.js answers "when is this player usually active" (for the
// scan planner's windowBonus), this answers the ATTACK question: "when is this
// player reliably NOT playing?" The two are related data, opposite conclusions.
//
// # The asymmetry this module is built around
//
// An activity marker is asymmetric evidence (the user's own insight):
//   - a POSITIVE marker ("someone interacted with this body") is WEAK evidence
//     of the owner being online — a foreign fleet, a foreign probe, or our own
//     probe can light it. Activity ≠ the owner is playing.
//   - a QUIET look at KNOWN COVERAGE ("we looked N times and saw nothing") is
//     STRONG evidence of offline — if the player consistently touches nothing
//     in a time band we DID observe, they almost certainly aren't playing then.
//
// The attack goal lives on the strong side. So the model needs two things
// routine.js doesn't compute: the DENOMINATOR (how often we looked) and the
// NEGATIVES (the "-1" quiet ring entries). Both already live in the activity
// rings — a quiet look is a real, persisted observation.
//
// # How routine (noise) is separated from a one-off
//
// Two mechanisms, both here:
//   1. Beta shrinkage — p = (hits+α)/(looks+α+β). A single online blip against
//      many looks stays cold; a band only heats up once REPEATEDLY confirmed.
//      This is what makes a midnight login "once in 7 days" not fabricate a hot
//      cell.
//   2. Per-moment collapse — several bodies observed around the same time are
//      CORRELATED (if the owner is offline they're quiet everywhere at once), so
//      counting each body as an independent offline vote overstates certainty.
//      Events within COLLAPSE_MS collapse to ONE presence sample (online if ANY
//      body interacted, offline if all quiet) before they reach the grid.
//
// Cost asymmetry (attack): a missed window is cheap, an ambush during a rare
// login is not — so a lone online blip inside an otherwise-cold window is
// DOWN-WEIGHTED but still reported (never silently dropped). And the tool never
// fabricates a "99% offline" the samples don't support: windows carry their
// observed basis (look count), gated by coverage.
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives from the caller.
// Hours/weekdays are LOCAL (the user strikes in THEIR day), so it is
// timezone-dependent by design (matches routine.js).

import { interactionInterval, SAME_TAU_SLACK_S } from './activityObs.js';

/** @typedef {import('./activityObs.js').ActivityObs} ActivityObs */
/** @typedef {import('./routine.js').RoutineBody} RoutineBody */

/** Observations older than this are dropped (matches the ring 45-day sweep, with slack). */
export const PRESENCE_RECENCY_MS = 60 * 24 * 3600 * 1000;
/** Exponential recency half-life — routines drift (new job, season), so weight recency. */
export const DECAY_HALFLIFE_MS = 21 * 24 * 3600 * 1000;
/** Events within this window collapse to ONE presence sample (correlation guard). */
export const COLLAPSE_MS = 90 * 60 * 1000;
/** Beta prior: base rate ~0.2 (α/(α+β)) at strength ~3 — a thin sample sits mid-cool. */
export const PRIOR_ALPHA = 0.6;
export const PRIOR_BETA = 2.4;
/** Coverage curve knee: conf = 1 − e^(−looks/L0). */
export const CONF_L0 = 3;
/** Offline-window thresholds: every cell must clear both. */
export const WINDOW_MAX_P = 0.15;
export const WINDOW_MIN_CONF = 0.45;
export const WINDOW_MIN_LEN = 3;
/** Scale auto-pick: weekly needs enough samples AND weekday-varying peaks. */
export const WEEK_MIN_SAMPLES = 30;
export const DAY_MIN_SAMPLES = 8;
export const WEEK_MIN_PEAK_SPREAD_H = 3;

/**
 * One collapsed presence sample: at `tSec` the player was (or was not) seen
 * interacting with any of their bodies. `online:false` is the negative-evidence
 * sample (we looked, all quiet).
 * @typedef {object} PresenceProbe
 * @property {number} tSec
 * @property {boolean} online
 */

/**
 * One raw activity event before the per-moment collapse.
 * @typedef {object} RawEvent
 * @property {number} tSec     Representative time: τ (implied interaction) for a
 *   positive, the observation time for a quiet look.
 * @property {boolean} online
 */

/**
 * Extract one body's raw presence events (both sources, recency-gated). Positives
 * carry the implied-interaction time τ and are discounted when τ matches one of
 * OUR OWN probe arrivals on the body (else the tool measures its own scanning);
 * quiet looks (m = −1) carry the observation time as offline evidence and are
 * NEVER self-induced (our probe cannot manufacture silence). Mirrors the
 * discount half of domain/routine.bodyActivityEvents, but KEEPS the negatives.
 *
 * @param {RoutineBody} b
 * @param {number} cutoffSec
 * @returns {RawEvent[]}
 */
function bodyPresenceEvents(b, cutoffSec) {
  /** @type {number[]} own-probe arrival times = every report ts we hold. */
  const probes = [];
  for (const e of b.history || []) if (typeof e.ts === 'number') probes.push(e.ts);
  if (typeof b.latestTs === 'number' && !probes.includes(b.latestTs)) probes.push(b.latestTs);

  // Self-induced iff SOME OTHER probe arrival falls in the implied-interaction
  // interval (±slack). `ownTs` (a report's own arrival) is excluded — a probe
  // does not light the marker it itself reads (the marker predates its arrival);
  // this mirrors routine.bodyActivityEvents' `p !== ev.ownTs` exactly. A galaxy
  // reading has no ownTs, so every probe arrival is a candidate.
  /** @param {{lo:number, hi:number}} iv @param {number} [ownTs] @returns {boolean} */
  const selfInduced = (iv, ownTs) => probes.some((p) => p !== ownTs
    && p >= iv.lo - SAME_TAU_SLACK_S && p <= iv.hi + SAME_TAU_SLACK_S);

  /** @type {RawEvent[]} */
  const out = [];
  // Spy-report history: activityMin ≥ 0 → positive interaction; = −1 → a quiet
  // reading (the report saw no activity) → offline evidence at the report time.
  for (const e of b.history || []) {
    if (typeof e.ts !== 'number' || e.ts < cutoffSec) continue;
    if (typeof e.activityMin !== 'number') continue;
    if (e.activityMin < 0) { out.push({ tSec: e.ts, online: false }); continue; }
    const iv = interactionInterval({ t: e.ts, m: e.activityMin });
    if (selfInduced(iv, e.ts)) continue; // ANOTHER probe lit it — not the owner
    out.push({ tSec: iv.hi, online: true });
  }
  // Galaxy rings: same split (no ownTs — any probe arrival can be the cause).
  for (const o of b.activity || []) {
    if (typeof o.t !== 'number' || o.t < cutoffSec) continue;
    if (o.m < 0) { out.push({ tSec: o.t, online: false }); continue; }
    const iv = interactionInterval(o);
    if (selfInduced(iv)) continue;
    out.push({ tSec: iv.hi, online: true });
  }
  return out;
}

/**
 * Build the player-level presence samples: gather every body's raw events, then
 * COLLAPSE events within {@link COLLAPSE_MS} into one sample — online if ANY
 * member interacted (activity anywhere ⇒ the owner was online), offline only if
 * every member is a quiet look. This is what stops N correlated bodies from
 * counting as N independent offline votes.
 *
 * @param {RoutineBody[]} bodies
 * @param {number} nowMs
 * @returns {{ probes: PresenceProbe[], positives: number, negatives: number }}
 */
export function buildPresenceProbes(bodies, nowMs) {
  const cutoffSec = (nowMs - PRESENCE_RECENCY_MS) / 1000;
  /** @type {RawEvent[]} */
  const raw = [];
  for (const b of bodies || []) raw.push(...bodyPresenceEvents(b, cutoffSec));
  raw.sort((a, b) => a.tSec - b.tSec);

  /** @type {PresenceProbe[]} */
  const probes = [];
  let i = 0;
  const collapseSec = COLLAPSE_MS / 1000;
  while (i < raw.length) {
    const start = raw[i].tSec;
    let anyOnline = false;
    /** @type {number[]} */
    const onlineTimes = [];
    /** @type {number[]} */
    const quietTimes = [];
    let j = i;
    while (j < raw.length && raw[j].tSec <= start + collapseSec) {
      if (raw[j].online) { anyOnline = true; onlineTimes.push(raw[j].tSec); }
      else quietTimes.push(raw[j].tSec);
      j += 1;
    }
    const times = anyOnline ? onlineTimes : quietTimes;
    // Representative time = median of the deciding events (stable, no Date.now).
    const mid = times[Math.floor(times.length / 2)];
    probes.push({ tSec: mid, online: anyOnline });
    i = j;
  }

  let positives = 0;
  let negatives = 0;
  for (const p of probes) (p.online ? (positives += 1) : (negatives += 1));
  return { probes, positives, negatives };
}

/**
 * One grid cell.
 * @typedef {object} PresenceCell
 * @property {number} p       P(online | this phase) — Beta-shrunk, smoothed.
 * @property {number} conf    Coverage confidence 0..1 (from weighted look mass).
 * @property {number} looks   RAW look count in this cell (honest tooltip basis).
 * @property {number} hits    RAW online count in this cell.
 */

/**
 * The presence grid.
 * @typedef {object} PresenceGrid
 * @property {'week'|'day'} scale
 * @property {number} rows          7 (week, dow×hour) or 1 (day, hour).
 * @property {PresenceCell[][]} cells   [row][hour], hour 0..23.
 * @property {number} samples       Total presence probes placed.
 * @property {number} online        Of those, how many were online.
 */

/**
 * Bin the presence probes onto a phase grid (weekly dow×hour, or daily hour),
 * apply exponential recency weighting, an hour-kernel smooth on the weighted
 * look/hit mass, then Beta shrinkage → p, and a coverage curve → conf. Raw
 * (unweighted) counts are kept per cell for the tooltip basis.
 *
 * @param {PresenceProbe[]} probes
 * @param {number} nowMs
 * @param {{ scale: 'week'|'day' }} opts
 * @returns {PresenceGrid}
 */
export function buildPresenceGrid(probes, nowMs, opts) {
  const scale = opts.scale;
  const rows = scale === 'week' ? 7 : 1;
  /** weighted look/hit mass + raw counts */
  const Lw = Array.from({ length: rows }, () => new Array(24).fill(0));
  const Hw = Array.from({ length: rows }, () => new Array(24).fill(0));
  const Ln = Array.from({ length: rows }, () => new Array(24).fill(0));
  const Hn = Array.from({ length: rows }, () => new Array(24).fill(0));

  let samples = 0;
  let online = 0;
  for (const pr of probes || []) {
    if (typeof pr.tSec !== 'number') continue;
    const d = new Date(pr.tSec * 1000);
    const row = scale === 'week' ? d.getDay() : 0;
    const h = d.getHours();
    const ageMs = nowMs - pr.tSec * 1000;
    const w = Math.pow(0.5, Math.max(0, ageMs) / DECAY_HALFLIFE_MS);
    Lw[row][h] += w;
    Ln[row][h] += 1;
    if (pr.online) { Hw[row][h] += w; Hn[row][h] += 1; }
    samples += 1;
    if (pr.online) online += 1;
  }

  /** Wrapping hour-kernel [.25,.5,.25] on one row. @param {number[]} a @returns {number[]} */
  const smooth = (a) => a.map((_, h) => 0.5 * a[h] + 0.25 * a[(h + 23) % 24] + 0.25 * a[(h + 1) % 24]);

  /** @type {PresenceCell[][]} */
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const ls = smooth(Lw[r]);
    const hs = smooth(Hw[r]);
    const rowCells = [];
    for (let h = 0; h < 24; h++) {
      const p = (hs[h] + PRIOR_ALPHA) / (ls[h] + PRIOR_ALPHA + PRIOR_BETA);
      const conf = 1 - Math.exp(-ls[h] / CONF_L0);
      rowCells.push({ p, conf, looks: Ln[r][h], hits: Hn[r][h] });
    }
    cells.push(rowCells);
  }
  return { scale, rows, cells, samples, online };
}

/**
 * A recommended offline window.
 * @typedef {object} OfflineWindow
 * @property {number} row       Weekday (0=Sun) for 'week', else 0.
 * @property {number} startH
 * @property {number} endH      Inclusive last hour.
 * @property {number} looks     Pooled RAW look count across the block (the basis).
 * @property {number} exceptions  Cells with ≥1 online blip (down-weighted, noted).
 * @property {number} score
 */

/**
 * Best contiguous offline block (≥ {@link WINDOW_MIN_LEN} h) where every cell
 * clears the coverage + low-P bars. Score favours length × coverage × quiet;
 * a one-off online blip inside the block doesn't disqualify it (cost asymmetry)
 * but is counted in `exceptions` so the view can flag it. Returns null when no
 * band has enough well-covered quiet — never guess.
 *
 * @param {PresenceGrid} grid
 * @param {{ maxP?: number, minConf?: number, minLen?: number }} [opts]
 * @returns {OfflineWindow | null}
 */
export function pickOfflineWindow(grid, opts = {}) {
  const maxP = opts.maxP ?? WINDOW_MAX_P;
  const minConf = opts.minConf ?? WINDOW_MIN_CONF;
  const minLen = opts.minLen ?? WINDOW_MIN_LEN;
  /** @type {OfflineWindow | null} */
  let best = null;

  for (let r = 0; r < grid.rows; r++) {
    const row = grid.cells[r];
    // Scan non-wrapping hour blocks (a strike window is a clock span in the
    // user's day; wrapping midnight blocks read confusingly on the grid).
    for (let start = 0; start < 24; start++) {
      let score = 0;
      let looks = 0;
      let exceptions = 0;
      for (let end = start; end < 24; end++) {
        const c = row[end];
        if (c.conf < minConf || c.p > maxP) break;
        score += c.conf * (1 - c.p);
        looks += c.looks;
        if (c.hits > 0) exceptions += 1;
        const len = end - start + 1;
        if (len >= minLen) {
          const blockScore = score * len;
          if (!best || blockScore > best.score) {
            best = { row: r, startH: start, endH: end, looks, exceptions, score: blockScore };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Choose the display scale from the samples: 'week' when there's enough data to
 * fill a weekly grid AND the peak activity hour VARIES across weekdays (a
 * genuine weekday pattern — shift work, different weekends); 'day' when a daily
 * pattern is all the data supports; 'occasional' when there isn't a stable
 * pattern to draw (too few samples) — the view then shows raw recent looks, not
 * a fabricated grid.
 *
 * @param {PresenceProbe[]} probes
 * @returns {'week'|'day'|'occasional'}
 */
export function pickScale(probes) {
  const onl = (probes || []).filter((p) => p.online);
  if (onl.length < DAY_MIN_SAMPLES) return 'occasional';
  if (onl.length < WEEK_MIN_SAMPLES) return 'day';

  // Peak online hour per weekday; spread of those peaks decides week vs day.
  /** @type {number[][]} */
  const byDay = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const p of onl) {
    const d = new Date(p.tSec * 1000);
    byDay[d.getDay()][d.getHours()] += 1;
  }
  /** @type {number[]} */
  const peaks = [];
  for (let d = 0; d < 7; d++) {
    const total = byDay[d].reduce((a, c) => a + c, 0);
    if (total < 2) continue; // too thin a day to have a meaningful peak
    let peakH = 0;
    let peakV = -1;
    for (let h = 0; h < 24; h++) if (byDay[d][h] > peakV) { peakV = byDay[d][h]; peakH = h; }
    peaks.push(peakH);
  }
  if (peaks.length < 3) return 'day';
  // Circular spread of peak hours (max gap on the 24-clock → concentration).
  const sorted = [...peaks].sort((a, b) => a - b);
  let maxGap = (sorted[0] + 24) - sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  const spread = 24 - maxGap; // how many hours the peaks span
  return spread >= WEEK_MIN_PEAK_SPREAD_H ? 'week' : 'day';
}

/**
 * High-level summary for the dossier view: samples → scale → grid → window.
 * `scale === 'occasional'` returns no grid (the view shows recent raw looks).
 *
 * @param {RoutineBody[]} bodies
 * @param {number} nowMs
 * @param {{ scaleOverride?: 'week'|'day' }} [opts]
 * @returns {{ scale: 'week'|'day'|'occasional', grid: PresenceGrid | null,
 *   window: OfflineWindow | null, samples: number, online: number,
 *   lastActiveSec?: number, probes: PresenceProbe[] }}
 */
export function summarizePresence(bodies, nowMs, opts = {}) {
  const { probes } = buildPresenceProbes(bodies, nowMs);
  // Player-level last-active (any body): the newest ONLINE presence sample —
  // the honest "when was this player last seen doing anything, anywhere".
  let lastActiveSec;
  for (const p of probes) {
    if (p.online && (lastActiveSec === undefined || p.tSec > lastActiveSec)) lastActiveSec = p.tSec;
  }
  const online = probes.filter((p) => p.online).length;
  const autoScale = pickScale(probes);
  const scale = opts.scaleOverride || (autoScale === 'occasional' ? 'occasional' : autoScale);
  if (scale === 'occasional') {
    return {
      scale, grid: null, window: null, samples: probes.length, online, ...(lastActiveSec !== undefined ? { lastActiveSec } : {}), probes,
    };
  }
  const grid = buildPresenceGrid(probes, nowMs, { scale });
  const window = pickOfflineWindow(grid);
  return {
    scale, grid, window, samples: grid.samples, online: grid.online, ...(lastActiveSec !== undefined ? { lastActiveSec } : {}), probes,
  };
}
