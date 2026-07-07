// @ts-check

// Scan-mode primitives — whether a watched body is actively PROBE-scanned.
// The leaf both scanPriority (probe plan) and galaxyWatch (look plan) import,
// so neither has to depend on the other. Zero imports on purpose: pure
// key-shaping + resolution over plain data. The ScanMode union is DEFINED here
// (domain floor) and re-imported by state/watchList — the correct direction
// (state → domain).
//
// Why binary (not the old probe/galaxy/off tri-state): GALAXY activity
// observation is now ALWAYS on for every watched body — it is passive and
// undetectable, so there is nothing to gate. The only real choice is whether we
// ALSO send probes (which reveal us to the target). So a body is simply
// scan-'on' (probes proposed) or scan-'off' (galaxy activity still tracked, no
// probes). Removing a player from the watch-list is the way to stop watching
// entirely; there is no "off everything" mode.

/**
 * Whether a body is probe-scanned:
 *   - 'on'  — the FAB proposes espionage probes for it (the default).
 *   - 'off' — no probes; galaxy activity is STILL tracked (always-on) — the
 *     "watch this passively, don't reveal me" choice.
 * @typedef {'on'|'off'} ScanMode
 */

/**
 * Activity-ring key for a body — "g:s:p:type" (type 1 = planet, 3 = moon), the
 * shape state/activityObs writes.
 * @param {string} coord  "g:s:p"
 * @param {1|3} bodyType
 * @returns {string}
 */
export const ringKeyFor = (coord, bodyType) => `${coord}:${bodyType}`;

/**
 * Scan-mode OVERRIDE / rescan key for a body — planets "g:s:p", moons
 * "g:s:p:3" (a planet carries NO type suffix, matching spyScan.rescanAtFor and
 * the dossier's per-body controls). Distinct from {@link ringKeyFor} on
 * purpose: the rings key both bodies by explicit type, but the user-facing
 * override space treats a planet as the bare coord so a moon's flag never
 * touches it.
 * @param {string} coord  "g:s:p"
 * @param {1|3} bodyType
 * @returns {string}
 */
export const overrideKeyFor = (coord, bodyType) => (bodyType === 3 ? `${coord}:3` : coord);

/**
 * Resolve a body's effective scan mode: per-body override wins, then the
 * whole-player default, then 'on' (so an absent map behaves as "scan
 * everything", the pre-feature default).
 * @param {Record<string, ScanMode> | undefined} scanMode
 * @param {string} playerId
 * @param {string} overrideKey  body override key (see {@link overrideKeyFor})
 * @returns {ScanMode}
 */
export const effectiveScan = (scanMode, playerId, overrideKey) => {
  if (!scanMode) return 'on';
  const body = scanMode[overrideKey];
  if (body) return body;
  const player = scanMode[playerId];
  if (player) return player;
  return 'on';
};

/**
 * Summarise a player's scan mode across their in-scope bodies for a compact
 * table glyph: a single {@link ScanMode} when every body resolves the same,
 * `'mixed'` when they differ, or `null` when there's nothing to summarise (no
 * bodies known AND no whole-player default). `'on'` is a real result the caller
 * chooses to draw nothing for, so the table stays quiet about the status quo.
 * @param {Record<string, ScanMode> | undefined} scanMode
 * @param {string} playerId
 * @param {string[]} overrideKeys  the player's in-scope body override keys
 * @returns {ScanMode | 'mixed' | null}
 */
export const aggregatePlayerScan = (scanMode, playerId, overrideKeys) => {
  if (!overrideKeys || overrideKeys.length === 0) {
    return (scanMode && scanMode[playerId]) || null;
  }
  /** @type {ScanMode | null} */
  let seen = null;
  for (const key of overrideKeys) {
    const m = effectiveScan(scanMode, playerId, key);
    if (seen === null) seen = m;
    else if (seen !== m) return 'mixed';
  }
  return seen;
};
