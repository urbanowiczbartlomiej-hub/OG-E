// @ts-check

// Rescan scheduling policy — when is a system's cached scan too stale
// to trust.
//
// Every known position status maps to either a rescan threshold (ms of
// age after which we need to re-observe it) or is absent from the map,
// meaning "never stale, the scan is always good enough". Why per-status
// thresholds at all? Because the cost/benefit of re-scanning varies
// drastically by what's in the slot:
//
//   - `empty`, `mine`, `admin`
//       Game semantics give us no reason to expect change. An empty slot
//       only becomes non-empty via a fresh colonization; we'll observe
//       that on our own next sweep anyway. A slot that is `mine` is
//       under our own control. `admin` slots are game-master accounts
//       and effectively frozen. None of these three warrant a rescan —
//       they are absent from {@link RESCAN_AFTER} on purpose.
//
//   - `empty_sent` (4h)
//       We dispatched a colonizer here. The game still shows the slot
//       as empty until the fleet lands. Four hours is enough to cover
//       the flight time of any practical colonize mission plus a margin;
//       after that we re-scan to see whether it became `mine` (success),
//       stayed `empty` (recalled / intercepted), or got stolen under us
//       (`occupied`, `abandoned`, …).
//
//   - `abandoned` (24h)
//       The "Porzucona planeta" debris marker persists 24-48h after
//       abandonment; after ~24h the game's cleanup sweep can clear it,
//       so we need a fresh look to know whether the slot is now truly
//       `empty` and available for colonization. (4.x also had a dynamic
//       "earliest 3 AM server time" deadline on top of this; v5 keeps
//       just the flat 24h threshold for simplicity — any small over-wait
//       is harmless, whereas under-waiting would double-rescan.)
//
//   - `inactive` / `long_inactive` (5d)
//       The game's `i` and `I` flags track dormancy windows (7-28 days
//       and 28+ days respectively). Five days is short enough to catch
//       a flag flip soon after it happens but long enough to avoid
//       spam-rescanning stable inactive accounts.
//
//   - `vacation`, `banned`, `occupied` (30d)
//       These change rarely. Vacations are typically days to a few
//       weeks; bans either hold or are lifted on a scale of weeks; an
//       active player moving out of `occupied` is uncommon. 30 days
//       keeps our cache useful without pretending these never change.
//
// Time flows in explicitly via a `now` argument (default `Date.now()`
// for call-site convenience). The function is otherwise pure: no DOM,
// no storage, no module-level mutable state. Unit tests pass a stable
// `now` to stay deterministic.

/**
 * @typedef {import('./scans.js').PositionStatus} PositionStatus
 */

/**
 * Rescan threshold (ms) per position status. A system is stale if ANY
 * of its positions has a status listed here whose age exceeds the
 * mapped threshold.
 *
 * Statuses ABSENT from this map are treated as never-stale — an
 * `empty`, `mine`, or `admin` slot can live in the cache indefinitely
 * without prompting a rescan (see the module header for the reasoning
 * per status).
 *
 * @type {Readonly<{ [K in PositionStatus]?: number }>}
 */
export const RESCAN_AFTER = Object.freeze({
  abandoned:     24 * 3600 * 1000,        // 24h  — debris marker can clear after ~24h
  inactive:      5 * 24 * 3600 * 1000,    // 5d   — the `i` flag may flip
  long_inactive: 5 * 24 * 3600 * 1000,    // 5d   — the `I` flag may flip
  vacation:      30 * 24 * 3600 * 1000,   // 30d  — rarely changes
  banned:        30 * 24 * 3600 * 1000,   // 30d  — rarely changes
  occupied:      30 * 24 * 3600 * 1000,   // 30d  — player might still leave
  empty_sent:    4 * 3600 * 1000,         // 4h   — our colonizer should have landed; verify
});

/**
 * Minimal shape of a stored system scan as consumed by this module.
 * We do NOT depend on scans.js's fuller `Position` type here: every
 * field we look at is `status`, so a local structural typedef keeps
 * the dependency surface small and lets tests pass simple fixtures
 * without importing the scans module at all.
 *
 * @typedef {object} StaleCheckScan
 * @property {number} [scannedAt] ms timestamp of when this scan was
 *   captured. Missing or falsy → the scan has no usable timestamp and
 *   must be treated as stale.
 * @property {Record<number, { status: PositionStatus }>} [positions]
 *   Per-slot classification. Missing or empty → we have no observable
 *   positions and must be treated as stale.
 */

/**
 * Decide whether a stored system scan is stale enough to re-observe.
 *
 * Returns `true` — the system needs a rescan — when any of these hold:
 *
 *   1. `scan` is `null` or `undefined` (no data at all)
 *   2. `scan.positions` is missing or an empty object (no slots known)
 *   3. `scan.scannedAt` is missing or falsy (no timestamp to age off)
 *   4. ANY position's status maps to a threshold in {@link RESCAN_AFTER}
 *      and `now - scannedAt` STRICTLY exceeds that threshold
 *
 * Returns `false` only when we have a timestamped scan with at least
 * one position and every thresholded position is still within its
 * window. Positions whose status is absent from {@link RESCAN_AFTER}
 * (empty / mine / admin) contribute nothing to the staleness decision
 * — they can be arbitrarily old and still read as fresh.
 *
 * The comparison is strict `>`, not `>=`, so a scan at exactly the
 * threshold age is still fresh by one tick. This matters for tests
 * that hit the boundary exactly; in practice the distinction doesn't
 * survive a single `Date.now()` tick.
 *
 * @param {StaleCheckScan | null | undefined} scan The system's cached
 *   scan record (e.g. from `oge_galaxyScans`). `null` / `undefined`
 *   both read as "no data" and return true.
 * @param {number} [now=Date.now()] Wall-clock ms used to compute age.
 *   Defaulted for call-site convenience; tests should pass a stable
 *   value to stay deterministic.
 * @returns {boolean} `true` if the scan should be refreshed.
 *
 * @example
 *   // Fresh empty_sent (1h old, threshold 4h) — NOT stale:
 *   isSystemStale(
 *     { scannedAt: now - 3600_000, positions: { 8: { status: 'empty_sent' } } },
 *     now,
 *   ); // false
 *
 * @example
 *   // Old empty_sent (5h old, threshold 4h) — stale:
 *   isSystemStale(
 *     { scannedAt: now - 5 * 3600_000, positions: { 8: { status: 'empty_sent' } } },
 *     now,
 *   ); // true
 *
 * @example
 *   // Ancient but only empty/mine/admin — NOT stale, they're stable:
 *   isSystemStale(
 *     { scannedAt: now - 1000 * 86400_000, positions: { 8: { status: 'empty' } } },
 *     now,
 *   ); // false
 *
 * @example
 *   // Mixed slots: one stable, one past its threshold — stale:
 *   isSystemStale(
 *     {
 *       scannedAt: now - 25 * 3600_000,
 *       positions: { 8: { status: 'empty' }, 9: { status: 'abandoned' } },
 *     },
 *     now,
 *   ); // true — abandoned has a 24h threshold, 25h > 24h
 */
export const isSystemStale = (scan, now = Date.now()) => {
  if (!scan) return true;
  if (!scan.scannedAt) return true;
  if (!scan.positions) return true;

  const age = now - scan.scannedAt;
  let anyPosition = false;
  for (const key of Object.keys(scan.positions)) {
    anyPosition = true;
    const p = scan.positions[Number(key)];
    if (!p) continue;
    const threshold = RESCAN_AFTER[p.status];
    if (threshold !== undefined && age > threshold) return true;
  }
  if (!anyPosition) return true;

  return false;
};
