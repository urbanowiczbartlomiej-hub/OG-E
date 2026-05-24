// Galaxy-streak finder — pure analyzer that walks the recorded
// galaxy-scan dataset and returns the longest consecutive runs of
// systems where a chosen slot has a chosen status.
//
// # What and why
//
// Players colonising a fresh universe often want to know: "where is
// the longest stretch of consecutive systems whose position 15 is
// confirmed empty?" That answers practical questions like which
// galaxy + system range to plant a row of moons in, or where to scout
// a stretch of `inactive` farms with no live defenders between.
//
// The function is generic in two axes — `position` (1..15) and
// `status` (any `PositionStatus`) — so the histogram UI can wire one
// renderer that supports more shapes than just the position-15 / empty
// case the v1.2.0 UI exposes.
//
// # Strictness: confirmed matches only
//
// A system that was never scanned, OR a system that was scanned but
// whose chosen `position` has a non-matching status, BREAKS the run.
// We never extrapolate over unknown territory. The returned lengths
// are therefore a LOWER BOUND on the true longest run — if the player
// finishes scanning the rest of their galaxy and re-runs the analyzer,
// reported lengths can only grow.
//
// # Wrap-around
//
// OGame galaxies are circular (system 499 sits next to system 1).
// A run that crosses that boundary — e.g. {497, 498, 499, 1, 2, 3} —
// is a single length-6 run, not two length-3 fragments. The walk
// loops 1..galaxyMax twice in sequence; runs that span the boundary
// naturally continue across the gap between iteration 1 and
// iteration 2 (because the inner loop never resets `curr` at the
// boundary, only when it hits a non-match).
//
// Optimisation: the early break on `currLength >= matches.size`
// short-circuits the second lap when the whole match set is one
// continuous streak — and also caps the worst case at a single full
// walk for galaxies where every system matches.
//
// Pure function, no DOM, no storage, no clock — matches the
// `domain/` purity contract.
//
// @ts-check

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
 */

/**
 * One reported run.
 *
 * @typedef {object} Streak
 * @property {number} galaxy  1-indexed galaxy number.
 * @property {number} start   First system in the run (1..galaxyMax,
 *   inclusive). For wrap-around runs this is the system on the
 *   "earlier" side of the boundary (e.g. 497 for the {497..499, 1..3}
 *   run); the run reads naturally as `start → end` in display.
 * @property {number} end     Last system in the run (1..galaxyMax,
 *   inclusive). Computed `((start - 1 + length - 1) % galaxyMax) + 1`
 *   so wrap-around is built in.
 * @property {number} length  Number of consecutive matching systems.
 *   Always ≥ 1 in the returned list.
 */

/**
 * @typedef {object} FindStreaksOptions
 * @property {number} position
 *   Slot to inspect, 1..15. Coerced to its string form internally so
 *   it matches the integer-string keys JSON serialises numbers under.
 * @property {PositionStatus} [status]
 *   Status to count as a "match". Defaults to `'empty'` — the
 *   colonise-a-fresh-row use case the feature was named for.
 * @property {number} [galaxyMax]
 *   Number of systems per galaxy. Defaults to `499`, OGame's
 *   universe constant. Exposed so tests can use small fixtures
 *   without manufacturing thousands of placeholder systems.
 */

/**
 * Find the longest matching run per galaxy.
 *
 * @param {GalaxyScans} scans  Full per-system scan map. Keys are
 *   `"galaxy:system"`.
 * @param {FindStreaksOptions} opts
 * @returns {Streak[]}  Sorted by `length` descending; ties broken by
 *   galaxy ascending. Galaxies with zero matches do not appear in
 *   the result.
 */
export const findLongestStreaks = (scans, opts) => {
  const positionKey = String(opts.position);
  const status = opts.status ?? 'empty';
  const galaxyMax = opts.galaxyMax ?? 499;

  // Step 1: collect matches per galaxy.
  //
  // We bucket systems by galaxy into a Set of matching system numbers.
  // Doing this in a single pass over the scan map (rather than
  // re-querying per galaxy) keeps the total work proportional to the
  // scan count, not the galaxy count × scan count.
  /** @type {Map<number, Set<number>>} */
  const matchesByGalaxy = new Map();
  for (const [key, sysData] of Object.entries(scans)) {
    // Split once — `"4:30"` → galaxy 4, system 30. A malformed key
    // (no colon, empty galaxy/system) is skipped silently rather than
    // throwing: this function is read-only over potentially-imported
    // data, so resilience against garbage matters.
    const colonIdx = key.indexOf(':');
    if (colonIdx <= 0) continue;
    const galaxy = parseInt(key.slice(0, colonIdx), 10);
    const system = parseInt(key.slice(colonIdx + 1), 10);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system)) continue;
    if (system < 1 || system > galaxyMax) continue;

    const slot = sysData?.positions?.[/** @type {any} */ (positionKey)];
    if (!slot || slot.status !== status) continue;

    let set = matchesByGalaxy.get(galaxy);
    if (!set) {
      set = new Set();
      matchesByGalaxy.set(galaxy, set);
    }
    set.add(system);
  }

  // Step 2: for each galaxy, walk 1..galaxyMax twice and track the
  // longest contiguous run of matching systems.
  /** @type {Streak[]} */
  const results = [];

  for (const [galaxy, matches] of matchesByGalaxy) {
    if (matches.size === 0) continue;

    let bestStart = -1;
    let bestLength = 0;
    let currStart = -1;
    let currLength = 0;

    outer: for (let lap = 0; lap < 2; lap++) {
      for (let s = 1; s <= galaxyMax; s++) {
        if (matches.has(s)) {
          if (currLength === 0) currStart = s;
          currLength += 1;
          // Short-circuit: if the running streak equals the total
          // number of matches, no longer run can exist anywhere
          // (and continuing would either find a same-length tie or
          // double-count). This also caps the work for the
          // "entire galaxy matches" degenerate case at one lap.
          if (currLength >= matches.size) {
            bestLength = matches.size;
            bestStart = currStart;
            break outer;
          }
          if (currLength > bestLength) {
            bestLength = currLength;
            bestStart = currStart;
          }
        } else {
          // A break in the run — either an unscanned system or a
          // scanned system with a non-matching status. Reset and
          // wait for the next match to start a fresh run.
          currLength = 0;
          currStart = -1;
        }
      }
      // Inter-lap: `curr*` deliberately survives the lap boundary so
      // a run that ends at `galaxyMax` and continues at `1` is
      // captured as one continuous streak — that is the whole point
      // of the second lap.
    }

    if (bestLength > 0) {
      const end = ((bestStart - 1 + bestLength - 1) % galaxyMax) + 1;
      results.push({ galaxy, start: bestStart, end, length: bestLength });
    }
  }

  // Step 3: sort by length descending; ties broken deterministically
  // by ascending galaxy id so repeated calls produce stable output
  // (useful for tests and for the histogram's render diffing).
  results.sort((a, b) => b.length - a.length || a.galaxy - b.galaxy);
  return results;
};
