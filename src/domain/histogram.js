// @ts-check

// Histogram domain — pure transforms from raw storage data into the shapes
// the histogram page renders directly.
//
// The histogram page runs in the extension origin (separate JS realm from
// the game-origin content scripts), but reads the same persisted shapes
// that `state/history.js` and `state/scans.js` own on the game side. The
// functions here work from either realm with zero branching — they never
// touch DOM, storage, timers, or module-level state.
//
// Exports:
//   - STATUS_PRIORITY                          ordered PositionStatus list
//   - parseTargetPositions(str)                → Set<number>
//   - bestStatusInSystem(positions, targets)   → PositionStatus | null
//   - computeFieldStats(entries)               → summary stats of `fields` column
//   - buildFieldBuckets(entries)               → Map<fields, count> (sorted)
//   - collectGalaxyStats(scans, targets)       → global + per-galaxy tallies
//
// @see ../state/scans.js  — GalaxyScans / SystemScan shapes
// @see ../state/history.js — ColonyHistory / ColonyEntry shapes
// @see ./scans.js         — PositionStatus / Position typedefs
// @see ./positions.js     — parsePositions underlying parser

import { parsePositions } from './positions.js';

/**
 * @typedef {import('./scans.js').Position} Position
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../state/scans.js').SystemScan} SystemScan
 * @typedef {import('../state/history.js').ColonyEntry} ColonyEntry
 */

/**
 * Status interest order for the galaxy pixel map and legend. The pixel
 * map colours each system by the single "most interesting" status among
 * the user's target positions — first match in this list wins.
 *
 * Rationale for the specific ordering:
 *
 *   - `empty` first, because a colonisable slot is the *actionable* state
 *     the user is hunting for. If a system has even one empty target
 *     position, that's what they want the pixel to show.
 *   - `empty_sent` next — already claimed by us, still actionable info
 *     (don't re-send).
 *   - `abandoned` next — short-lived debris-slot state that is about to
 *     become `empty` (24-48h sweep). The user may want to revisit.
 *   - `reserved` — slot held for planet-move by another player; clears
 *     in ~22h, so worth checking back on.
 *   - long/short inactive, vacation, banned — interesting for scouting.
 *   - `mine` / `admin` / `occupied` last — least actionable.
 *
 * @type {PositionStatus[]}
 */
export const STATUS_PRIORITY = [
  'empty',
  'empty_sent',
  'abandoned',
  'reserved',
  'long_inactive',
  'inactive',
  'vacation',
  'banned',
  'mine',
  'admin',
  'occupied',
];

/**
 * Parse a target-position string (e.g. `"8"`, `"8,10-12"`) into a Set.
 *
 * Thin wrapper around {@link parsePositions} that drops the ordered-array
 * semantics and returns a Set instead — the histogram only ever asks
 * "is position P in my target list?", and Set membership is cheaper and
 * more legible than `arr.includes(p)`.
 *
 * @param {string} str
 * @returns {Set<number>}
 *
 * @example
 *   parseTargetPositions("8")          // Set {8}
 *   parseTargetPositions("8,10-12,15") // Set {8, 10, 11, 12, 15}
 *   parseTargetPositions("")           // Set {}
 */
export const parseTargetPositions = (str) => new Set(parsePositions(str));

/**
 * Pick the single highest-priority {@link PositionStatus} among the
 * user's target positions in one system. Returns `null` iff no target
 * position has any recorded status yet (missing, or the whole
 * `positions` map is empty / nullish).
 *
 * Algorithm: for each status in `priority` (in order), scan every
 * target position looking for a match. The first hit wins. This is
 * O(|priority| × |targets|) but both are tiny (≤10 and ≤15).
 *
 * An unknown status in the data (one not present in `priority`) is
 * silently ignored — the pixel will fall back to "no data" colouring
 * upstream. That keeps the histogram robust if the domain ever gains a
 * new status that the prio list hasn't yet been updated for.
 *
 * @param {Record<number, Position> | undefined | null} positions
 *   The system's per-slot map (1..15 → Position). Treated as empty when
 *   nullish.
 * @param {Set<number>} targetPositions
 *   The user's configured colonize targets — see
 *   {@link parseTargetPositions}.
 * @param {PositionStatus[]} [priority]
 *   Ordering; defaults to {@link STATUS_PRIORITY}. Exposed for tests and
 *   for any future caller that wants a different interest ordering.
 * @returns {PositionStatus | null}
 */
export const bestStatusInSystem = (
  positions,
  targetPositions,
  priority = STATUS_PRIORITY,
) => {
  if (!positions) return null;
  for (const status of priority) {
    for (const pos of targetPositions) {
      if (positions[pos]?.status === status) return status;
    }
  }
  return null;
};

/**
 * Summary statistics of the `fields` column in a {@link ColonyEntry}
 * list — the numbers that drive the top stat-card row on the colony
 * histogram.
 *
 * Empty input returns a zero-filled record so downstream render code
 * doesn't need to branch on "is there any data?" — an empty histogram
 * is rendered separately (empty-state message).
 *
 * `avg` and `median` are rounded to the nearest integer: the histogram
 * displays them as integer field counts, and the extra decimals would
 * just add visual noise to a stat that's already fuzzy.
 *
 * @param {ReadonlyArray<ColonyEntry>} entries
 * @returns {{ count: number, min: number, max: number, avg: number, median: number }}
 */
export const computeFieldStats = (entries) => {
  if (entries.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, median: 0 };
  }
  const fields = entries.map((e) => e.fields).sort((a, b) => a - b);
  const count = fields.length;
  const min = fields[0];
  const max = fields[count - 1];
  const sum = fields.reduce((s, v) => s + v, 0);
  const avg = Math.round(sum / count);
  const median = count % 2 === 0
    ? Math.round((fields[count / 2 - 1] + fields[count / 2]) / 2)
    : fields[Math.floor(count / 2)];
  return { count, min, max, avg, median };
};

/**
 * Build a (fields → count) Map sorted ascending by fields value.
 *
 * Used by the bar-chart renderer: each entry produces one bar, ordered
 * from smallest `fields` on the left to largest on the right. Map is
 * returned (rather than a plain object) because numeric-key object
 * iteration order is technically engine-specific, while Map guarantees
 * insertion order.
 *
 * @param {ReadonlyArray<ColonyEntry>} entries
 * @returns {Map<number, number>}
 */
export const buildFieldBuckets = (entries) => {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const e of entries) {
    counts.set(e.fields, (counts.get(e.fields) || 0) + 1);
  }
  // Rebuild from a sorted snapshot so the returned Map iterates low→high.
  const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  return new Map(sorted);
};

/**
 * Per-system tally: one counter per {@link PositionStatus} plus a
 * running `total` of counted positions (= sum of all status counters
 * plus any unknown-status observations, which advance `total` but no
 * per-status bucket).
 *
 * `total` is tracked separately so callers can compute per-status
 * percentages without re-summing the record.
 *
 * Exported for cross-module typing — the histogram renderers in
 * `features/histogram/` type their args against this.
 *
 * @typedef {{
 *   total: number,
 *   empty: number,
 *   empty_sent: number,
 *   abandoned: number,
 *   reserved: number,
 *   long_inactive: number,
 *   inactive: number,
 *   vacation: number,
 *   banned: number,
 *   mine: number,
 *   admin: number,
 *   occupied: number,
 * }} StatusCounts
 */

/**
 * Zero-filled {@link StatusCounts}. Factory rather than a const so each
 * caller gets its own mutable record (important — `collectGalaxyStats`
 * mutates in place while summing).
 *
 * @returns {StatusCounts}
 */
const makeZeroCounts = () => {
  /** @type {Record<string, number>} */
  const out = { total: 0 };
  for (const s of STATUS_PRIORITY) out[s] = 0;
  return /** @type {StatusCounts} */ (/** @type {unknown} */ (out));
};

/**
 * Collect per-status tallies across all scanned systems, limited to the
 * user's target positions. Produces two views:
 *
 *   - `global`   — single {@link StatusCounts} over every system.
 *   - `byGalaxy` — per-galaxy {@link StatusCounts}, keyed by galaxy
 *                  number (1..N) extracted from each system key.
 *
 * Why limit to target positions: a typical system has 14 empty slots
 * and one occupied one. Counting ALL positions would make every bar
 * chart and stat card 90% green noise, drowning out the signal the
 * user actually cares about (their colonize targets).
 *
 * Defensive parsing: a malformed system key (missing `":"`, non-numeric
 * galaxy) is silently skipped. A `null` / missing `positions` map on a
 * system is skipped too. Unknown statuses (not in {@link STATUS_PRIORITY})
 * still count toward `total` — they just don't land in any per-status
 * bucket.
 *
 * @param {GalaxyScans} scans
 * @param {Set<number>} targetPositions
 * @returns {{ global: StatusCounts, byGalaxy: Record<number, StatusCounts> }}
 */
export const collectGalaxyStats = (scans, targetPositions) => {
  const global = makeZeroCounts();
  /** @type {Record<number, StatusCounts>} */
  const byGalaxy = {};

  for (const [key, systemScan] of Object.entries(scans)) {
    if (!systemScan || !systemScan.positions) continue;
    const g = Number(key.split(':')[0]);
    if (!Number.isFinite(g)) continue;
    if (!byGalaxy[g]) byGalaxy[g] = makeZeroCounts();
    const galStats = byGalaxy[g];

    for (const pos of targetPositions) {
      const p = systemScan.positions[pos];
      if (!p) continue;
      global.total++;
      galStats.total++;
      if (p.status && Object.prototype.hasOwnProperty.call(global, p.status)) {
        // Narrow p.status from the broad string union to a known key via
        // the hasOwnProperty guard just above.
        const k = /** @type {PositionStatus} */ (p.status);
        global[k]++;
        galStats[k]++;
      }
    }
  }

  return { global, byGalaxy };
};
