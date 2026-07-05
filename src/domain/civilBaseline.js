// @ts-check

// Civil-fleet baseline (Spyglass v3, Etap C) — the model that finally SPENDS
// the fetched-but-unused economy highscore feed.
//
// # The idea
//
// Economy points predict how many ships a peaceful builder would own. A player
// running a big economy naturally accumulates cargos, recyclers and a defensive
// escort in rough proportion to that economy — those are CIVIL ships, not a raid
// fleet. So we learn, from the whole server, the typical ship count at each
// economy level (a binned median curve), then for each player compare their
// ACTUAL ship count (the military feed carries it) to that economy-predicted
// baseline. A big ship SURPLUS over the baseline is the tell of a real combat
// fleet — ships that the player's economy does not explain.
//
//   combatShips = max(0, ships − expectedCivil(economyScore))
//   combatRatio = combatShips / ships
//
// # Honesty note — this is a WEAK PRIOR, an UPPER BOUND only
//
// The ratio is contaminated in BOTH directions and must never be presented as
// truth:
//   • a probe / cargo SWARM inflates the raw ship COUNT with near-worthless
//     hulls, diluting the ratio (a hoarder of 100k probes reads "baseline"
//     while a lean 200-battleship fleeter reads "fleet-holder");
//   • LIFEFORM economy inflates the economy score WITHOUT adding civil ships
//     (lifeform buildings/research are pure points), pushing the expected-civil
//     baseline up and MASKING a real fleet as "explained".
// Because of that, the caller shows `combatShips` strictly as an UPPER BOUND on
// combat fleet, dossier-only prose — NEVER a table column, NEVER sorted on, and
// NEVER fed into the danger scalar D (which has its own, harder ships/destroyed
// bounds in domain/dangerScore.js). This file computes the number; the dossier
// composes the caveat sentence.
//
// Pure: plain functions over plain data. No DOM/timers/storage/chrome.
//
// @see domain/dangerScore.js — the authoritative danger model (D); this baseline
//   is a soft, separate signal and is deliberately NOT wired into it.
// @see domain/apiOccupancy.js — highscore `ranks` shape (ships only on military).

/**
 * One player's civil-fleet baseline profile. `combatShips` is an UPPER BOUND on
 * combat fleet (see the file header's honesty note) — everything else explains
 * how it was derived so the dossier can caveat it honestly.
 *
 * @typedef {object} CivilProfile
 * @property {number} economyScore   The player's economy highscore points.
 * @property {number} ships          Ship COUNT from the military feed (absent = 0).
 * @property {number} expectedCivil  Economy-predicted civil ship count (the
 *   binned-median baseline for the player's economy decile).
 * @property {number} combatShips    max(0, ships − expectedCivil). UPPER BOUND
 *   on combat fleet — probe swarms / lifeform eco contaminate it (see header).
 * @property {number} combatRatio    combatShips / ships (0 when ships === 0).
 * @property {number} [resPerShip]    militaryPts·1000/ships — the composition tell
 *   that vetoes a cheap-hull surplus (undefined = no military score / 0 ships).
 * @property {'baseline'|'elevated'|'fleet-holder'|'cheap-swarm'} band  Coarse
 *   ratio bucket. `cheap-swarm` = a big COUNT surplus but ~logistics hulls
 *   (low res/ship) — the count model's blind spot, relabelled honestly.
 * @property {'high'|'medium'|'low'} confidence  How much to trust the band.
 */

// ── Thresholds — all heuristic, tunable. ──────────────────────────────────────
/** Below this combat ratio the fleet is economy-explained. Heuristic, tunable. */
const BASELINE_MAX = 0.25;
/** Below this the surplus is notable but not dominant. Heuristic, tunable. */
const ELEVATED_MAX = 0.6;
/** Fewer usable samples than this and the curve is noise — model nothing. Heuristic, tunable. */
const MIN_SAMPLES = 20;
/** Bin count for the economy→ships median curve (deciles). Heuristic, tunable. */
const DECILES = 10;
/** Below this res/ship the surplus is cheap logistics hulls, not combat fleet. Heuristic, tunable. */
const CHEAP_HULL_RPS = 12_000;

/** Median of an ascending-sorted array; even length → mean of the two middles. @param {number[]} a */
const medianSorted = (a) => {
  const n = a.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/**
 * Build every player's {@link CivilProfile} from the economy + military
 * highscore feeds. Learns a whole-server economy→ships median curve (deciles),
 * then scores each military-feed player who also has an economy score against
 * it. Returns an EMPTY map when the feeds can't support a model (missing feed,
 * no ship counts, or too few overlapping samples) — the caller then renders
 * nothing rather than a made-up baseline.
 *
 * @param {object} input
 * @param {Record<string, {score?:number}>} [input.economy]   Economy highscore ranks.
 * @param {Record<string, {score?:number, ships?:number}>} [input.military]  Military
 *   ranks; only this feed carries the per-player ship COUNT.
 * @returns {Map<number, CivilProfile>}
 */
export const buildCivilBaseline = ({ economy, military } = {}) => {
  /** @type {Map<number, CivilProfile>} */
  const out = new Map();
  if (!economy || !military) return out;

  // Does the military feed carry the ships attribute at all? Mirrors
  // dangerScore.js's `feedHasShips`: a feed cached by a pre-`ships` parser has
  // it on NO row, and then "absent = 0 ships" would fabricate a baseline from
  // all-zero ship counts. One carrying row (any real server has fleeters) is
  // proof the attribute is live, so an absent attribute genuinely means 0.
  const feedHasShips = Object.values(military).some((r) => typeof r.ships === 'number');
  if (!feedHasShips) return out;

  // ── Samples: players present in BOTH feeds, with a finite economy score. ──
  // `ships` absent on a present military row = 0 (justified by feedHasShips).
  /** @type {Array<{ eco: number, ships: number }>} */
  const samples = [];
  for (const id of Object.keys(military)) {
    const eco = economy[id];
    if (!eco || !Number.isFinite(eco.score)) continue;
    const m = military[id];
    const ships = Number.isFinite(m.ships) ? /** @type {number} */ (m.ships) : 0;
    samples.push({ eco: /** @type {number} */ (eco.score), ships });
  }
  if (samples.length < MIN_SAMPLES) return out;

  // ── Curve: sort by economy ascending, split into equal-count deciles, and
  // record each bin's { ecoMax, medianShips }. Ships within a bin are sorted
  // independently for the median. ──
  samples.sort((a, b) => a.eco - b.eco);
  /** @type {Array<{ ecoMax: number, medianShips: number }>} */
  const bins = [];
  const n = samples.length;
  for (let b = 0; b < DECILES; b++) {
    // Even split with the remainder pushed into the earliest bins, so every bin
    // is non-empty (n ≥ MIN_SAMPLES ≥ DECILES guarantees ≥ 1 per bin).
    const start = Math.floor((b * n) / DECILES);
    const end = Math.floor(((b + 1) * n) / DECILES);
    if (end <= start) continue;
    const slice = samples.slice(start, end);
    const ecoMax = slice[slice.length - 1].eco;
    const shipVals = slice.map((s) => s.ships).sort((x, y) => x - y);
    bins.push({ ecoMax, medianShips: medianSorted(shipVals) });
  }
  if (!bins.length) return out;
  const lastBin = bins[bins.length - 1];

  // ── Score every military player that also has an economy score. ──
  for (const id of Object.keys(military)) {
    const eco = economy[id];
    if (!eco || !Number.isFinite(eco.score)) continue;
    const numId = Number(id);
    if (!Number.isFinite(numId)) continue;
    const economyScore = /** @type {number} */ (eco.score);
    const m = military[id];
    const ships = Number.isFinite(m.ships) ? /** @type {number} */ (m.ships) : 0;

    // Expected civil ships = the median of the FIRST bin whose ecoMax reaches
    // the player's economy (the decile they fall in); the top players clamp to
    // the last bin.
    let expectedCivil = lastBin.medianShips;
    for (const bin of bins) {
      if (bin.ecoMax >= economyScore) {
        expectedCivil = bin.medianShips;
        break;
      }
    }

    const combatShips = Math.max(0, ships - expectedCivil);
    const combatRatio = ships > 0 ? combatShips / ships : 0;

    /** @type {'baseline'|'elevated'|'fleet-holder'|'cheap-swarm'} */
    let band;
    if (combatRatio < BASELINE_MAX) band = 'baseline';
    else if (combatRatio < ELEVATED_MAX) band = 'elevated';
    else band = 'fleet-holder';

    // Confidence: a clear SURPLUS (combatShips genuinely above the baseline, not
    // just brushing the threshold) on a fleet-holder is high; a baseline reading
    // is low (dominated by noise/contamination); everything between is medium.
    /** @type {'high'|'medium'|'low'} */
    let confidence;
    if (band === 'fleet-holder' && combatShips > expectedCivil) confidence = 'high';
    else if (band === 'baseline') confidence = 'low';
    else confidence = 'medium';

    // res/ship veto — the count model's blind spot. A huge COUNT surplus made of
    // cheap hulls (probes / small transporters, < ~12k/ship) is a logistics/probe
    // swarm, NOT a combat fleet (the Qbaba case: 20M ships at ~2k/ship read as
    // "fleet-holder"). Relabel it so the dossier says "cheap swarm" instead of
    // asserting a combat fleet. A high res/ship is left alone here — that's real
    // capital ships or defence, which the surplus-vs-baseline reading handles.
    const rps = Number.isFinite(m.score) && ships > 0
      ? (/** @type {number} */ (m.score) * 1000) / ships
      : undefined;
    if (typeof rps === 'number' && rps < CHEAP_HULL_RPS && band !== 'baseline') {
      band = 'cheap-swarm';
      confidence = 'low';
    }

    out.set(numId, {
      economyScore,
      ships,
      expectedCivil,
      combatShips,
      combatRatio,
      ...(typeof rps === 'number' ? { resPerShip: rps } : {}),
      band,
      confidence,
    });
  }

  return out;
};
