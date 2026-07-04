// @ts-check

// Pure routine analysis over a watched player's gathered intel — the honest,
// sample-gated summaries the Spyglass dossier shows: hour-of-day activity, a
// weekday resource pattern, the "collection" planet, and a plain timeline. It
// runs ENTIRELY over data the user already gathered while playing — the
// `SpyReportLite` rings (reports they opened) plus the galaxy-view activity
// rings (markers rendered in galaxy views they browsed, §6.6bis) — and
// originates nothing. No DOM, no timers, no storage, no `chrome.*` —
// unit-testable with plain fixtures.
//
// Honesty is structural, not cosmetic (SPYGLASS-REDESIGN.md §6.6):
//   - Every summary carries its own SAMPLE COUNT so the renderer can show a
//     coverage row — the tool visibly only knows what the user sampled.
//   - Everything is n-GATED: `none` (too few) → `hint` (faint) → `pattern` →
//     `strong`. A thin sample never reads as a confident claim.
//   - "activity" means "this body was interacted with", NOT "the player was
//     online" — the renderer must never say "online" (the caveat lives in §6.6bis;
//     the wording lives in the view).
//   - SELF-INDUCED markers are discounted (§6.6bis): an activity reading whose
//     implied interaction time matches one of OUR OWN probe arrivals on that
//     body (= the body's own report timestamps) is dropped and counted in
//     `discounted` — otherwise the tracker measures its own scanning rhythm.
//     (The append-side pass in domain/activityObs.js already caught markers
//     from probes whose report was never opened; this read-side pass catches
//     the opened ones, on both sources.)
//
// Hours/weekdays are LOCAL (the user cares when, in THEIR day, to strike), so the
// output is timezone-dependent by design.

import { interactionInterval, SAME_TAU_SLACK_S } from './activityObs.js';
import { latestOf, historyOf } from './targetReports.js';

/** @typedef {import('./targetReports.js').SpyReportLite} SpyReportLite */
/** @typedef {import('./activityObs.js').ActivityObs} ActivityObs */

/** Observations older than this are dropped — a routine goes stale. */
const RECENCY_MS = 30 * 24 * 60 * 60 * 1000;
/** Contiguous hour window (wrapping) used to name the activity peak. */
const PEAK_SPAN = 5;

/**
 * @typedef {'none'|'hint'|'pattern'|'strong'} Gate
 */

/**
 * @typedef {object} ActivitySummary
 * @property {number[]} bins      24 hour-of-day counts (local hour of last-activity).
 * @property {number} samples     Interactions counted (both sources, deduped, post-discount).
 * @property {Gate} gate
 * @property {string} [label]     Human peak, e.g. "evenings 19–22" (≥ pattern only).
 * @property {{startH:number, endH:number}} [peak]  The peak hour window (wrapping,
 *   ≥ pattern only) — consumed by the scan planner's `windowBonus`.
 * @property {{reports:number, galaxy:number}} sources  Counted interactions per source.
 * @property {number} discounted  Markers dropped as self-induced (our own probes).
 * @property {number} galaxyLooks Galaxy sightings considered (incl. "no marker" —
 *   the negative-evidence looks that prove coverage).
 */

/**
 * @typedef {object} WeekdaySummary
 * @property {(number|null)[]} medians  Median on-planet resources per weekday (0=Sun); null = no sample.
 * @property {number[]} samples         Observation count per weekday.
 * @property {Gate} gate
 */

/**
 * @typedef {object} CollectionSummary
 * @property {string} coord       The body usually holding the most resources.
 * @property {number} medianRes   Its median on-planet resources.
 * @property {number} samples     Its resource-bearing observations.
 * @property {number} ofBodies    How many of the player's bodies were compared.
 */

/**
 * @typedef {object} TimelineEntry
 * @property {number} [ts]
 * @property {string} coord
 * @property {number} [resTotal]
 * @property {number} [fleetValue]
 * @property {number} [defenseValue]
 * @property {number} [activityMin]
 */

/**
 * @typedef {object} RoutineSummary
 * @property {number} observations   Total observations considered post-recency
 *   (spy-history entries + galaxy sightings) — the dossier's "anything at all?" gate.
 * @property {ActivitySummary} activity
 * @property {WeekdaySummary} weekday
 * @property {CollectionSummary|null} collection
 * @property {TimelineEntry[]} timeline   Newest first, across all bodies (capped).
 */

/**
 * One body's gathered intel, as {@link summarizeRoutine} consumes it.
 * @typedef {object} RoutineBody
 * @property {string} coord            "g:s:p" (type stripped — display key).
 * @property {SpyReportLite[]} history Spy-report ring (own-probe arrivals included).
 * @property {ActivityObs[]} [activity] Galaxy-view activity ring (§6.6bis).
 * @property {number} [latestTs]       Newest report's ts (epoch s) — an own-probe
 *   arrival that may predate the history ring (unwatched-era report).
 */

/**
 * @param {number[]} nums
 * @returns {number}
 */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Sample+consistency → confidence gate (§6.6): hint < 5 · pattern ≥ 5 & ≥ 70%
 * concentrated · strong ≥ 10 & ≥ 80%. `none` under 3 (nothing worth drawing).
 * @param {number} samples
 * @param {number} consistency   Peak-window share, 0..1 (1 for non-directional stats).
 * @returns {Gate}
 */
function gateFor(samples, consistency) {
  if (samples < 3) return 'none';
  if (samples >= 10 && consistency >= 0.8) return 'strong';
  if (samples >= 5 && consistency >= 0.7) return 'pattern';
  return 'hint';
}

/**
 * Day-part name for an hour — so the label reads "evenings", not "hour 20".
 * @param {number} h
 * @returns {string}
 */
function dayPart(h) {
  if (h < 6) return 'nights';
  if (h < 12) return 'mornings';
  if (h < 18) return 'afternoons';
  return 'evenings';
}

/**
 * Peak contiguous {@link PEAK_SPAN}-hour window (wrapping) of an hour histogram:
 * its centre hour, span mass, and the mass share. Drives the label + consistency.
 * @param {number[]} bins
 * @param {number} total
 * @returns {{ startH: number, endH: number, centreH: number, share: number }}
 */
function peakWindow(bins, total) {
  let bestStart = 0;
  let bestMass = -1;
  for (let start = 0; start < 24; start++) {
    let mass = 0;
    for (let k = 0; k < PEAK_SPAN; k++) mass += bins[(start + k) % 24];
    if (mass > bestMass) { bestMass = mass; bestStart = start; }
  }
  const centreH = (bestStart + Math.floor(PEAK_SPAN / 2)) % 24;
  return {
    startH: bestStart,
    endH: (bestStart + PEAK_SPAN - 1) % 24,
    centreH,
    share: total > 0 ? bestMass / total : 0,
  };
}

/**
 * One activity reading, unified across the two sources, pre-discount.
 * `tauSec` is the implied-interaction point estimate (interval hi edge: the
 * exact minute for the 15–60 band, the observation time for the fresh dot).
 * @typedef {object} ActivityEvent
 * @property {'report'|'galaxy'} source
 * @property {number} tauSec
 * @property {{lo:number, hi:number}} interval
 * @property {number} [ownTs] The event's OWN report timestamp (report source
 *   only) — a probe arrival that must not discount its own reading.
 */

/**
 * Collect one body's activity events (both sources, recency-gated), apply the
 * self-induced discount against the body's own-probe arrival times, then
 * dedupe re-observations of the same interaction (overlapping intervals).
 * Returns kept events + the discounted count + the galaxy-look count.
 *
 * @param {RoutineBody} b
 * @param {number} cutoffSec
 * @returns {{ kept: ActivityEvent[], discounted: number, galaxyLooks: number }}
 */
function bodyActivityEvents(b, cutoffSec) {
  // Own-probe arrivals on this body = every report timestamp we hold for it.
  /** @type {number[]} */
  const probes = [];
  for (const e of b.history || []) {
    if (typeof e.ts === 'number') probes.push(e.ts);
  }
  if (typeof b.latestTs === 'number' && !probes.includes(b.latestTs)) probes.push(b.latestTs);

  /** @type {ActivityEvent[]} */
  const events = [];
  let galaxyLooks = 0;
  for (const e of b.history || []) {
    if (typeof e.ts !== 'number' || e.ts < cutoffSec) continue;
    if (typeof e.activityMin !== 'number' || e.activityMin < 0) continue;
    const obs = { t: e.ts, m: e.activityMin };
    events.push({
      source: 'report',
      tauSec: interactionInterval(obs).hi,
      interval: interactionInterval(obs),
      ownTs: e.ts,
    });
  }
  for (const o of b.activity || []) {
    if (typeof o.t !== 'number' || o.t < cutoffSec) continue;
    galaxyLooks += 1;
    if (o.m < 0) continue; // negative evidence — coverage only, no interaction
    events.push({
      source: 'galaxy',
      tauSec: interactionInterval(o).hi,
      interval: interactionInterval(o),
    });
  }

  // Self-induced discount: drop a reading whose implied interaction interval
  // (±slack) contains one of OUR probe arrivals — except the reading's own
  // report (a probe does not light the marker it itself reads; §6.6bis).
  let discounted = 0;
  const survivors = events.filter((ev) => {
    const self = probes.some((p) => p !== ev.ownTs
      && p >= ev.interval.lo - SAME_TAU_SLACK_S
      && p <= ev.interval.hi + SAME_TAU_SLACK_S);
    if (self) discounted += 1;
    return !self;
  });

  // Same-interaction dedup across sources/looks: ascending by implied time,
  // a reading overlapping the last KEPT one is the same interaction re-seen.
  survivors.sort((a, b2) => a.tauSec - b2.tauSec);
  /** @type {ActivityEvent[]} */
  const kept = [];
  for (const ev of survivors) {
    const prev = kept.length ? kept[kept.length - 1] : null;
    if (prev
      && ev.interval.lo - SAME_TAU_SLACK_S <= prev.interval.hi
      && ev.interval.hi + SAME_TAU_SLACK_S >= prev.interval.lo) continue;
    kept.push(ev);
  }
  return { kept, discounted, galaxyLooks };
}

/**
 * Summarise a watched player's routine from their per-body intel rings. Pure.
 * @param {RoutineBody[]} bodies
 * @param {number} nowMs   Current time (recency cutoff) — matches waves.js's shape.
 * @returns {RoutineSummary}
 */
export function summarizeRoutine(bodies, nowMs) {
  const cutoffSec = (nowMs - RECENCY_MS) / 1000;
  /** @type {Array<{ coord: string, e: SpyReportLite }>} */
  const obs = [];
  for (const b of bodies || []) {
    for (const e of b.history || []) {
      if (typeof e.ts === 'number' && e.ts < cutoffSec) continue; // stale — drop
      obs.push({ coord: b.coord, e });
    }
  }

  // ── Activity (hour of day) — two sources, discounted + deduped ─────────
  const bins = new Array(24).fill(0);
  let actSamples = 0;
  let discounted = 0;
  let galaxyLooks = 0;
  const sources = { reports: 0, galaxy: 0 };
  for (const b of bodies || []) {
    const r = bodyActivityEvents(b, cutoffSec);
    discounted += r.discounted;
    galaxyLooks += r.galaxyLooks;
    for (const ev of r.kept) {
      bins[new Date(ev.tauSec * 1000).getHours()] += 1;
      actSamples += 1;
      sources[ev.source === 'report' ? 'reports' : 'galaxy'] += 1;
    }
  }
  const pk = peakWindow(bins, actSamples);
  const actGate = gateFor(actSamples, pk.share);
  /** @type {ActivitySummary} */
  const activity = {
    bins, samples: actSamples, gate: actGate, sources, discounted, galaxyLooks,
  };
  if (actGate === 'pattern' || actGate === 'strong') {
    activity.label = `${dayPart(pk.centreH)} ${pk.startH}–${pk.endH}`;
    activity.peak = { startH: pk.startH, endH: pk.endH };
  }

  // ── Weekday resource pattern ────────────────────────────────────────────
  /** @type {number[][]} */
  const byDay = Array.from({ length: 7 }, () => []);
  for (const { e } of obs) {
    if (typeof e.ts === 'number' && typeof e.resTotal === 'number') {
      byDay[new Date(e.ts * 1000).getDay()].push(e.resTotal);
    }
  }
  const wSamples = byDay.map((d) => d.length);
  const medians = byDay.map((d) => (d.length ? median(d) : null));
  const resSamples = wSamples.reduce((a, c) => a + c, 0);
  /** @type {WeekdaySummary} */
  const weekday = { medians, samples: wSamples, gate: gateFor(resSamples, 1) };

  // ── Collection planet (usually richest body) ────────────────────────────
  /** @type {Map<string, number[]>} */
  const resByBody = new Map();
  for (const { coord, e } of obs) {
    if (typeof e.resTotal === 'number') {
      const arr = resByBody.get(coord) || [];
      arr.push(e.resTotal);
      resByBody.set(coord, arr);
    }
  }
  /** @type {CollectionSummary|null} */
  let collection = null;
  for (const [coord, vals] of resByBody) {
    const med = median(vals);
    if (!collection || med > collection.medianRes) {
      collection = { coord, medianRes: med, samples: vals.length, ofBodies: resByBody.size };
    }
  }

  // ── Timeline (newest first, across bodies) ──────────────────────────────
  const timeline = obs
    .filter(({ e }) => typeof e.ts === 'number')
    .sort((a, b) => (b.e.ts ?? 0) - (a.e.ts ?? 0))
    .slice(0, 14)
    .map(({ coord, e }) => ({
      ts: e.ts,
      coord,
      resTotal: e.resTotal,
      fleetValue: e.fleetValue,
      defenseValue: e.defenseValue,
      activityMin: e.activityMin,
    }));

  return {
    observations: obs.length + galaxyLooks,
    activity,
    weekday,
    collection,
    timeline,
  };
}

/**
 * Build the {@link RoutineBody} list for one player by joining their
 * spy-report bucket with their galaxy-activity rings — the ONE place that
 * knows a body may exist in either store alone (spied but never browsed /
 * browsed but never spied). Used by both the dashboard (raw per-universe
 * reads) and the in-game scan FAB (reactive stores), so it lives here.
 *
 * @param {Record<string, import('./targetReports.js').BodyEntry
 *   | import('./espionageReport.js').SpyReport>} [reportsBucket]
 *   One player's `targetReports` bucket (bodyKey → entry), either shape.
 * @param {Record<string, ActivityObs[]>} [activityBucket]
 *   The same player's activity rings (bodyKey → ring).
 * @returns {RoutineBody[]}
 */
export function routineBodies(reportsBucket, activityBucket) {
  const keys = new Set([
    ...Object.keys(reportsBucket || {}),
    ...Object.keys(activityBucket || {}),
  ]);
  /** @type {RoutineBody[]} */
  const out = [];
  for (const key of keys) {
    const lastColon = key.lastIndexOf(':');
    const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
    const entry = reportsBucket ? reportsBucket[key] : undefined;
    const latest = entry ? latestOf(entry) : undefined;
    /** @type {RoutineBody} */
    const body = {
      coord,
      history: entry ? historyOf(entry) : [],
      activity: activityBucket ? activityBucket[key] || [] : [],
    };
    if (latest && typeof latest.timestamp === 'number') body.latestTs = latest.timestamp;
    out.push(body);
  }
  return out;
}
