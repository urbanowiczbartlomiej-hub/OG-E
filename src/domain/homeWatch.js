// @ts-check

// Home watch — the pure math of watching YOUR OWN neighbourhood.
//
// Every other observation mode in OG-E points outward: the watch list follows
// players you chose, the patrol sweeps the grounds around your colonies for prey.
// This one points inward and asks a defensive question the others never ask:
// *who moved in next to me?*
//
// A stranger colonising a system where you keep a planet or a moon changes your
// risk model immediately. They see your bodies in the galaxy view every time
// they open it, they are in range of a probe with no travel time worth
// mentioning, and if their Danger is high, the overnight fleet-save you have
// been flying to that moon for months is now a fleet parked next to a hunter.
// You cannot react to that if nobody tells you it happened.
//
// Three pure pieces over data OG-E already holds:
//
//   1. TERRITORY — {@link homeSystemKeys}: the "g:s" systems where we own a
//      body (state/bodies). Not a radius: your own systems, exactly.
//   2. LOOKS     — {@link buildHomeLookPlan}: those systems whose last galaxy
//      sighting outgrew the look cadence, shaped like `galaxyWatch`'s plan
//      entries so the Spy FAB walks them as ordinary Look proposals. Unlike the
//      patrol plan this does NOT skip a system with no known occupants — an
//      empty neighbourhood is precisely the state whose CHANGE we want to catch.
//   3. DIFF      — {@link diffHomeSystems}: compare each fresh sighting against
//      the previous occupant set and report ARRIVALS.
//
// Passive by construction: the observation is the user's own galaxy browsing
// (undetectable, no extra request), the diff is arithmetic over what those looks
// already recorded, and nothing is ever sent.
//
// Pure: no DOM, no storage, no Date.now() — the `domain/` contract.

import { stalenessWeight } from './scanPriority.js';

/**
 * Home looks outrank patrol looks (0.5) and sit at the top of the ordinary look
 * plan: the grounds are an opportunity, your own system is your exposure.
 */
export const HOME_LOOK_WEIGHT = 0.85;

/**
 * A system holding an unacknowledged arrival is worth looking at NOW — the
 * stranger's bodies were seen once and everything about them (moon? fleet?
 * activity rhythm?) is still unread. Boosted past every ordinary look.
 */
export const HOME_ALERT_BOOST = 3;

/**
 * Cap on the stored arrival log. Arrivals are rare (a colonisation next door),
 * so this is a runaway guard, not a retention policy.
 */
export const HOME_ARRIVALS_CAP = 40;

/**
 * The systems we live in — `"g:s"` for every own body. A planet and its moon
 * collapse to one key (same system), which is what we want: the question is
 * "who else is in this system", asked once.
 *
 * @param {Array<{galaxy: number, system: number}>} ownBodies
 * @returns {Set<string>}
 */
export const homeSystemKeys = (ownBodies) => {
  /** @type {Set<string>} */
  const out = new Set();
  for (const b of ownBodies || []) {
    if (!b || !Number.isFinite(b.galaxy) || !Number.isFinite(b.system)) continue;
    out.add(`${b.galaxy}:${b.system}`);
  }
  return out;
};

/**
 * Foreign occupants of one scanned system: `{ id, position }` per body whose
 * owner is somebody else, ordered by slot. Our own bodies are excluded twice
 * over — by the `mine` status the galaxy ingest stamps, and by `ownId` for the
 * case where a scan predates knowing which player we are.
 *
 * @param {Record<string | number, { status?: string, player?: { id?: number } }> | undefined} posMap
 * @param {number | null} [ownId]
 * @returns {Array<{ id: number, position: number }>}
 */
export const systemOccupants = (posMap, ownId = null) => {
  /** @type {Array<{ id: number, position: number }>} */
  const out = [];
  if (!posMap) return out;
  for (const [pos, cell] of Object.entries(posMap)) {
    if (!cell || cell.status === 'mine') continue;
    const id = cell.player && typeof cell.player.id === 'number' ? cell.player.id : null;
    if (id == null || (ownId != null && id === ownId)) continue;
    const p = Number(pos);
    if (!Number.isFinite(p)) continue;
    out.push({ id, position: p });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
};

/**
 * @typedef {object} HomeBaselineEntry
 * @property {number[]} ids     Foreign player ids seen in the system, sorted.
 * @property {number} seenAt    `scannedAt` of the sighting this was taken from
 *   (ms). Guards the diff: a system is only re-diffed against a STRICTLY newer
 *   sighting, so a repaint can't manufacture arrivals from the same look twice.
 */

/**
 * @typedef {object} HomeArrival
 * @property {string} system    `"g:s"` of ours they moved into.
 * @property {string} coord     `"g:s:p"` of the new body.
 * @property {number} playerId
 * @property {number} atMs      When we SAW it (the sighting time) — not when
 *   they actually colonised, which the galaxy view never tells us.
 */

/**
 * Diff every home system's fresh sighting against the stored baseline.
 *
 * First sight of a system produces NO arrivals — it only seeds the baseline.
 * That is the honest reading: everyone there is simply "already a neighbour",
 * and claiming a dozen arrivals the first time the feature runs would train the
 * user to ignore the alert.
 *
 * Departures are deliberately not reported: a neighbour leaving is good news,
 * and OGame's galaxy view cannot distinguish "abandoned" from "we happened to
 * look while the row was rendering". Only the risk-increasing direction alerts.
 *
 * @param {object} env
 * @param {Set<string>} env.systems  Home systems ({@link homeSystemKeys}).
 * @param {Record<string, { scannedAt?: number, positions?: Record<string | number, { status?: string, player?: { id?: number } }> }>} env.scans
 * @param {Record<string, HomeBaselineEntry>} env.baseline  Previous state.
 * @param {number | null} [env.ownId]
 * @returns {{ arrivals: HomeArrival[], baseline: Record<string, HomeBaselineEntry>, changed: boolean }}
 *   `baseline` is a NEW object when `changed`; the same reference otherwise, so
 *   a caller can skip the write.
 */
export const diffHomeSystems = ({ systems, scans, baseline, ownId = null }) => {
  /** @type {HomeArrival[]} */
  const arrivals = [];
  /** @type {Record<string, HomeBaselineEntry>} */
  const next = {};
  let changed = false;
  for (const key of systems || []) {
    const sc = scans ? scans[key] : undefined;
    const rawSeen = sc ? Number(sc.scannedAt) : 0;
    const seenAt = Number.isFinite(rawSeen) && rawSeen > 0 ? rawSeen : 0;
    const prev = baseline ? baseline[key] : undefined;
    if (!sc || !seenAt) {
      // Never looked at this system — carry any earlier baseline forward
      // untouched (a body added in a system we haven't browsed yet).
      if (prev) next[key] = prev;
      continue;
    }
    if (prev && seenAt <= prev.seenAt) {
      next[key] = prev;
      continue;
    }
    const occ = systemOccupants(sc.positions, ownId);
    const ids = occ.map((o) => o.id);
    if (prev) {
      const before = new Set(prev.ids);
      for (const o of occ) {
        if (before.has(o.id)) continue;
        arrivals.push({
          system: key,
          coord: `${key}:${o.position}`,
          playerId: o.id,
          atMs: seenAt,
        });
      }
    }
    next[key] = { ids, seenAt };
    changed = true;
  }
  // A dropped home system (we abandoned the last body there) must not keep its
  // baseline — `next` is built from the CURRENT system set, so that's automatic;
  // detect it so the caller still persists the shrink.
  if (!changed && baseline && Object.keys(baseline).length !== Object.keys(next).length) {
    changed = true;
  }
  return {
    arrivals,
    baseline: changed ? next : (baseline || next),
    changed,
  };
};

/**
 * Merge fresh arrivals into the stored log: newest first, one entry per
 * (system, player) — a neighbour seen again in the same system is the SAME news,
 * and re-listing them would bury the rest. Capped at {@link HOME_ARRIVALS_CAP}.
 *
 * @param {HomeArrival[]} stored
 * @param {HomeArrival[]} fresh
 * @returns {HomeArrival[]}
 */
export const mergeHomeArrivals = (stored, fresh) => {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {HomeArrival[]} */
  const out = [];
  for (const a of [...(fresh || []), ...(stored || [])]) {
    if (!a || a.playerId == null) continue;
    const k = `${a.system}|${a.playerId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  out.sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
  return out.slice(0, HOME_ARRIVALS_CAP);
};

/**
 * The home half of the look plan: our own systems whose last galaxy sighting
 * outgrew `staleMs`, in `galaxyWatch.GalaxyPlanEntry` shape so the Spy FAB
 * needs no new machinery (the orchestrator hands these to `deriveSpy` through
 * the same `patrolLooks` channel; a system claimed by both keeps the higher
 * priority). A system with an OPEN arrival is boosted to the front — the
 * stranger has been seen once and nothing about them is read yet.
 *
 * @param {object} env
 * @param {Set<string>} env.systems  Home systems ({@link homeSystemKeys}).
 * @param {Record<string, { scannedAt?: number }>} env.scans
 * @param {number} env.nowMs
 * @param {number} env.staleMs   Galaxy-look cadence (galaxyStaleMs).
 * @param {Set<string>} [env.alertSystems]  Systems with unacknowledged arrivals.
 * @returns {{ entries: import('./galaxyWatch.js').GalaxyPlanEntry[] }}
 */
export const buildHomeLookPlan = ({ systems, scans, nowMs, staleMs, alertSystems }) => {
  /** @type {import('./galaxyWatch.js').GalaxyPlanEntry[]} */
  const entries = [];
  if (!systems || !systems.size) return { entries };
  for (const key of systems) {
    const sc = scans ? scans[key] : undefined;
    const rawSeen = sc ? Number(sc.scannedAt) : 0;
    const seenMs = Number.isFinite(rawSeen) && rawSeen > 0 ? rawSeen : 0;
    const ageMs = seenMs ? nowMs - seenMs : 0;
    const alert = !!(alertSystems && alertSystems.has(key));
    if (seenMs && ageMs <= staleMs && !alert) continue;
    const status = seenMs ? 'stale' : 'none';
    const [galaxy, system] = key.split(':').map(Number);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system)) continue;
    entries.push({
      galaxy,
      system,
      label: key,
      // No bodies: a home look watches the SYSTEM, not a body list (that is the
      // whole point — the interesting slot may be one nobody owns yet).
      bodies: [],
      worst: status,
      priority: (alert ? HOME_ALERT_BOOST : HOME_LOOK_WEIGHT)
        * Math.max(0.2, stalenessWeight(status, ageMs, staleMs)),
      home: true,
      why: alert ? 'home · new neighbour' : 'home · your own system',
    });
  }
  entries.sort((a, b) => (
    b.priority - a.priority || a.galaxy - b.galaxy || a.system - b.system
  ));
  return { entries };
};
