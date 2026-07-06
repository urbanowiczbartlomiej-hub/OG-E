// Settlement-region finder — generalises the classic "longest free streak".
//
// # What and why
//
// The classic search answered "longest PERFECT run of systems whose slot N
// is empty". Real colonisation planning wants something softer (see the
// post-1.17.0 feedback): a REGION may span several slots at once
// ("positions 12-15 all free"), and a single unscanned or occupied system
// should not disqualify an otherwise great stretch — it is far better to
// report a 30-system region with one blemish than to hunt for a perfect
// 12-system streak. So this module finds, per galaxy, the longest
// contiguous span of systems in which:
//
//   - a system MATCHES when EVERY requested slot has the requested status
//     (confirmed by a scan — unknown is never a match), and
//   - at most `maxGaps` non-matching systems are tolerated INSIDE the span
//     (a span always starts and ends on a match, so the tolerance can
//     never pad the edges).
//
// With `positions: [p]` and `maxGaps: 0` the result is exactly the
// classic single-slot streak.
//
// # Strictness
//
// An unscanned system is a NON-MATCH (it may consume gap tolerance, but
// is never silently assumed free). Reported regions are therefore a lower
// bound: keep scanning and they only grow.
//
// # Wrap-around
//
// Galaxies are circular (system 499 borders system 1). The finder works
// on the match list doubled by +galaxyMax (the standard circular-window
// trick): a region crossing the boundary is found as a window whose start
// lies in the first lap. A window never spans more than `galaxyMax`
// systems nor uses the same match twice, so a fully-empty galaxy reports
// exactly one full-circle region.
//
// Pure function: no DOM, no storage, no clock — the `domain/` contract.
//
// @ts-check

import { occupantStrength } from './players.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
 * @typedef {import('./players.js').PlayerMeta} PlayerMeta
 * @typedef {Record<number, PlayerMeta>} PlayerCache
 */

/**
 * Neighbourhood stats computed over the full system range of a region
 * (all systems start→end, wrap included). Players are de-duplicated by id
 * so a player with two colonies in the region counts as one.
 *
 * @typedef {object} RegionScore
 * @property {number} systemCount Total systems in the region span.
 * @property {number} scanned    How many of those systems have any scan data.
 * @property {number} occupied   Distinct players with `status: 'occupied'`
 *   in the range. Active neighbours — shows how crowded the area is.
 * @property {number} inactive   Distinct players in `inactive | long_inactive`
 *   states. Actual farm targets — they cannot defend.
 * @property {number} vacation   Distinct players in `vacation` mode — PLUS banned
 *   accounts, which are folded in as an "eternal vacation" (frozen, can never
 *   attack). Game-protected; cannot be attacked, so not a farm target and not a
 *   threat (banned players are also kept out of the bandit/honored/rank tallies).
 * @property {number[]} ranks    Highscore rank of every player seen in range,
 *   sorted ascending (rank 1 = #1 on highscore = strongest). Empty when no
 *   rank data was collected — the field was added in v1.17.x so older scans
 *   won't have it.
 * @property {number} bandits    Players with negative honor
 *   (`rankClass` starts with `"rank_bandit"`). Falling into bandit1 can
 *   happen by accident; bandit3 is top-10-server-level aggressor who very
 *   consistently targets weaker players — treat as a strong danger signal.
 * @property {number} banditMaxLevel Highest bandit tier seen in range (1–3;
 *   0 when `bandits === 0`). The tier is the trailing digit of `rankClass`
 *   (`"rank_bandit3"` → 3). Use this to distinguish an accidental bandit1
 *   from a true top-tier aggressor.
 * @property {number} banditTierSum  Sum of all bandit tier values (Σ tier_i).
 *   Monotonically grows with every additional bandit OR with higher tier —
 *   bandit3 scores 3× the threat of bandit1. Used in scoring; `banditMaxLevel`
 *   is used only for display.
 * @property {Record<number, number>} banditTiers  Bandit count keyed by honour
 *   tier — 1 Bandit, 2 Bandit Lord, 3 Bandit King. Empty when `bandits === 0`.
 *   Drives the per-tier breakdown line in the detail panel.
 * @property {number} honored    Players with positive honor (non-bandit
 *   ranked — likely `rank_general*` / `rank_starlord*`). Also mostly
 *   combat-active, but they prefer stronger targets — lower danger for a
 *   new, weak colonist than bandits of the same level.
 * @property {number} honoredMaxLevel Highest honored tier (1–3; 0 when
 *   `honored === 0`). Mirrors `banditMaxLevel`.
 * @property {number} honoredTierSum Sum of all honored tier values. Mirrors
 *   `banditTierSum` for the honor-fighter population.
 * @property {Record<number, number>} honoredTiers  Honored count keyed by
 *   honour tier (1–3). Mirrors `banditTiers` — drives the census ★/★★/★★★
 *   split. Empty when `honored === 0`.
 * @property {number} strong   Distinct players flagged `isStrong` (player cache
 *   only) — outside your noob-protection bracket; attacking is allowed but
 *   they out-gun a fresh colony. A danger signal. `0` without a player cache.
 * @property {number} newbie   Distinct players flagged `isNewbie` — noob-protected,
 *   cannot be raided, so they offer no farm value. `0` without a player cache.
 * @property {number} honorable Distinct players flagged `isHonorableTarget` — a
 *   fair fight, attacking earns honour. (Distinct from `honored`, which counts
 *   positive-honor RANK CLASSES.) `0` without a player cache.
 * @property {number} normal   Distinct live-scanned ACTIVE occupants with no
 *   special standing — past noob protection, below the honour bracket, not a
 *   friend/ally: the plain "white" farm target (`occupantStrength === 'normal'`).
 *   `0` without a player cache.
 * @property {number} buddy    Distinct players on your buddy list (`isBuddy`) —
 *   friends, never targets. `0` without a player cache.
 * @property {number} outlaw   Distinct players flagged `isOutlaw` — have lost
 *   protection by raiding the weak; sanctioned / fair-game targets. `0` without
 *   a player cache.
 * @property {number} activeOnVacation Distinct players in `vacation` status that
 *   are ALSO flagged `isActive` — NOT a safe farm: a live player hiding behind
 *   vacation mode who will return. `0` without a player cache. A player who
 *   ALSO owns an `occupied` colony in range is counted as occupied instead
 *   (one status per id; occupied wins) — they already read as "live".
 * @property {number} allianceCount Distinct alliance tags seen in range.
 * @property {number} allyNearby  Distinct players whose alliance tag matches
 *   the caller's `ownAllyTag`. 0 when no tag was supplied to
 *   {@link scoreRegion}. Use as a "friendly neighbours" signal.
 * @property {number} mineMinDist Minimum circular-distance in systems from
 *   any system in the region to the nearest OWN colony (`status: 'mine'`)
 *   in the SAME galaxy. `Infinity` when no own colonies exist in that
 *   galaxy's scans. Used by the placement modifier: < 50 = "too close home",
 *   100+ = "reasonable expansion territory", 200+ = "solid new zone".
 * @property {number} avgTotal   Mean TOTAL-highscore points of the distinct
 *   players in range (banned excluded), 0 when no points were joined (live-only
 *   scans / pre-API callers). The points-temperature "calibre" signal — high =
 *   a strong neighbourhood to avoid when settling.
 * @property {number} avgMilitary Mean MILITARY-highscore points of the distinct
 *   players in range, 0 when unknown. The aggressor lens — where fleets
 *   concentrate (target-rich) — as opposed to total-points calibre.
 */

/**
 * One reported region.
 *
 * @typedef {object} Region
 * @property {number} galaxy   1-indexed galaxy number.
 * @property {number} start    First system of the region (always a match).
 * @property {number} end      Last system of the region (always a match).
 *   `end < start` means the region wraps across the 499 → 1 boundary.
 * @property {number} length   Total systems spanned, INCLUDING tolerated
 *   gaps. Always ≥ 1.
 * @property {number} matched  Systems in the span where every requested
 *   slot matches. `matched = length - gaps`.
 * @property {number} gaps     Tolerated non-matching systems inside the
 *   span (unscanned or wrong status). Always ≤ `maxGaps`.
 * @property {RegionScore} [score] Neighbourhood stats, present when
 *   `scans` were supplied to {@link findBestRegions}.
 * @property {number} [center] Neighbourhood mode only: the settle system at the
 *   window's centre (the system that qualified the window — has a free target
 *   slot). `start`/`end` are then `center ± radius`.
 * @property {Array<{ id: number, name?: string, rank?: number, rankClass?: string }>} [excluded]
 *   Neighbourhood mode only: the players dropped from this window's score by the
 *   "ignore N worst" feature, best-to-worst. Empty/absent when none were dropped.
 * @property {number} [fit] Zone fit 0..1, stamped by
 *   `zoneScore.annotateAndSortByZone` — the analyzer's one ranking number.
 * @property {import('./zoneScore.js').ZoneChannels} [channels] The bounded
 *   channel breakdown behind `fit` (safety/farm/streak/target + coverage).
 * @property {number} [freeRun] Memoised ANY-free contiguous run through the
 *   candidate's centre (zoneScore.contiguousFreeRun) — computed once per
 *   region lifetime.
 * @property {{ field: unknown, value: number | null }} [threatAdjMemo]
 *   Memoised exclusion-adjusted threat sample (zoneScore), keyed by the
 *   field build it was computed against.
 */

/**
 * @typedef {object} FindRegionsOptions
 * @property {number[]} positions
 *   Slots that must ALL hold the status for a system to match. Typically
 *   from the same `parsePositions` grammar the rest of the dashboard uses
 *   (e.g. `[8]` or `[12,13,14,15]`). Empty array → no results.
 * @property {PositionStatus} [status]
 *   Status that counts as a match. Defaults to `'empty'`.
 * @property {number} [maxGaps]
 *   Non-matching systems tolerated inside a region. Defaults to `0`
 *   (perfect streak).
 * @property {number} [galaxyMax]
 *   Systems per galaxy. Defaults to `499` (OGame's constant); exposed so
 *   tests can use small fixtures.
 * @property {string} [ownAllyTag]
 *   The caller's own alliance TAG. When supplied, {@link scoreRegion} counts
 *   allied neighbours in `RegionScore.allyNearby` — fed by the UI's optional
 *   "Ally tag" text field and used by the alliance proximity modifier.
 * @property {PlayerCache} [players]
 *   Player-metadata cache forwarded to {@link scoreRegion} for the
 *   strong/newbie/buddy/outlaw/active-on-vacation signals and game-truth
 *   `allyNearby`. Optional — omit to score from scan data alone.
 */

/**
 * Enumerate the system numbers spanned by a region, honouring wrap-around.
 *
 * @param {Pick<Region,'start'|'end'>} region
 * @param {number} galaxyMax
 * @returns {number[]}
 */
const regionSystems = ({ start, end }, galaxyMax) => {
  const out = [];
  if (end >= start) {
    for (let s = start; s <= end; s++) out.push(s);
  } else {
    for (let s = start; s <= galaxyMax; s++) out.push(s);
    for (let s = 1; s <= end; s++) out.push(s);
  }
  return out;
};

/**
 * @typedef {object} ScoreRegionOptions
 * @property {number}   [galaxyMax]   Systems per galaxy (default 499).
 * @property {string}   [ownAllyTag]  The caller's own alliance TAG (e.g. `"FORM"`).
 *   When supplied, players whose `ally` matches are counted in `allyNearby`.
 *   Omit / leave empty to skip alliance proximity scoring.
 * @property {number[]} [mineSystemsInGalaxy]
 *   Pre-computed list of systems in this galaxy that contain a `mine` position.
 *   When provided, `scoreRegion` skips its own full-scan-map pass — pass this
 *   when calling from a loop over many candidates to avoid O(N×M) work.
 * @property {PlayerCache} [players]
 *   The per-universe player-metadata cache (`state/players.js`), keyed by id.
 *   When provided, scoreRegion joins region players by id to derive the
 *   strong/newbie/buddy/outlaw/active-on-vacation counts, and computes
 *   `allyNearby` from the game-truth `isAllianceMember` flag rather than the
 *   `ownAllyTag` text match. Omit to skip those signals (counts stay 0;
 *   `allyNearby` falls back to the legacy tag match).
 * @property {Set<number>} [excludeIds]
 *   Player ids to DROP from the neighbourhood aggregation entirely — as if
 *   they weren't in range. Used by {@link findNeighbourhoodCandidates}'s
 *   "ignore the N worst stat-ruining players" feature: a top-tier bandit far
 *   above our own rank can be excluded so the region scores on the players we
 *   would actually contend with. Omit (the common case) to count everyone.
 */

/**
 * Compute neighbourhood stats for a region by scanning the systems it spans
 * AND the full galaxy slice for own-colony distance.
 * Pure: reads `scans` but never mutates it. Players are de-duplicated by id.
 *
 * @param {Pick<Region,'galaxy'|'start'|'end'>} region
 * @param {GalaxyScans} scans
 * @param {ScoreRegionOptions} [opts]
 * @returns {RegionScore}
 */
export const scoreRegion = (region, scans, opts = {}) => {
  const galaxyMax = opts.galaxyMax ?? 499;
  const ownAllyTag = opts.ownAllyTag ?? '';
  const systems = regionSystems(region, galaxyMax);
  let scanned = 0;
  /** @type {Map<number, string>} id → dominant status */
  const playerStatus = new Map();
  /** @type {Map<number, number>} id → rank */
  const playerRank = new Map();
  /** @type {Map<number, string>} id → rankClass */
  const playerRankClass = new Map();
  /** @type {Map<number, { total?: number, military?: number }>} id → highscore POINTS */
  const playerPoints = new Map();
  const alliances = new Set();
  /** @type {Set<number>} ids of own-ally players seen in range */
  const allyPlayerIds = new Set();
  /** @type {Set<number>} ids whose account is banned (treated as eternal vacation). */
  const bannedIds = new Set();

  for (const sys of systems) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    if (!sysData?.positions) continue;
    scanned++;
    for (const pos of Object.values(sysData.positions)) {
      if (pos.status === 'mine') continue;
      const p = pos.player;
      if (!p) continue;
      if (opts.excludeIds && opts.excludeIds.has(p.id)) continue;
      // A banned account can never attack (frozen), so it is treated as an
      // ETERNAL VACATION: counted as a protected, no-value neighbour but DROPPED
      // from every threat tally — its rank/rankClass are not recorded (so a
      // banned bandit3 stops reading as a danger or a "ranked above you") and
      // the cache-flag loop below skips it.
      const banned = pos.status === 'banned';
      const effStatus = banned ? 'vacation' : pos.status;
      if (banned) bannedIds.add(p.id);
      // First-seen status wins for the player. occupied overrides inactive
      // (the player may have colonies in both states in different systems).
      if (!playerStatus.has(p.id) || effStatus === 'occupied') {
        playerStatus.set(p.id, effStatus);
      }
      if (!banned) {
        if (typeof p.rank === 'number' && !playerRank.has(p.id)) {
          playerRank.set(p.id, p.rank);
        }
        if (typeof p.rankClass === 'string' && !playerRankClass.has(p.id)) {
          playerRankClass.set(p.id, p.rankClass);
        }
        // Points temperature: capture each distinct player's account POINTS.
        // Only the API map carries points; fill from whichever position first
        // exposes a number so a player counts once, with data.
        let pp = playerPoints.get(p.id);
        if (!pp) {
          pp = {};
          playerPoints.set(p.id, pp);
        }
        if (pp.total == null && typeof p.score === 'number') pp.total = p.score;
        if (pp.military == null && typeof p.militaryScore === 'number') pp.military = p.militaryScore;
      }
      if (p.ally) alliances.add(p.ally);
      if (ownAllyTag && p.ally === ownAllyTag) allyPlayerIds.add(p.id);
    }
  }

  // Compute the true minimum circular distance to any own colony in this galaxy.
  // Use pre-computed mine systems when available (avoids O(all scans) scan per call).
  let mineSystems;
  if (opts.mineSystemsInGalaxy) {
    mineSystems = opts.mineSystemsInGalaxy;
  } else {
    mineSystems = [];
    for (const [key, sd] of Object.entries(scans)) {
      const colonIdx = key.indexOf(':');
      if (colonIdx <= 0) continue;
      if (parseInt(key.slice(0, colonIdx), 10) !== region.galaxy) continue;
      const s = parseInt(key.slice(colonIdx + 1), 10);
      if (!Number.isFinite(s)) continue;
      if (sd?.positions && Object.values(sd.positions).some((p) => p.status === 'mine')) {
        mineSystems.push(s);
      }
    }
  }
  let mineMinDist = Infinity;
  for (const rSys of systems) {
    for (const mSys of mineSystems) {
      const d = Math.min(Math.abs(rSys - mSys), galaxyMax - Math.abs(rSys - mSys));
      if (d < mineMinDist) mineMinDist = d;
    }
  }

  let occupied = 0;
  let inactive = 0;
  let vacation = 0;
  for (const st of playerStatus.values()) {
    if (st === 'occupied') occupied++;
    else if (st === 'inactive' || st === 'long_inactive') inactive++;
    else if (st === 'vacation') vacation++;
  }

  const ranks = [...playerRank.values()].sort((a, b) => a - b);

  let bandits = 0;
  let banditMaxLevel = 0;
  let banditTierSum = 0;
  /** @type {Record<number, number>} bandit count keyed by tier (1–3) */
  const banditTiers = {};
  let honored = 0;
  let honoredMaxLevel = 0;
  let honoredTierSum = 0;
  /** @type {Record<number, number>} honored count keyed by tier (1–3) */
  const honoredTiers = {};
  for (const rc of playerRankClass.values()) {
    // Tier is the trailing digit: "rank_bandit3" → 3, "rank_starlord2" → 2.
    // Falls back to 1 when the class has no trailing digit (unknown variant).
    const tier = parseInt(rc.slice(-1), 10) || 1;
    if (rc.startsWith('rank_bandit')) {
      bandits++;
      banditTierSum += tier;
      banditTiers[tier] = (banditTiers[tier] || 0) + 1;
      if (tier > banditMaxLevel) banditMaxLevel = tier;
    } else {
      honored++;
      honoredTierSum += tier;
      honoredTiers[tier] = (honoredTiers[tier] || 0) + 1;
      if (tier > honoredMaxLevel) honoredMaxLevel = tier;
    }
  }

  // Cache-derived per-player signals (2b). Joined by id against the player
  // cache so a player with several colonies in range counts once. With no
  // cache these stay 0 and `allyNearby` falls back to the ownAllyTag match
  // computed above — older scans / callers without a cache are unaffected.
  const cache = opts.players;
  let strong = 0;
  let newbie = 0;
  let honorable = 0;
  let normal = 0;
  let buddy = 0;
  let outlaw = 0;
  let activeOnVacation = 0;
  let allyMembers = 0;
  if (cache) {
    for (const [id, st] of playerStatus) {
      if (bannedIds.has(id)) continue; // banned = eternal vacation, no threat/value
      const meta = cache[id];
      if (!meta) continue; // not live-scanned → unknown, not a counted target
      const f = meta.flags;
      if (f) {
        if (f.strong) strong++;
        if (f.newbie) newbie++;
        if (f.honorable) honorable++;
        if (f.buddy) buddy++;
        if (f.outlaw) outlaw++;
        if (f.allianceMember) allyMembers++;
        // A vacation-status owner who is ALSO flagged active is a live player
        // hiding behind vacation, not a dormant farm — surface separately.
        if (f.active && st === 'vacation') activeOnVacation++;
      }
      // "Normal/white" target: a live-scanned ACTIVE occupant with no special
      // standing. Same classifier the per-occupant card uses, so the count and
      // the labels can't drift.
      if (st === 'occupied' && occupantStrength(meta) === 'normal') normal++;
    }
  }

  // Points temperature: mean account POINTS of the distinct players in range.
  // Total = "calibre" (avoid when settling); military = fleet concentration
  // (target-rich for an aggressor). 0 when no points were joined.
  let pointsTotalSum = 0;
  let pointsTotalN = 0;
  let pointsMilSum = 0;
  let pointsMilN = 0;
  for (const pp of playerPoints.values()) {
    if (typeof pp.total === 'number') {
      pointsTotalSum += pp.total;
      pointsTotalN++;
    }
    if (typeof pp.military === 'number') {
      pointsMilSum += pp.military;
      pointsMilN++;
    }
  }
  const avgTotal = pointsTotalN ? Math.round(pointsTotalSum / pointsTotalN) : 0;
  const avgMilitary = pointsMilN ? Math.round(pointsMilSum / pointsMilN) : 0;

  return {
    systemCount: systems.length,
    scanned,
    occupied,
    inactive,
    vacation,
    ranks,
    bandits,
    banditMaxLevel,
    banditTierSum,
    banditTiers,
    honored,
    honoredMaxLevel,
    honoredTierSum,
    honoredTiers,
    strong,
    newbie,
    honorable,
    normal,
    buddy,
    outlaw,
    activeOnVacation,
    allianceCount: alliances.size,
    allyNearby: cache ? allyMembers : allyPlayerIds.size,
    mineMinDist,
    avgTotal,
    avgMilitary,
  };
};

// ─── Neighbourhood harm weights ─────────────────────────────────────────────
//
// The `StrategyWeights` weight set below is retained for the "drop the N worst"
// exclusion ranking (`playerHarm` / `findNeighbourhoodCandidates`): a negative
// weight marks a dimension whose occupants HURT a candidate. The legacy
// full-strategy scoring/sorting engine that also consumed it has been removed —
// candidate ranking now lives in `domain/zoneScore.js` (annotateAndSortByZone).

/**
 * @typedef {object} StrategyWeights
 * @property {number} [free]     Free-slot density (0–1). Positive = want free slots.
 * @property {number} [inactive] Dormant-player density. Positive = want farm targets.
 * @property {number} [occupied] Active-player density. Positive = want PvP; negative = want quiet.
 * @property {number} [bandit]   Bandit-threat factor. Negative = penalise; positive = seek.
 * @property {number} [honored]  Honored-presence factor. Positive = seek; negative = avoid.
 * @property {number} [strong]   Strong + active-on-vacation density (player cache).
 *   Negative = avoid (a fresh colony gets crushed); positive = seek fights.
 * @property {number} [outlaw]   Outlaw (sanctioned-target) density (player cache).
 *   Positive = prefer fair-game targets.
 * @property {number} [weakerNearby] Rank-relative safety signal: net count of
 *   neighbours WEAKER than us minus those STRONGER (by highscore rank), per
 *   scanned system. Positive = settle where you out-rank the neighbours
 *   (the points-temperature "safe expansion" lens); needs `ownRank` in the
 *   sort/heat opts, else it contributes 0.
 * @property {number} [length]   Small length tiebreaker (0–1 over 499 systems).
 */

/**
 * Minimum region length worth reporting. Shorter spans aren't useful as a
 * settlement *row*. Exported so the UI can name the threshold in its
 * "no region ≥ N" fallback copy ({@link findFreeSystems}) without a
 * hard-coded literal drifting from this value.
 */
export const MIN_REGION_LENGTH = 5;

/** Non-overlapping regions to extract per galaxy before global ranking. */
const MAX_REGIONS_PER_GALAXY = 5;

/**
 * Two-pointer over the doubled match list to find the single best window.
 * Returns `null` when no window of length ≥ MIN_REGION_LENGTH exists.
 *
 * @param {number[]} sorted  Sorted system numbers (already a copy).
 * @param {number}   maxGaps
 * @param {number}   galaxyMax
 * @returns {{ startI: number, endJ: number, span: number, gaps: number, matched: number } | null}
 */
const bestWindow = (sorted, maxGaps, galaxyMax) => {
  const k = sorted.length;
  if (k === 0) return null;
  const m = sorted.concat(sorted.map((s) => s + galaxyMax));

  let best = null;
  let i = 0;
  for (let j = 0; j < m.length; j++) {
    if (j - i + 1 > k) i = j - k + 1;
    while (
      i < j
      && (m[j] - m[i] + 1 > galaxyMax
        || (m[j] - m[i] + 1) - (j - i + 1) > maxGaps)
    ) i++;
    if (i >= k) break;
    const span = m[j] - m[i] + 1;
    if (span < MIN_REGION_LENGTH) continue;
    const gaps = span - (j - i + 1);
    if (!best || span > best.span || (span === best.span && gaps < best.gaps)) {
      best = { startI: i, endJ: j, span, gaps, matched: j - i + 1 };
    }
  }
  return best;
};

/**
 * Extract up to `maxRegions` non-overlapping regions from a galaxy's match
 * list. After each find, the match indices used are removed and the search
 * restarts on the remaining matches.
 *
 * @param {number[]} arr       Sorted system numbers for matching systems.
 * @param {number}   maxGaps
 * @param {number}   galaxyMax
 * @param {number}   maxRegions
 * @returns {Array<{start:number,end:number,length:number,matched:number,gaps:number}>}
 */
const findGalaxyRegions = (arr, maxGaps, galaxyMax, maxRegions) => {
  const found = [];
  let remaining = [...arr]; // sorted copy; we splice used matches out

  while (found.length < maxRegions && remaining.length > 0) {
    const win = bestWindow(remaining, maxGaps, galaxyMax);
    if (!win) break;

    const k = remaining.length;
    const m = remaining.concat(remaining.map((s) => s + galaxyMax));
    found.push({
      start: ((m[win.startI] - 1) % galaxyMax) + 1,
      end:   ((m[win.endJ]   - 1) % galaxyMax) + 1,
      length: win.span,
      matched: win.matched,
      gaps: win.gaps,
    });

    // Remove the match indices consumed by this window from `remaining`.
    const usedIndices = new Set();
    for (let idx = win.startI; idx <= win.endJ; idx++) usedIndices.add(idx % k);
    remaining = remaining.filter((_, i) => !usedIndices.has(i));
  }

  return found;
};

/**
 * Shared first pass over the scan map, run by BOTH region finders. Walks
 * every `"galaxy:system"` entry exactly once and produces, per galaxy:
 *
 *   - `matchesByGalaxy` — systems where EVERY requested position holds
 *     `status` (a confirmed match; unknown/wrong is never a match), and
 *   - `minesByGalaxy`   — systems that contain at least one `'mine'` slot.
 *     Passing this to {@link scoreRegion} lets it skip its own
 *     O(all scans) own-colony search for every candidate region.
 *
 * Pure: reads `scans`, allocates fresh Maps, mutates nothing external —
 * the `domain/` contract.
 *
 * @param {GalaxyScans} scans Full per-system scan map, keys `"galaxy:system"`.
 * @param {{ positions: number[], status: PositionStatus, galaxyMax: number }} opts
 *   `positions` must already be de-duplicated and finite (callers clean it
 *   before calling); `status` and `galaxyMax` are likewise resolved.
 * @returns {{ matchesByGalaxy: Map<number, number[]>, minesByGalaxy: Map<number, number[]> }}
 *   Systems within each galaxy are in scan-iteration order; callers that
 *   need them sorted sort the per-galaxy arrays themselves.
 */
const collectMatchesAndMines = (scans, { positions, status, galaxyMax }) => {
  /** @type {Map<number, number[]>} */
  const matchesByGalaxy = new Map();
  /** @type {Map<number, number[]>} galaxy → systems that have a 'mine' slot */
  const minesByGalaxy = new Map();

  for (const [key, sysData] of Object.entries(scans)) {
    const colonIdx = key.indexOf(':');
    if (colonIdx <= 0) continue;
    const galaxy = parseInt(key.slice(0, colonIdx), 10);
    const system = parseInt(key.slice(colonIdx + 1), 10);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system)) continue;
    if (system < 1 || system > galaxyMax) continue;
    const posMap = sysData?.positions;
    if (!posMap) continue;

    if (Object.values(posMap).some((p) => p.status === 'mine')) {
      let mArr = minesByGalaxy.get(galaxy);
      if (!mArr) { mArr = []; minesByGalaxy.set(galaxy, mArr); }
      mArr.push(system);
    }

    let all = true;
    for (const p of positions) {
      if (posMap[/** @type {any} */ (String(p))]?.status !== status) { all = false; break; }
    }
    if (!all) continue;
    let arr = matchesByGalaxy.get(galaxy);
    if (!arr) { arr = []; matchesByGalaxy.set(galaxy, arr); }
    arr.push(system);
  }

  return { matchesByGalaxy, minesByGalaxy };
};

/**
 * Find the best regions across all galaxies — up to MAX_REGIONS_PER_GALAXY
 * non-overlapping regions per galaxy, scored and ranked globally.
 *
 * @param {GalaxyScans} scans Full per-system scan map, keys `"galaxy:system"`.
 * @param {FindRegionsOptions} opts
 * @returns {Region[]} Sorted by `length` desc, then `gaps` asc, then
 *   `galaxy` asc. Galaxies with zero matching systems do not appear.
 */
export const findBestRegions = (scans, opts) => {
  const positions = [...new Set(opts.positions)].filter((p) => Number.isFinite(p));
  const status = opts.status ?? 'empty';
  const maxGaps = Math.max(0, opts.maxGaps ?? 0);
  const galaxyMax = opts.galaxyMax ?? 499;
  if (positions.length === 0) return [];

  // One pass over the scan map: matching systems AND mine systems per galaxy,
  // so scoreRegion can skip its own O(all scans) mine-search per candidate.
  const { matchesByGalaxy, minesByGalaxy } = collectMatchesAndMines(scans, { positions, status, galaxyMax });

  /** @type {Region[]} */
  const results = [];
  for (const [galaxy, arr] of matchesByGalaxy) {
    arr.sort((a, b) => a - b);
    const candidates = findGalaxyRegions(arr, maxGaps, galaxyMax, MAX_REGIONS_PER_GALAXY);
    const mineSystemsInGalaxy = minesByGalaxy.get(galaxy) ?? [];
    for (const c of candidates) {
      const region = /** @type {Region} */ ({
        galaxy,
        start: c.start,
        end: c.end,
        length: c.length,
        matched: c.matched,
        gaps: c.gaps,
      });
      region.score = scoreRegion(region, scans, {
        galaxyMax, ownAllyTag: opts.ownAllyTag, mineSystemsInGalaxy, players: opts.players,
      });
      results.push(region);
    }
  }

  results.sort((a, b) => b.length - a.length || a.gaps - b.gaps || a.galaxy - b.galaxy);
  return results;
};

/**
 * List EVERY system whose requested positions are ALL `status`, as
 * length-1 {@link Region}s carrying the same neighbourhood {@link RegionScore}.
 *
 * # Why this exists (the "I typed 8 and got nothing" trap)
 *
 * {@link findBestRegions} windows matching systems into CONTIGUOUS spans of
 * length ≥ {@link MIN_REGION_LENGTH} (and caps at {@link MAX_REGIONS_PER_GALAXY}
 * per galaxy) — exactly right for planning a settlement ROW, but it returns
 * NOTHING when the free systems are scattered (no run of five). That is the
 * common case for a single colonise slot: the very act of colonising slot 8
 * turns those slots `mine`/`empty_sent`, fragmenting any run, so a galaxy
 * full of individually-free "8"s yields zero regions.
 *
 * For single-slot colonisation the user wants the free systems themselves,
 * adjacency be damned. This returns one scored region per matching system
 * (`length: 1`, `start === end`), with NO minimum length and NO per-galaxy
 * cap. The result is a plain `Region[]`, so it sorts and renders through the
 * exact same `zoneScore.annotateAndSortByZone` / table code as real regions.
 *
 * @param {GalaxyScans} scans
 * @param {Omit<FindRegionsOptions, 'maxGaps'>} opts  `positions` (required),
 *   `status` (default `'empty'`), `galaxyMax`, `ownAllyTag` — same grammar as
 *   {@link findBestRegions}, minus the gap tolerance (a single system has no
 *   gaps to tolerate).
 * @returns {Region[]} One length-1 region per matching system, ordered by
 *   galaxy then system (insertion order). The caller sorts by strategy.
 */
export const findFreeSystems = (scans, opts) => {
  const positions = [...new Set(opts.positions)].filter((p) => Number.isFinite(p));
  const status = opts.status ?? 'empty';
  const galaxyMax = opts.galaxyMax ?? 499;
  if (positions.length === 0) return [];

  // One pass: matching systems per galaxy AND mine systems per galaxy, so
  // scoreRegion can skip its own O(all scans) own-colony search per system
  // (shared with findBestRegions via collectMatchesAndMines).
  const { matchesByGalaxy, minesByGalaxy } = collectMatchesAndMines(scans, { positions, status, galaxyMax });

  /** @type {Region[]} */
  const results = [];
  for (const [galaxy, arr] of matchesByGalaxy) {
    arr.sort((a, b) => a - b);
    const mineSystemsInGalaxy = minesByGalaxy.get(galaxy) ?? [];
    for (const system of arr) {
      const region = /** @type {Region} */ ({
        galaxy,
        start: system,
        end: system,
        length: 1,
        matched: 1,
        gaps: 0,
      });
      region.score = scoreRegion(region, scans, {
        galaxyMax,
        ownAllyTag: opts.ownAllyTag,
        mineSystemsInGalaxy,
        players: opts.players,
      });
      results.push(region);
    }
  }

  return results;
};

// ─── Neighbourhood mode (non-streak strategies) ─────────────────────────────
//
// A different question from the streak finder. There the slot+gap define the
// SHAPE we hunt (a long run of a free slot). In the neighbourhood strategies
// (peaceful / farmer / PvP) the user isn't planning a settlement ROW — they
// want ONE good place to drop a colony and to understand the area AROUND it.
// So here:
//
//   - the slot list picks CANDIDATE CENTRES: any system with ≥1 of those slots
//     confirmed free is a place we could settle (the centre S),
//   - the window is the symmetric band [S−radius, S+radius] (S included), and
//     EVERY position 1..15 of every system in it feeds the neighbourhood score
//     — left and right of S alike,
//   - `excludeN` lets us ignore the N most stat-ruining players (a top-tier
//     bandit ranked far above us) so one outlier in the band doesn't condemn an
//     otherwise good area — we just accept we'll avoid that single system.
//
// Candidates are scored with the SAME strategy weights as everything else and
// spaced out (a picked centre suppresses other centres within `radius`) so the
// table lists distinct areas, not S / S+1 / S+2 near-duplicates.

/**
 * Circular system arithmetic: map any integer to 1..galaxyMax (wrap at the
 * 499↔1 seam). Pure.
 *
 * @param {number} s
 * @param {number} galaxyMax
 * @returns {number}
 */
const wrapSystem = (s, galaxyMax) => ((((s - 1) % galaxyMax) + galaxyMax) % galaxyMax) + 1;

/**
 * Shortest circular distance between two systems in the same galaxy.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} galaxyMax
 * @returns {number}
 */
const circularDist = (a, b, galaxyMax) => {
  const d = Math.abs(a - b);
  return Math.min(d, galaxyMax - d);
};

/**
 * Per-galaxy: systems that qualify as a window CENTRE (≥1 requested slot free)
 * plus the `mine` systems (so scoring can skip its own own-colony search).
 *
 * @param {GalaxyScans} scans
 * @param {{ positions: number[], status: PositionStatus, galaxyMax: number }} opts
 * @returns {{ centresByGalaxy: Map<number, number[]>, minesByGalaxy: Map<number, number[]> }}
 */
const collectCentresAndMines = (scans, { positions, status, galaxyMax }) => {
  /** @type {Map<number, number[]>} */
  const centresByGalaxy = new Map();
  /** @type {Map<number, number[]>} */
  const minesByGalaxy = new Map();
  for (const [key, sysData] of Object.entries(scans)) {
    const colonIdx = key.indexOf(':');
    if (colonIdx <= 0) continue;
    const galaxy = parseInt(key.slice(0, colonIdx), 10);
    const system = parseInt(key.slice(colonIdx + 1), 10);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system)) continue;
    if (system < 1 || system > galaxyMax) continue;
    const posMap = sysData?.positions;
    if (!posMap) continue;

    if (Object.values(posMap).some((p) => p.status === 'mine')) {
      let mArr = minesByGalaxy.get(galaxy);
      if (!mArr) { mArr = []; minesByGalaxy.set(galaxy, mArr); }
      mArr.push(system);
    }
    // ANY requested slot free → a settle candidate (vs streak's ALL-free).
    const free = positions.some(
      (p) => posMap[/** @type {any} */ (String(p))]?.status === status,
    );
    if (!free) continue;
    let arr = centresByGalaxy.get(galaxy);
    if (!arr) { arr = []; centresByGalaxy.set(galaxy, arr); }
    arr.push(system);
  }
  return { centresByGalaxy, minesByGalaxy };
};

/**
 * Gather the distinct players present in a window, with the identity fields the
 * exclusion ranking needs (rank + rankClass) and a display name. De-duplicated
 * by id; `occupied` status wins over a dormant one (same rule as scoreRegion).
 *
 * @param {Pick<Region,'galaxy'|'start'|'end'>} region
 * @param {GalaxyScans} scans
 * @param {number} galaxyMax
 * @returns {Array<{ id: number, name?: string, status: string, rank?: number, rankClass?: string }>}
 */
const gatherWindowPlayers = (region, scans, galaxyMax) => {
  /** @type {Map<number, { id: number, name?: string, status: string, rank?: number, rankClass?: string }>} */
  const byId = new Map();
  for (const sys of regionSystems(region, galaxyMax)) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    if (!sysData?.positions) continue;
    for (const pos of Object.values(sysData.positions)) {
      if (pos.status === 'mine') continue;
      // Non-attack-capable occupants are never a stat-ruiner worth spending an
      // "ignore worst" slot on: banned = eternal vacation, vacation = frozen,
      // inactive/long_inactive = a farm, not a threat. Mirrors cellClass's
      // buckets (only ACTIVE occupants can be 'threat'), so an exclusion slot
      // always buys an actual safety effect.
      if (pos.status === 'banned' || pos.status === 'vacation'
        || pos.status === 'inactive' || pos.status === 'long_inactive') continue;
      const p = pos.player;
      if (!p) continue;
      const prev = byId.get(p.id);
      if (!prev) {
        byId.set(p.id, {
          id: p.id, name: p.name, status: pos.status,
          rank: p.rank, rankClass: p.rankClass,
        });
      } else {
        if (pos.status === 'occupied') prev.status = 'occupied';
        if (prev.rank == null && typeof p.rank === 'number') prev.rank = p.rank;
        if (prev.rankClass == null && typeof p.rankClass === 'string') prev.rankClass = p.rankClass;
        if (!prev.name && p.name) prev.name = p.name;
      }
    }
  }
  return [...byId.values()];
};

/**
 * Rank-relative danger multiplier: a neighbour far ABOVE us (lower rank number =
 * stronger) is worth excluding more than one below us. Saturates so a single
 * monster can't dominate. Returns 1 when either rank is unknown.
 *
 * @param {number | undefined} ownRank
 * @param {number | undefined} rank
 * @returns {number}
 */
const rankAboveFactor = (ownRank, rank) => {
  if (!ownRank || !rank) return 1;
  return Math.max(0.5, Math.min(3, ownRank / rank));
};

/**
 * How much a single player HURTS the current strategy score — the basis for
 * "drop the N worst". Only counts dimensions the active weights PENALISE
 * (negative weight): a bandit when `bandit < 0`, an active occupant when
 * `occupied < 0`, a strong neighbour when `strong < 0`, an honoured fighter
 * when `honored < 0`. Bandit/honoured harm scales with tier; all scale with
 * {@link rankAboveFactor}. A player we don't penalise has harm 0 and is never
 * excluded. Pure.
 *
 * @param {{ id: number, status: string, rank?: number, rankClass?: string }} p
 * @param {StrategyWeights} weights
 * @param {number | undefined} ownRank
 * @param {PlayerCache} [cache]
 * @returns {number}
 */
const playerHarm = (p, weights, ownRank, cache) => {
  let h = 0;
  const above = rankAboveFactor(ownRank, p.rank);
  const rc = p.rankClass;
  if (rc) {
    const tier = parseInt(rc.slice(-1), 10) || 1;
    if (rc.startsWith('rank_bandit')) {
      if ((weights.bandit ?? 0) < 0) h += Math.abs(weights.bandit ?? 0) * tier * above;
    } else if ((weights.honored ?? 0) < 0) {
      h += Math.abs(weights.honored ?? 0) * tier * above;
    }
  }
  if ((weights.occupied ?? 0) < 0 && p.status === 'occupied') {
    h += Math.abs(weights.occupied ?? 0) * above;
  }
  const flags = cache?.[p.id]?.flags;
  if (flags?.strong && (weights.strong ?? 0) < 0) {
    h += Math.abs(weights.strong ?? 0) * above;
  }
  return h;
};

/**
 * Find settlement candidates for the neighbourhood strategies: one scored
 * window per free-slot system, spaced out and ranked. See the section header
 * above for the model. Pure: reads `scans`, mutates nothing.
 *
 * @param {GalaxyScans} scans
 * @param {object} opts
 * @param {number[]} opts.positions   Settle-slot candidates (≥1 free → centre).
 * @param {PositionStatus} [opts.status]  Free-slot status (default 'empty').
 * @param {number} opts.radius        Window half-width R.
 * @param {number} [opts.galaxyMax]
 * @param {PlayerCache} [opts.players]
 * @param {string} [opts.ownAllyTag]
 * @param {number} [opts.ownRank]
 * @param {number} [opts.excludeN]    Worst players to ignore per window (default 0).
 * @param {StrategyWeights} [opts.weights]  Active weights (for the harm ranking).
 * @returns {Region[]} Scored windows, centre-spaced; caller sorts by strategy.
 */
export const findNeighbourhoodCandidates = (scans, opts) => {
  const positions = [...new Set(opts.positions)].filter((p) => Number.isFinite(p));
  const status = opts.status ?? 'empty';
  const galaxyMax = opts.galaxyMax ?? 499;
  const radius = Math.max(1, Math.floor(opts.radius ?? 15));
  const excludeN = Math.max(0, Math.floor(opts.excludeN ?? 0));
  const weights = opts.weights ?? {};
  if (positions.length === 0) return [];

  const { centresByGalaxy, minesByGalaxy } = collectCentresAndMines(scans, { positions, status, galaxyMax });

  /** @type {Region[]} */
  const results = [];
  for (const [galaxy, centresRaw] of centresByGalaxy) {
    const centres = [...centresRaw].sort((a, b) => a - b);
    const mineSystemsInGalaxy = minesByGalaxy.get(galaxy) ?? [];
    for (const centre of centres) {
      const region = /** @type {Region} */ ({
        galaxy,
        start: wrapSystem(centre - radius, galaxyMax),
        end: wrapSystem(centre + radius, galaxyMax),
        center: centre,
        length: radius * 2 + 1,
        matched: 1,
        gaps: 0,
      });

      /** @type {Set<number>} */
      let excludeIds = new Set();
      if (excludeN > 0) {
        const players = gatherWindowPlayers(region, scans, galaxyMax)
          .map((p) => ({ p, harm: playerHarm(p, weights, opts.ownRank, opts.players) }))
          .filter((x) => x.harm > 0)
          .sort((a, b) => b.harm - a.harm)
          .slice(0, excludeN);
        excludeIds = new Set(players.map((x) => x.p.id));
        region.excluded = players.map((x) => ({
          id: x.p.id, name: x.p.name, rank: x.p.rank, rankClass: x.p.rankClass,
        }));
      }

      region.score = scoreRegion(region, scans, {
        galaxyMax, ownAllyTag: opts.ownAllyTag, mineSystemsInGalaxy,
        players: opts.players, excludeIds,
      });
      results.push(region);
    }
  }
  return results;
};

/**
 * Suppress near-duplicate windows AFTER a strategy sort: walk the ranked list
 * and keep a candidate only when its centre is ≥ `radius` systems from every
 * already-kept centre in the same galaxy. Leaves a spread of DISTINCT areas
 * instead of a cluster of overlapping windows around one hotspot. Pure; returns
 * a new array. Non-neighbourhood regions (no `center`) pass through untouched.
 *
 * @param {Region[]} sorted   Already strategy-sorted, best first.
 * @param {number} radius
 * @param {number} [galaxyMax]
 * @returns {Region[]}
 */
export const spaceOutCandidates = (sorted, radius, galaxyMax = 499) => {
  /** @type {Map<number, number[]>} galaxy → kept centres */
  const kept = new Map();
  /** @type {Region[]} */
  const out = [];
  for (const r of sorted) {
    const centre = r.center;
    if (typeof centre !== 'number') { out.push(r); continue; }
    const centres = kept.get(r.galaxy) ?? [];
    if (centres.some((c) => circularDist(c, centre, galaxyMax) < radius)) continue;
    centres.push(centre);
    kept.set(r.galaxy, centres);
    out.push(r);
  }
  return out;
};
