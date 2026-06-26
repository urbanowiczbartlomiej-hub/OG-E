// @ts-check

// Pure scan-status logic shared by the in-game spy FAB (which planet to scan
// next) and the dashboard Targets table (the per-planet status + freshness
// readout). It lives in domain/ precisely because BOTH a feature
// (features/sendSpy) AND another feature (features/dashboard) need it, and the
// architecture forbids feature→feature imports — domain is the shared floor.
//
// A planet "needs a scan" when we have no report, the report is stale (older
// than the threshold), or the user explicitly flagged a re-scan AFTER the report
// was taken (because the target's defenses/fleet may have changed). The re-scan
// flag is a timestamp ("treat any report older than this as stale"); it clears
// itself the moment a newer report lands.

/** A spy report older than this is stale — re-scan to refresh the estimate. */
export const SPY_STALE_MS = 7 * 24 * 3600 * 1000;

/**
 * Scan status of one planet:
 *   - `none`   — never spied (no report on file).
 *   - `fresh`  — report on file, recent, not flagged for re-scan.
 *   - `stale`  — report older than the stale threshold.
 *   - `rescan` — a re-scan was requested after this report was taken.
 *
 * @param {object} a
 * @param {number} [a.reportTsSec]  Newest report timestamp (epoch SECONDS); absent = none.
 * @param {number} a.nowMs
 * @param {number} [a.rescanAtMs]   "treat reports before this as stale" mark (epoch MS).
 * @param {number} [a.staleMs]      Stale threshold (default {@link SPY_STALE_MS}).
 * @returns {'none'|'fresh'|'stale'|'rescan'}
 */
export function scanStatus({ reportTsSec, nowMs, rescanAtMs = 0, staleMs = SPY_STALE_MS }) {
  if (!reportTsSec || reportTsSec <= 0) return 'none';
  const reportMs = reportTsSec * 1000;
  if (rescanAtMs && reportMs < rescanAtMs) return 'rescan';
  if (nowMs - reportMs > staleMs) return 'stale';
  return 'fresh';
}

/**
 * Does this status mean the FAB should (re)scan the planet?
 * @param {'none'|'fresh'|'stale'|'rescan'} status
 * @returns {boolean}
 */
export const needsScan = (status) => status !== 'fresh';

/**
 * Effective "re-scan requested at" (epoch MS) for a planet, from a rescan map
 * that may be keyed by player id (whole player) and/or "g:s:p" coord (single
 * planet) — the later of the two wins.
 * @param {Record<string, number> | undefined} rescan
 * @param {string} playerId
 * @param {string} coord  "g:s:p"
 * @returns {number}
 */
export function rescanAtFor(rescan, playerId, coord) {
  if (!rescan) return 0;
  return Math.max(rescan[playerId] || 0, rescan[coord] || 0);
}
