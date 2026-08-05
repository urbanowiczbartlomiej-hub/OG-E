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
 * A system holding a fresh arrival is worth ONE look now — the stranger's bodies
 * were seen once and everything about them (moon? fleet? activity rhythm?) is
 * still unread. Boosted past every ordinary look, but strictly one-shot: see the
 * `alerts` contract on {@link buildHomeLookPlan}.
 */
export const HOME_ALERT_BOOST = 3;

/**
 * Cap on the stored arrival log. Arrivals are rare (a colonisation next door),
 * so this is a runaway guard, not a retention policy.
 */
export const HOME_ARRIVALS_CAP = 40;

/**
 * How long an arrival stays flagged NEW after the user has actually SEEN it
 * (the dashboard stamps `shownAt` when it paints the row).
 *
 * This replaces a "clear NEW" button. A button is the wrong instrument here: the
 * flag's whole job is "you have not read this yet", which the act of reading
 * settles by itself — asking for a click afterwards is asking the user to
 * maintain our bookkeeping.
 */
export const NEW_ARRIVAL_TTL_MS = 24 * 3600_000;

/**
 * Hard ceiling on the NEW flag, counted from when the arrival was recorded —
 * regardless of whether it was ever displayed. Without it, an arrival logged
 * while the player never opens the dashboard would stay NEW forever, and forever
 * is exactly the state that turns a signal into furniture.
 */
export const NEW_ARRIVAL_MAX_MS = 7 * 24 * 3600_000;

/**
 * Player ids that are never a home-watch threat: your own alliance and your
 * buddy list. A neighbour is only news if they might come for you, and these
 * cannot — an alliance-mate sharing your system is company, not exposure.
 *
 * Three independent sources, because each can be cold on its own: the danger
 * profiles already carry a `friendly` verdict (dangerScore folds buddy +
 * alliance-member + own-alliance-tag into it), the player cache carries the
 * in-game flags for anyone we have seen in a galaxy view, and the alliance id on
 * the public players feed catches the rest as long as we know our own.
 *
 * @param {object} env
 * @param {Map<number, { friendly?: boolean }>} [env.danger]  Danger profiles.
 * @param {Record<string | number, { flags?: { buddy?: true, allianceMember?: true } }>} [env.playerFlags]
 *   `state/players` cache records — their `flags` carry the game's own isBuddy /
 *   isAllianceMember for anyone we have seen in a galaxy view.
 * @param {Record<string, { alliance?: string }>} [env.apiPlayers]  players.xml rows.
 * @param {string} [env.ownAlliance]  Our own alliance id.
 * @returns {Set<string>}
 */
export const friendlyNeighbourIds = ({
  danger, playerFlags, apiPlayers, ownAlliance,
}) => {
  /** @type {Set<string>} */
  const out = new Set();
  if (danger) {
    for (const [id, prof] of danger) {
      if (prof && prof.friendly) out.add(String(id));
    }
  }
  if (playerFlags) {
    for (const [id, entry] of Object.entries(playerFlags)) {
      const flags = entry ? entry.flags : undefined;
      if (flags && (flags.buddy || flags.allianceMember)) out.add(String(id));
    }
  }
  if (ownAlliance && apiPlayers) {
    for (const [id, row] of Object.entries(apiPlayers)) {
      if (row && row.alliance && String(row.alliance) === String(ownAlliance)) out.add(String(id));
    }
  }
  return out;
};

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
 * @property {number} [shownAt] When the dashboard first PAINTED this row. Starts
 *   the {@link NEW_ARRIVAL_TTL_MS} countdown — the flag clears itself once the
 *   news has been read, with no button to press.
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
 * @param {Set<string>} [env.skip]  Player ids that are never news — your alliance
 *   and your buddies ({@link friendlyNeighbourIds}). They are dropped from the
 *   BASELINE too, not just from the arrivals: a baseline that remembers them
 *   would resurrect every one of them as an arrival the day they leave the
 *   alliance, which is not when they became a threat.
 * @returns {{ arrivals: HomeArrival[], baseline: Record<string, HomeBaselineEntry>, changed: boolean }}
 *   `baseline` is a NEW object when `changed`; the same reference otherwise, so
 *   a caller can skip the write.
 */
export const diffHomeSystems = ({ systems, scans, baseline, ownId = null, skip }) => {
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
    // A scan entry with NO position map carries no occupancy information, and
    // that state is routine, not exotic: `state/scans` persists only the look
    // TIME (the 15-slot positions are ephemeral by design), so after every page
    // load — i.e. after every click in OGame — each system reads as
    // `{scannedAt: <last look>, positions: {}}`.
    //
    // Reading that as "I looked and the system is empty" is what made Home watch
    // spam: the baseline got re-seeded with nobody in it, and the next REAL look
    // re-announced every neighbour as a fresh arrival. So an empty map is
    // treated exactly like "never looked" — keep what we knew.
    const looked = !!sc && !!seenAt && !!sc.positions && Object.keys(sc.positions).length > 0;
    if (!looked) {
      if (prev) next[key] = prev;
      continue;
    }
    if (prev && seenAt <= prev.seenAt) {
      next[key] = prev;
      continue;
    }
    // Your alliance and your buddies are not neighbours in the risk sense — drop
    // them before the diff so they never appear as news and never enter the
    // baseline (see the `skip` contract above).
    const occ = skip && skip.size
      ? systemOccupants(sc.positions, ownId).filter((o) => !skip.has(String(o.id)))
      : systemOccupants(sc.positions, ownId);
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
 * The STORED entry wins every collision. That is the rule that makes "I've read
 * this" stick: `atMs` is when we FIRST saw them (see the typedef), and the
 * acknowledgement compares against it — so letting a re-derived arrival refresh
 * `atMs` would resurrect a neighbour the user has already cleared, every time
 * they walk the galaxy. Once reported, an arrival ages; it never comes back.
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
  // Stored FIRST: the first entry per (system, player) is the one kept.
  for (const a of [...(stored || []), ...(fresh || [])]) {
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
 * Order two `"g:s"` keys by galaxy, then system.
 * @param {string} a @param {string} b @returns {number}
 */
const bySystemKey = (a, b) => {
  const [ag, as] = a.split(':').map(Number);
  const [bg, bs] = b.split(':').map(Number);
  return (ag - bg) || (as - bs);
};

/**
 * @typedef {object} HomeNeighbour
 * @property {string} playerId
 * @property {string[]} systems   OUR systems they sit in ("g:s"), ascending. Its
 *   length is the reach that matters: every one of these is a system where their
 *   fleet is already inside, minutes from a moon of ours.
 * @property {number | null} danger  0..1, or null when we hold no profile (an
 *   unknown Danger is not a zero Danger).
 * @property {string} [allianceId]
 * @property {boolean} isNew      Holds an unacknowledged arrival.
 */

/**
 * Fold the per-system occupant lists into one row per NEIGHBOUR — the actor, not
 * the address.
 *
 * Why the actor: a system-by-system list hides the thing that actually escalates
 * the threat. One player sitting in THREE of our systems is not three ordinary
 * neighbours; it is one account whose fleet is permanently inside our space,
 * able to run a moon-destruction on its own, at any of three places, with no
 * travel time worth planning around. That fact only exists once the rows are
 * grouped by player.
 *
 * Ordered worst Danger first (the app-wide axis), reach as the tiebreaker.
 * Unknown Danger sinks below any known one.
 *
 * @param {object} env
 * @param {Record<string, Array<{playerId: string}>>} env.occupants  Foreign slots
 *   per own system.
 * @param {Record<string, number>} [env.dangerByPlayer]   playerId → danger 0..1.
 * @param {Record<string, string>} [env.allianceByPlayer] playerId → alliance id.
 * @param {Set<string>} [env.newKeys]  `"system|playerId"` pairs holding an
 *   unacknowledged arrival.
 * @returns {HomeNeighbour[]}
 */
export const rankHomeNeighbours = ({
  occupants, dangerByPlayer, allianceByPlayer, newKeys,
}) => {
  /** @type {Map<string, { systems: Set<string>, isNew: boolean }>} */
  const acc = new Map();
  for (const [system, slots] of Object.entries(occupants || {})) {
    for (const slot of slots || []) {
      const pid = slot && slot.playerId != null ? String(slot.playerId) : '';
      if (!pid) continue;
      let e = acc.get(pid);
      if (!e) {
        e = { systems: new Set(), isNew: false };
        acc.set(pid, e);
      }
      e.systems.add(system);
      if (newKeys && newKeys.has(`${system}|${pid}`)) e.isNew = true;
    }
  }
  /** @type {HomeNeighbour[]} */
  const out = [];
  for (const [playerId, e] of acc) {
    const d = dangerByPlayer ? dangerByPlayer[playerId] : undefined;
    const ally = allianceByPlayer ? allianceByPlayer[playerId] : undefined;
    out.push({
      playerId,
      systems: [...e.systems].sort(bySystemKey),
      danger: typeof d === 'number' && Number.isFinite(d) ? d : null,
      ...(ally ? { allianceId: String(ally) } : {}),
      isNew: e.isNew,
    });
  }
  out.sort((a, b) => (
    (b.danger ?? -1) - (a.danger ?? -1)
    || b.systems.length - a.systems.length
    || a.playerId.localeCompare(b.playerId)
  ));
  return out;
};

/**
 * @typedef {object} HomeCoalition
 * @property {string} allianceId
 * @property {string[]} playerIds  Members among our neighbours who contribute to
 *   the alliance's reach, worst-reach first.
 * @property {string[]} systems    OUR systems this alliance reaches — the UNION
 *   over its members. Its length is the alliance's reach.
 * @property {number} soloBest     The largest reach a SINGLE member has.
 * @property {number} lift         `systems.length - soloBest`: how many more of
 *   our systems the alliance covers together than its best member covers alone.
 *   Always ≥ 1 for a returned coalition (see below).
 */

/**
 * Alliances whose members TOGETHER reach more of our systems than any of them
 * reaches alone.
 *
 * The escalation is reach, not headcount. Two members of one alliance sitting in
 * the SAME system of ours are worth no more than one of them: the capability
 * bought by being in-system — instant arrival on a moon there — is already
 * bought, and doubling the fleets in one place does not widen anything. Likewise
 * a second member who only occupies systems their ally already occupies adds
 * nothing our neighbour rows do not already show as that ally's `×N`.
 *
 * What DOES escalate: members who individually touch one or two of our systems
 * covering four between them. None of them could reach that far solo; together
 * they can put a fleet next to any of four of our moons and coordinate the hit.
 *
 * Hence the single gate: `lift ≥ 1`. An alliance whose collective reach equals
 * its best member's reach is not reported at all — there is nothing new to say.
 *
 * @param {object} env
 * @param {Record<string, Array<{playerId: string}>>} env.occupants
 * @param {Record<string, string>} [env.allianceByPlayer]
 * @returns {HomeCoalition[]}
 */
export const findHomeCoalitions = ({ occupants, allianceByPlayer }) => {
  /** @type {Map<string, Map<string, Set<string>>>} alliance → player → systems */
  const acc = new Map();
  for (const [system, slots] of Object.entries(occupants || {})) {
    for (const slot of slots || []) {
      const pid = slot && slot.playerId != null ? String(slot.playerId) : '';
      const ally = pid && allianceByPlayer ? allianceByPlayer[pid] : undefined;
      if (!pid || !ally) continue;
      const key = String(ally);
      let members = acc.get(key);
      if (!members) {
        members = new Map();
        acc.set(key, members);
      }
      const mine = members.get(pid) || new Set();
      mine.add(system);
      members.set(pid, mine);
    }
  }
  /** @type {HomeCoalition[]} */
  const out = [];
  for (const [allianceId, members] of acc) {
    if (members.size < 2) continue;
    /** @type {Set<string>} */
    const union = new Set();
    let soloBest = 0;
    for (const mine of members.values()) {
      for (const s of mine) union.add(s);
      if (mine.size > soloBest) soloBest = mine.size;
    }
    const lift = union.size - soloBest;
    if (lift < 1) continue;
    const playerIds = [...members.keys()]
      .sort((a, b) => (members.get(b)?.size ?? 0) - (members.get(a)?.size ?? 0)
        || a.localeCompare(b));
    out.push({
      allianceId,
      playerIds,
      systems: [...union].sort(bySystemKey),
      soloBest,
      lift,
    });
  }
  // Widest joint reach first; the lift breaks ties (a bigger jump over what any
  // single member manages is the sharper surprise).
  out.sort((a, b) => (
    b.systems.length - a.systems.length
    || b.lift - a.lift
    || a.allianceId.localeCompare(b.allianceId)
  ));
  return out;
};

/**
 * The home half of the look plan: our own systems whose last galaxy sighting
 * outgrew `staleMs`, in `galaxyWatch.GalaxyPlanEntry` shape so the Spy FAB
 * needs no new machinery (the orchestrator hands these to `deriveSpy` through
 * the same `patrolLooks` channel; a system claimed by both keeps the higher
 * priority). A system with a fresh arrival is boosted to the front — the
 * stranger has been seen once and nothing about them is read yet.
 *
 * @param {object} env
 * @param {Set<string>} env.systems  Home systems ({@link homeSystemKeys}).
 * @param {Record<string, { scannedAt?: number }>} env.scans
 * @param {number} env.nowMs
 * @param {number} env.staleMs   Galaxy-look cadence (galaxyStaleMs).
 * @param {Map<string, number>} [env.alerts]  System → the newest UNACKNOWLEDGED
 *   arrival's sighting time (ms). The boost is a ONE-SHOT nudge: it lives only
 *   until the system gets a sighting NEWER than that arrival — i.e. exactly until
 *   the user has taken the look it asks for. It must NOT hang on the arrival's
 *   acknowledgement: that flag is cleared on the dashboard, so a boost keyed to
 *   it wedges the Spy button on one system forever (tap → look → same proposal,
 *   which reads as a broken button, because it is one).
 * @returns {{ entries: import('./galaxyWatch.js').GalaxyPlanEntry[] }}
 */
export const buildHomeLookPlan = ({ systems, scans, nowMs, staleMs, alerts }) => {
  /** @type {import('./galaxyWatch.js').GalaxyPlanEntry[]} */
  const entries = [];
  if (!systems || !systems.size) return { entries };
  for (const key of systems) {
    const sc = scans ? scans[key] : undefined;
    const rawSeen = sc ? Number(sc.scannedAt) : 0;
    const seenMs = Number.isFinite(rawSeen) && rawSeen > 0 ? rawSeen : 0;
    const ageMs = seenMs ? nowMs - seenMs : 0;
    // One-shot alert: an arrival whose system has been looked at SINCE it was
    // logged has already had its nudge — from there the ordinary cadence rules
    // the system again (see the `alerts` contract above).
    const alertAt = alerts ? alerts.get(key) : undefined;
    const alert = alertAt != null && (!seenMs || seenMs <= alertAt);
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
