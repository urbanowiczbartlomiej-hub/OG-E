// @ts-check

// Pure galaxy-watch logic (SPYGLASS-PASSIVE-PLAN) — the passive-observation
// counterpart to the probe scan plan. Galaxy activity is observed for EVERY
// watched body (planet + moon), always, by the player BROWSING its galaxy
// system (undetectable by the target: no espionage log entry, no
// counter-espionage); the LOOK PLAN below can be muted per player via the
// watch-list `galaxyMode` toggle (proposals stop, recording never does).
// The COVERAGE-freshness source is the galaxy-view activity
// ring (state/activityObs) — its NEWEST entry time, of ANY marker including a
// "-1" quiet look, because a look is a look whether or not it saw activity.
//
// Two distinct questions this module answers, kept separate on purpose:
//   - "should we LOOK at this system again?" → coverage staleness
//     (`galaxySightStatus` / `buildGalaxyPlan`), keyed on the last-LOOK time.
//   - "when was this body last ACTIVE?" → `bodyActivityReadout`, keyed on the
//     positive markers' implied INTERACTION time — NOT the look time (a recent
//     quiet look means "inactive ≥1 h at that look", not "active just now").
//
// This module only PROPOSES (like scanPriority): it groups needs-look bodies by
// system so one navigation covers every watched body there, and ranks the
// systems. The one deliberate tap-per-navigation stays the only thing that ever
// drives the game (fair-play: 1 tap = 1 navigation, no auto-paging).
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives in the env.

import { playerPlanets } from './targets.js';
import { scanStatus, needsScan, rescanAtFor } from './spyScan.js';
import { dangerWeight, stalenessWeight } from './scanPriority.js';
import { ringKeyFor, overrideKeyFor } from './scanMode.js';
import { interactionInterval } from './activityObs.js';

/** @typedef {import('./activityObs.js').ActivityObs} ActivityObs */

const DAY_MS = 24 * 3600 * 1000;

/**
 * Newest sighting time of a body (epoch SECONDS) from its activity ring, or 0
 * when never sighted. The ring is oldest→newest, so the last entry is newest;
 * ANY marker counts (a "-1" quiet look still proves we looked). This is
 * COVERAGE (when did we last look), NOT activity — see {@link bodyActivityReadout}.
 * @param {ActivityObs[] | undefined} ring
 * @returns {number}
 */
export const lastSightSec = (ring) => {
  if (!Array.isArray(ring) || !ring.length) return 0;
  const t = ring[ring.length - 1].t;
  return Number.isFinite(t) && t > 0 ? t : 0;
};

/**
 * A body's HONEST activity readout from its ring.
 * @typedef {object} ActivityReadout
 * @property {number} [lastActiveSec]  Implied time (epoch s) of the most recent
 *   INTERACTION across the ring's positive markers; absent when none was ever
 *   seen (only quiet looks, or no ring).
 * @property {number} [lastLookSec]    Newest look time (any marker); absent when
 *   no ring.
 * @property {number} [quietSinceSec]  OLDEST look time — set only when the ring
 *   holds looks but NO positive marker ever (hits = 0): "quiet at every look
 *   since here". Drives the ">Nh" no-activity readout (a claim about our
 *   observations — activity between looks can't be ruled out).
 * @property {boolean} quietNow        The newest look saw NO activity (m < 0).
 * @property {number} looks            Total observations in the ring.
 * @property {number} hits             Observations that saw activity (m ≥ 0).
 */

/**
 * Summarise a body's activity ring into a truthful last-active readout — the
 * fix for the "<1 h" bug. A quiet look (m = −1) means "inactive for ≥60 min AT
 * that look", NOT "active just now", so last-active is derived from the POSITIVE
 * markers' implied interaction time (`interactionInterval().hi`), never from the
 * look time. When only quiet looks exist, `lastActiveSec` is absent (we don't
 * know when they were last active — only that they were quiet each time we
 * looked); the caller must then show "no activity seen", not a small number.
 * @param {ActivityObs[] | undefined} ring
 * @returns {ActivityReadout}
 */
export const bodyActivityReadout = (ring) => {
  if (!Array.isArray(ring) || !ring.length) {
    return { quietNow: false, looks: 0, hits: 0 };
  }
  /** @type {number | undefined} */
  let lastActiveSec;
  let hits = 0;
  for (const o of ring) {
    if (typeof o.t !== 'number' || typeof o.m !== 'number') continue;
    if (o.m < 0) continue;
    hits += 1;
    const hi = interactionInterval(o).hi;
    if (lastActiveSec === undefined || hi > lastActiveSec) lastActiveSec = hi;
  }
  const last = ring[ring.length - 1];
  return {
    ...(lastActiveSec !== undefined ? { lastActiveSec } : {}),
    lastLookSec: last.t,
    // Never any positive → "quiet since the first look" (the ">Nh" bound).
    ...(hits === 0 ? { quietSinceSec: ring[0].t } : {}),
    quietNow: last.m < 0,
    looks: ring.length,
    hits,
  };
};

/**
 * Freshness of a galaxy-watched body — the sighting analogue of
 * `spyScan.scanStatus`, delegating to it with the last-sight time as the
 * "report" time. `none` = never sighted, `fresh` = sighted within cadence,
 * `stale` = sighting older than cadence, `rescan` = ↻ requested after the last
 * sighting (a ↻ works regardless of mode).
 * @param {object} a
 * @param {number} [a.lastSightSec]
 * @param {number} a.nowMs
 * @param {number} [a.rescanAtMs]
 * @param {number} a.staleMs
 * @returns {'none'|'fresh'|'stale'|'rescan'}
 */
export const galaxySightStatus = ({ lastSightSec: sec, nowMs, rescanAtMs = 0, staleMs }) => (
  scanStatus({ reportTsSec: sec, nowMs, rescanAtMs, staleMs })
);

/**
 * @typedef {object} GalaxyPlanEnv
 * @property {string[]} players     Watched player ids (tiebreak order).
 * @property {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 *   universe.xml occupancy rows (same shape scanPriority consumes).
 * @property {Record<string, Record<string, ActivityObs[]>>} [rings]
 *   playerId → ringKey ("g:s:p:type") → activity ring (state/activityObs).
 * @property {Record<string, number>} [rescan]   player id / override key → mark (ms).
 * @property {number} nowMs
 * @property {number} staleMs       Galaxy-look stale threshold (cadence.galaxyHours in ms).
 * @property {Record<string, number>} [dangerByPlayer]   playerId → D (0..100).
 * @property {Record<string, import('./scanMode.js').ScanMode>} [galaxyMode]
 *   Per-player galaxy-watch toggle (watchList `galaxyMode`, player-id keys):
 *   'off' drops the player's bodies from the LOOK plan (the dossier's "Watch
 *   via → galaxy" button). Recording stays always-on — sightings the user
 *   browses past still accrue; only the proposals stop.
 * @property {Record<string, import('./fleetLanding.js').LandingRecheck>} [rechecks]
 *   Per-player ambiguous-moon re-look windows (fleetLanding.detectAllRechecks).
 *   While a window is OPEN (readyAt ≤ now < expiresAt) the moon's system is
 *   force-included and boosted to {@link RECHECK_BOOST} — one look there now
 *   reads exact minutes and settles the moon-vs-planet order the 'newest'
 *   strike tier needs. Fresh coverage does NOT suppress it (we just looked;
 *   that is exactly why it is ambiguous).
 *
 * Note: NO probe scan-mode / scan-bodies filter — a galaxy look is per-system
 * and covers planet + moon alike, so body-type prefs don't apply here.
 */

/**
 * Priority of a re-look entry: far above any staleness-driven look or normal
 * probe entry (those top out ~1.3), deliberately BELOW a live strike's
 * {@link import('./scanPriority.js').STRIKE_BOOST} — a confirmed-enough
 * landing to probe beats a maybe to re-look.
 */
export const RECHECK_BOOST = 50;

/**
 * One ranked galaxy-look entry — a whole SYSTEM (one navigation refreshes every
 * galaxy-watched body in it).
 * @typedef {object} GalaxyPlanEntry
 * @property {number} galaxy
 * @property {number} system
 * @property {string} label   "g:s"
 * @property {Array<{playerId: string, position: number, bodyType: 1|3,
 *   status: 'none'|'stale'|'rescan'}>} bodies   needs-sight bodies here.
 * @property {'none'|'stale'|'rescan'} worst   worst member status (display).
 * @property {number} priority
 * @property {string} why
 * @property {boolean} [recheck]  An ambiguous-moon re-look window is open in
 *   this system (see env.rechecks) — the FAB words the look accordingly.
 */

/**
 * Rank every system that hosts a needs-sight galaxy-watched body, by the max
 * over its member bodies of danger × staleness. Grouping by system is the whole
 * point: the FAB proposes `entries[0]` and the user navigates there ONCE,
 * refreshing the planet, its moon, and any other watched body in that system.
 * Deterministic: priority desc, then galaxy→system.
 *
 * @param {GalaxyPlanEnv} env
 * @returns {{ entries: GalaxyPlanEntry[] }}
 */
export const buildGalaxyPlan = (env) => {
  const players = env.players || [];

  // Per-SYSTEM newest sighting across every watched body there. ONE galaxy look
  // records every body the game shows in that system, so a system we just
  // looked at is "covered" even for a watched body that left NO ring entry — an
  // empty/relocated slot (the player moved) or an activity encoding
  // `parseActivity` doesn't record. Without this, such a body's own ring never
  // advances (`lastSightSec` = 0 → status 'none'), so the FAB would re-propose
  // the system on every rebuild, forever, no matter how often it's looked at.
  // (galaxyMode 'off' is NOT skipped here: mute suppresses proposals, not the
  // fact that a look happened — coverage is about "did we look".)
  /** @type {Map<string, number>} "g:s" → newest sight sec */
  const sysLastSight = new Map();
  for (const pid of players) {
    const ringsForPid = env.rings ? env.rings[pid] : undefined;
    if (!ringsForPid) continue;
    for (const p of playerPlanets(env.universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      let best = lastSightSec(ringsForPid[ringKeyFor(coord, 1)]);
      if (p.hasMoon) best = Math.max(best, lastSightSec(ringsForPid[ringKeyFor(coord, 3)]));
      if (best > 0) {
        const k = `${p.galaxy}:${p.system}`;
        if (best > (sysLastSight.get(k) || 0)) sysLastSight.set(k, best);
      }
    }
  }

  /**
   * Per-system accumulator (loose — the ranked {@link GalaxyPlanEntry} with its
   * worst/why/priority is derived once at the end).
   * @typedef {{ galaxy: number, system: number, label: string,
   *   bodies: GalaxyPlanEntry['bodies'], score: number, recheck?: boolean }} SysAcc
   */
  /** @type {Map<string, SysAcc>} */
  const bySystem = new Map();

  for (const pid of players) {
    // Galaxy watch toggled off for this player (Watch via) → no look proposals.
    if (env.galaxyMode && env.galaxyMode[pid] === 'off') continue;
    const ringsForPid = env.rings ? env.rings[pid] : undefined;
    const d100 = env.dangerByPlayer ? env.dangerByPlayer[pid] : undefined;
    const wDanger = dangerWeight(d100);

    /**
     * @param {1|3} bodyType
     * @param {import('./targets.js').PlanetPos} p
     * @returns {void}
     */
    const consider = (bodyType, p) => {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      const overrideKey = overrideKeyFor(coord, bodyType);
      const ring = ringsForPid ? ringsForPid[ringKeyFor(coord, bodyType)] : undefined;
      // Effective coverage = this body's own last sight OR the newest look at
      // its whole system (one navigation covers the system — see sysLastSight),
      // so a body the look couldn't record still clears once the system is seen.
      const sec = Math.max(lastSightSec(ring), sysLastSight.get(`${p.galaxy}:${p.system}`) || 0);
      const status = galaxySightStatus({
        lastSightSec: sec,
        nowMs: env.nowMs,
        rescanAtMs: rescanAtFor(env.rescan, pid, overrideKey),
        staleMs: env.staleMs,
      });
      if (!needsScan(status)) return;

      const ageMs = sec ? env.nowMs - sec * 1000 : 0;
      const bodyScore = wDanger * stalenessWeight(status, ageMs, env.staleMs);

      const sysKey = `${p.galaxy}:${p.system}`;
      let acc = bySystem.get(sysKey);
      if (!acc) {
        acc = { galaxy: p.galaxy, system: p.system, label: sysKey, bodies: [], score: 0 };
        bySystem.set(sysKey, acc);
      }
      acc.bodies.push({
        playerId: pid, position: p.position, bodyType, status: /** @type {'none'|'stale'|'rescan'} */ (status),
      });
      if (bodyScore > acc.score) acc.score = bodyScore;
    };

    for (const p of playerPlanets(env.universePlanets, pid)) {
      consider(1, p);
      if (p.hasMoon) consider(3, p);
    }
  }

  // Re-look nudge: force-include each system whose ambiguous-moon window is
  // OPEN, at RECHECK_BOOST. Runs after the staleness pass on purpose — fresh
  // coverage must not suppress it (see the env.rechecks doc).
  if (env.rechecks) {
    for (const [pid, r] of Object.entries(env.rechecks)) {
      if (env.nowMs < r.readyAtMs || env.nowMs >= r.expiresAtMs) continue;
      if (env.galaxyMode && env.galaxyMode[pid] === 'off') continue;
      const m = /^(\d+):(\d+):(\d+)$/.exec(r.coord);
      if (!m) continue;
      const galaxy = Number(m[1]);
      const system = Number(m[2]);
      const position = Number(m[3]);
      const sysKey = `${galaxy}:${system}`;
      let acc = bySystem.get(sysKey);
      if (!acc) {
        acc = { galaxy, system, label: sysKey, bodies: [], score: 0 };
        bySystem.set(sysKey, acc);
      }
      acc.recheck = true;
      if (!acc.bodies.some((b) => b.playerId === pid && b.position === position && b.bodyType === 3)) {
        acc.bodies.push({ playerId: pid, position, bodyType: 3, status: 'rescan' });
      }
      if (RECHECK_BOOST > acc.score) acc.score = RECHECK_BOOST;
    }
  }

  /** @type {GalaxyPlanEntry[]} */
  const entries = [...bySystem.values()].map((e) => {
    // worst = the most-urgent member status for the display band
    // (never > rescan > stale), independent of the numeric score.
    const rank = { none: 3, rescan: 2, stale: 1 };
    let worst = /** @type {'none'|'stale'|'rescan'} */ (e.bodies[0].status);
    for (const b of e.bodies) if (rank[b.status] > rank[worst]) worst = b.status;
    const n = e.bodies.length;
    const label = worst === 'none' ? 'never sighted' : worst === 'rescan' ? 're-sight' : 'stale sighting';
    return {
      galaxy: e.galaxy,
      system: e.system,
      label: e.label,
      bodies: e.bodies,
      worst,
      priority: e.score,
      why: e.recheck
        ? 'moon order? · marks readable now'
        : `${n} ${n === 1 ? 'body' : 'bodies'} · ${label}`,
      ...(e.recheck ? { recheck: true } : {}),
    };
  });

  entries.sort((a, b) => (
    b.priority - a.priority || a.galaxy - b.galaxy || a.system - b.system
  ));
  return { entries };
};

/**
 * Convenience: galaxy stale threshold (ms) from a cadence's `galaxyHours`.
 * @param {{ galaxyHours?: number }} [cadence]
 * @returns {number}
 */
export const galaxyStaleMs = (cadence) => {
  const gh = cadence ? cadence.galaxyHours : undefined;
  const h = typeof gh === 'number' && Number.isFinite(gh) && gh > 0 ? gh : 24;
  return h * 3600 * 1000;
};

export { DAY_MS };
