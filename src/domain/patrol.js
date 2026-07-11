// @ts-check

// Patrol territory ("hunting grounds") — the pure math of the TERRITORY
// observation mode. Where the watch-list is the sniper's tool (pick a player,
// work them), the patrol is the territorial predator's: colonies are spread
// as a coverage lattice, and the prey is whoever NEARBY slips — a returning
// fleet-save on a forgetful neighbour's moon, not a name hunted for months.
//
// The mode is three pure pieces over data OG-E already holds:
//
//   1. TERRITORY  — {@link patrolSystemKeys}: the "g:s" systems within
//      ±radius of any OWN body (state/bodies), same galaxy, honouring the
//      server's donut wrap (domain/geometry rules).
//   2. PATROL     — {@link buildPatrolPlan}: which territory systems need a
//      (re)look, from the galaxy-scan timestamps (state/scans) — entries in
//      the SAME shape as the galaxy-look plan, so the Spy FAB walks the
//      grounds through the ordinary Look proposals (look-first doctrine).
//   3. PREY       — {@link patrolPlayers}: who lives in the territory, minus
//      the noise filters (self, vacation/banned/admin from the public API,
//      buddy / own-alliance / noob-protected from the galaxy meta, and an
//      explicit 'friend' relationship). The moon-strike detector then runs
//      over these players exactly as it does over the watch-list.
//
// Everything stays passive + propose-only: patrol looks are the user's own
// galaxy browsing (undetectable), strikes still take one deliberate tap per
// probe. Recording is bounded structurally — the territory is a finite set
// of systems, and state/activityObs' ring caps + sweeps apply as ever.
//
// Pure: no DOM, no storage, no Date.now() — the `domain/` contract.

import { axisDelta } from './geometry.js';
import { stalenessWeight } from './scanPriority.js';

/** Radius clamp (systems) — one knob, edited on the Spyglass tab. */
export const PATROL_SYSTEMS_MIN = 0; // 0 = patrol off
export const PATROL_SYSTEMS_MAX = 50;

/**
 * Patrol looks weigh below same-staleness watch-list looks (those carry a
 * danger weight ≥ 0.3, unknown-danger 0.65): the grounds matter, but a
 * player you deliberately watch matters more.
 */
export const PATROL_LOOK_WEIGHT = 0.5;

/**
 * The patrol territory: system keys `"g:s"` within ±`radius` systems of any
 * OWN body, in that body's own galaxy. System wrap follows the server's
 * donut flag; when server data hasn't landed yet the defaults (499 systems,
 * donut) keep the set usable — a slightly generous wrap edge only means a
 * couple of extra recorded systems, never a wrong proposal (the plan side
 * always passes real server data).
 *
 * @param {Array<{galaxy: number, system: number}>} ownBodies
 * @param {number} radius  ± systems; ≤0 → empty set (patrol off).
 * @param {{ systems?: number, donutSystem?: boolean }} [server]
 * @returns {Set<string>}
 */
export const patrolSystemKeys = (ownBodies, radius, server = {}) => {
  /** @type {Set<string>} */
  const out = new Set();
  const r = Math.min(PATROL_SYSTEMS_MAX, Math.floor(Number(radius) || 0));
  if (r <= 0) return out;
  const total = Number(server.systems) > 0 ? Number(server.systems) : 499;
  const donut = server.donutSystem !== false;
  for (const b of ownBodies || []) {
    if (!b || !Number.isFinite(b.galaxy) || !Number.isFinite(b.system)) continue;
    for (let d = -r; d <= r; d += 1) {
      let s = b.system + d;
      if (donut) s = ((s - 1) % total + total) % total + 1;
      if (s < 1 || s > total) continue;
      out.add(`${b.galaxy}:${s}`);
    }
  }
  return out;
};

/**
 * Whether a `"g:s:p"` coord lies inside the territory.
 * @param {string} coord
 * @param {Set<string> | null | undefined} systems
 * @returns {boolean}
 */
export const coordInPatrol = (coord, systems) => {
  if (!systems || !systems.size || typeof coord !== 'string') return false;
  const i = coord.lastIndexOf(':');
  return i > 0 && systems.has(coord.slice(0, i));
};

/**
 * Distance of a system from the nearest own body's system (same galaxy),
 * donut-aware — exposed for future "closest first" ranking / display.
 *
 * @param {{galaxy: number, system: number}} sys
 * @param {Array<{galaxy: number, system: number}>} ownBodies
 * @param {{ systems?: number, donutSystem?: boolean }} [server]
 * @returns {number} Systems of distance, Infinity when no own body shares
 *   the galaxy.
 */
export const patrolDistance = (sys, ownBodies, server = {}) => {
  const total = Number(server.systems) > 0 ? Number(server.systems) : 499;
  const donut = server.donutSystem !== false;
  let best = Infinity;
  for (const b of ownBodies || []) {
    if (!b || b.galaxy !== sys.galaxy) continue;
    const d = axisDelta(sys.system, b.system, total, donut);
    if (d < best) best = d;
  }
  return best;
};

/**
 * The occupied slots of every territory system, from the public-API
 * occupancy rows: `"g:s"` → `[{ playerId, position }]`. Own slots are
 * excluded when `ownPlayerId` is known (my planets are not prey, and the
 * patrol-look entry should count neighbours, not me).
 *
 * @param {Array<{coords: string, player?: number}>} universePlanets
 * @param {Set<string>} systems
 * @param {string | number | null} [ownPlayerId]
 * @returns {Record<string, Array<{playerId: string, position: number}>>}
 */
export const patrolOccupants = (universePlanets, systems, ownPlayerId) => {
  /** @type {Record<string, Array<{playerId: string, position: number}>>} */
  const out = {};
  if (!systems || !systems.size) return out;
  const own = ownPlayerId != null ? String(ownPlayerId) : null;
  for (const p of universePlanets || []) {
    if (!p || typeof p.coords !== 'string' || p.player == null) continue;
    const i = p.coords.lastIndexOf(':');
    if (i <= 0) continue;
    const sysKey = p.coords.slice(0, i);
    if (!systems.has(sysKey)) continue;
    const pid = String(p.player);
    if (own && pid === own) continue;
    const position = Number(p.coords.slice(i + 1));
    if (!Number.isFinite(position)) continue;
    (out[sysKey] || (out[sysKey] = [])).push({ playerId: pid, position });
  }
  return out;
};

/**
 * The prey: player ids with ≥1 body in the territory, minus the noise
 * filters. Filtered out are:
 *
 *   - me (`ownPlayerId`);
 *   - API status letters `v` (vacation), `b` (banned), `a` (admin) — known
 *     for the whole server, no look required;
 *   - galaxy-meta flags `buddy`, `allianceMember`, `newbie` (game-computed
 *     relative to YOU; available once the slot was browsed — exactly what a
 *     patrol does);
 *   - an explicit `'friend'` relationship tag.
 *
 * Inactive players are deliberately KEPT — a lit moon on an inactive is
 * still worth a probe (someone parked there, or they're briefly back).
 *
 * @param {Record<string, Array<{playerId: string, position: number}>>} occupants
 *   Output of {@link patrolOccupants} (already excludes own slots).
 * @param {object} [opts]
 * @param {Record<string, { status?: string }>} [opts.apiPlayers]
 *   Public-API player meta (`getApiContext().players`).
 * @param {Record<number, { flags?: { buddy?: true, allianceMember?: true, newbie?: true } }>} [opts.meta]
 *   Galaxy-scan player meta (`state/players`) — structurally narrowed to the
 *   three flags this filter reads.
 * @param {Record<string, string>} [opts.relationships]  Watch-list tags.
 * @returns {string[]}
 */
export const patrolPlayers = (occupants, opts = {}) => {
  const apiPlayers = opts.apiPlayers || {};
  const meta = opts.meta || {};
  const rel = opts.relationships || {};
  /** @type {Set<string>} */
  const out = new Set();
  for (const slots of Object.values(occupants || {})) {
    for (const s of slots) out.add(s.playerId);
  }
  return [...out].filter((pid) => {
    if (rel[pid] === 'friend') return false;
    const status = apiPlayers[pid] ? String(apiPlayers[pid].status || '') : '';
    if (/[vba]/.test(status)) return false;
    const flags = (meta[Number(pid)] && meta[Number(pid)].flags) || {};
    if (flags.buddy || flags.allianceMember || flags.newbie) return false;
    return true;
  });
};

/**
 * The patrol half of the look plan: territory systems whose last galaxy
 * scan (state/scans `scannedAt` — ANY browse counts) is older than
 * `staleMs`, shaped like `galaxyWatch.GalaxyPlanEntry` so the Spy FAB's
 * Look proposals need no new machinery. Systems with no known occupants
 * are skipped — nothing to observe there.
 *
 * @param {object} env
 * @param {Set<string>} env.systems  The territory ({@link patrolSystemKeys}).
 * @param {Record<string, { scannedAt?: number }>} env.scans
 *   Per-system scan snapshots (state/scans value).
 * @param {Record<string, Array<{playerId: string, position: number}>>} env.occupants
 *   {@link patrolOccupants} output — the entry's bodies + the skip signal.
 * @param {number} env.nowMs
 * @param {number} env.staleMs  Galaxy-look cadence (galaxyStaleMs).
 * @returns {{ entries: import('./galaxyWatch.js').GalaxyPlanEntry[] }}
 */
export const buildPatrolPlan = ({ systems, scans, occupants, nowMs, staleMs }) => {
  /** @type {import('./galaxyWatch.js').GalaxyPlanEntry[]} */
  const entries = [];
  if (!systems || !systems.size) return { entries };
  for (const key of systems) {
    const slots = occupants ? occupants[key] : undefined;
    if (!slots || !slots.length) continue;
    const sc = scans ? scans[key] : undefined;
    const rawSeen = sc ? Number(sc.scannedAt) : 0;
    const seenMs = Number.isFinite(rawSeen) && rawSeen > 0 ? rawSeen : 0;
    const ageMs = seenMs ? nowMs - seenMs : 0;
    if (seenMs && ageMs <= staleMs) continue;
    const status = seenMs ? 'stale' : 'none';
    const [galaxy, system] = key.split(':').map(Number);
    entries.push({
      galaxy,
      system,
      label: key,
      bodies: slots.map((s) => ({
        playerId: s.playerId, position: s.position, bodyType: 1, status,
      })),
      worst: status,
      priority: PATROL_LOOK_WEIGHT * stalenessWeight(status, ageMs, staleMs),
      why: `patrol · ${slots.length} ${slots.length === 1 ? 'slot' : 'slots'}`,
    });
  }
  entries.sort((a, b) => (
    b.priority - a.priority || a.galaxy - b.galaxy || a.system - b.system
  ));
  return { entries };
};
