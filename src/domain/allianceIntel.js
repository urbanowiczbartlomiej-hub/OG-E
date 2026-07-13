// @ts-check

// Alliance-shared Spyglass intel — the pure core of the opt-in co-op share
// (IDEAS.md entry 2). Builds the block of coverage WE contribute, merges it
// into the shared per-universe document, and summarises the union for display.
//
// # The per-member-block model
//
// The shared file is `memberKey → block`: each member is the SOLE writer of
// their own block and never touches anyone else's. That kills the whole
// cross-member conflict class the rough plan's per-(player,field) LWW would
// have had to referee — a share round is fetch → UNION own block → PATCH.
// Since 2026-07 the own-block update is a per-player field-wise-max union
// (see mergeOwnBlock), not a wholesale replace: every shared field is a
// monotonic maximum, so the union is exact, and the replace model's one data
// loss — two writers under the same member name (e.g. the same player's
// desktop + mobile) clobbering each other — is gone. The flip side accepted
// with it: a player never leaves a block by mere absence (observations don't
// un-happen; row staleness is visible via the times themselves).
//
// # What a block carries (privacy floor)
//
// Player ids, names, last-spy / last-seen times and a spied-bodies count —
// NO coordinates, NO report contents, and NO watch-list decisions (2026-07):
// the block's scope is "players I hold OBSERVATIONS about" (≥1 spy report or
// galaxy-activity marker), never "players I chose to watch", and nothing a
// member configures (watch list, per-player toggles, map colours, Spyglass
// knobs) leaves the device. Times are epoch SECONDS throughout (the
// SpyReport unit, same as targetReports/activityObs).
//
// # Display-only, by invariant
//
// Pulled alliance intel is a coverage/display layer. It must NEVER feed the
// danger score `D` or any scan plan — the same discipline as the civil
// baseline (IDEAS.md decision, 2026-07-09).

import { latestOf } from './targetReports.js';

/**
 * Schema version of the shared alliance file. A doc with a different version
 * is REJECTED by {@link normalizeAllianceDoc} (returns null) — the caller must
 * surface "update OG-E" instead of overwriting a newer format and clobbering
 * the rest of the alliance's blocks.
 */
export const ALLIANCE_INTEL_VERSION = 1;

/**
 * One player's shared coverage, as one member sees them. (Older clients also
 * wrote a `tag` relationship field — retired 2026-07; unknown fields drop in
 * {@link normalizeAllianceDoc}, so old blocks stay readable.)
 *
 * @typedef {object} SharedPlayerIntel
 * @property {string} [name]        Display name at share time.
 * @property {number} [lastSpySec]  Newest spy report, epoch seconds.
 * @property {number} [lastSeenSec] Newest implied interaction from galaxy
 *   activity markers, epoch seconds.
 * @property {number} [bodiesSpied] Count of bodies with at least one report.
 */

/**
 * One alliance member's whole contribution.
 *
 * @typedef {object} AllianceMemberBlock
 * @property {number} updatedAtSec  When this block was last shared.
 * @property {Record<string, SharedPlayerIntel>} players  Keyed by player id.
 */

/**
 * The shared per-universe document (one gist file).
 *
 * @typedef {object} AllianceIntelDoc
 * @property {number} version    See {@link ALLIANCE_INTEL_VERSION}.
 * @property {string} universeId
 * @property {Record<string, AllianceMemberBlock>} members  Keyed by member name.
 */

/**
 * One row of the union view: a player with every member holding data on them.
 *
 * @typedef {object} AllianceIntelRow
 * @property {string} pid
 * @property {string} name
 * @property {number} lastSpySec   Newest across members (0 = never).
 * @property {number} lastSeenSec  Newest across members (0 = never).
 * @property {string[]} watchers   Contributing member names, alphabetical.
 */

/**
 * Canonical member key for a share name: trimmed, inner whitespace collapsed,
 * bounded. The key doubles as the display name.
 *
 * @param {string} name
 * @returns {string}
 */
export const memberKeyFor = (name) =>
  String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * Coerce to a positive integer epoch-seconds value, else undefined.
 * @param {unknown} v
 * @returns {number | undefined}
 */
const secField = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Coerce one raw shared-player entry; null when it carries nothing usable.
 * @param {unknown} raw
 * @returns {SharedPlayerIntel | null}
 */
const normalizePlayerIntel = (raw) => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  if (!o) return null;
  /** @type {SharedPlayerIntel} */
  const out = {};
  if (typeof o.name === 'string' && o.name) out.name = o.name.slice(0, 60);
  const spy = secField(o.lastSpySec);
  if (spy) out.lastSpySec = spy;
  const seen = secField(o.lastSeenSec);
  if (seen) out.lastSeenSec = seen;
  const bodies = secField(o.bodiesSpied);
  if (bodies) out.bodiesSpied = bodies;
  return out;
};

/**
 * Coerce one raw member block; null when malformed.
 * @param {unknown} raw
 * @returns {AllianceMemberBlock | null}
 */
const normalizeMemberBlock = (raw) => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  if (!o) return null;
  /** @type {Record<string, SharedPlayerIntel>} */
  const players = {};
  if (o.players && typeof o.players === 'object' && !Array.isArray(o.players)) {
    for (const pid of Object.keys(o.players)) {
      const p = normalizePlayerIntel(o.players[pid]);
      if (p) players[String(pid)] = p;
    }
  }
  return { updatedAtSec: secField(o.updatedAtSec) ?? 0, players };
};

/**
 * A fresh, empty document for a universe.
 * @param {string} universeId
 * @returns {AllianceIntelDoc}
 */
export const emptyAllianceDoc = (universeId) => ({
  version: ALLIANCE_INTEL_VERSION,
  universeId,
  members: {},
});

/**
 * Coerce a raw parsed gist file into a valid doc.
 *
 *   - `null`/`undefined` raw (file absent) → an empty doc: first share seeds it.
 *   - version ≠ {@link ALLIANCE_INTEL_VERSION} → `null`: the caller must NOT
 *     write (a newer OG-E owns the format; overwriting would clobber every
 *     other member's blocks).
 *   - otherwise → doc with each member block normalised (malformed ones drop).
 *
 * The stored `universeId` is informational (the filename scopes the file);
 * the expected one always wins so a hand-copied file can't relabel itself.
 *
 * @param {unknown} raw
 * @param {string} universeId
 * @returns {AllianceIntelDoc | null}
 */
export const normalizeAllianceDoc = (raw, universeId) => {
  if (raw == null) return emptyAllianceDoc(universeId);
  const o = typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  if (!o || o.version !== ALLIANCE_INTEL_VERSION) return null;
  const doc = emptyAllianceDoc(universeId);
  if (o.members && typeof o.members === 'object' && !Array.isArray(o.members)) {
    for (const name of Object.keys(o.members)) {
      const key = memberKeyFor(name);
      if (!key) continue;
      const block = normalizeMemberBlock(o.members[name]);
      if (block) doc.members[key] = block;
    }
  }
  return doc;
};

/**
 * Build OUR contribution block from local Spyglass state. Pure over plain
 * data — the caller (dashboard) reads the stores and hands in plain maps.
 *
 * Scope = every player we hold at least one OBSERVATION about (a spy report
 * in `reports` or an activity marker in `activity`) — deliberately NOT the
 * watch list (2026-07): the share carries what we've seen, never what we've
 * decided to track. An id with no usable observation contributes nothing
 * (a bare name is a decision trace, not data).
 *
 * `lastSeenSec` is the newest IMPLIED INTERACTION time across the player's
 * activity rings: a marker `m` minutes idle observed at `t` implies an
 * interaction at `t − m·60`; `m === -1` ("no marker") is negative evidence
 * and contributes nothing.
 *
 * @param {object} args
 * @param {Record<string, string>} [args.playerNames]  Player id → name.
 * @param {Record<string, Record<string, { latest?: unknown } | unknown>>} [args.reports]
 *   TargetReports-shaped map (`pid → bodyKey → entry`, read via `latestOf`).
 * @param {Record<string, Record<string, Array<{ t?: number, m?: number }>>>} [args.activity]
 *   ActivityObsMap-shaped map (`pid → bodyKey → ring`).
 * @param {number} args.nowSec
 * @returns {AllianceMemberBlock}
 */
export const buildMemberBlock = ({
  playerNames = {}, reports = {}, activity = {}, nowSec,
}) => {
  /** @type {Record<string, SharedPlayerIntel>} */
  const players = {};
  const pids = new Set([...Object.keys(reports), ...Object.keys(activity)]);
  for (const rawPid of pids) {
    const pid = String(rawPid);
    /** @type {SharedPlayerIntel} */
    const entry = {};
    const name = playerNames[pid];
    if (typeof name === 'string' && name) entry.name = name.slice(0, 60);

    const bucket = reports[pid];
    if (bucket && typeof bucket === 'object') {
      let newest = 0;
      let bodies = 0;
      for (const key of Object.keys(bucket)) {
        const latest = latestOf(/** @type {any} */ (bucket[key]));
        const ts = secField(latest?.timestamp);
        if (!ts) continue;
        bodies += 1;
        if (ts > newest) newest = ts;
      }
      if (newest) entry.lastSpySec = newest;
      if (bodies) entry.bodiesSpied = bodies;
    }

    const rings = activity[pid];
    if (rings && typeof rings === 'object') {
      let seen = 0;
      for (const key of Object.keys(rings)) {
        const ring = rings[key];
        if (!Array.isArray(ring)) continue;
        for (const obs of ring) {
          const t = secField(obs?.t);
          const m = Number(obs?.m);
          if (!t || !Number.isFinite(m) || m < 0) continue;
          const implied = t - m * 60;
          if (implied > seen) seen = implied;
        }
      }
      if (seen) entry.lastSeenSec = seen;
    }

    // The observation gate (see the scope note above): no spy/seen signal →
    // the id stays local, whatever else we know about it.
    if (entry.lastSpySec || entry.bodiesSpied || entry.lastSeenSec) players[pid] = entry;
  }
  return { updatedAtSec: nowSec, players };
};

/**
 * Union of the previous own block (as fetched from the gist) with the fresh
 * locally-built one, per player, field-wise max — the multi-device-safe core
 * of {@link mergeOwnBlock}. Every shared field is monotonic ("newest spy
 * report ever", "newest implied interaction ever", "bodies covered"), so max
 * is semantically exact, and two devices sharing under the SAME member name
 * converge instead of the last click wiping the other device's contribution.
 * The name follows the fresh block when it carries one (it reflects the
 * newest local observation), else the previous one is kept.
 *
 * @param {AllianceMemberBlock | undefined} prev
 * @param {AllianceMemberBlock} fresh
 * @returns {AllianceMemberBlock}
 */
const unionMemberBlock = (prev, fresh) => {
  if (!prev) return fresh;
  /** @type {Record<string, SharedPlayerIntel>} */
  const players = { ...prev.players };
  for (const pid of Object.keys(fresh.players)) {
    const f = fresh.players[pid];
    const p = players[pid];
    if (!p) {
      players[pid] = f;
      continue;
    }
    /** @type {SharedPlayerIntel} */
    const out = {};
    const name = f.name || p.name;
    if (name) out.name = name;
    const spy = Math.max(f.lastSpySec ?? 0, p.lastSpySec ?? 0);
    if (spy) out.lastSpySec = spy;
    const seen = Math.max(f.lastSeenSec ?? 0, p.lastSeenSec ?? 0);
    if (seen) out.lastSeenSec = seen;
    const bodies = Math.max(f.bodiesSpied ?? 0, p.bodiesSpied ?? 0);
    if (bodies) out.bodiesSpied = bodies;
    players[pid] = out;
  }
  return { updatedAtSec: Math.max(prev.updatedAtSec ?? 0, fresh.updatedAtSec ?? 0), players };
};

/**
 * Merge OUR block into the shared doc: UNION the fresh local block with the
 * previous `members[memberKey]` (per player, field-wise max — see
 * {@link unionMemberBlock}), keep every other member's block verbatim. The
 * input doc is not mutated.
 *
 * Union, NOT wholesale replace (changed 2026-07): a replace assumed one
 * member = one device, so two devices sharing under the same name silently
 * clobbered each other's coverage — whichever synced last owned the block.
 * With the union a player never LEAVES a block by mere absence; that's the
 * right call for observations (they don't un-happen), and staleness is
 * visible per row via the times themselves.
 *
 * @param {AllianceIntelDoc} doc
 * @param {string} memberKey  Already canonical (see {@link memberKeyFor}).
 * @param {AllianceMemberBlock} block
 * @returns {AllianceIntelDoc}
 */
export const mergeOwnBlock = (doc, memberKey, block) => ({
  ...doc,
  members: { ...doc.members, [memberKey]: unionMemberBlock(doc.members[memberKey], block) },
});

/**
 * Union view of a doc for display: one row per player across all members,
 * newest-signal first. Display-only — see the file-header invariant.
 *
 * @param {AllianceIntelDoc} doc
 * @returns {AllianceIntelRow[]}
 */
export const summarizeAllianceIntel = (doc) => {
  /** @type {Map<string, AllianceIntelRow & { _nameAtSec: number }>} */
  const byPid = new Map();
  for (const member of Object.keys(doc.members).sort((a, b) => a.localeCompare(b))) {
    const block = doc.members[member];
    for (const pid of Object.keys(block.players)) {
      const p = block.players[pid];
      let row = byPid.get(pid);
      if (!row) {
        row = { pid, name: '', lastSpySec: 0, lastSeenSec: 0, watchers: [], _nameAtSec: -1 };
        byPid.set(pid, row);
      }
      row.watchers.push(member);
      // The name follows the FRESHEST block that carries one, so a renamed
      // player converges on the most recent observation.
      if (p.name && block.updatedAtSec > row._nameAtSec) {
        row.name = p.name;
        row._nameAtSec = block.updatedAtSec;
      }
      if ((p.lastSpySec ?? 0) > row.lastSpySec) row.lastSpySec = /** @type {number} */ (p.lastSpySec);
      if ((p.lastSeenSec ?? 0) > row.lastSeenSec) row.lastSeenSec = /** @type {number} */ (p.lastSeenSec);
    }
  }
  return [...byPid.values()]
    .map(({ _nameAtSec, ...row }) => row)
    .sort((a, b) =>
      Math.max(b.lastSpySec, b.lastSeenSec) - Math.max(a.lastSpySec, a.lastSeenSec)
      || a.name.localeCompare(b.name));
};
