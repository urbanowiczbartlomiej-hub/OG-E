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
// # Spy calibration (IDEAS #1) — the ceiling from fully-verified players
//
// The user's own spy reports can CALIBRATE the model. A player whose scans
// close the military-points identity —
//
//   Σ militaryPointsOf(fleet) + militaryPointsOf(defense) over every body
//     ≈ CURRENT military highscore (±IDENTITY_TOL)
//
// — is a player we have provably seen in full: every moon scanned, nothing in
// flight, scans current. The check is SELF-GATING: an unscanned parking moon, a
// fleet in flight or a stale report all break the identity and the sample
// excludes itself (we compare against the CURRENT feed score, not the
// report-time one). From those verified players we learn the server's civil
// ships-per-economy-point CEILING (a high quantile — freshly-crashed players
// hold LESS civil fleet than their economy implies, so low samples must not
// drag the ceiling down; calibrating against economy NET of the spied
// lifeformPoints kills the lifeform bias in the samples).
//
// The ceiling powers a second, OPPOSITE-direction reading:
//
//   combatFloor = max(0, ships − ratioCeil · economy)
//
// Ships beyond the maximal plausible civil fleet are unexplained — a
// low-false-positive "at least this many look combat" tell, complementing the
// median-curve combatShips upper bound. It stays a COUNT: a probe swarm can
// still exceed the ceiling, so the res/ship cheap-swarm veto applies to it the
// same way. And it stays OUT of the danger score D, like everything here.
//
// Verified players themselves need no heuristic at all — their profile carries
// the SEEN composition (`civilSeen`/`combatSeen`, `verified: true`) and the
// dossier states it directly.
//
// Pure: plain functions over plain data. No DOM/timers/storage/chrome.
//
// @see domain/dangerScore.js — the authoritative danger model (D); this baseline
//   is a soft, separate signal and is deliberately NOT wired into it.
// @see domain/apiOccupancy.js — highscore `ranks` shape (ships only on military).
// @see domain/unitCosts.js — militaryPointsOf (civil @50%), validated live.

import { CIVIL_SHIP_IDS, militaryPointsOf } from './unitCosts.js';
import { latestOf } from './targetReports.js';

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
 * @property {number} [combatFloor]  Ships beyond the CALIBRATED civil ceiling
 *   (ratioCeil·economy) — "at least this many look combat". Present only when
 *   the spy calibration is live (≥ MIN_CAL_SAMPLES verified players). Still a
 *   count: the cheap-swarm veto applies (a probe swarm exceeds any ceiling).
 * @property {number} [calibrationSamples]  Verified players behind the ceiling.
 * @property {true} [verified]  This player's OWN scans close the military-points
 *   identity — the seen composition below is authoritative, skip heuristics.
 * @property {number} [civilSeen]   Verified only: civil ship count in the scans.
 * @property {number} [combatSeen]  Verified only: combat ship count in the scans.
 */

/**
 * The spy-derived calibration bundle (see the header note): a civil-per-eco
 * ceiling learned from players whose scans close the military-points identity,
 * plus the per-player seen compositions of those verified players.
 *
 * @typedef {object} CivilCalibration
 * @property {number} samples    Verified players contributing to the ceiling.
 * @property {number} ratioCeil  High-quantile civil ships per economy point.
 * @property {Map<number, {civilSeen:number, combatSeen:number, shipsSeen:number}>} perPlayer
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
/** Identity tolerance: |seen/military − 1| within this = fully verified. Heuristic, tunable. */
const IDENTITY_TOL = 0.10;
/** Fewer verified players than this and the ceiling is anecdote — calibration stays off. Heuristic, tunable. */
const MIN_CAL_SAMPLES = 3;
/** Ceiling quantile over the verified civil-per-eco ratios — high, because
 * freshly-crashed samples sit LOW and must not drag the ceiling down. Heuristic, tunable. */
const CEIL_QUANTILE = 0.9;
/** combatFloor below this share of the fleet is noise — don't upgrade the band on it. Heuristic, tunable. */
const FLOOR_MIN_RATIO = 0.05;

/** Median of an ascending-sorted array; even length → mean of the two middles. @param {number[]} a */
const medianSorted = (a) => {
  const n = a.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/**
 * Learn the {@link CivilCalibration} from the user's own spy reports (see the
 * header note). A player qualifies as a SAMPLE only when the military-points
 * identity closes against the CURRENT military feed — the self-gating proof
 * that every body (moons included) was seen, recently, with nothing in flight.
 * Returns `{ samples: 0, ratioCeil: 0, perPlayer }` when nothing qualifies —
 * `buildCivilBaseline` then simply leaves the calibrated fields off.
 *
 * @param {object} input
 * @param {Record<string, Record<string, import('./targetReports.js').BodyEntry | import('./espionageReport.js').SpyReport>>} [input.reports]
 *   The target-reports store: playerId → bodyKey → newest report (+ history).
 * @param {Record<string, {score?:number, ships?:number}>} [input.military]  CURRENT military ranks.
 * @param {Record<string, {score?:number}>} [input.economy]  CURRENT economy ranks.
 * @returns {CivilCalibration}
 */
export const collectCivilCalibration = ({ reports, military, economy } = {}) => {
  /** @type {CivilCalibration} */
  const out = { samples: 0, ratioCeil: 0, perPlayer: new Map() };
  if (!reports || !military || !economy) return out;

  /** @type {number[]} */
  const ratios = [];
  for (const pid of Object.keys(reports)) {
    const bucket = reports[pid];
    const mil = military[pid];
    if (!bucket || !mil || !Number.isFinite(mil.score) || /** @type {number} */ (mil.score) <= 0) continue;

    // Sum the spied composition over every body (planets AND moons — each
    // bodyKey is its own entry). Bodies whose report never revealed a fleet /
    // defense section contribute 0 points there, which BREAKS the identity
    // unless the body genuinely holds nothing — exactly the self-gating we want.
    let seenPts = 0;
    let civilSeen = 0;
    let combatSeen = 0;
    let shipsSeen = 0;
    /** Newest report-time lifeform points seen (de-biases the eco basis). */
    let lifeformPts = 0;
    let lifeformTs = -Infinity;
    for (const key of Object.keys(bucket)) {
      const r = latestOf(bucket[key]);
      if (!r) continue;
      seenPts += militaryPointsOf(r.fleet) + militaryPointsOf(r.defense);
      if (r.fleet) {
        for (const [id, count] of Object.entries(r.fleet)) {
          const n = Number(count);
          if (!Number.isFinite(n) || n <= 0) continue;
          shipsSeen += n;
          if (CIVIL_SHIP_IDS.has(Number(id))) civilSeen += n;
          else combatSeen += n;
        }
      }
      const ts = typeof r.timestamp === 'number' ? r.timestamp : 0;
      if (typeof r.lifeformPoints === 'number' && ts > lifeformTs) {
        lifeformTs = ts;
        lifeformPts = r.lifeformPoints;
      }
    }
    if (!(seenPts > 0)) continue;

    // The identity check — seen vs the CURRENT feed score, so any change since
    // the scans (rebuild, crash, fleet bought) disqualifies the sample.
    const ratio = seenPts / /** @type {number} */ (mil.score);
    if (Math.abs(ratio - 1) > IDENTITY_TOL) continue;

    const numId = Number(pid);
    if (Number.isFinite(numId)) out.perPlayer.set(numId, { civilSeen, combatSeen, shipsSeen });

    // Ceiling sample: civil ships per economy point, economy NET of the spied
    // lifeform score (lifeform inflates eco without adding a single cargo).
    const eco = economy[pid];
    if (!eco || !Number.isFinite(eco.score)) continue;
    const ecoNet = /** @type {number} */ (eco.score) - lifeformPts;
    if (!(ecoNet > 0) || !(civilSeen > 0)) continue;
    ratios.push(civilSeen / ecoNet);
  }

  out.samples = ratios.length;
  if (ratios.length >= MIN_CAL_SAMPLES) {
    ratios.sort((a, b) => a - b);
    out.ratioCeil = ratios[Math.min(ratios.length - 1, Math.max(0, Math.ceil(CEIL_QUANTILE * ratios.length) - 1))];
  }
  return out;
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
 * @param {CivilCalibration} [input.calibration]  Spy-derived ceiling + verified
 *   compositions (see {@link collectCivilCalibration}); absent/under-sampled →
 *   the calibrated fields simply stay off every profile.
 * @returns {Map<number, CivilProfile>}
 */
export const buildCivilBaseline = ({ economy, military, calibration } = {}) => {
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

    // ── Spy calibration (see header): the OPPOSITE-direction reading. Ships
    // beyond the verified civil CEILING are unexplained by any plausible civil
    // fleet — "at least this many look combat". A non-trivial floor upgrades a
    // baseline read to elevated (the median curve underestimated this player's
    // room for civil, the ceiling says otherwise) and lifts confidence off the
    // floor. The cheap-swarm res/ship veto below still applies — the floor is
    // a COUNT and a probe swarm exceeds any ceiling. ──
    /** @type {number | undefined} */
    let combatFloor;
    const calibrated = calibration && calibration.samples >= MIN_CAL_SAMPLES && calibration.ratioCeil > 0;
    if (calibrated) {
      combatFloor = Math.max(0, ships - /** @type {CivilCalibration} */ (calibration).ratioCeil * economyScore);
      const floorRatio = ships > 0 ? combatFloor / ships : 0;
      if (floorRatio >= FLOOR_MIN_RATIO) {
        if (band === 'baseline') band = 'elevated';
        if (confidence === 'low') confidence = 'medium';
      }
    }

    // Verified overlay: this player's OWN scans close the identity — the seen
    // composition is authoritative, no curve needed.
    const seen = calibration ? calibration.perPlayer.get(numId) : undefined;

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
      ...(typeof combatFloor === 'number'
        ? { combatFloor, calibrationSamples: /** @type {CivilCalibration} */ (calibration).samples }
        : {}),
      ...(seen ? { verified: true, civilSeen: seen.civilSeen, combatSeen: seen.combatSeen } : {}),
    });
  }

  return out;
};
