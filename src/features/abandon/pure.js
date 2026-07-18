// @ts-check

// Pure core of the colony FAB's pre-arrival states — the "a colonization is
// about to land / just landed" derivation, DOM-free per the pure-core rule.
//
// # The staleness model
//
// OGame only reflects a completed colonization (the new row in `#planetList`)
// on a FULL page load. So the page the user is sitting on when the fleet lands
// is stale by construction, and stays stale until a reload. The FAB therefore
// walks: a dimmed countdown while the landing is ≤ {@link LANDING_WINDOW_S}
// away → an actionable "Refresh" (→ overview reload) once the server has had
// {@link LANDING_GRACE_S} to process the arrival. A page BORN after the
// arrival is already fresh — it must never arm either state for that arrival.
//
// # Why a latch
//
// The landed leg's `tr.eventFleet` row disappears on OGame's next eventbox
// refresh, and the localStorage cache only ever holds UPCOMING arrivals. The
// "this page went stale" fact therefore can't be re-derived from either source
// a minute later — it is remembered in-memory (`latch`) for the lifetime of
// the page. A reload (the button's own action, or any navigation) resets it
// naturally.

/** Show the countdown once the arrival is at most this many seconds away. */
export const LANDING_WINDOW_S = 60;

/**
 * Flip to "Refresh" this many seconds AFTER the arrival — reloading in the
 * same second the fleet lands can race the server's event processing and
 * serve a planet list that does not have the colony yet.
 */
export const LANDING_GRACE_S = 2;

/**
 * Re-check cadence cap while an arrival is known but still outside the
 * window: wake at the window boundary, but at least every 30 s so cache /
 * event-list drift is picked up.
 */
const IDLE_RECHECK_MS = 30_000;

/**
 * @typedef {object} LandingInput
 * @property {number[] | null} domArrivals Outbound colonization arrivals read
 *   from the live event list (epoch SECONDS): `null` = list absent/unreadable
 *   (fall back to the cache), `[]` = readable and none in flight. A landed
 *   leg's row lingers until OGame's next eventbox refresh, so entries may sit
 *   slightly in the past — that lingering is what lets an open page detect
 *   "landed while you were here".
 * @property {number} cachedArrival  localStorage cache (epoch s; 0 = none).
 * @property {number} latchedArrival Arrival already latched as landed-on-this-
 *   page (epoch s; 0 = none) — pass the previous result's `latch` back in.
 * @property {number} pageBornMs     Epoch ms this page (≈ the feature) loaded.
 * @property {number} nowMs          Epoch ms.
 */

/**
 * @typedef {object} LandingResult
 * @property {'idle' | 'landing' | 'refresh'} phase
 * @property {number} arrivalAt  The arrival the phase is about (epoch s):
 *   the latched landing, else the nearest upcoming one, else 0.
 * @property {number | null} cacheWrite Value to persist (0 clears), or `null`
 *   when the cache already holds it (skip the write).
 * @property {number} latch      New latched value — feed back into the next call.
 */

/**
 * One step of the landing state machine. Pure: all inputs explicit.
 *
 * @param {LandingInput} input
 * @returns {LandingResult}
 */
export const deriveLanding = ({ domArrivals, cachedArrival, latchedArrival, pageBornMs, nowMs }) => {
  // Live event list wins whenever readable (including "readable and empty",
  // which is what clears a consumed cache); otherwise trust the cache.
  const source = domArrivals !== null
    ? domArrivals
    : (cachedArrival > 0 ? [cachedArrival] : []);

  // Latch the first arrival observed to land while THIS page was open. Kept
  // once set — the page can only get staler until a reload resets everything.
  let latch = latchedArrival;
  if (!latch) {
    let crossed = 0;
    for (const a of source) {
      if (a * 1000 <= nowMs && a * 1000 > pageBornMs && a > crossed) crossed = a;
    }
    latch = crossed;
  }

  // The cache only ever holds the nearest UPCOMING arrival: a page loaded
  // after a landing is fresh by construction, so a past value must never
  // survive to arm anything there.
  let upcoming = 0;
  for (const a of source) {
    if (a * 1000 > nowMs && (upcoming === 0 || a < upcoming)) upcoming = a;
  }
  const cacheWrite = upcoming === cachedArrival ? null : upcoming;

  if (latch) {
    const phase = nowMs - latch * 1000 >= LANDING_GRACE_S * 1000 ? 'refresh' : 'landing';
    return { phase, arrivalAt: latch, cacheWrite, latch };
  }
  if (upcoming && upcoming * 1000 - nowMs <= LANDING_WINDOW_S * 1000) {
    return { phase: 'landing', arrivalAt: upcoming, cacheWrite, latch };
  }
  return { phase: 'idle', arrivalAt: upcoming, cacheWrite, latch };
};

/**
 * Delay until the next self-scheduled re-derive (ms; 0 = no timer needed —
 * 'refresh' is static and a bare idle has nothing to wake for; DOM mutations
 * still drive re-evaluation).
 *
 * @param {LandingResult['phase']} phase
 * @param {number} arrivalAt epoch s (the result's `arrivalAt`).
 * @param {number} nowMs
 * @returns {number}
 */
export const nextLandingTickMs = (phase, arrivalAt, nowMs) => {
  if (phase === 'landing') return 1000;
  if (phase === 'refresh' || arrivalAt <= 0) return 0;
  const untilWindow = (arrivalAt - LANDING_WINDOW_S) * 1000 - nowMs;
  return Math.max(1000, Math.min(untilWindow, IDLE_RECHECK_MS));
};

/**
 * `m:ss` countdown to `arrivalAt`, clamped at `0:00` (the grace slice between
 * landing and the Refresh flip).
 *
 * @param {number} arrivalAt epoch s.
 * @param {number} nowMs
 * @returns {string}
 */
export const formatLandingCountdown = (arrivalAt, nowMs) => {
  const remaining = Math.max(0, Math.ceil((arrivalAt * 1000 - nowMs) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Progress-arc fill (0..1) for the landing countdown — 0 when the countdown
 * was first armed, 1 at arrival, so the ring fills AS the landing approaches
 * (mirrors sendColony's min-gap wait arc). The span it fills across is
 * `windowStartS` — the remaining seconds AT THE MOMENT the countdown armed —
 * not the full {@link LANDING_WINDOW_S}: a page that only picks up the
 * arrival with e.g. 10s left (a late tick, or a countdown that armed mid-
 * window) fills its arc across those 10s, instead of reading as "50s already
 * elapsed" against a fixed 60s span. Callers pass back the span they recorded
 * when the phase first went 'landing' for this arrival; defaults to
 * {@link LANDING_WINDOW_S} for a caller that never tracked one. Clamped both
 * ends: a past arrival reads full, a not-yet-armed one reads empty.
 *
 * @param {number} arrivalAt epoch s.
 * @param {number} nowMs
 * @param {number} [windowStartS] remaining seconds when the countdown armed.
 * @returns {number}
 */
export const landingProgress = (arrivalAt, nowMs, windowStartS = LANDING_WINDOW_S) => {
  const remaining = (arrivalAt * 1000 - nowMs) / 1000;
  const span = windowStartS > 0 ? windowStartS : LANDING_WINDOW_S;
  return Math.max(0, Math.min(1, (span - remaining) / span));
};
