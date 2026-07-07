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
import { effectiveScan, overrideKeyFor } from './scanMode.js';

/** @typedef {import('./routine.js').ActivitySummary} ActivitySummary */
/** @typedef {import('./scanMode.js').ScanMode} ScanMode */
/**
 * The probe-cadence fields of the watch-list cadence (see state/watchList
 * Cadence) — typed structurally so the domain floor never imports state. The
 * optional `galaxyHours` rides along so the SAME config object also feeds
 * galaxyWatch.galaxyStaleMs (this module only reads the day fields).
 * @typedef {{ hotDays: number, warmDays: number, coldDays: number, galaxyHours?: number }} ProbeCadence
 */

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
 * Priority floor for a STRIKE body (a fresh fleet-landing candidate,
 * domain/fleetLanding). Far above any normal entry (which top out ~1.3), so a
 * strike always becomes `entries[0]` — the FAB proposes spying that moon NOW.
 * Additive with dangerWeight so multiple strikes still order by danger.
 */
export const STRIKE_BOOST = 100;

/**
 * Stale threshold for a player of danger D (0..100). When a {@link ProbeCadence}
 * is supplied its hot/warm/cold day fields drive the tiers (the user-configured
 * cadence); without one the module falls back to the hardcoded defaults, so
 * every existing caller is unchanged. Unknown D uses the cold/default tier.
 * @param {number | undefined} d100
 * @param {ProbeCadence} [cadence]
 * @returns {number}
 */
export const staleMsFor = (d100, cadence) => {
  const cold = cadence ? cadence.coldDays * DAY_MS : SPY_STALE_MS;
  if (typeof d100 !== 'number' || !Number.isFinite(d100)) return cold;
  if (d100 >= HOT_D) return cadence ? cadence.hotDays * DAY_MS : STALE_HOT_MS;
  if (d100 >= WARM_D) return cadence ? cadence.warmDays * DAY_MS : STALE_WARM_MS;
  return cold;
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
 * @property {ProbeCadence} [cadence]           User-configured probe cadence
 *   (drives {@link staleMsFor}); absent → hardcoded default tiers.
 * @property {Record<string, ScanMode>} [scanMode]  Scan-mode map — bodies whose
 *   effective scan is 'off' are excluded from the probe plan (their galaxy
 *   activity is still tracked always-on, via domain/galaxyWatch).
 * @property {Set<string>} [strikeCoords]  Override keys ("g:s:p:3") flagged as
 *   fresh fleet-landing candidates (domain/fleetLanding). A strike body is
 *   FORCE-INCLUDED (even past the scan-bodies filter and the freshness gate —
 *   an old report predates the landing) and boosted to the top, so the FAB
 *   proposes spying it NOW. Still respects scan-'off' (an explicit "don't probe
 *   this player" wins; the dashboard flag still shows).
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
 * @property {boolean} [strike]  A fresh fleet-landing candidate (force-included +
 *   boosted). The FAB paints this proposal distinctly.
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
      ? staleMsFor(d100, env.cadence)
      : env.staleMs ?? staleMsFor(undefined, env.cadence);
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
      const sentK = overrideKeyFor(coord, bodyType);
      // Scan-off bodies are excluded from the probe plan (their galaxy activity
      // is still tracked always-on) — even a strike respects an explicit
      // "don't probe this player" (the dashboard flag still shows). The
      // override key ("g:s:p" / "g:s:p:3") is exactly the sent/rescan key shape.
      if (effectiveScan(env.scanMode, pid, sentK) === 'off') return;
      if (env.sentCoords && env.sentCoords.has(sentK)) return;
      const strike = !!(env.strikeCoords && env.strikeCoords.has(sentK));
      const reportTsSec = tsMap ? tsMap[coord] : undefined;
      const status = scanStatus({
        reportTsSec,
        nowMs: env.nowMs,
        // Each body reads its OWN rescan key (planet "g:s:p", moon "g:s:p:3" —
        // the same shape as the sent-key): a planet's re-scan flag must not
        // drag its moon back into the plan, and the dossier's moon ↻ writes
        // the ":3" key. The player-id mark still covers both bodies.
        rescanAtMs: rescanAtFor(env.rescan, pid, sentK),
        staleMs,
      });
      // A strike bypasses the freshness gate: any report predates the landing,
      // so even a 'fresh' one is stale intel now.
      if (!strike && !needsScan(status)) return;
      const ageMs = reportTsSec ? env.nowMs - reportTsSec * 1000 : 0;
      const priority = strike
        ? STRIKE_BOOST + wDanger
        : wDanger * stalenessWeight(status, ageMs, staleMs) * wWindow;
      // Terse by design — the strip row was drowning in prose ("re-scan
      // requested · good moment (activity window, from intel you gathered)").
      // No 'moon' word either: the renderer already prints 🌙 after the coords.
      const whyParts = [];
      if (strike) whyParts.push('🎯 fresh landing?');
      else if (status === 'none') whyParts.push('never scanned');
      else if (status === 'rescan') whyParts.push('re-scan');
      else whyParts.push(`${Math.max(1, Math.round(ageMs / DAY_MS))}d old`);
      if (typeof d100 === 'number') whyParts.push(`D ${Math.round(d100)}`);
      if (!strike && wWindow > 1) whyParts.push('good moment');
      entries.push({
        playerId: pid,
        galaxy: p.galaxy,
        system: p.system,
        position: p.position,
        bodyType,
        status: /** @type {'none'|'stale'|'rescan'} */ (status === 'fresh' ? 'rescan' : status),
        priority,
        ...(strike ? { strike: true } : {}),
        why: whyParts.join(' · '),
      });
    };

    for (const p of playerPlanets(env.universePlanets, pid)) {
      if (wantPlanets) consider(1, p, coordTs);
      // Moons enter when the filter wants them OR a strike forces this moon in
      // (you always want to spy a fresh-landing moon, whatever your filter).
      const moonStrike = !!(env.strikeCoords && env.strikeCoords.has(`${p.galaxy}:${p.system}:${p.position}:3`));
      if ((wantMoons || moonStrike) && p.hasMoon) consider(3, p, moonTs);
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
