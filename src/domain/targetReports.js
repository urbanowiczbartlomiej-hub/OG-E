// @ts-check

// Pure accessors + projections for the per-body spy-report entry. The store
// (`state/targets.js`) keeps, per body, the NEWEST full report plus a bounded
// ring of lean prior observations:
//
//     targetReports[playerId][bodyKey] = { latest: SpyReport, history: SpyReportLite[] }
//
// This module is the ONE place that knows that shape, so every reader goes
// through `latestOf` / `historyOf` and tolerates BOTH the new shape and the
// legacy bare-`SpyReport` value (pre-migration data, or a device still on old
// code). See SPYGLASS-REDESIGN.md §10.1 — the migration MUST route both dashboard
// read paths through these accessors, or a raw `.defenseValue` read on a
// `{latest,history}` object returns undefined and silently zeroes every
// hidden-fleet estimate.
//
// Pure: no DOM, no storage, no time. Unit-testable with plain fixtures.

/** @typedef {import('./espionageReport.js').SpyReport} SpyReport */

/**
 * A lean per-observation history entry — deliberately WITHOUT the per-ship
 * fleet/defense count maps (those live only on `latest`, to hold the storage
 * budget, SPYGLASS-REDESIGN.md §10.5). Defence/fleet VALUES accrue only from a
 * report that actually revealed those sections (§9bis); a resources-only partial
 * contributes `resTotal` (loot rhythm) but leaves them undefined so an absent
 * section is never later mistaken for a real zero.
 * @typedef {object} SpyReportLite
 * @property {number} [ts]           Report time, epoch SECONDS (the SpyReport unit).
 * @property {number} [activityMin]  Activity marker (see parseActivityMin).
 * @property {number} [resTotal]     Total on-planet resources (loot rhythm).
 * @property {number} [fleetValue]   Visible fleet value — only when revealed.
 * @property {number} [defenseValue] Defense value — only when revealed.
 */

/**
 * One spied body's stored intel: the newest report plus a bounded, newest-last
 * ring of lean prior observations. The ring accrues only for WATCHED players
 * (see `recordReport`'s retention gate); an unwatched player keeps `latest` only.
 * @typedef {object} BodyEntry
 * @property {SpyReport} latest
 * @property {SpyReportLite[]} history
 */

/** Max history observations kept per body (§10.1 ring cap; §10.5 storage budget). */
export const HISTORY_CAP = 24;

/**
 * The current (newest) report for a body. Tolerant of BOTH persisted shapes: a
 * new `{latest, history}` entry AND a legacy bare `SpyReport`. Never reaches into
 * history.
 * @param {BodyEntry | SpyReport} entry
 * @returns {SpyReport}
 */
export function latestOf(entry) {
  const e = /** @type {any} */ (entry);
  return e && e.latest ? e.latest : e;
}

/**
 * The bounded history ring for a body — newest-last. `[]` for a legacy
 * bare-report entry (which has no history).
 * @param {BodyEntry | SpyReport} entry
 * @returns {SpyReportLite[]}
 */
export function historyOf(entry) {
  const e = /** @type {any} */ (entry);
  return e && Array.isArray(e.history) ? e.history : [];
}

/**
 * Project the whole report store into `playerId → ("g:s:p" coord → newest
 * PLANET report ts, epoch SECONDS)` — the freshness map the scan planner
 * (domain/scanPriority) reasons over. Moon reports (type 3) are skipped: their
 * bodyKey collapses to the planet's "g:s:p" once ":type" is stripped, and a
 * moon scan must never mark the planet spied. Shared by the in-game Spy FAB
 * and the dashboard's plan strip (feature→feature imports are forbidden, so
 * the projection lives here).
 * @param {Record<string, Record<string, BodyEntry | SpyReport>>} reports
 * @returns {Record<string, Record<string, number>>}
 */
export function spiedCoordsByPlayer(reports) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const pid of Object.keys(reports || {})) {
    const bucket = reports[pid];
    if (!bucket) continue;
    /** @type {Record<string, number>} */
    const coordTs = {};
    for (const key of Object.keys(bucket)) {
      const report = latestOf(bucket[key]);
      if (!report || report.planetType === 3) continue;
      const lastColon = key.lastIndexOf(':');
      const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
      coordTs[coord] = report.timestamp ?? 0;
    }
    out[pid] = coordTs;
  }
  return out;
}

/**
 * Companion to {@link spiedCoordsByPlayer} for MOON scans: `playerId → ("g:s:p"
 * coord → newest MOON report ts, epoch SECONDS)`. `spiedCoordsByPlayer` skips
 * moons on purpose (a moon scan must never mark the planet spied), so the scan
 * planner needs this separate freshness map to know a moon has already been
 * scanned — without it a moon would be proposed forever. The coord is the
 * shared "g:s:p" (the ":type" suffix stripped, exactly like the planet map), so
 * a moon and its planet key by the same coord in their OWN maps.
 * @param {Record<string, Record<string, BodyEntry | SpyReport>>} reports
 * @returns {Record<string, Record<string, number>>}
 */
export function spiedMoonsByPlayer(reports) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const pid of Object.keys(reports || {})) {
    const bucket = reports[pid];
    if (!bucket) continue;
    /** @type {Record<string, number>} */
    const coordTs = {};
    for (const key of Object.keys(bucket)) {
      const report = latestOf(bucket[key]);
      if (!report || report.planetType !== 3) continue;
      const lastColon = key.lastIndexOf(':');
      const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
      coordTs[coord] = report.timestamp ?? 0;
    }
    out[pid] = coordTs;
  }
  return out;
}

/**
 * Project a full {@link SpyReport} down to a lean {@link SpyReportLite} for the
 * history ring. Honours `revealed`: defence/fleet values accrue only from a
 * report that actually showed them (§9bis). Legacy reports (no `revealed`) came
 * through the old numeric-defence gate, so they count as full reveals.
 * @param {SpyReport} report
 * @returns {SpyReportLite}
 */
export function toLite(report) {
  const rev = report.revealed;
  const showedDef = rev ? rev.defense : true;
  const showedFleet = rev ? rev.fleet : true;
  /** @type {SpyReportLite} */
  const lite = {};
  if (typeof report.timestamp === 'number') lite.ts = report.timestamp;
  if (typeof report.activityMin === 'number') lite.activityMin = report.activityMin;
  if (typeof report.resources === 'number') lite.resTotal = report.resources;
  if (showedFleet && typeof report.fleetValue === 'number') lite.fleetValue = report.fleetValue;
  if (showedDef && typeof report.defenseValue === 'number') lite.defenseValue = report.defenseValue;
  return lite;
}
