// @ts-check

// Pure logic of the per-body galaxy-activity ring (SPYGLASS-REDESIGN.md
// §6.6bis). One observation = "when the user happened to render this body in
// their own galaxy view, what did its activity marker say". The marker fires
// on ANY interaction with the body (owner action, returning fleet, incoming
// probe/attack/transport) — it is NOT "the player is online", and the copy
// downstream must never say so.
//
// Three structural honesty rules live HERE, at append time:
//
//   1. SELF-INDUCED DISCOUNT — the single most important rule of the routine
//      tracker: our own probe's arrival lights the target's marker for the
//      next hour. Any positive marker whose implied interaction time falls
//      inside a window around one of OUR OWN probe sends to that coord is
//      dropped before it ever enters the ring — otherwise the tool measures
//      its own scanning rhythm. (Reports the user later OPENS are discounted
//      a second time, read-side, in domain/routine.js — this append-side pass
//      is what catches probes whose report is never opened.)
//   2. SAME-INTERACTION DEDUP — browsing the same system twice within the
//      hour re-observes the SAME interaction (the exact minute ticks up, the
//      implied time τ = obsTime − idleMinutes stays put). An observation whose
//      implied-interaction interval overlaps the last kept one is skipped, so
//      one login never counts twice however often the user scrolls past.
//   3. NEGATIVE-EVIDENCE THROTTLE — "no marker" (m = −1) is kept as honest
//      coverage ("looked, saw nothing") but a quiet body would otherwise fill
//      the ring with it during a hunting session; repeats within 30 min drop.
//
// Pure: no DOM, no storage, no Date.now() — time arrives in the observation
// and the options. Unit-testable with plain fixtures.

/**
 * One galaxy-view activity observation of one body.
 * @typedef {object} ActivityObs
 * @property {number} t Observation time, epoch SECONDS (the SpyReport unit).
 * @property {number} m Marker: `0` = interacted <15 min ago, `15..60` = exact
 *   idle minutes, `-1` = no marker (nothing in the last 60 min).
 */

/** Max observations kept per body (mirrors targetReports' HISTORY_CAP idea). */
export const ACTIVITY_RING_CAP = 48;
/** Repeated "no marker" looks within this window collapse to one. */
export const NONE_REPEAT_MS = 30 * 60 * 1000;
/** Slack (s) when comparing implied interaction times / probe arrivals. */
export const SAME_TAU_SLACK_S = 180;
/** The fresh-dot band: "<15 min" means the interaction is inside this span. */
export const FRESH_BAND_S = 15 * 60;
/** Self-induced window before a probe SEND that still counts as ours (skew). */
export const SELF_BEFORE_MS = 2 * 60 * 1000;
/**
 * Self-induced window after a probe SEND: the probe flies (minutes, up to
 * tens cross-galaxy), then its arrival lights the marker — which then lives a
 * full HOUR. Sized to that 60-min lifetime so a look late in the hour still
 * discounts our own probe. Generous on purpose — the honest failure direction
 * is dropping a genuine marker, never keeping our own. This wide window is the
 * best we can do off a bare send TIME; once the report lands, the precise,
 * age-aware {@link matchesProbeArrival} takes over (see state/activityObs).
 */
export const SELF_AFTER_MS = 60 * 60 * 1000;

/**
 * The implied-interaction-time interval of a positive observation, in epoch
 * seconds: the fresh dot means "somewhere in the last 15 min"; an exact
 * minute means that minute (±60 s resolution).
 * @param {ActivityObs} obs  Positive (`m >= 0`) observation.
 * @returns {{ lo: number, hi: number }}
 */
export const interactionInterval = (obs) => (obs.m === 0
  ? { lo: obs.t - FRESH_BAND_S, hi: obs.t }
  : { lo: obs.t - obs.m * 60 - 60, hi: obs.t - obs.m * 60 });

/**
 * Was this positive marker plausibly caused by OUR OWN probe sent to the body
 * at `sentAtMs`? True when the implied interaction interval intersects
 * [send − {@link SELF_BEFORE_MS}, send + {@link SELF_AFTER_MS}]. A `sentAtMs`
 * of 0/undefined means "no send recorded / time unknown" → never discounted.
 * @param {ActivityObs} obs
 * @param {number} [sentAtMs]
 * @returns {boolean}
 */
export const isSelfInduced = (obs, sentAtMs) => {
  if (obs.m < 0 || !sentAtMs) return false;
  const iv = interactionInterval(obs);
  return iv.hi * 1000 >= sentAtMs - SELF_BEFORE_MS
    && iv.lo * 1000 <= sentAtMs + SELF_AFTER_MS;
};

/**
 * Was this positive marker one of OUR OWN probe ARRIVALS? True when the
 * marker's implied interaction interval contains any probe-arrival time (epoch
 * SECONDS — a spy report's `ts`/`timestamp`) within ±{@link SAME_TAU_SLACK_S}.
 * The durable, age-aware companion to {@link isSelfInduced}: a report we hold
 * PROVES we probed the body at ~that time (the arrival that lit the marker),
 * and unlike the per-tab send map (lib/spySentSession) it survives a tab close,
 * a manual (non-OG-E) send, and looking from a different tab. Age-aware by
 * construction — a FRESHER marker (genuine activity after our probe) has an
 * interval that misses every arrival and is kept. Mirrors the read-side match
 * in {@link probeActivityObs}.
 * @param {ActivityObs} obs
 * @param {number[]} [probeTimesSec]  Our probe arrivals for this body, epoch s.
 * @returns {boolean}
 */
export const matchesProbeArrival = (obs, probeTimesSec) => {
  if (obs.m < 0 || !Array.isArray(probeTimesSec) || !probeTimesSec.length) return false;
  const iv = interactionInterval(obs);
  return probeTimesSec.some((p) => Number.isFinite(p)
    && p >= iv.lo - SAME_TAU_SLACK_S && p <= iv.hi + SAME_TAU_SLACK_S);
};

/**
 * Convert a body's spy-report history into activity observations — every
 * espionage report is also a LOOK at the body (its activity field is the same
 * marker the galaxy view shows). `activityMin` ≥ 0 → a positive marker;
 * `-1` OR absent → a quiet look (reports recorded before the `-1` parse fix
 * stored quiet as absent, and the game always prints the activity block, so
 * absent ≈ quiet). A positive whose implied interaction time matches ANOTHER
 * of our own probe arrivals (± {@link SAME_TAU_SLACK_S}) is demoted to a quiet
 * look — the marker was almost surely our earlier probe, not the owner
 * (mirrors presence.bodyPresenceEvents; a report's OWN arrival is excluded:
 * the marker it reads predates it). Output is oldest→newest by report time.
 * @param {Array<{ ts?: number, activityMin?: number }>} events
 *   Spy-report observations of ONE body (targetReports history shape).
 * @returns {ActivityObs[]}
 */
export const probeActivityObs = (events) => {
  if (!Array.isArray(events) || !events.length) return [];
  /** @type {number[]} our own probe arrivals = every report time we hold. */
  const probes = [];
  for (const e of events) {
    if (typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0) probes.push(e.ts);
  }
  /** @type {ActivityObs[]} */
  const out = [];
  for (const e of events) {
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts <= 0) continue;
    let m = typeof e.activityMin === 'number' && e.activityMin >= 0
      ? Math.min(60, e.activityMin)
      : -1;
    if (m >= 0) {
      const iv = interactionInterval({ t: e.ts, m });
      const selfInduced = probes.some((p) => p !== e.ts
        && p >= iv.lo - SAME_TAU_SLACK_S && p <= iv.hi + SAME_TAU_SLACK_S);
      if (selfInduced) m = -1;
    }
    out.push({ t: e.ts, m });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
};

/**
 * Merge two oldest→newest observation lists (galaxy ring + probe looks) into
 * one time-ordered list — the input of a combined activity readout. No dedup:
 * the readout takes a max over implied interaction times, so re-observing the
 * same interaction from both sources cannot inflate the last-active claim.
 * @param {ActivityObs[] | undefined} a
 * @param {ActivityObs[] | undefined} b
 * @returns {ActivityObs[]}
 */
export const mergeActivityObs = (a, b) => {
  const la = Array.isArray(a) ? a : [];
  const lb = Array.isArray(b) ? b : [];
  if (!la.length) return lb;
  if (!lb.length) return la;
  return [...la, ...lb].sort((x, y) => x.t - y.t);
};

/**
 * Append one observation to a body's ring, applying the three append-time
 * rules (header). Returns the NEW ring, or `null` when the observation was
 * absorbed (duplicate / throttled / self-induced) — callers skip the store
 * write on `null`, so a galaxy-scroll burst over unchanged markers is free.
 *
 * @param {ActivityObs[] | undefined} ring  Existing ring (oldest→newest).
 * @param {ActivityObs} obs
 * @param {{ sentAtMs?: number, probeTimesSec?: number[] }} [opts]  Anchors for
 *   the self-induced discount: `sentAtMs` = our probe-SEND time for this body
 *   (per-tab, fresh — lib/spySentSession.js); `probeTimesSec` = our probe
 *   ARRIVALS from reports we already hold (durable, cross-tab —
 *   state/activityObs). Either one matching drops the marker.
 * @returns {ActivityObs[] | null}
 */
export const appendActivityObs = (ring, obs, opts = {}) => {
  if (typeof obs.t !== 'number' || !Number.isFinite(obs.t)) return null;
  if (typeof obs.m !== 'number' || obs.m < -1 || obs.m > 60) return null;
  const cur = Array.isArray(ring) ? ring : [];
  const last = cur.length ? cur[cur.length - 1] : null;
  // Out-of-order / repeated event echo: never append an observation older
  // than the newest kept one (the ring is oldest→newest by construction).
  if (last && obs.t < last.t) return null;

  if (obs.m === -1) {
    // Negative evidence: keep, but throttle repeats of an unchanged "quiet".
    if (last && last.m === -1 && (obs.t - last.t) * 1000 < NONE_REPEAT_MS) return null;
  } else {
    if (isSelfInduced(obs, opts.sentAtMs)) return null;
    if (matchesProbeArrival(obs, opts.probeTimesSec)) return null;
    // Same-interaction dedup against the most recent POSITIVE observation
    // (intervals are time-ordered; only the newest one can still collide).
    const lastPos = [...cur].reverse().find((e) => e.m >= 0);
    if (lastPos) {
      const a = interactionInterval(lastPos);
      const b = interactionInterval(obs);
      if (b.lo - SAME_TAU_SLACK_S <= a.hi && b.hi + SAME_TAU_SLACK_S >= a.lo) return null;
    }
  }

  return [...cur, { t: obs.t, m: obs.m }].slice(-ACTIVITY_RING_CAP);
};

/**
 * Rings whose newest observation is older than this can no longer influence
 * the 30-day routine window (domain/routine.js RECENCY_MS) and only cost
 * storage / sync payload. Shared horizon of the state store's hydrate sweep
 * AND the sync scheduler's merge (the sweep must run on the merged result
 * too, or a ring another device already swept locally would ping-pong back
 * through the gist forever).
 */
export const ACTIVITY_SWEEP_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Drop rings whose newest observation predates the sweep horizon, and empty
 * player buckets. Pure over the map value (time arrives as an argument).
 *
 * @param {Record<string, Record<string, ActivityObs[]>>} map
 * @param {number} nowMs
 * @returns {Record<string, Record<string, ActivityObs[]>>}
 */
export const sweepStaleActivityObs = (map, nowMs) => {
  const cutoffSec = (nowMs - ACTIVITY_SWEEP_AFTER_MS) / 1000;
  /** @type {Record<string, Record<string, ActivityObs[]>>} */
  const out = {};
  for (const pid of Object.keys(map)) {
    const bucket = map[pid];
    if (!bucket || typeof bucket !== 'object') continue;
    /** @type {Record<string, ActivityObs[]>} */
    const kept = {};
    for (const key of Object.keys(bucket)) {
      const ring = bucket[key];
      if (!Array.isArray(ring) || !ring.length) continue;
      if ((ring[ring.length - 1].t ?? 0) < cutoffSec) continue;
      kept[key] = ring;
    }
    if (Object.keys(kept).length) out[pid] = kept;
  }
  return out;
};
