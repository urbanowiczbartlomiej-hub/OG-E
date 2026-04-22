// @ts-check

// Pure domain logic for galaxy / system / position math.
//
// Three small, self-contained helpers used by feature code to translate
// user-supplied target strings into concrete coord work-lists and to
// prioritise nearby systems / galaxies during colonization and scan
// sweeps. Every function in here is pure: deterministic, no DOM, no
// storage, no timers, no network, no hidden state. Inputs in, outputs
// out — that is the whole contract.
//
// Exports:
//   - parsePositions(str)                parse a "8,10-12,15" style list
//   - sysDist(a, b, maxSystem?)          wrap-aware distance on the 1..N ring
//   - buildGalaxyOrder(home, maxGalaxy?) near-first galaxy priority list
//
// Behaviour is ported verbatim from OG-E 4.x (see `mobile.js`) — those
// functions shipped for months and users built muscle memory around
// them. In particular `buildGalaxyOrder` uses modular arithmetic that
// *wraps* galaxies (so from galaxy 1 the "previous" galaxy is the last
// one, not nothing), even though OGame itself does not let ships cross
// that boundary. The wrap keeps the priority list uniform and is kept
// intentionally; see the function's own docstring for detail.
//
// @see ./rules.js for the universe-shape constants.

import {
  COL_MAX_SYSTEM,
  COL_MAX_GALAXY,
  MIN_POSITION,
  MAX_POSITION,
} from './rules.js';

/**
 * Parse a position string into an ordered, deduped list of valid planet
 * positions.
 *
 * Accepted syntax (comma-separated segments, whitespace tolerated):
 *   - single:       "8"          → [8]
 *   - list:         "8,9,10"     → [8, 9, 10]
 *   - range:        "8-12"       → [8, 9, 10, 11, 12]
 *   - reverse:      "10-8"       → [8, 9, 10]   (endpoints are sorted)
 *   - mixed:        "8,10-12,15" → [8, 10, 11, 12, 15]
 *
 * Semantics:
 *   - Order is preserved. The first occurrence of a position wins; any
 *     later repeat is dropped silently. This matters because downstream
 *     code treats the array as a priority queue (first = try first), so
 *     "8,10,8,9" becomes [8, 10, 9], not [8, 10, 9, 8] and not [8, 9, 10].
 *   - Values outside {@link MIN_POSITION}..{@link MAX_POSITION} are
 *     dropped silently. "0,8,16" → [8].
 *   - Empty input or pure whitespace returns an empty array.
 *   - Malformed segments (non-numeric, dangling dash, etc.) are skipped
 *     silently — the function never throws. "8,abc,10,-,5" → [8, 10, 5].
 *
 * @param {string} str  position list in the documented mini-format
 * @returns {number[]}  ordered, deduped list of valid positions
 *
 * @example
 *   parsePositions("8")          // [8]
 *   parsePositions("8,10-12,15") // [8, 10, 11, 12, 15]
 *   parsePositions("8,8,9")      // [8, 9]
 *   parsePositions("0,16,5")     // [5]
 *   parsePositions("")           // []
 *
 * @see MIN_POSITION, MAX_POSITION in ./rules.js
 */
export const parsePositions = (str) => {
  /** @type {number[]} */
  const positions = [];
  /** @type {Set<number>} */
  const seen = new Set();

  if (typeof str !== 'string' || str.length === 0) return positions;

  for (const part of str.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      // Reverse ranges ("10-8") are treated as ascending — 4.x behaviour.
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let i = lo; i <= hi; i++) {
        if (i >= MIN_POSITION && i <= MAX_POSITION && !seen.has(i)) {
          positions.push(i);
          seen.add(i);
        }
      }
      continue;
    }

    // Single-number segment. We deliberately require the whole trimmed
    // segment to be digits; parseInt would accept "8abc" as 8 otherwise,
    // which is sloppier than the 4.x reference intends.
    if (!/^\d+$/.test(trimmed)) continue;
    const n = parseInt(trimmed, 10);
    if (n >= MIN_POSITION && n <= MAX_POSITION && !seen.has(n)) {
      positions.push(n);
      seen.add(n);
    }
  }

  return positions;
};

/**
 * Wrap-aware distance between two systems on the 1..maxSystem ring.
 *
 * OGame's galaxy view wraps: system 1 and system {@link COL_MAX_SYSTEM}
 * are one step apart, not `COL_MAX_SYSTEM - 1` steps. The minimum of the
 * two arc lengths is the right answer for flight-time ranking.
 *
 * Symmetric: `sysDist(a, b) === sysDist(b, a)`.
 * Non-negative, zero iff `a === b`.
 *
 * @param {number} a          system number, 1..maxSystem
 * @param {number} b          system number, 1..maxSystem
 * @param {number} [maxSystem=COL_MAX_SYSTEM]  ring size; default = COL_MAX_SYSTEM (499)
 * @returns {number}          smaller of the two arc distances (>= 0)
 *
 * @example
 *   sysDist(10, 50)         // 40
 *   sysDist(498, 2, 499)    // 3   (wraps via 499 → 1)
 *   sysDist(1, 499, 499)    // 1   (directly adjacent across the wrap)
 *   sysDist(50, 50)         // 0
 *
 * @see COL_MAX_SYSTEM in ./rules.js
 */
export const sysDist = (a, b, maxSystem = COL_MAX_SYSTEM) => {
  const d = Math.abs(a - b);
  return Math.min(d, maxSystem - d);
};

/**
 * Build the galaxy traversal order starting from `homeGalaxy` and
 * expanding outward in alternating ±d steps. The first galaxy is always
 * home, then home+1, home-1, home+2, home-2, … — but galaxy indices are
 * wrapped modulo `maxGalaxy` (so from galaxy 1, the "-1" direction lands
 * on `maxGalaxy`, not on the nonexistent galaxy 0).
 *
 * Why modular wrap? OGame itself does *not* let fleets cross the
 * galaxy-1 / galaxy-N boundary, so physically the wrap is fictional.
 * 4.x wrapped anyway, because the resulting list is uniform (always
 * length `maxGalaxy`, always covers every galaxy once) and the ordering
 * still produces a reasonable near-first priority when the user is near
 * an edge. We keep that decision for behavioural parity — users built
 * habits on it.
 *
 * Result properties (guaranteed):
 *   - `result.length === maxGalaxy`
 *   - `result[0] === homeGalaxy`
 *   - every value is in 1..maxGalaxy
 *   - no duplicates
 *
 * @param {number} homeGalaxy            galaxy of the active planet, 1..maxGalaxy
 * @param {number} [maxGalaxy=COL_MAX_GALAXY]  universe width; default = COL_MAX_GALAXY (7)
 * @returns {number[]}                   all galaxies, near-first
 *
 * @example
 *   buildGalaxyOrder(4, 7)  // [4, 5, 3, 6, 2, 7, 1]
 *   buildGalaxyOrder(1, 7)  // [1, 2, 7, 3, 6, 4, 5]  (wraps at the edge)
 *   buildGalaxyOrder(7, 7)  // [7, 1, 6, 2, 5, 3, 4]
 *   buildGalaxyOrder(1, 3)  // [1, 2, 3]
 *
 * @see COL_MAX_GALAXY in ./rules.js
 */
export const buildGalaxyOrder = (homeGalaxy, maxGalaxy = COL_MAX_GALAXY) => {
  /** @type {number[]} */
  const order = [homeGalaxy];
  for (let d = 1; d <= Math.floor(maxGalaxy / 2); d++) {
    const g1 = ((homeGalaxy - 1 + d) % maxGalaxy) + 1;
    const g2 = ((homeGalaxy - 1 - d + maxGalaxy) % maxGalaxy) + 1;
    if (!order.includes(g1)) order.push(g1);
    if (!order.includes(g2)) order.push(g2);
  }
  return order;
};
