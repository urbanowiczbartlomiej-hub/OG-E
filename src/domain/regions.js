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
      results.push({
        galaxy,
        start: ((m[best.startIdx] - 1) % galaxyMax) + 1,
        end: ((m[endIdx] - 1) % galaxyMax) + 1,
        length: best.span,
        matched: best.matched,
        gaps: best.gaps,
      });
    }
  }

  // Step 3: longest first; ties prefer cleaner (fewer gaps), then stable
  // galaxy order.
  results.sort((a, b) => b.length - a.length || a.gaps - b.gaps || a.galaxy - b.galaxy);
  return results;
};
