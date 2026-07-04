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
 * tens cross-galaxy), then its arrival is the interaction. Generous on
 * purpose — the honest failure direction is dropping a genuine marker, never
 * keeping our own.
 */
export const SELF_AFTER_MS = 45 * 60 * 1000;

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
 * Append one observation to a body's ring, applying the three append-time
 * rules (header). Returns the NEW ring, or `null` when the observation was
 * absorbed (duplicate / throttled / self-induced) — callers skip the store
 * write on `null`, so a galaxy-scroll burst over unchanged markers is free.
 *
 * @param {ActivityObs[] | undefined} ring  Existing ring (oldest→newest).
 * @param {ActivityObs} obs
 * @param {{ sentAtMs?: number }} [opts]  Our own probe-send time for this
 *   body's coord, if any (see lib/spySentSession.js).
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
