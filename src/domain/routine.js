// @ts-check

// Pure routine analysis over a watched player's spy-report HISTORY — the honest,
// sample-gated summaries the Spyglass dossier shows: hour-of-day activity, a
// weekday resource pattern, the "collection" planet, and a plain timeline. It
// runs ENTIRELY over `SpyReportLite` rings the user already gathered (reports
// they opened while playing); this module originates nothing and reads no live
// state. No DOM, no timers, no storage, no `chrome.*` — unit-testable with plain
// fixtures.
//
// Honesty is structural, not cosmetic (SPYGLASS-REDESIGN.md §6.6):
//   - Every summary carries its own SAMPLE COUNT so the renderer can show a
//     coverage row — the tool visibly only knows what the user sampled.
//   - Everything is n-GATED: `none` (too few) → `hint` (faint) → `pattern` →
//     `strong`. A thin sample never reads as a confident claim.
//   - "activity" means "this body was interacted with", NOT "the player was
//     online" — the renderer must never say "online" (the caveat lives in §6.6bis;
//     the wording lives in the view).
//
// Hours/weekdays are LOCAL (the user cares when, in THEIR day, to strike), so the
// output is timezone-dependent by design.

/** @typedef {import('./targetReports.js').SpyReportLite} SpyReportLite */

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
 * @property {number} samples     Observations that carried a usable activity signal.
 * @property {Gate} gate
 * @property {string} [label]     Human peak, e.g. "evenings 19–22" (≥ pattern only).
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
 * @property {number} observations   Total lite observations considered (post-recency).
 * @property {ActivitySummary} activity
 * @property {WeekdaySummary} weekday
 * @property {CollectionSummary|null} collection
 * @property {TimelineEntry[]} timeline   Newest first, across all bodies (capped).
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
 * The local hour a report implies the body was last interacted with: the report
 * time minus the activity age. `null` when either is missing (no usable signal).
 * @param {SpyReportLite} e
 * @returns {number|null}
 */
function activityHour(e) {
  if (typeof e.ts !== 'number' || typeof e.activityMin !== 'number') return null;
  return new Date((e.ts - e.activityMin * 60) * 1000).getHours();
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
 * Summarise a watched player's routine from their per-body history rings. Pure.
 * @param {Array<{ coord: string, history: SpyReportLite[] }>} bodies
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

  // ── Activity (hour of day) ──────────────────────────────────────────────
  const bins = new Array(24).fill(0);
  let actSamples = 0;
  for (const { e } of obs) {
    const h = activityHour(e);
    if (h != null) { bins[h] += 1; actSamples += 1; }
  }
  const pk = peakWindow(bins, actSamples);
  const actGate = gateFor(actSamples, pk.share);
  /** @type {ActivitySummary} */
  const activity = { bins, samples: actSamples, gate: actGate };
  if (actGate === 'pattern' || actGate === 'strong') {
    activity.label = `${dayPart(pk.centreH)} ${pk.startH}–${pk.endH}`;
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

  return { observations: obs.length, activity, weekday, collection, timeline };
}
