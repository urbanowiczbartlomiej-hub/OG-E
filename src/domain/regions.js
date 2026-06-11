// Settlement-region finder — the generalisation of `domain/freeStreak.js`.
//
// # What and why
//
// `findLongestStreaks` answers "longest PERFECT run of systems whose slot N
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
// classic streak — the old module remains for its callers/tests, but new
// UI should come here.
//
// # Strictness inherited from freeStreak
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

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
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
 * @property {number} inactive   Distinct players in `inactive | long_inactive
 *   | vacation` states. Potential farm targets for the new colonist.
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
 * @property {number} honored    Players with positive honor (non-bandit
 *   ranked — likely `rank_general*` / `rank_starlord*`). Also mostly
 *   combat-active, but they prefer stronger targets — lower danger for a
 *   new, weak colonist than bandits of the same level.
 * @property {number} honoredMaxLevel Highest honored tier (1–3; 0 when
 *   `honored === 0`). Mirrors `banditMaxLevel`.
 * @property {number} allianceCount Distinct alliance tags seen in range.
 * @property {number} mineNearby Systems in the range that contain at least
 *   one of the player's OWN colonies (`status: 'mine'`). Used by the
 *   "Expansion" strategy to favour regions away from existing territory.
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
 * Compute neighbourhood stats for a region by scanning the systems it spans.
 * Pure: reads `scans` but never mutates it. Players are de-duplicated by id.
 *
 * @param {Pick<Region,'galaxy'|'start'|'end'>} region
 * @param {GalaxyScans} scans
 * @param {number} [galaxyMax]
 * @returns {RegionScore}
 */
export const scoreRegion = (region, scans, galaxyMax = 499) => {
  const systems = regionSystems(region, galaxyMax);
  let scanned = 0;
  /** @type {Map<number, string>} id → dominant status */
  const playerStatus = new Map();
  /** @type {Map<number, number>} id → rank */
  const playerRank = new Map();
  /** @type {Map<number, string>} id → rankClass */
  const playerRankClass = new Map();
  const alliances = new Set();

  let mineNearby = 0;
  for (const sys of systems) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    if (!sysData?.positions) continue;
    scanned++;
    let hasMine = false;
    for (const pos of Object.values(sysData.positions)) {
      if (pos.status === 'mine') { hasMine = true; continue; }
      const p = pos.player;
      if (!p) continue;
      // First-seen status wins for the player. occupied overrides inactive
      // (the player may have colonies in both states in different systems).
      if (!playerStatus.has(p.id) || pos.status === 'occupied') {
        playerStatus.set(p.id, pos.status);
      }
      if (typeof p.rank === 'number' && !playerRank.has(p.id)) {
        playerRank.set(p.id, p.rank);
      }
      if (typeof p.rankClass === 'string' && !playerRankClass.has(p.id)) {
        playerRankClass.set(p.id, p.rankClass);
      }
      if (p.ally) alliances.add(p.ally);
    }
    if (hasMine) mineNearby++;
  }

  let occupied = 0;
  let inactive = 0;
  for (const st of playerStatus.values()) {
    if (st === 'occupied') occupied++;
    else if (st === 'inactive' || st === 'long_inactive' || st === 'vacation') inactive++;
  }

  const ranks = [...playerRank.values()].sort((a, b) => a - b);

  let bandits = 0;
  let banditMaxLevel = 0;
  let honored = 0;
  let honoredMaxLevel = 0;
  for (const rc of playerRankClass.values()) {
    // Tier is the trailing digit: "rank_bandit3" → 3, "rank_starlord2" → 2.
    // Falls back to 1 when the class has no trailing digit (unknown variant).
    const tier = parseInt(rc.slice(-1), 10) || 1;
    if (rc.startsWith('rank_bandit')) {
      bandits++;
      if (tier > banditMaxLevel) banditMaxLevel = tier;
    } else {
      honored++;
      if (tier > honoredMaxLevel) honoredMaxLevel = tier;
    }
  }

  return {
    systemCount: systems.length,
    scanned,
    occupied,
    inactive,
    ranks,
    bandits,
    banditMaxLevel,
    honored,
    honoredMaxLevel,
    allianceCount: alliances.size,
    mineNearby,
  };
};

// ─── Strategy engine ────────────────────────────────────────────────────────
//
// A "strategy" is a named set of weights applied to the neighbourhood score
// to re-sort regions for different play styles. All rate inputs are
// normalised to roughly 0–1 so weights are directly comparable:
//
//   free      = matched / length        (density of confirmed-free slots)
//   inactive  = inactive  / scanned     (dormant-player density)
//   occupied  = occupied  / scanned     (active-player density)
//   bandit    = bandits  * banditMaxLevel  / (scanned × 3)   (0–1 threat)
//   honored   = honored  * honoredMaxLevel / (scanned × 3)   (0–1 presence)
//   mine      = mineNearby / systemCount  (own-colony proximity, 0–1)
//   length    = region.length / 499      (small length tiebreaker)
//
// The default 'longest' preset ignores all rates and sorts purely by length,
// reproducing the pre-strategy behaviour exactly.

/**
 * @typedef {object} StrategyWeights
 * @property {number} [free]     Density of confirmed-free target slots (0–1).
 * @property {number} [inactive] Dormant-player density. Positive = want farm targets.
 * @property {number} [occupied] Active-player density. Positive = want PvP targets; negative = want quiet.
 * @property {number} [bandit]   Bandit-threat factor. Negative = penalise aggressors; positive = seek them.
 * @property {number} [honored]  Honored-presence factor. Positive = seek honour-fighters; negative = avoid.
 * @property {number} [mine]     Own-colony proximity. Negative = expansion away; positive = cluster near base.
 * @property {number} [length]   Tiebreaker length bonus (normalised to 0–1 over 499 systems).
 */

/**
 * Named strategy presets. Exported so the UI can build a `<select>` from them
 * without duplicating label strings.
 *
 * Weights are designed so that a region with "typical" values (e.g. 20% inactive
 * density, 1 bandit3 per 20 systems) gets a meaningful non-zero score component
 * for each weight, making the sort order intuitive at real data scale.
 *
 * @type {Record<string, { label: string, hint: string, weights: StrategyWeights }>}
 */
export const STRATEGIES = {
  longest: {
    label: 'Longest streak',
    hint: 'Default — pure free-slot length; no neighbourhood weighting',
    weights: { length: 1 },
  },
  peaceful: {
    label: 'Peaceful settler',
    hint: 'Mining / expeditions — quiet zone; bandits strongly penalised, honored moderately; inactive farm targets welcome',
    weights: { free: 1, inactive: 0.5, occupied: -0.3, bandit: -3, honored: -1.5, length: 0.1 },
  },
  farmer: {
    label: 'Farmer',
    hint: 'Maximise inactive targets nearby for resource raiding; bandits penalised (they may raid you back)',
    weights: { free: 0.7, inactive: 2.5, bandit: -1.5, honored: -0.3, length: 0.1 },
  },
  honor_pvp: {
    label: 'Honor PvP',
    hint: 'Seek honored fighters — attacking them earns positive honour points; avoid bandits (they undercut your targets)',
    weights: { free: 0.5, occupied: 0.8, honored: 2.5, bandit: -1, length: 0.1 },
  },
  aggressive: {
    label: 'Aggressive PvP',
    hint: 'Max active players of any honour rank — density of targets matters more than their colour',
    weights: { free: 0.5, occupied: 2, inactive: 0.5, bandit: 0.3, honored: 0.5, length: 0.1 },
  },
  expansion: {
    label: 'Expansion',
    hint: 'Away from current colonies — minimise own planets in range; use when spreading to a new part of the galaxy',
    weights: { free: 1, inactive: 0.2, occupied: -0.2, bandit: -1, honored: -0.5, mine: -3, length: 0.1 },
  },
};

/**
 * Compute a single comparable score for a region under a given weight set.
 * Higher = better for that strategy.
 *
 * @param {Region} region
 * @param {StrategyWeights} weights
 * @returns {number}
 */
const scoreForStrategy = (region, weights) => {
  const s = region.score;
  // No neighbourhood data — fall back to length only.
  if (!s || !s.scanned) return (weights.length ?? 0) * (region.length / 499);
  const n = s.scanned;
  return (
    (weights.free    ?? 0) * (region.matched / Math.max(region.length, 1)) +
    (weights.inactive ?? 0) * (s.inactive  / n) +
    (weights.occupied ?? 0) * (s.occupied  / n) +
    // bandit/honored: normalise by n×3 so "every system has a max-tier player" = 1.0
    (weights.bandit   ?? 0) * (s.bandits   * s.banditMaxLevel  / (n * 3)) +
    (weights.honored  ?? 0) * (s.honored   * s.honoredMaxLevel / (n * 3)) +
    (weights.mine     ?? 0) * (s.mineNearby / Math.max(s.systemCount, 1)) +
    (weights.length   ?? 0) * (region.length / 499)
  );
};

/**
 * Re-sort an array of regions by the named strategy. Returns a NEW array
 * (does not mutate `regions`). Unknown key falls back to 'longest'.
 *
 * @param {Region[]} regions
 * @param {string} strategyKey — key of {@link STRATEGIES}
 * @returns {Region[]}
 */
export const sortRegionsByStrategy = (regions, strategyKey) => {
  const strategy = STRATEGIES[strategyKey];
  if (!strategy || strategyKey === 'longest') {
    return [...regions].sort((a, b) => b.length - a.length || a.gaps - b.gaps || a.galaxy - b.galaxy);
  }
  const w = strategy.weights;
  // Secondary tiebreaker: length desc so equal-scoring regions still prefer longer.
  return [...regions].sort(
    (a, b) => scoreForStrategy(b, w) - scoreForStrategy(a, w) || b.length - a.length || a.galaxy - b.galaxy,
  );
};

/**
 * Find the best (longest, then fewest-gaps) region per galaxy.
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

  // Step 1: per galaxy, the sorted list of matching systems. One pass over
  // the scan map; a system matches only when EVERY requested slot is
  // confirmed in the requested status.
  /** @type {Map<number, number[]>} */
  const matchesByGalaxy = new Map();
  for (const [key, sysData] of Object.entries(scans)) {
    const colonIdx = key.indexOf(':');
    if (colonIdx <= 0) continue;
    const galaxy = parseInt(key.slice(0, colonIdx), 10);
    const system = parseInt(key.slice(colonIdx + 1), 10);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system)) continue;
    if (system < 1 || system > galaxyMax) continue;
    const posMap = sysData?.positions;
    if (!posMap) continue;
    let all = true;
    for (const p of positions) {
      if (posMap[/** @type {any} */ (String(p))]?.status !== status) { all = false; break; }
    }
    if (!all) continue;
    let arr = matchesByGalaxy.get(galaxy);
    if (!arr) { arr = []; matchesByGalaxy.set(galaxy, arr); }
    arr.push(system);
  }

  // Step 2: per galaxy, two-pointer over the doubled match list. For a
  // window of matches m[i..j] the spanned length is `m[j]-m[i]+1` and its
  // interior gaps are `span - (j-i+1)`; both shrink as `i` advances, so
  // the classic sliding window applies. Constraints: gaps ≤ maxGaps, span
  // ≤ galaxyMax, and at most `k` matches per window (no match reused
  // across the lap boundary). Windows starting in the second lap are
  // shifted duplicates — stop once `i` crosses into it.
  /** @type {Region[]} */
  const results = [];
  for (const [galaxy, arr] of matchesByGalaxy) {
    arr.sort((a, b) => a - b);
    const k = arr.length;
    const m = arr.concat(arr.map((s) => s + galaxyMax));

    /** @type {{ span: number, gaps: number, matched: number, startIdx: number } | null} */
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
      const gaps = span - (j - i + 1);
      if (!best || span > best.span || (span === best.span && gaps < best.gaps)) {
        best = { span, gaps, matched: j - i + 1, startIdx: i };
      }
    }

    if (best) {
      const endIdx = best.startIdx + best.matched - 1;
      /** @type {Region} */
      const region = {
        galaxy,
        start: ((m[best.startIdx] - 1) % galaxyMax) + 1,
        end: ((m[endIdx] - 1) % galaxyMax) + 1,
        length: best.span,
        matched: best.matched,
        gaps: best.gaps,
      };
      region.score = scoreRegion(region, scans, galaxyMax);
      results.push(region);
    }
  }

  // Step 3: longest first; ties prefer cleaner (fewer gaps), then stable
  // galaxy order.
  results.sort((a, b) => b.length - a.length || a.gaps - b.gaps || a.galaxy - b.galaxy);
  return results;
};
