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
 *   (`rankClass` starts with `"rank_bandit"`). A proxy for combat-active
 *   neighbours (though it can reflect defence too — use as a soft signal).
 * @property {number} honored    Players with positive honor (non-bandit
 *   ranked class — likely `rank_general*` / `rank_starlord*`).
 * @property {number} allianceCount Distinct alliance tags seen in range.
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

  for (const sys of systems) {
    const sysData = scans[`${region.galaxy}:${sys}`];
    if (!sysData?.positions) continue;
    scanned++;
    for (const pos of Object.values(sysData.positions)) {
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
  }

  let occupied = 0;
  let inactive = 0;
  for (const st of playerStatus.values()) {
    if (st === 'occupied') occupied++;
    else if (st === 'inactive' || st === 'long_inactive' || st === 'vacation') inactive++;
  }

  const ranks = [...playerRank.values()].sort((a, b) => a - b);

  let bandits = 0;
  let honored = 0;
  for (const rc of playerRankClass.values()) {
    if (rc.startsWith('rank_bandit')) bandits++;
    else honored++;
  }

  return {
    systemCount: systems.length,
    scanned,
    occupied,
    inactive,
    ranks,
    bandits,
    honored,
    allianceCount: alliances.size,
  };
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
