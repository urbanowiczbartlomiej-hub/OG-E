// @ts-check

// Pure aggregation for the Spyglass "Who's spying on you" strip (Etap H3).
// The store (state/proximityReports.js) is a flat newest-first log — one entry
// per opened "foreign fleet spotted near your planet" alert — so a repeat
// scout used to fill the strip with near-identical lines. This collapses the
// log into ONE row per prober plus headline counts, and flags the probers
// whose ORIGIN body sits in the same g:s as the body of ours they approached:
// a fleet parked in your own system reaches you fast even with Death Stars
// (the slowest ship in the game), so those rows sort first and read hottest.
//
// Same passive provenance as the raw strip (alerts the player opened —
// fair-play GREEN, docs/fair-play.md §"Spyglass intelligence workbench");
// aggregation is presentation only, no new data is captured.

/** @typedef {import('./espionageReport.js').ProximityReport} ProximityReport */

/**
 * @typedef {object} ProximityDigestEntry
 * @property {number} byPlayerId
 * @property {string|null} name       Latest known nickname (alerts may omit it).
 * @property {number} count           Alerts this prober triggered (in the log window).
 * @property {number|null} lastTs     Newest alert, epoch SECONDS; null = none carried a ts.
 * @property {Array<{coords: string, moon: boolean}>} atBodies
 *   Distinct bodies of OURS approached, newest first. A planet and its moon
 *   share coords but are separate spiable bodies, so they list separately —
 *   `moon` says which one the scout actually probed.
 * @property {string|null} fromCoords Newest known origin body.
 * @property {boolean} fromMoon       That origin is a moon (launched from a moon).
 * @property {boolean} sameSystem     Some alert's origin g:s equals the approached body's g:s.
 * @property {string|null} sameSystemFrom  The origin behind that flag (newest such).
 */

/**
 * @typedef {object} ProximityDigest
 * @property {ProximityDigestEntry[]} players
 *   Hot-first: same-system probers, then newest-alert-first, then most alerts.
 * @property {number} totalReports
 * @property {number} playerCount
 * @property {number} sameSystemCount  Probers (not alerts) with a same-system origin.
 * @property {number|null} lastTs      Newest alert overall, epoch seconds.
 */

/**
 * `"g:s:p"` → `"g:s"`, or null when the string doesn't parse. Strict shape —
 * a malformed coord must never accidentally equal another malformed coord.
 * @param {string | undefined} coords
 * @returns {string | null}
 */
const systemOf = (coords) => {
  const m = /^\s*(\d+):(\d+):\d+\s*$/.exec(coords ?? '');
  return m ? `${m[1]}:${m[2]}` : null;
};

/**
 * Collapse the proximity-alert log into a per-prober digest.
 * Order-tolerant: entries are re-ranked by their own timestamps, so a caller
 * passing an unordered log still gets newest-first fields.
 *
 * @param {ProximityReport[]} reports
 * @returns {ProximityDigest}
 */
export const digestProximityReports = (reports) => {
  /** @type {Map<number, ProximityDigestEntry>} */
  const byId = new Map();
  let totalReports = 0;
  /** @type {number | null} */
  let lastTs = null;

  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r || typeof r.byPlayerId !== 'number') continue;
    totalReports++;
    const ts = typeof r.ts === 'number' && r.ts > 0 ? r.ts : null;
    if (ts != null && (lastTs == null || ts > lastTs)) lastTs = ts;

    let e = byId.get(r.byPlayerId);
    if (!e) {
      e = {
        byPlayerId: r.byPlayerId,
        name: null,
        count: 0,
        lastTs: null,
        atBodies: [],
        fromCoords: null,
        fromMoon: false,
        sameSystem: false,
        sameSystemFrom: null,
      };
      byId.set(r.byPlayerId, e);
    }
    e.count++;
    const newest = ts != null && (e.lastTs == null || ts > e.lastTs);
    if (newest) e.lastTs = ts;
    // Name / origin: prefer the newest alert that actually carries the field
    // (first fill wins on a ts-less log, which the store keeps newest-first).
    // fromMoon travels WITH fromCoords — the pair describes one origin body.
    if (r.byPlayerName && (newest || e.name == null)) e.name = r.byPlayerName;
    if (r.fromCoords && (newest || e.fromCoords == null)) {
      e.fromCoords = r.fromCoords;
      e.fromMoon = r.fromPlanetType === 3;
    }
    if (r.atCoords) {
      const moon = r.atPlanetType === 3;
      if (!e.atBodies.some((b) => b.coords === r.atCoords && b.moon === moon)) {
        if (newest) e.atBodies.unshift({ coords: r.atCoords, moon });
        else e.atBodies.push({ coords: r.atCoords, moon });
      }
    }
    const from = systemOf(r.fromCoords);
    if (from != null && from === systemOf(r.atCoords)) {
      if (!e.sameSystem || newest) e.sameSystemFrom = r.fromCoords ?? null;
      e.sameSystem = true;
    }
  }

  const players = [...byId.values()].sort((a, b) => {
    if (a.sameSystem !== b.sameSystem) return a.sameSystem ? -1 : 1;
    const at = a.lastTs ?? -1;
    const bt = b.lastTs ?? -1;
    if (at !== bt) return bt - at;
    return b.count - a.count;
  });

  return {
    players,
    totalReports,
    playerCount: players.length,
    sameSystemCount: players.reduce((n, p) => n + (p.sameSystem ? 1 : 0), 0),
    lastTs,
  };
};
