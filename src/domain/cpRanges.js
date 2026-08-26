// Run-length index over OGame planet cp-ids.
//
// # Why this exists
//
// `state/history.js` holds one `ColonyEntry` per colony we have ever
// observed — the histogram dataset. It grows forever by design (see that
// file on why abandoned colonies must never be pruned), and at a measured
// ~14 observations/day per universe it reaches five figures within a couple
// of years. The full array costs ~89 bytes per row; 10k rows is ~870 KB of
// UNCOMPRESSED `chrome.storage.local` that the content script used to
// deserialize on EVERY OGame page-load, in EVERY frame.
//
// But the only thing `features/colonyRecorder.js` needs on a page-load is a
// yes/no answer: "have I already recorded planet cp X?" — a membership test
// over a set of integers, not the rows themselves.
//
// # Why RANGES rather than a flat cp list
//
// OGame assigns cp-ids from one global, monotonically increasing counter, so
// consecutive colonizations get consecutive ids. A colonize-heavy account
// therefore produces long unbroken runs: in a real 1474-observation universe
// 1178 of the 1473 gaps between sorted cps were exactly 1, collapsing the
// whole set into 296 runs. Measured on that data:
//
//   flat cp array (JSON)          13 267 B
//   [[start, end], ...]            5 921 B
//   this encoding                  1 413 B
//
// ~9x smaller than the flat list, and ~93x smaller than the history rows it
// replaces on the hot path.
//
// # Wire format
//
// A flat `number[]` of (delta, length) PAIRS, ascending, no overlaps:
//
//   [ start0, len0, gap1, len1, gap2, len2, ... ]
//
//   - `start0` is the first run's absolute start.
//   - `lenN` is how many consecutive cps that run covers (>= 1).
//   - `gapN` (N > 0) is `startN - endN-1`, so it is always >= 2 — a gap of 1
//     would mean the runs are adjacent, and `encodeCpRanges` would have
//     merged them into one.
//
// Flat pairs rather than nested tuples because JSON spends two bytes per
// nested array on brackets, which at 296 runs is most of the difference
// between the second and third rows of the table above.
//
// # The under-report invariant (the reason this is safe to cache)
//
// Every reader here treats a malformed or truncated payload as "the rest of
// the index does not exist" and answers NEGATIVELY, never positively. That
// direction is deliberate, and it is what makes this an index rather than a
// second source of truth:
//
//   - Says "not known" when it IS known  ->  the caller falls through to the
//     real history array, finds the cp there, records nothing, and rewrites
//     the index. Cost: one slow page-load. Nothing is lost.
//   - Says "known" when it is NOT        ->  the caller silently skips a real
//     observation. That datum is gone forever.
//
// So a false negative is a performance bug and a false positive is a data
// loss bug. Corruption, version skew and partially-written payloads must all
// land on the false-negative side — hence the early `return` (not `throw`,
// and not "skip the bad pair and keep going", which would shift every
// subsequent delta and could then report a cp we have never seen).
//
// @ts-check

/**
 * Encode a set of cp-ids into the flat (delta, length) form described in the
 * module header.
 *
 * Input may be in any order and may repeat — both are normalised. Non-integer
 * and negative values are dropped rather than encoded: they cannot be real
 * cp-ids, and letting one through would corrupt every delta after it.
 *
 * @param {Iterable<number>} cps
 * @returns {number[]} Flat pair array; `[]` for an empty input.
 */
export const encodeCpRanges = (cps) => {
  const sorted = [...new Set(cps)]
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  /** @type {number[]} */
  const flat = [];
  // `prevEnd < 0` doubles as "no run emitted yet", which is what selects the
  // absolute-start encoding for the very first pair.
  let prevEnd = -1;
  let runStart = -1;
  let runEnd = -1;

  const emit = () => {
    if (runStart < 0) return;
    flat.push(prevEnd < 0 ? runStart : runStart - prevEnd, runEnd - runStart + 1);
    prevEnd = runEnd;
  };

  for (const cp of sorted) {
    if (runStart < 0) {
      runStart = cp;
      runEnd = cp;
    } else if (cp === runEnd + 1) {
      runEnd = cp;
    } else {
      emit();
      runStart = cp;
      runEnd = cp;
    }
  }
  emit();
  return flat;
};

/**
 * Test whether `cp` is covered by the index.
 *
 * Walks the pairs without materialising the runs, and exits early once the
 * runs have ascended past `cp` — the encoding guarantees ascending order, so
 * a `cp` below the current run's start cannot appear in any later run. At 296
 * runs a miss costs a few hundred integer additions.
 *
 * Answers `false` for anything that is not a well-formed index, and stops at
 * the first malformed pair — see the under-report invariant in the module
 * header for why that is the safe direction.
 *
 * @param {unknown} flat  Candidate index, straight out of storage.
 * @param {number} cp
 * @returns {boolean}
 */
export const cpRangesHas = (flat, cp) => {
  if (!Array.isArray(flat) || !Number.isInteger(cp)) return false;
  let prevEnd = -1;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const delta = flat[i];
    const len = flat[i + 1];
    if (!Number.isInteger(delta) || !Number.isInteger(len) || len < 1) return false;
    const start = prevEnd < 0 ? delta : prevEnd + delta;
    const end = start + len - 1;
    if (cp < start) return false;
    if (cp <= end) return true;
    prevEnd = end;
  }
  return false;
};

/**
 * Decode the flat form back into absolute inclusive `[start, end]` runs.
 *
 * Not used on the recorder's hot path — `cpRangesHas` answers without
 * allocating. This exists for tests and diagnostics, where comparing runs is
 * far more legible than comparing deltas.
 *
 * A malformed pair truncates the result: the runs decoded so far are
 * returned and the rest is treated as absent, the same under-report
 * direction as `cpRangesHas`.
 *
 * @param {unknown} flat
 * @returns {Array<[number, number]>}
 */
export const decodeCpRanges = (flat) => {
  /** @type {Array<[number, number]>} */
  const runs = [];
  if (!Array.isArray(flat)) return runs;
  let prevEnd = -1;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const delta = flat[i];
    const len = flat[i + 1];
    if (!Number.isInteger(delta) || !Number.isInteger(len) || len < 1) return runs;
    const start = prevEnd < 0 ? delta : prevEnd + delta;
    const end = start + len - 1;
    runs.push([start, end]);
    prevEnd = end;
  }
  return runs;
};
