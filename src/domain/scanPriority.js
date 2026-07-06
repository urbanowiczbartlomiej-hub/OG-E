// @ts-check

// Scan-plan priority (SPYGLASS-REDESIGN.md §6.7) — the pure ranking BOTH
// surfaces share: the dashboard's "suggested scan order" strip and the
// in-game Spy FAB (which proposes exactly the top entry, so the two never
// disagree about "what's next"). Ranking only — this module PROPOSES; the one
// deliberate in-game tap per probe stays the only thing that ever sends
// (fair-play: one-tap-one-send, no queue semantics anywhere).
//
//   priority(planet) = dangerWeight(D) × stalenessWeight(status, age) × windowBonus
//
//   - dangerWeight    — a dangerous target's intel is worth more (0.3..1.0,
//                       never 0: even a quiet player deserves an eventual scan).
//   - stalenessWeight — never-scanned first, explicit re-scan requests next,
//                       then stale reports ramping up as they age; fresh = 0
//                       (excluded — nothing to learn).
//   - windowBonus     — a gentle ×1.3 re-rank when NOW falls inside the
//                       target's observed activity window (≥ pattern gate).
//                       Passive re-ordering only: never a toast, never a
//                       timer, framed "good moment, based on intel you
//                       gathered" (§8 wording discipline).
//
// Per-player cadence (staleMsFor) spends `deriveSpy`'s plumbed-but-unused
// staleMs: hot targets (high D) go stale sooner, so the plan naturally
// rotates through the dangerous ones more often.
//
// Pure: no DOM, no storage, no Date.now() — `nowMs` arrives in the env.

import { playerPlanets } from './targets.js';
import { scanStatus, needsScan, rescanAtFor, SPY_STALE_MS } from './spyScan.js';

/** @typedef {import('./routine.js').ActivitySummary} ActivitySummary */

const DAY_MS = 24 * 3600 * 1000;
/** Re-scan cadence by danger: hot targets go stale sooner (§6.7). */
export const STALE_HOT_MS = 2 * DAY_MS;
export const STALE_WARM_MS = 4 * DAY_MS;
/** D thresholds for the cadence tiers. */
const HOT_D = 60;
const WARM_D = 30;
/** Danger weight floor/scale: 0.3 + 0.7·(D/100). */
const DANGER_FLOOR = 0.3;
/** Assumed mid danger when a player's D is unknown (no API profile yet). */
const DANGER_UNKNOWN = 50;
/** Staleness weights (never > rescan > stale-ramp; fresh excluded). */
const W_NEVER = 1.0;
const W_RESCAN = 0.9;
const W_STALE_BASE = 0.3;
/** Stale age ramp: +0.2 per full staleMs beyond the threshold, capped. */
const W_STALE_RAMP = 0.2;
const W_STALE_CAP = 0.9;
/** The "good moment" multiplier when NOW is inside the activity window. */
export const WINDOW_BONUS = 1.3;

/**
 * Stale threshold for a player of danger D (0..100). Unknown D → the default
 * 7-day {@link SPY_STALE_MS}.
 * @param {number | undefined} d100
 * @returns {number}
 */
export const staleMsFor = (d100) => {
  if (typeof d100 !== 'number' || !Number.isFinite(d100)) return SPY_STALE_MS;
  if (d100 >= HOT_D) return STALE_HOT_MS;
  if (d100 >= WARM_D) return STALE_WARM_MS;
  return SPY_STALE_MS;
};

/**
 * Danger multiplicand: 0.3 (harmless) .. 1.0 (D=100). Unknown D sits mid-scale
 * so profiled players order around it instead of dominating or vanishing.
 * @param {number | undefined} d100
 * @returns {number}
 */
export const dangerWeight = (d100) => {
  const d = typeof d100 === 'number' && Number.isFinite(d100)
    ? Math.max(0, Math.min(100, d100))
    : DANGER_UNKNOWN;
  return DANGER_FLOOR + (1 - DANGER_FLOOR) * (d / 100);
};

/**
 * Staleness multiplicand — see the constants above. `fresh` returns 0 (the
 * planet is excluded from the plan entirely).
 * @param {'none'|'fresh'|'stale'|'rescan'} status
 * @param {number} ageMs    Age of the newest report (only read for 'stale').
 * @param {number} staleMs  The player's stale threshold.
 * @returns {number}
 */
export const stalenessWeight = (status, ageMs, staleMs) => {
  if (status === 'none') return W_NEVER;
  if (status === 'rescan') return W_RESCAN;
  if (status === 'stale') {
    const over = staleMs > 0 ? Math.max(0, ageMs / staleMs - 1) : 0;
    return Math.min(W_STALE_CAP, W_STALE_BASE + over * W_STALE_RAMP);
  }
  return 0;
};

/**
 * ×{@link WINDOW_BONUS} when the local hour of `nowMs` falls inside the
 * player's observed activity peak (≥ pattern gate — a hint never re-ranks).
 * Purely a re-ordering nudge; the copy around it must read "good moment,
 * based on intel you gathered" (§8) — never "due"/"scheduled".
 * @param {number} nowMs
 * @param {ActivitySummary} [activity]
 * @returns {number}
 */
export const windowBonus = (nowMs, activity) => {
  if (!activity || !activity.peak) return 1;
  if (activity.gate !== 'pattern' && activity.gate !== 'strong') return 1;
  const h = new Date(nowMs).getHours();
  const { startH, endH } = activity.peak;
  const inside = startH <= endH ? h >= startH && h <= endH : h >= startH || h <= endH;
  return inside ? WINDOW_BONUS : 1;
};

/**
 * @typedef {object} ScanPlanEnv
 * @property {string[]} players                Watched player ids (tiebreak order).
 * @property {Array<{coords: string, player?: number, hasMoon?: boolean}>} universePlanets
 *   universe.xml occupancy rows (each watched player's planet coords + a
 *   `hasMoon` flag when the slot also carries a moon).
 * @property {Record<string, Record<string, number>>} spiedByPlayer
 *   playerId → ("g:s:p" coord → newest PLANET report ts, epoch SECONDS).
 * @property {Record<string, Record<string, number>>} [spiedMoonsByPlayer]
 *   playerId → ("g:s:p" coord → newest MOON report ts, epoch SECONDS). Absent =
 *   no moon scans on file (every enabled moon then ranks as never-scanned).
 * @property {Record<string, number>} [rescan]  player id / coord → re-scan mark (ms).
 * @property {Set<string>} [sentCoords]         Bodies probed this session (skip);
 *   moons are keyed `"g:s:p:3"`, planets `"g:s:p"`.
 * @property {number} nowMs
 * @property {'planets'|'moons'|'both'} [scanBodies]  Which body types to plan
 *   (default 'planets').
 * @property {number} [staleMs]                 Default stale threshold override.
 * @property {Record<string, number>} [dangerByPlayer]   playerId → D (0..100).
 * @property {Record<string, ActivitySummary>} [activityByPlayer]
 *   playerId → routine activity summary (drives {@link windowBonus}).
 */

/**
 * One ranked entry of the scan plan.
 * @typedef {object} ScanPlanEntry
 * @property {string} playerId
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {1|3} bodyType   Body to scan: 1 = planet, 3 = moon.
 * @property {'none'|'stale'|'rescan'} status
 * @property {number} priority
 * @property {string} why   Compact, wording-safe reason ("never scanned",
 *   "report 9d old", "re-scan requested", "+ good moment (activity window)").
 */

/**
 * Rank every needs-scan planet across the watched players by
 * danger × staleness × windowBonus. Deterministic: priority desc, then
 * watch-list order, then galaxy→system→position — so the FAB's proposal is
 * exactly `entries[0]` and the dashboard strip shows the same order.
 *
 * @param {ScanPlanEnv} env
 * @returns {{ entries: ScanPlanEntry[] }}
 */
export const buildScanPlan = (env) => {
  const players = env.players || [];
  /** @type {ScanPlanEntry[]} */
  const entries = [];
  /** @type {Map<string, number>} */
  const orderByPid = new Map();
  players.forEach((pid, i) => orderByPid.set(pid, i));

  const scanBodies = env.scanBodies || 'planets';
  const wantPlanets = scanBodies !== 'moons';
  const wantMoons = scanBodies !== 'planets';

  for (const pid of players) {
    const coordTs = env.spiedByPlayer ? env.spiedByPlayer[pid] : undefined;
    const moonTs = env.spiedMoonsByPlayer ? env.spiedMoonsByPlayer[pid] : undefined;
    const d100 = env.dangerByPlayer ? env.dangerByPlayer[pid] : undefined;
    const staleMs = env.dangerByPlayer && pid in env.dangerByPlayer
      ? staleMsFor(d100)
      : env.staleMs ?? SPY_STALE_MS;
    const wDanger = dangerWeight(d100);
    const wWindow = windowBonus(env.nowMs, env.activityByPlayer
      ? env.activityByPlayer[pid]
      : undefined);

    /**
     * Consider one body (planet or moon) at a coord; push a plan entry if it
     * needs a scan and wasn't already sent this session. Planet and moon read
     * their OWN freshness map + sent-key so scanning one never suppresses the
     * other.
     * @param {1|3} bodyType
     * @param {import('./targets.js').PlanetPos} p
     * @param {Record<string, number> | undefined} tsMap
     * @returns {void}
     */
    const consider = (bodyType, p, tsMap) => {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      const sentK = bodyType === 3 ? `${coord}:3` : coord;
      if (env.sentCoords && env.sentCoords.has(sentK)) return;
      const reportTsSec = tsMap ? tsMap[coord] : undefined;
      const status = scanStatus({
        reportTsSec,
        nowMs: env.nowMs,
        rescanAtMs: rescanAtFor(env.rescan, pid, coord),
        staleMs,
      });
      if (!needsScan(status)) return;
      const ageMs = reportTsSec ? env.nowMs - reportTsSec * 1000 : 0;
      const priority = wDanger * stalenessWeight(status, ageMs, staleMs) * wWindow;
      const whyParts = [];
      if (bodyType === 3) whyParts.push('moon');
      if (status === 'none') whyParts.push('never scanned');
      else if (status === 'rescan') whyParts.push('re-scan requested');
      else whyParts.push(`report ${Math.max(1, Math.round(ageMs / DAY_MS))}d old`);
      if (typeof d100 === 'number') whyParts.push(`D ${Math.round(d100)}`);
      if (wWindow > 1) whyParts.push('good moment (activity window, from intel you gathered)');
      entries.push({
        playerId: pid,
        galaxy: p.galaxy,
        system: p.system,
        position: p.position,
        bodyType,
        status: /** @type {'none'|'stale'|'rescan'} */ (status),
        priority,
        why: whyParts.join(' · '),
      });
    };

    for (const p of playerPlanets(env.universePlanets, pid)) {
      if (wantPlanets) consider(1, p, coordTs);
      if (wantMoons && p.hasMoon) consider(3, p, moonTs);
    }
  }

  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const oa = orderByPid.get(a.playerId) ?? 0;
    const ob = orderByPid.get(b.playerId) ?? 0;
    if (oa !== ob) return oa - ob;
    return a.galaxy - b.galaxy || a.system - b.system || a.position - b.position
      || a.bodyType - b.bodyType;
  });
  return { entries };
};
