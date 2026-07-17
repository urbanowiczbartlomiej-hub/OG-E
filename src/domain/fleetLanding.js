// @ts-check

// Fleet-landing detection (SPYGLASS-PASSIVE-PLAN) — the aggressor's "a fleet
// just landed here and the owner is away" signal, read PURELY from the galaxy
// activity we already gather passively.
//
// # The signature (docs/ogame-fleet-mechanics.md → fleet-save catching)
//
// A returning fleet-save lands on a MOON. If the owner is offline they can't
// re-save it, so it sits there catchable. That landing lights the moon's
// activity marker — but a human PLAYING leaves marks on several bodies (they
// hop planets, use their main). So the tell is asymmetric, exactly the
// "activity ≠ online" insight turned offensive: activity concentrated on a
// moon while the human is (or has since gone) away ⇒ likely a mechanical
// event (a landing), not play.
//
// # The mode ladder ({@link MoonStrikeMode})
//
// How much corroboration the detector demands is the user's choice — ONE
// Spyglass option, each rung including the previous:
//
//   'off'    — never flag.
//   'lone'   — the moon is the ONLY body lit RIGHT NOW and ≥1 other body is
//              confirmed quiet (the classic, strictest FS-landing signature).
//   'newest' — the moon holds the account's NEWEST known interaction: other
//              bodies may show strictly OLDER marks (the player hopped
//              planets, left, then a landing lit the moon) — or everything
//              has already faded and the LAST trace, within the
//              {@link AFTERGLOW_HORIZON_MS} horizon, sits on the moon with
//              only silence observed since (a parked fleet outlives its
//              60-min marker; what decays is our confidence).
//   'any'    — any lit moon, even alongside freshly-active planets. The
//              owner may well be online — weakest signal, for aggressive
//              hunters; flagged `concurrent` + confidence 'weak' so every
//              surface says so.
//
// It is only ever a CANDIDATE — the marker also fires for a foreign
// attack/probe or a brief owner login, so the honest verb is "spy to
// confirm", never "fleet is there". A probe (one deliberate tap) confirms
// it; this module only RANKS/flags.
//
// # The re-look nudge ({@link detectLandingRecheck})
//
// The one ambiguity a 'newest' claim cannot resolve NOW — a moon and a
// planet both marked inside the fuzzy "<15 min" band — resolves ITSELF with
// time: once both marks age past 15 min the game shows exact idle minutes
// (±1 min), and a single re-look orders the events. The recheck detector
// flags exactly that situation with a time WINDOW: `readyAtMs` (both marks
// have left the fuzzy band) → `expiresAtMs` (a marker dies 60 min after its
// interaction — after that a re-look can no longer order anything). The
// galaxy LOOK plan boosts the moon's system inside that window, so the FAB
// passively proposes "look here again now" — no timers, no toasts, same
// propose-only discipline as everything else here.
//
// # Several moons lit at once
//
// ONE signal per player — the strongest claim the evidence supports, on the
// moon with the newest mark; `coMoons` counts the other lit moons so the
// surfaces can say "newest of N". Co-lit MOONS never demote a 'newest'
// claim: a human playing touches planets (economy, building), so activity
// concentrated on moons alone reads as landings, not play — only a PLANET's
// overlapping/newer mark does (the owner may genuinely be active). The rest
// rotates naturally: probing the top moon self-discounts its light
// (sentMap), so the NEXT tick flags the next moon — one deliberate tap per
// probe, in evidence order. Across players each watched player yields their
// own signal; the scan plan ranks the strikes by danger.
//
// # Honesty gates (structural)
//
//   - FULL-SWEEP: a verdict (ANY tier) fires only once the WHOLE account has
//     been swept — every body of the player looked at within
//     {@link QUIET_COVERAGE_MS}. Partial knowledge proposes MORE LOOKING,
//     never a probe: {@link detectLandingSweep} lists the player's uncovered
//     systems, and the galaxy look plan boosts them so the FAB walks the
//     account to completion first (looks are free and undetectable; a fresh
//     planet mark elsewhere refutes the claim before a probe is spent).
//     Body coverage is system-level: the ring's own last look OR the
//     caller-supplied per-system scan time (`opts.sysLookSec` — a rendered
//     system covers a body whose activity block wasn't parseable).
//   - COVERAGE: we can only call the other bodies "quiet"/"older" if we
//     LOOKED at them. Bodies with a stale look (or none) are `unknown`, not
//     quiet — and under the full-sweep gate they block the verdict outright.
//   - SELF-INDUCED: our own probe lights the moon for the next hour. The ring
//     append already discounts probes whose send we recorded; this pass ALSO
//     skips a body we probed recently ({@link SELF_WINDOW_MS} for a live
//     marker, interval-matched {@link isSelfInduced} for an older one), so
//     the tool never flags its own scan as a landing.
//   - KEPT-LOOKING: the afterglow claim "quiet since the landing" requires at
//     least one QUIET look taken AFTER the implied interaction — a quiet look
//     that PRECEDES it says nothing about "since", and absence of looks is
//     not evidence of silence.
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives from the caller.

import { playerPlanets } from './targets.js';
import {
  interactionInterval, isSelfInduced, SAME_TAU_SLACK_S, FRESH_BAND_S,
} from './activityObs.js';
import { ringKeyFor, overrideKeyFor } from './scanMode.js';

/**
 * The moon-strike aggressiveness ladder — see the file header for the rungs.
 * Owned here (domain floor); `state/watchList` re-imports it for its config
 * field, the dashboard chip group edits it.
 * @typedef {'off'|'lone'|'newest'|'any'} MoonStrikeMode
 */

/** A body is "freshly active" only if its IMPLIED INTERACTION (τ, from the
 * marker's minutes — not the look time) falls within this window. The old
 * look-age rule let a marker of 40–55 idle minutes seen just now read as
 * "lit NOW", so a lone strike could claim a moon whose last interaction was
 * an hour old (a real false-strike users hit while their own probes lit the
 * planets); the 15–60 min tail belongs to the 'newest' tier, which reports
 * its age instead of claiming NOW. */
export const FRESH_LOOK_MS = 30 * 60 * 1000;
/** A quiet look counts as "quiet now" only if this recent (concurrency). */
export const QUIET_COVERAGE_MS = 60 * 60 * 1000;
/** A fresh body we probed within this window is our OWN light — not a landing. */
export const SELF_WINDOW_MS = 45 * 60 * 1000;
/** Coverage ratio at/above which the signal reads `strong` (else `medium`). */
export const STRONG_COVERAGE = 0.7;
/**
 * How far back the account's newest interaction may lie and still argue "a
 * fleet may be sitting there since" (the 'newest' tier's afterglow reach).
 * The marker itself dies after 60 min — a parked fleet doesn't; the horizon
 * bounds how long we keep proposing before the trail is stale.
 */
export const AFTERGLOW_HORIZON_MS = 8 * 3600 * 1000;
/** A galaxy activity marker's lifetime: it shows the exact idle minutes up
 * to 60, then disappears. Bounds the re-look window below. */
const MARKER_LIFE_MS = 60 * 60 * 1000;

/**
 * @typedef {object} BodyState
 * @property {string} coord
 * @property {1|3} bodyType
 * @property {'fresh'|'quiet'|'unknown'} cls  What the newest look says about NOW.
 * @property {import('./activityObs.js').ActivityObs | null} pos
 *   Newest POSITIVE observation in the ring (any age) — the interaction-
 *   ordering evidence.
 * @property {number} lastLookT  Newest look time (epoch s); 0 when none.
 * @property {boolean} selfLit   The positive light is plausibly our own probe.
 * @property {boolean} covered   Looked at within {@link QUIET_COVERAGE_MS} —
 *   by its own ring OR the per-system scan time (the full-sweep gate's unit).
 */

/** `"g:s"` of a `"g:s:p"` coord. @param {string} coord @returns {string} */
const systemOf = (coord) => coord.slice(0, coord.lastIndexOf(':'));

/**
 * Distill one body's activity ring at `nowMs` (see {@link BodyState}).
 * @param {string} coord
 * @param {1|3} bodyType
 * @param {import('./activityObs.js').ActivityObs[] | undefined} ring
 * @param {number} nowMs
 * @param {Record<string, number>} sent  our recent probe sends (overrideKey → epoch ms).
 * @param {Record<string, number>} sysLookSec  per-system newest look (epoch s).
 * @returns {BodyState}
 */
function bodyState(coord, bodyType, ring, nowMs, sent, sysLookSec) {
  /** @type {BodyState['cls']} */
  let cls = 'unknown';
  /** @type {BodyState['pos']} */
  let pos = null;
  let lastLookT = 0;
  if (Array.isArray(ring) && ring.length) {
    const last = ring[ring.length - 1];
    if (last && typeof last.t === 'number' && typeof last.m === 'number') {
      lastLookT = last.t;
      const lookAgeMs = nowMs - last.t * 1000;
      if (last.m >= 0) {
        // Interaction age, not look age (see FRESH_LOOK_MS) — τ_hi ≤ look
        // time, so a recent interaction implies a recent look for free.
        const tauAgeMs = nowMs - interactionInterval(last).hi * 1000;
        if (lookAgeMs >= 0 && tauAgeMs <= FRESH_LOOK_MS) cls = 'fresh';
      } else if (lookAgeMs >= 0 && lookAgeMs <= QUIET_COVERAGE_MS) {
        cls = 'quiet';
      }
    }
    for (let i = ring.length - 1; i >= 0; i--) {
      const o = ring[i];
      if (o && typeof o.t === 'number' && typeof o.m === 'number' && o.m >= 0) {
        pos = o;
        break;
      }
    }
  }
  const sentAt = sent[overrideKeyFor(coord, bodyType)];
  const selfLit = !!(sentAt && (
    (cls === 'fresh' && nowMs - sentAt < SELF_WINDOW_MS)
    || (pos && isSelfInduced(pos, sentAt))
  ));
  const sysT = Number(sysLookSec[systemOf(coord)]) || 0;
  const bestLookT = Math.max(lastLookT, sysT);
  const covered = bestLookT > 0
    && nowMs - bestLookT * 1000 >= 0
    && nowMs - bestLookT * 1000 <= QUIET_COVERAGE_MS;
  return { coord, bodyType, cls, pos, lastLookT, selfLit, covered };
}

/**
 * @typedef {object} FleetLandingSignal
 * @property {string} coord        "g:s:p" of the suspicious moon.
 * @property {3} bodyType          Always a moon (the headline case).
 * @property {string} overrideKey  "g:s:p:3" — the plan boost / rescan key.
 * @property {number} freshAgeMs   How long ago the moon's implied interaction was.
 * @property {number} quiet        Other bodies corroborated (quiet-recent, or
 *   for the 'newest' tier also strictly-older marks).
 * @property {number} total        Other bodies total (coverage denominator).
 * @property {'strong'|'medium'|'weak'} confidence  strong/medium from
 *   coverage; the 'any' tier is always weak.
 * @property {'lone'|'newest'|'any'} tier  Which rung of the ladder fired.
 * @property {boolean} concurrent  Other PLANETS were ALSO freshly lit (the
 *   owner may be around) — only 'newest'/'any' can set it.
 * @property {number} coMoons  OTHER moons lit alongside the flagged one (see
 *   the multi-moon section in the header) — 0 in the common case.
 * @property {string} [playerId]  The moon's owner — stamped by
 *   {@link detectAllLandings} (the per-body detector doesn't know it). Lets
 *   the scan plan synthesize an entry for a strike on a player OUTSIDE the
 *   watch-list (the patrol mode's prey).
 */

/** Build the signal from a winning body state. Confidence from coverage
 * unless forced (the 'any' tier passes 'weak').
 * @param {BodyState} s @param {FleetLandingSignal['tier']} tier
 * @param {number} corroborated @param {number} total @param {boolean} concurrent
 * @param {number} coMoons @param {number} nowMs @param {'weak'} [forceConfidence]
 * @returns {FleetLandingSignal} */
function mkSignal(s, tier, corroborated, total, concurrent, coMoons, nowMs, forceConfidence) {
  const iv = interactionInterval(/** @type {import('./activityObs.js').ActivityObs} */ (s.pos));
  const ratio = total > 0 ? corroborated / total : 0;
  return {
    coord: s.coord,
    bodyType: 3,
    overrideKey: overrideKeyFor(s.coord, 3),
    freshAgeMs: nowMs - iv.hi * 1000,
    quiet: corroborated,
    total,
    confidence: forceConfidence ?? (ratio >= STRONG_COVERAGE ? 'strong' : 'medium'),
    tier,
    concurrent,
    coMoons,
  };
}

/**
 * Detect the moon-strike signature for ONE player at the given mode. Tiers
 * are tried strictest-first, so the returned signal always carries the
 * STRONGEST claim the evidence supports. Self-lit bodies never flag.
 *
 * FULL-SWEEP GATE: no tier fires unless EVERY body of the player is covered
 * (looked at within {@link QUIET_COVERAGE_MS} — see the header). Partial
 * knowledge yields `null` here; {@link detectLandingSweep} turns it into a
 * "finish sweeping this account" look proposal instead.
 *
 * @param {Array<{coord: string, bodyType: 1|3}>} bodies  the player's bodies.
 * @param {Record<string, import('./activityObs.js').ActivityObs[]> | undefined} rings
 *   this player's activity rings (ringKey → ring).
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 *   `sentMap`: our recent probe sends (overrideKey → epoch ms) for the
 *   self-induced skip. `mode`: the ladder rung (default 'newest' — the
 *   store's default; callers normally pass the configured value).
 *   `sysLookSec`: per-system newest scan time ("g:s" → epoch s, from
 *   state/scans) — covers bodies whose activity block wasn't parseable.
 * @returns {FleetLandingSignal | null}
 */
export function detectFleetLanding(bodies, rings, nowMs, opts = {}) {
  const mode = opts.mode ?? 'newest';
  if (mode === 'off') return null;
  const sent = opts.sentMap || {};
  const sysLookSec = opts.sysLookSec || {};
  const states = (bodies || []).map((b) =>
    bodyState(b.coord, b.bodyType, rings ? rings[ringKeyFor(b.coord, b.bodyType)] : undefined, nowMs, sent, sysLookSec));
  if (!states.length) return null;
  // The full-sweep gate: verdicts only over a COMPLETELY seen account.
  if (states.some((s) => !s.covered)) return null;
  const totalOthers = Math.max(0, states.length - 1);

  const fresh = states.filter((s) => s.cls === 'fresh' && !s.selfLit);
  const quietN = states.filter((s) => s.cls === 'quiet').length;

  // ── Tier 'lone' (every mode): the classic signature — exactly one body
  // lit, it's a moon, ≥1 other confirmed quiet.
  if (fresh.length === 1 && fresh[0].bodyType === 3 && quietN >= 1) {
    return mkSignal(fresh[0], 'lone', quietN, totalOthers, false, 0, nowMs);
  }
  if (mode === 'lone') return null;

  // ── Tier 'newest': the moon holds the account's newest known interaction.
  // Other bodies corroborate by being quiet-recent OR strictly older-marked.
  // A PLANET's interaction that overlaps/outdates the moon's makes the claim
  // ambiguous (the owner may be playing — falls through to 'any'); another
  // MOON's co-lit mark does NOT (moons-only concurrency reads as landings —
  // see the multi-moon header section), it just counts into `coMoons`. The
  // afterglow horizon bounds the age; a FADED marker additionally needs at
  // least one quiet look taken after the interaction itself (kept-looking).
  const positives = states.filter((s) => s.pos && !s.selfLit);
  if (positives.length) {
    const newest = positives.reduce((a, b) =>
      (interactionInterval(/** @type {any} */ (b.pos)).hi > interactionInterval(/** @type {any} */ (a.pos)).hi ? b : a));
    const iv = interactionInterval(/** @type {any} */ (newest.pos));
    const ageMs = nowMs - iv.hi * 1000;
    if (newest.bodyType === 3 && ageMs >= 0 && ageMs <= AFTERGLOW_HORIZON_MS) {
      let corroborated = 0;
      let quietSince = 0;
      let coMoons = 0;
      let ambiguous = false;
      for (const o of states) {
        if (o === newest) continue;
        if (o.pos && !o.selfLit) {
          if (interactionInterval(o.pos).hi <= iv.lo - SAME_TAU_SLACK_S) corroborated += 1;
          else if (o.bodyType === 3) coMoons += 1; // co-lit moon — a co-candidate, not the owner
          else ambiguous = true; // a planet's overlapping/newer mark — owner may be active
        } else if (o.cls === 'quiet') {
          corroborated += 1;
          // A quiet look AFTER the moon's interaction testifies "quiet
          // SINCE"; one that precedes it only lowers unknown-ness.
          if (o.lastLookT > iv.hi) quietSince += 1;
        }
      }
      if (!ambiguous && corroborated >= 1 && (newest.cls === 'fresh' || quietSince >= 1)) {
        const concurrent = states.some((s) =>
          s !== newest && s.bodyType === 1 && s.cls === 'fresh' && !s.selfLit);
        return mkSignal(newest, 'newest', corroborated, totalOthers, concurrent, coMoons, nowMs);
      }
    }
  }
  if (mode === 'newest') return null;

  // ── Tier 'any': any lit moon at all — owner may be around; always weak.
  const freshMoons = fresh.filter((s) => s.bodyType === 3);
  if (freshMoons.length) {
    const pick = freshMoons.reduce((a, b) =>
      (interactionInterval(/** @type {any} */ (b.pos)).hi > interactionInterval(/** @type {any} */ (a.pos)).hi ? b : a));
    return mkSignal(
      pick, 'any', quietN, totalOthers, fresh.length > 1, freshMoons.length - 1, nowMs, 'weak',
    );
  }
  return null;
}

/**
 * Run {@link detectFleetLanding} across all watched players.
 * @param {string[]} players
 * @param {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 * @param {Record<string, Record<string, import('./activityObs.js').ActivityObs[]>>} ringsMap
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 * @returns {Record<string, FleetLandingSignal>}
 */
export function detectAllLandings(players, universePlanets, ringsMap, nowMs, opts = {}) {
  /** @type {Record<string, FleetLandingSignal>} */
  const out = {};
  if (opts.mode === 'off') return out;
  for (const pid of players || []) {
    /** @type {Array<{coord: string, bodyType: 1|3}>} */
    const bodies = [];
    for (const p of playerPlanets(universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      bodies.push({ coord, bodyType: 1 });
      if (p.hasMoon) bodies.push({ coord, bodyType: 3 });
    }
    const sig = detectFleetLanding(bodies, ringsMap ? ringsMap[pid] : undefined, nowMs, opts);
    if (sig) out[pid] = { ...sig, playerId: String(pid) };
  }
  return out;
}

/**
 * Override-key → signal map of everything flagged this tick — what the scan
 * plan boosts (and reads the tier from, for the FAB's per-tier wording).
 * Convenience over {@link detectAllLandings}'s per-player map.
 * @param {Record<string, FleetLandingSignal>} signals
 * @returns {Map<string, FleetLandingSignal>}
 */
export const strikeMapOf = (signals) =>
  new Map(Object.values(signals || {}).map((s) => [s.overrideKey, s]));

/**
 * @typedef {object} LandingSweep
 * @property {string} coord      The candidate moon ("g:s:p") whose claim the
 *   sweep would settle.
 * @property {3} bodyType
 * @property {string[]} systems  The player's UNCOVERED systems ("g:s") — the
 *   looks still needed before any verdict may fire.
 * @property {number} expiresAtMs  When the candidate's trail leaves the
 *   afterglow horizon — past it the sweep has nothing left to settle.
 */

/**
 * The full-sweep gate's actionable half: when a player has a plausible moon
 * candidate (a non-self positive within the horizon, not already outdated by
 * a planet mark) but the account is NOT fully covered, list the uncovered
 * systems so the look plan can walk them. Once they're covered,
 * {@link detectFleetLanding}'s verdict takes over. `null` when there is no
 * candidate (nothing to settle) or nothing is uncovered (verdict path).
 *
 * @param {Array<{coord: string, bodyType: 1|3}>} bodies
 * @param {Record<string, import('./activityObs.js').ActivityObs[]> | undefined} rings
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 * @returns {LandingSweep | null}
 */
export function detectLandingSweep(bodies, rings, nowMs, opts = {}) {
  const mode = opts.mode ?? 'newest';
  if (mode === 'off') return null;
  const sent = opts.sentMap || {};
  const sysLookSec = opts.sysLookSec || {};
  const states = (bodies || []).map((b) =>
    bodyState(b.coord, b.bodyType, rings ? rings[ringKeyFor(b.coord, b.bodyType)] : undefined, nowMs, sent, sysLookSec));
  const uncovered = [...new Set(states.filter((s) => !s.covered).map((s) => systemOf(s.coord)))];
  if (!uncovered.length) return null;
  // Candidate: the newest non-self MOON mark (any body, covered or not — an
  // aged moon sighting is exactly what a sweep re-examines), within the
  // horizon and not already strictly outdated by a planet mark.
  /** @type {{ s: BodyState, hi: number } | null} */
  let moonTop = null;
  let planetHi = -Infinity;
  for (const s of states) {
    if (!s.pos || s.selfLit) continue;
    const hi = interactionInterval(s.pos).hi;
    if (s.bodyType === 3) {
      if (!moonTop || hi > moonTop.hi) moonTop = { s, hi };
    } else if (hi > planetHi) {
      planetHi = hi;
    }
  }
  if (!moonTop) return null;
  const ageMs = nowMs - moonTop.hi * 1000;
  if (!(ageMs >= 0 && ageMs <= AFTERGLOW_HORIZON_MS)) return null;
  if (planetHi > moonTop.hi + SAME_TAU_SLACK_S) return null; // owner moved later — claim dead
  // Mode 'lone' short-circuit: a lone verdict needs EXACTLY ONE lit body (the
  // moon). The instant a SECOND non-self body is already lit, no amount of
  // further coverage can bring `fresh` back to 1 — the verdict is unreachable,
  // so sweeping the rest of the account would spend looks (a real galaxy-view
  // footprint) that can never settle anything. Stop proposing it. 'newest'/'any'
  // still sweep — they can resolve WITH other lit bodies, so their sweep isn't
  // wasted.
  if (mode === 'lone'
    && states.some((s) => s !== moonTop.s && s.cls === 'fresh' && !s.selfLit)) {
    return null;
  }
  return {
    coord: moonTop.s.coord,
    bodyType: 3,
    systems: uncovered,
    expiresAtMs: moonTop.hi * 1000 + AFTERGLOW_HORIZON_MS,
  };
}

/**
 * Run {@link detectLandingSweep} across all watched players.
 * @param {string[]} players
 * @param {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 * @param {Record<string, Record<string, import('./activityObs.js').ActivityObs[]>>} ringsMap
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 * @returns {Record<string, LandingSweep>}
 */
export function detectAllSweeps(players, universePlanets, ringsMap, nowMs, opts = {}) {
  /** @type {Record<string, LandingSweep>} */
  const out = {};
  if (opts.mode === 'off') return out;
  for (const pid of players || []) {
    /** @type {Array<{coord: string, bodyType: 1|3}>} */
    const bodies = [];
    for (const p of playerPlanets(universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      bodies.push({ coord, bodyType: 1 });
      if (p.hasMoon) bodies.push({ coord, bodyType: 3 });
    }
    const s = detectLandingSweep(bodies, ringsMap ? ringsMap[pid] : undefined, nowMs, opts);
    if (s) out[pid] = s;
  }
  return out;
}

/**
 * @typedef {object} LandingRecheck
 * @property {string} coord      "g:s:p" of the ambiguous moon.
 * @property {3} bodyType
 * @property {number} readyAtMs   From here a re-look is informative: every
 *   mark of the ambiguous pair has left the fuzzy "<15" band, so the game
 *   shows exact minutes and one look orders the events.
 * @property {number} expiresAtMs After this a re-look can't help any more:
 *   the earliest mark of the pair has died (60 min lifetime), so the order
 *   is lost for good.
 */

/**
 * Detect the "come back and look again" situation for ONE player: a lit moon
 * whose 'newest' claim is blocked ONLY by a planet mark it can't be ordered
 * against (overlapping implied-interaction intervals — see the re-look
 * header section). Modes 'off'/'lone' never recheck (nothing to upgrade).
 *
 * @param {Array<{coord: string, bodyType: 1|3}>} bodies
 * @param {Record<string, import('./activityObs.js').ActivityObs[]> | undefined} rings
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 * @returns {LandingRecheck | null}
 */
export function detectLandingRecheck(bodies, rings, nowMs, opts = {}) {
  const mode = opts.mode ?? 'newest';
  if (mode === 'off' || mode === 'lone') return null;
  const sent = opts.sentMap || {};
  const states = (bodies || []).map((b) =>
    bodyState(b.coord, b.bodyType, rings ? rings[ringKeyFor(b.coord, b.bodyType)] : undefined, nowMs, sent, opts.sysLookSec || {}));

  const freshMoons = states.filter((s) => s.bodyType === 3 && s.cls === 'fresh' && !s.selfLit);
  if (!freshMoons.length) return null;
  const moon = freshMoons.reduce((a, b) =>
    (interactionInterval(/** @type {any} */ (b.pos)).hi > interactionInterval(/** @type {any} */ (a.pos)).hi ? b : a));
  const mIv = interactionInterval(/** @type {any} */ (moon.pos));

  // Planets whose mark OVERLAPS the moon's (neither strictly older nor
  // strictly newer) — the exact blocker of the 'newest' tier. A strictly
  // NEWER planet is not rechecked: the re-look would only re-confirm "the
  // owner moved last", which is already the no-strike verdict.
  let latestHiS = mIv.hi;
  let earliestLoS = mIv.lo;
  let overlapping = false;
  for (const o of states) {
    if (o === moon || o.bodyType !== 1 || o.cls !== 'fresh' || o.selfLit || !o.pos) continue;
    const iv = interactionInterval(o.pos);
    const older = iv.hi <= mIv.lo - SAME_TAU_SLACK_S;
    const newer = mIv.hi <= iv.lo - SAME_TAU_SLACK_S;
    if (older || newer) continue;
    overlapping = true;
    if (iv.hi > latestHiS) latestHiS = iv.hi;
    if (iv.lo < earliestLoS) earliestLoS = iv.lo;
  }
  if (!overlapping) return null;

  const readyAtMs = (latestHiS + FRESH_BAND_S + SAME_TAU_SLACK_S) * 1000;
  const expiresAtMs = earliestLoS * 1000 + MARKER_LIFE_MS;
  if (nowMs >= expiresAtMs) return null; // the order is already lost
  return { coord: moon.coord, bodyType: 3, readyAtMs, expiresAtMs };
}

/**
 * Run {@link detectLandingRecheck} across all watched players.
 * @param {string[]} players
 * @param {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 * @param {Record<string, Record<string, import('./activityObs.js').ActivityObs[]>>} ringsMap
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number>, mode?: MoonStrikeMode,
 *   sysLookSec?: Record<string, number> }} [opts]
 * @returns {Record<string, LandingRecheck>}
 */
export function detectAllRechecks(players, universePlanets, ringsMap, nowMs, opts = {}) {
  /** @type {Record<string, LandingRecheck>} */
  const out = {};
  if (opts.mode === 'off' || opts.mode === 'lone') return out;
  for (const pid of players || []) {
    /** @type {Array<{coord: string, bodyType: 1|3}>} */
    const bodies = [];
    for (const p of playerPlanets(universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      bodies.push({ coord, bodyType: 1 });
      if (p.hasMoon) bodies.push({ coord, bodyType: 3 });
    }
    const r = detectLandingRecheck(bodies, ringsMap ? ringsMap[pid] : undefined, nowMs, opts);
    if (r) out[pid] = r;
  }
  return out;
}
