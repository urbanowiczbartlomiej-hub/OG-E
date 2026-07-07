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
// "activity ≠ online" insight turned offensive:
//
//     exactly ONE body freshly active, it's a MOON, and every OTHER body we
//     looked at recently is quiet  ⇒  a mechanical event (a landing) on that
//     moon while the human is away.
//
// It is a NOW signal (the marker fades after ~1 h) and it is only a CANDIDATE —
// the marker also fires for a foreign attack/probe or a brief owner login, so
// the honest verb is "spy to confirm", never "fleet is there". A probe (one
// deliberate tap) confirms it; this module only RANKS/flags.
//
// # Honesty gates (structural)
//
//   - COVERAGE: we can only call the other bodies "quiet" if we LOOKED at them
//     recently. Bodies with a stale look (or none) are `unknown`, not quiet,
//     and they lower the coverage the caller displays — the tool never claims
//     more than it saw.
//   - SELF-INDUCED: our own probe lights the moon for the next hour. The ring
//     append already discounts probes whose send we recorded; this pass ALSO
//     skips a fresh body we probed within {@link SELF_WINDOW_MS} (belt + braces),
//     so the tool never flags its own scan as a landing.
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives from the caller.

import { playerPlanets } from './targets.js';
import { interactionInterval } from './activityObs.js';
import { ringKeyFor, overrideKeyFor } from './scanMode.js';

/** A body is "freshly active" only if we saw it active within this window (so
 * the reading reflects NOW, not an hours-old look). */
export const FRESH_LOOK_MS = 30 * 60 * 1000;
/** A quiet look counts as "quiet now" only if this recent (concurrency). */
export const QUIET_COVERAGE_MS = 60 * 60 * 1000;
/** A fresh body we probed within this window is our OWN light — not a landing. */
export const SELF_WINDOW_MS = 45 * 60 * 1000;
/** Coverage ratio at/above which the signal reads `strong` (else `medium`). */
export const STRONG_COVERAGE = 0.7;

/**
 * Classify one body from its activity ring at `nowMs`.
 *   - `fresh`   — newest look is positive (activity) AND recent ({@link FRESH_LOOK_MS}).
 *   - `quiet`   — newest look is a quiet "-1" AND recent ({@link QUIET_COVERAGE_MS}).
 *   - `unknown` — no ring, or the newest look is too old to speak for NOW.
 * @param {import('./activityObs.js').ActivityObs[] | undefined} ring
 * @param {number} nowMs
 * @returns {{ cls: 'fresh'|'quiet'|'unknown', activeAgeMs: number }}
 */
function classify(ring, nowMs) {
  if (!Array.isArray(ring) || !ring.length) return { cls: 'unknown', activeAgeMs: 0 };
  const last = ring[ring.length - 1];
  if (typeof last.t !== 'number' || typeof last.m !== 'number') return { cls: 'unknown', activeAgeMs: 0 };
  const lookAgeMs = nowMs - last.t * 1000;
  if (last.m >= 0) {
    if (lookAgeMs >= 0 && lookAgeMs <= FRESH_LOOK_MS) {
      return { cls: 'fresh', activeAgeMs: nowMs - interactionInterval(last).hi * 1000 };
    }
    return { cls: 'unknown', activeAgeMs: 0 };
  }
  if (lookAgeMs >= 0 && lookAgeMs <= QUIET_COVERAGE_MS) return { cls: 'quiet', activeAgeMs: 0 };
  return { cls: 'unknown', activeAgeMs: 0 };
}

/**
 * @typedef {object} FleetLandingSignal
 * @property {string} coord        "g:s:p" of the freshly-active moon.
 * @property {3} bodyType          Always a moon (the headline case).
 * @property {string} overrideKey  "g:s:p:3" — the plan boost / rescan key.
 * @property {number} freshAgeMs   How long ago the moon's implied interaction was.
 * @property {number} quiet        Other bodies confirmed quiet-recent.
 * @property {number} total        Other bodies total (coverage denominator).
 * @property {'strong'|'medium'} confidence  strong = most others confirmed quiet.
 */

/**
 * Detect the FS-landing signature for ONE player. Returns null unless EXACTLY
 * one body is fresh-active, it's a moon, and ≥1 other body is recently-seen
 * quiet. A fresh body we probed ourselves recently is skipped (self-induced).
 *
 * @param {Array<{coord: string, bodyType: 1|3}>} bodies  the player's bodies.
 * @param {Record<string, import('./activityObs.js').ActivityObs[]> | undefined} rings
 *   this player's activity rings (ringKey → ring).
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number> }} [opts]  our recent probe sends
 *   (overrideKey → epoch ms) for the self-induced skip.
 * @returns {FleetLandingSignal | null}
 */
export function detectFleetLanding(bodies, rings, nowMs, opts = {}) {
  const sent = opts.sentMap || {};
  /** @type {Array<{coord: string, bodyType: 1|3, activeAgeMs: number}>} */
  const fresh = [];
  let quiet = 0;
  for (const b of bodies || []) {
    const c = classify(rings ? rings[ringKeyFor(b.coord, b.bodyType)] : undefined, nowMs);
    if (c.cls === 'fresh') {
      const sentAt = sent[overrideKeyFor(b.coord, b.bodyType)];
      if (sentAt && nowMs - sentAt < SELF_WINDOW_MS) continue; // our own probe lit it
      fresh.push({ coord: b.coord, bodyType: b.bodyType, activeAgeMs: c.activeAgeMs });
    } else if (c.cls === 'quiet') {
      quiet += 1;
    }
  }
  if (fresh.length !== 1) return null;      // a lone blip is the signal; 0 or 2+ isn't
  const f = fresh[0];
  if (f.bodyType !== 3) return null;        // moons only (fleet-saves land on moons)
  if (quiet < 1) return null;               // need evidence the player is otherwise away
  const totalOthers = Math.max(0, bodies.length - 1);
  const ratio = totalOthers > 0 ? quiet / totalOthers : 0;
  return {
    coord: f.coord,
    bodyType: 3,
    overrideKey: overrideKeyFor(f.coord, 3),
    freshAgeMs: f.activeAgeMs,
    quiet,
    total: totalOthers,
    confidence: ratio >= STRONG_COVERAGE ? 'strong' : 'medium',
  };
}

/**
 * Run {@link detectFleetLanding} across all watched players.
 * @param {string[]} players
 * @param {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 * @param {Record<string, Record<string, import('./activityObs.js').ActivityObs[]>>} ringsMap
 * @param {number} nowMs
 * @param {{ sentMap?: Record<string, number> }} [opts]
 * @returns {Record<string, FleetLandingSignal>}
 */
export function detectAllLandings(players, universePlanets, ringsMap, nowMs, opts = {}) {
  /** @type {Record<string, FleetLandingSignal>} */
  const out = {};
  for (const pid of players || []) {
    /** @type {Array<{coord: string, bodyType: 1|3}>} */
    const bodies = [];
    for (const p of playerPlanets(universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      bodies.push({ coord, bodyType: 1 });
      if (p.hasMoon) bodies.push({ coord, bodyType: 3 });
    }
    const sig = detectFleetLanding(bodies, ringsMap ? ringsMap[pid] : undefined, nowMs, opts);
    if (sig) out[pid] = sig;
  }
  return out;
}

/**
 * The set of override keys ("g:s:p:3") flagged this tick — what the scan plan
 * boosts. Convenience over {@link detectAllLandings}'s map.
 * @param {Record<string, FleetLandingSignal>} signals
 * @returns {Set<string>}
 */
export const strikeKeysOf = (signals) => new Set(Object.values(signals || {}).map((s) => s.overrideKey));
