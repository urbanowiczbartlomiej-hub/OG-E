// @ts-check

// The ONE recipe that turns the per-universe API cache (+ the spy-report
// store) into per-player DangerProfiles. Extracted from the dashboard's
// loadAll so the in-game side (features/apiContext) can build the IDENTICAL
// profiles for the scan planner — the Spy FAB must walk exactly the order the
// dashboard's plan strip shows (§6.7), and that only holds if both sides
// compute D from one function. Same de-drift rationale as lib/dangerColor.js,
// one layer down.
//
// Pure join over plain data: callers pass their own reads (the dashboard reads
// raw per-universe keys for the SELECTED universe; the in-game side passes the
// live caches for the CURRENT one). No DOM, no storage, no time.

import { buildDangerProfiles } from './dangerScore.js';
import { estimateHiddenFleet } from './threatModel.js';
import { latestOf } from './targetReports.js';

/**
 * The slice of `state/apiCache.js`'s shape this join reads. Every field is
 * optional — a cold cache degrades to prior-only profiles, exactly like the
 * dashboard behaves before the in-game side populates the cache.
 * @typedef {object} DangerJoinApiCache
 * @property {{ planets: Array<{coords: string, player?: number, hasMoon?: boolean}> }} [universe]
 * @property {{ players: Record<string, {alliance?: string, status?: string}> }} [players]
 * @property {{ ranks: Record<string, {score?: number, ships?: number}> }} [military]
 * @property {{ ranks: Record<string, {score?: number}> }} [destroyed]
 * @property {{ ranks: Record<string, {position?: number, score?: number}> }} [honor]
 */

/**
 * @param {object} a
 * @param {DangerJoinApiCache} a.apiCache
 * @param {Record<number, import('./players.js').PlayerMeta>} [a.livePlayers]
 *   The live galaxy player-flag cache (`state/players.js` shape), when the
 *   caller has it — feeds buddy/alliance flags + the rankClass fallback.
 * @param {Record<string, Record<string, object>>} [a.targetReports]
 *   The spy-report store (`playerId → bodyKey → entry`, either shape) — the
 *   spy refinement that collapses/bounds the fleet estimate.
 * @param {string | number | null} [a.ownId]  Our player id.
 * @returns {{
 *   dangerProfiles: Map<number, import('./dangerScore.js').DangerProfile>,
 *   planetCountByPlayer: Record<string, number>,
 *   ownMilitary: number | undefined,
 * }}
 */
export const joinDangerProfiles = ({ apiCache, livePlayers, targetReports, ownId }) => {
  const uniPlanets = apiCache.universe ? apiCache.universe.planets : [];

  // Coverage denominator: each player's spiable BODIES — planets PLUS moons
  // (`hasMoon` from the <moon> parse; §9bis: without moons a fully-planet-spied
  // player reads "complete" while unspied moon defence still hides in the
  // military score). Stale caches predating the parse count planets-only until
  // the 7-day universe feed refreshes — graceful.
  /** @type {Record<string, number>} */
  const planetCountByPlayer = {};
  for (const pl of uniPlanets) {
    if (pl && pl.player != null) {
      const pid = String(pl.player);
      planetCountByPlayer[pid] = (planetCountByPlayer[pid] || 0) + 1 + (pl.hasMoon ? 1 : 0);
    }
  }

  const militaryRanks = apiCache.military ? apiCache.military.ranks : undefined;

  // Spy refinement (E4): per player, the defence we've seen + whether coverage
  // is complete — fully spied collapses the fleet bound to military − defence
  // EXACTLY, partial coverage just tightens the upper bound. Also carries the
  // NEWEST report's alliance class ('warrior' | 'trader' | 'researcher') — the
  // public XML API has no alliance class, so spy reports are its only source;
  // dangerScore reads 'warrior' as an apex tell.
  /** @type {Record<string, {defensePts:number, coverageComplete:boolean, spiedCount:number, planetCount?:number, allianceClass?:string}>} */
  const spiedByPlayer = {};
  const reports = targetReports || {};
  for (const pid of Object.keys(reports)) {
    const bucket = reports[pid];
    const latest = bucket
      ? Object.values(bucket).map((e) => latestOf(/** @type {any} */ (e)))
      : [];
    if (!latest.length) continue;
    const est = estimateHiddenFleet({
      militaryPoints: militaryRanks && militaryRanks[pid] ? militaryRanks[pid].score : undefined,
      reports: latest,
      planetCount: planetCountByPlayer[pid],
    });
    // Newest report carrying an alliance class wins (a player can switch
    // alliances; older reports would report the previous one).
    /** @type {string | undefined} */
    let allianceClass;
    let allianceTs = -Infinity;
    for (const r of latest) {
      const rr = /** @type {any} */ (r);
      if (rr && typeof rr.allianceClass === 'string' && (rr.timestamp ?? 0) > allianceTs) {
        allianceClass = rr.allianceClass;
        allianceTs = rr.timestamp ?? 0;
      }
    }
    spiedByPlayer[pid] = {
      defensePts: est.defensePoints,
      coverageComplete: est.coverageComplete,
      spiedCount: est.spiedCount,
      planetCount: est.planetCount,
      ...(allianceClass ? { allianceClass } : {}),
    };
  }

  const ownIdStr = ownId != null ? String(ownId) : undefined;
  const apiPlayersMap = apiCache.players ? apiCache.players.players : undefined;
  const ownMilitary = ownIdStr && militaryRanks && militaryRanks[ownIdStr]
    ? militaryRanks[ownIdStr].score
    : undefined;

  const dangerProfiles = buildDangerProfiles({
    military: militaryRanks,
    destroyed: apiCache.destroyed ? apiCache.destroyed.ranks : undefined,
    honor: apiCache.honor ? apiCache.honor.ranks : undefined,
    honorTotal: apiCache.honor ? Object.keys(apiCache.honor.ranks).length : 0,
    apiPlayers: apiPlayersMap,
    players: livePlayers,
    universePlanets: uniPlanets,
    spied: spiedByPlayer,
    ownMilitary,
    ownId: ownIdStr,
    ownAlliance: ownIdStr && apiPlayersMap ? apiPlayersMap[ownIdStr]?.alliance : undefined,
  });

  return { dangerProfiles, planetCountByPlayer, ownMilitary };
};
