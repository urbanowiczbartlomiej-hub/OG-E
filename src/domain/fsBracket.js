// @ts-check

// Fleet-save window bracketing (IDEAS backlog #1) — turn the spy-report +
// galaxy-activity HISTORY into *departure/return arcs*: when the same body
// reads fleet-present at one observation and fleet-absent at the next, the
// fleet left somewhere inside that window — the strike-timing intel (raid
// just after they fleet-save; catch the fleet just after it lands back).
//
// This is the HISTORICAL sibling of domain/fleetLanding.js: that one flags a
// landing happening NOW (a lone fresh moon marker), this one reconstructs
// when fleets LEFT and RETURNED over the past weeks — the raw material of the
// player's fleet-save rhythm.
//
// # The five confounds → structural honesty gates (why this was deferred to
//   v3.1 — each one, unhandled, makes the tool lie):
//
//   1. SAME-BODY PAIRING ONLY. An arc pairs two observations of ONE bodyKey
//      ("g:s:p:type"). A planet and its moon share "g:s:p" but are separate
//      bodies — never mixed (the ring/report keys already carry the type).
//   2. SIBLING RELOCATION. A fleet "gone" from body A may have simply moved
//      to the player's OTHER body. If a sibling's fleet value ROSE by roughly
//      the dropped value around the window, the arc is flagged 'possible'
//      relocation, not a save. If we lack sibling observations to check
//      (unspied bodies), the flag is 'unchecked' — the tool never claims a
//      clean save it cannot verify.
//   3. SECTION SUPPRESSION. A partial scan that did not REVEAL the fleet
//      section must never read as "no fleet". Structurally guaranteed by the
//      input: SpyReportLite carries `fleetValue` only when the section was
//      shown (domain/targetReports.toLite) — absent means unknown, and
//      unknown observations simply don't participate in pairing.
//   4. OUR OWN PROBE. Activity markers used for narrowing are already
//      self-discounted at ring-append time (domain/activityObs) and
//      report-derived looks go through probeActivityObs (same demotion) — so
//      a bracket is never narrowed onto our own probe's arrival.
//   5. INTERVAL, NEVER AN INSTANT. The output is [loSec, hiSec] — the two
//      observation times — optionally narrowed by a SINGLE positive activity
//      marker inside the window (the send/landing itself lights the marker).
//      Two+ markers in the window = the owner was around repeatedly =
//      ambiguous = no narrowing. Windows wider than {@link MAX_WINDOW_S}
//      say nothing about timing and are dropped.
//
// Plus the MOON-GATE downgrade: a departure from a moon, when the player has
// ≥2 moons, may be a jump-gate hop (instant, phalanx-invisible, possibly
// marker-less) — flagged so the reader weighs it.
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives from the caller.

import { latestOf, historyOf, toLite } from './targetReports.js';
import { probeActivityObs, mergeActivityObs, interactionInterval } from './activityObs.js';

// "A real fleet is home" is RELATIVE to the owner, not a fixed number (a top
// player's recycler junk outweighs a newbie's whole armada, and any absolute
// threshold rots across server ages). The present-gate is a fraction of the
// player's fleet SCALE — max(peak fleet value we ever observed in our own
// reports, the caller's API-derived total mobile fleet; see `fleetScaleRes`)
// — with an absolute floor so sparse data can't drive the gate to zero.
/** Floor of the present-gate (resource units) — parked probes/recyclers noise
 *  must not mint arcs even for players whose peak we barely know. */
export const FLEET_PRESENT_FLOOR = 50_000;
/** The present-gate as a fraction of the player's peak observed fleet value. */
export const FLEET_PEAK_FRACTION = 0.1;
/** "The fleet left" = the later value is at most this fraction of the earlier
 *  one (a small stay-behind — a recycler, some probes — must not mask a save). */
export const FLEET_ABSENT_FRACTION = 0.15;
/** Pairs further apart than this bracket nothing useful — dropped. */
export const MAX_WINDOW_S = 48 * 3600;
/** Arcs whose window closed before this horizon are stale — dropped (matches
 *  the routine tracker's 30-day recency). */
export const HORIZON_MS = 30 * 24 * 3600 * 1000;
/** Sibling fleet-rise lookahead past the window end (relocation check #2) —
 *  the moved fleet must be SEEN at the sibling within this slack to count. */
export const SIBLING_SLACK_S = 12 * 3600;
/** A sibling rise of at least this fraction of the dropped value reads as
 *  "the fleet plausibly moved there". */
export const RELOCATION_FRACTION = 0.5;
/** Newest arcs surfaced per player (the dossier block stays glanceable). */
export const MAX_ARCS = 6;

/**
 * One bracketed fleet movement on one body.
 * @typedef {object} FsArc
 * @property {string} coord            "g:s:p".
 * @property {1|3} bodyType            1 planet, 3 moon.
 * @property {'departure'|'return'} kind
 * @property {number} loSec            Window start (last observation "before").
 * @property {number} hiSec            Window end (first observation "after").
 * @property {{lo: number, hi: number} | null} narrowed  A single positive
 *   activity marker inside the window — the LIKELY moment (still an interval).
 * @property {number} valueBefore      Visible fleet value at loSec.
 * @property {number} valueAfter       Visible fleet value at hiSec.
 * @property {'none'|'possible'|'unchecked'} relocation  Gate #2 verdict
 *   (departures; returns carry 'none' — where it came FROM is not claimed).
 * @property {boolean} moonGate        Moon departure while the player has ≥2
 *   moons — may be a jump-gate hop, not a save.
 * @property {'strong'|'weak'} confidence  strong = relocation ruled out and
 *   no moon-gate ambiguity.
 */

/** @typedef {{ ts: number, fleetValue: number }} FleetObs */

/**
 * A body's fleet-value observations, oldest→newest — every stored look that
 * actually REVEALED the fleet section (gate #3: `fleetValue` undefined =
 * section hidden = not an observation). History already contains the lite of
 * the current latest (state/targets.recordReport); a history-less entry
 * (unwatched / legacy bare report) falls back to the latest alone.
 * @param {import('./targetReports.js').BodyEntry
 *   | import('./espionageReport.js').SpyReport} entry
 * @returns {FleetObs[]}
 */
export function fleetObsOf(entry) {
  const hist = historyOf(entry);
  const src = hist.length ? hist : [toLite(latestOf(entry))];
  /** @type {FleetObs[]} */
  const out = [];
  for (const h of src) {
    if (typeof h.ts !== 'number' || !Number.isFinite(h.ts) || h.ts <= 0) continue;
    if (typeof h.fleetValue !== 'number' || !Number.isFinite(h.fleetValue)) continue;
    out.push({ ts: h.ts, fleetValue: h.fleetValue });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Narrow a window by the body's positive activity markers (gate #5): exactly
 * ONE positive marker whose implied interaction interval intersects the open
 * window ⇒ its interval (clamped to the window) is the likely moment. Zero or
 * several ⇒ null (no claim). Markers arrive already self-discounted (gate #4).
 * @param {import('./activityObs.js').ActivityObs[]} merged  oldest→newest.
 * @param {number} loSec @param {number} hiSec
 * @returns {{lo: number, hi: number} | null}
 */
function narrowWindow(merged, loSec, hiSec) {
  /** @type {{lo: number, hi: number} | null} */
  let found = null;
  for (const o of merged) {
    if (o.m < 0) continue;
    const iv = interactionInterval(o);
    if (iv.hi <= loSec || iv.lo >= hiSec) continue;
    if (found) return null; // second marker in the window — ambiguous
    found = { lo: Math.max(iv.lo, loSec), hi: Math.min(iv.hi, hiSec) };
  }
  return found;
}

/**
 * Gate #2 — did the dropped fleet plausibly move to a SIBLING body? Scans the
 * other bodies' fleet observations for a rise of ≥{@link RELOCATION_FRACTION}
 * of the dropped value across the window. Three honest verdicts:
 *   'possible'  — a qualifying sibling rise was found;
 *   'none'      — every other known body was checkable and none rose;
 *   'unchecked' — some body could not be checked (no before/after pair, or
 *                 the player has bodies we hold no fleet observations for).
 * @param {Map<string, FleetObs[]>} obsByKey  All bodies' observations.
 * @param {string} arcKey  The departing body's key (excluded).
 * @param {number} loSec @param {number} hiSec @param {number} dropped
 * @param {number} totalBodies  The player's known body count (planets+moons).
 * @returns {'none'|'possible'|'unchecked'}
 */
function relocationVerdict(obsByKey, arcKey, loSec, hiSec, dropped, totalBodies) {
  let checked = 0;
  for (const [key, obs] of obsByKey) {
    if (key === arcKey) continue;
    // before = newest observation at/before the window start; after = first
    // observation past it (within the slack). Both needed to measure a rise.
    /** @type {FleetObs | null} */ let before = null;
    /** @type {FleetObs | null} */ let after = null;
    for (const o of obs) {
      if (o.ts <= loSec) before = o;
      else if (!after && o.ts <= hiSec + SIBLING_SLACK_S) after = o;
    }
    if (!before || !after) continue;
    checked += 1;
    if (after.fleetValue - before.fleetValue >= dropped * RELOCATION_FRACTION) return 'possible';
  }
  // All siblings we know of were checkable AND the player has no further
  // bodies beyond those we hold observations for ⇒ relocation is ruled out.
  const knownSiblings = obsByKey.size - 1;
  const uncheckable = Math.max(0, totalBodies - 1) - checked;
  return checked >= knownSiblings && uncheckable <= 0 ? 'none' : 'unchecked';
}

/**
 * Bracket one player's fleet departures/returns from their spy-report bucket +
 * activity rings. Newest arcs first, capped at {@link MAX_ARCS}.
 *
 * @param {Record<string, import('./targetReports.js').BodyEntry
 *   | import('./espionageReport.js').SpyReport> | undefined} reportsBucket
 *   This player's `targetReports` bucket (bodyKey "g:s:p:type" → entry).
 * @param {Record<string, import('./activityObs.js').ActivityObs[]> | undefined} rings
 *   This player's galaxy-activity rings (same keys).
 * @param {number} nowMs
 * @param {{ moonCount?: number, totalBodies?: number, fleetScaleRes?: number }} [opts]
 *   `moonCount` — the player's known moons (gate: moon-gate downgrade);
 *   `totalBodies` — known planets+moons (relocation 'unchecked' honesty);
 *   `fleetScaleRes` — the player's TOTAL mobile fleet value in resource units
 *   (API-derived: (visible + hidden fleet points) × 1000), a second anchor of
 *   the present-gate. Pass it only when the estimate's coverage is complete —
 *   a provisional estimate is inflated by unseen defense and would blind the
 *   gate. Defaults derive from the observed keys alone (conservative).
 * @returns {FsArc[]}
 */
export function bracketFsArcs(reportsBucket, rings, nowMs, opts = {}) {
  const reports = reportsBucket || {};
  const keys = Object.keys(reports);
  if (!keys.length) return [];

  /** @type {Map<string, FleetObs[]>} */
  const obsByKey = new Map();
  for (const key of keys) {
    const obs = fleetObsOf(reports[key]);
    if (obs.length) obsByKey.set(key, obs);
  }
  if (!obsByKey.size) return [];

  const observedMoons = keys.filter((k) => k.endsWith(':3')).length;
  const moonCount = Math.max(opts.moonCount ?? 0, observedMoons);
  const totalBodies = Math.max(opts.totalBodies ?? 0, keys.length);
  const cutoffSec = (nowMs - HORIZON_MS) / 1000;

  // The player-relative present-gate: a fraction of the player's fleet SCALE.
  // Scale = the larger of (a) the biggest fleet we ever saw parked on any of
  // their bodies and (b) the caller's API-derived total mobile fleet value —
  // (b) repairs a stale/empty peak (freshly watched player, or one who grew
  // since we last caught the fleet home), (a) covers a missing/partial API.
  let peak = 0;
  for (const obs of obsByKey.values()) {
    for (const o of obs) if (o.fleetValue > peak) peak = o.fleetValue;
  }
  const scale = Math.max(peak, opts.fleetScaleRes ?? 0);
  const presentMin = Math.max(FLEET_PRESENT_FLOOR, scale * FLEET_PEAK_FRACTION);

  /** @type {FsArc[]} */
  const arcs = [];
  for (const [key, obs] of obsByKey) {
    const lastColon = key.lastIndexOf(':');
    const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
    const bodyType = key.endsWith(':3') ? 3 : 1;
    // Merged positive-marker stream for narrowing: the galaxy ring + the
    // looks embedded in the spy history (both already self-discounted).
    const merged = mergeActivityObs(
      rings ? rings[key] : undefined,
      probeActivityObs(historyOf(reports[key])),
    );

    for (let i = 0; i + 1 < obs.length; i++) {
      const a = obs[i];
      const b = obs[i + 1];
      if (b.ts <= a.ts || b.ts - a.ts > MAX_WINDOW_S || b.ts < cutoffSec) continue;

      /** @type {'departure'|'return'|null} */
      let kind = null;
      if (a.fleetValue >= presentMin && b.fleetValue <= a.fleetValue * FLEET_ABSENT_FRACTION) {
        kind = 'departure';
      } else if (b.fleetValue >= presentMin && a.fleetValue <= b.fleetValue * FLEET_ABSENT_FRACTION) {
        kind = 'return';
      }
      if (!kind) continue;

      const relocation = kind === 'departure'
        ? relocationVerdict(obsByKey, key, a.ts, b.ts, a.fleetValue - b.fleetValue, totalBodies)
        : 'none';
      const moonGate = kind === 'departure' && bodyType === 3 && moonCount >= 2;

      arcs.push({
        coord,
        bodyType: /** @type {1|3} */ (bodyType),
        kind,
        loSec: a.ts,
        hiSec: b.ts,
        narrowed: narrowWindow(merged, a.ts, b.ts),
        valueBefore: a.fleetValue,
        valueAfter: b.fleetValue,
        relocation,
        moonGate,
        confidence: relocation === 'none' && !moonGate ? 'strong' : 'weak',
      });
    }
  }

  arcs.sort((x, y) => y.hiSec - x.hiSec);
  return arcs.slice(0, MAX_ARCS);
}
