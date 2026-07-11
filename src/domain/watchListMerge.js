// @ts-check

// Watch-list sync merge — the pure core of the Spyglass cross-device sync
// (SPYGLASS-SYNC-PLAN.md). No DOM, no timers, no storage, no chrome.*.
//
// # The model: per-key families of `{ v?, ts }` records
//
// The synced watch-list state decomposes into FAMILIES — flat maps of
// `key → { v?, ts }` where `v` present means "alive with this value, stamped
// at ts" and `v` ABSENT means "removed at ts" (a tombstone). One uniform rule
// merges every family: **the newest `ts` wins per key**, so add-vs-remove,
// set-vs-clear and tag-vs-untag all resolve by recency across devices. This
// replaces per-family bespoke rules (watched sets, relationship LWW, scanMode
// clear-tombstones, whole-object cadence LWW) with ONE function and ONE test
// surface — a single-key family (`"_"`) IS whole-object LWW.
//
// Families:
//   watched    player id → { v: true }        (starred) / tombstone (un-starred)
//   rel        player id → { v: Relationship } / tombstone (cleared to neutral)
//   scan       pid or bodyKey → { v: 'on'|'off' } / tombstone (cleared to inherited)
//   gal        player id → { v: 'on'|'off' }   / tombstone (cleared to default)
//   hide       player id → { v: true }         / tombstone (unhidden on the map)
//   scanBodies "_" → { v: 'planets'|'moons'|'both' }   — never tombstoned
//   cadence    "_" → { v: { rescanHours, galaxyHours } } — never tombstoned
//   moonStrike "_" → { v: 'off'|'lone'|'newest'|'any' }  — never tombstoned
//   patrol     "_" → { v: number (± systems, 0 = off) }   — never tombstoned
//
// `probes` and `rescan` are deliberately NOT families: probes is per-device
// FAB convenience, rescan is transient bookkeeping that self-clears against
// targetReports — which are per-device too, so syncing the flag would lie.
//
// # Tombstone GC
//
// Tombstones exist so a removal propagates instead of being resurrected by a
// union; they only need to outlive the slowest device's absence. Entries dead
// longer than {@link WATCH_TOMBSTONE_GC_MS} are dropped by both the merge and
// the stamp, so the synced payload cannot grow forever.
//
// # C6 invariant (the "silent wipe" class from the sync audit)
//
// A tombstone is born ONLY in {@link stampWatchListDiff} — i.e. only when a
// caller passes a next-config that explicitly dropped a key (a user action).
// {@link seedWatchListLedger} (migration/first-sync) stamps LIVE keys only and
// can never create one. An empty fresh device therefore composes empty
// families, which merge as a no-op against an established remote.

/**
 * @typedef {{ v?: unknown, ts: number }} FamRecord
 *   One synced entry: `v` present = alive value stamped at `ts` (epoch-ms);
 *   `v` absent = tombstone (removed at `ts`).
 *
 * @typedef {Record<string, FamRecord>} Family
 *
 * @typedef {object} WatchListSyncSlot
 *   The per-universe wire shape stored in the gist payload
 *   (`watchListPerUniverse[universeId]`) — see the family table in the file
 *   header. All families always present (possibly empty).
 * @property {Family} watched
 * @property {Family} rel
 * @property {Family} scan
 * @property {Family} gal
 * @property {Family} hide
 * @property {Family} scanBodies
 * @property {Family} cadence
 * @property {Family} moonStrike
 * @property {Family} patrol
 *
 * @typedef {Record<string, Record<string, number>>} WatchListLedger
 *   The local sidecar (`<uni>:oge_watchListTs`): per family, key → stamp.
 *   A ledger entry whose key is ABSENT from the config is the local record
 *   of a tombstone. Same family names as the slot; singles use key `"_"`.
 */

/** Family names, fixed — the slot/ledger contract. */
export const WATCH_FAMILIES = /** @type {const} */ ([
  'watched', 'rel', 'scan', 'gal', 'hide', 'scanBodies', 'cadence', 'moonStrike', 'patrol',
]);

/** The single-value families — one `"_"`-keyed record, never tombstoned. */
const SINGLE_FAMILIES = new Set(['scanBodies', 'cadence', 'moonStrike', 'patrol']);

/** Key used by the single-value families (see {@link SINGLE_FAMILIES}). */
export const SINGLE_KEY = '_';

/** Tombstones dead longer than this are GC'd (60 days — longer than any
 * realistic gap between two devices of the same player both syncing). */
export const WATCH_TOMBSTONE_GC_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Coerce one raw family (from a hand-editable gist or an older schema) into
 * clean `{ v?, ts }` records: finite non-negative ts, `v` kept as-is when
 * present. Junk entries are dropped rather than guessed at.
 *
 * @param {unknown} raw
 * @returns {Family}
 */
const normalizeFamily = (raw) => {
  /** @type {Family} */
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = /** @type {{ v?: unknown, ts?: unknown }} */ (rec);
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || ts < 0) continue;
    out[k] = 'v' in r ? { v: r.v, ts } : { ts };
  }
  return out;
};

/**
 * Coerce a raw wire slot into a complete {@link WatchListSyncSlot} (every
 * family present, junk dropped). Tolerates `null`/absent (→ all-empty slot).
 *
 * @param {unknown} raw
 * @returns {WatchListSyncSlot}
 */
export const normalizeWatchSlot = (raw) => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  /** @type {any} */
  const slot = {};
  for (const fam of WATCH_FAMILIES) slot[fam] = normalizeFamily(o[fam]);
  return /** @type {WatchListSyncSlot} */ (slot);
};

/**
 * Whether a slot is worth contributing to the gist. Keyed-family records
 * (live or tombstone) always count; the single-value families count only
 * once STAMPED (`ts > 0`) — a virgin universe composes its materialised
 * defaults with `ts: 0`, and contributing those would write a slot for
 * every universe the user merely visits (the same no-op-PATCH guard as
 * `galaxyConfigSlotHasData`).
 *
 * @param {WatchListSyncSlot} slot
 * @returns {boolean}
 */
export const watchSlotHasData = (slot) =>
  WATCH_FAMILIES.some((fam) =>
    Object.values(slot[fam] || {}).some(
      (rec) => rec.ts > 0 || !SINGLE_FAMILIES.has(fam),
    ));

/**
 * The live values of one config family as a flat `key → value` map. The
 * watch-list config stores families in three shapes (array of ids, value
 * maps, single values) — this is the one place that flattens them.
 *
 * @param {import('../state/watchList.js').WatchListConfig | Record<string, any>} cfg
 *   Structural: only the synced fields are read. (Type import is JSDoc-only —
 *   no runtime dependency, `domain` stays import-free of `state`.)
 * @param {(typeof WATCH_FAMILIES)[number]} fam
 * @returns {Record<string, unknown>}
 */
const liveValuesOf = (cfg, fam) => {
  const c = /** @type {Record<string, any>} */ (cfg);
  switch (fam) {
    case 'watched': {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const id of Array.isArray(c.players) ? c.players : []) out[String(id)] = true;
      return out;
    }
    case 'rel': return { ...(c.relationships || {}) };
    case 'scan': return { ...(c.scanMode || {}) };
    case 'gal': return { ...(c.galaxyMode || {}) };
    case 'hide': return { ...(c.mapHidden || {}) };
    case 'scanBodies': return c.scanBodies != null ? { [SINGLE_KEY]: c.scanBodies } : {};
    case 'cadence': return c.cadence != null ? { [SINGLE_KEY]: c.cadence } : {};
    case 'moonStrike': return c.moonStrike != null ? { [SINGLE_KEY]: c.moonStrike } : {};
    case 'patrol': return c.patrolSystems != null ? { [SINGLE_KEY]: c.patrolSystems } : {};
    default: return {};
  }
};

/**
 * Compose the wire slot from a local config + its ts ledger. Deterministic —
 * a key with no ledger stamp composes with `ts: 0` (pre-ledger legacy entry;
 * {@link seedWatchListLedger} exists so persisted state normally never has
 * one). Ledger stamps whose key is absent from the config become tombstones.
 *
 * @param {import('../state/watchList.js').WatchListConfig | Record<string, any>} cfg
 * @param {WatchListLedger} ledger
 * @returns {WatchListSyncSlot}
 */
export const composeWatchSlot = (cfg, ledger) => {
  /** @type {any} */
  const slot = {};
  for (const fam of WATCH_FAMILIES) {
    /** @type {Family} */
    const out = {};
    const live = liveValuesOf(cfg, fam);
    const stamps = ledger?.[fam] || {};
    for (const [k, v] of Object.entries(live)) out[k] = { v, ts: Number(stamps[k]) || 0 };
    for (const [k, ts] of Object.entries(stamps)) {
      if (!(k in live) && Number.isFinite(Number(ts))) out[k] = { ts: Number(ts) };
    }
    slot[fam] = out;
  }
  return /** @type {WatchListSyncSlot} */ (slot);
};

/**
 * Decompose a (merged) wire slot back into config fields + ledger. The
 * returned `cfg` carries ONLY the synced fields — the caller overlays it on
 * the current stored config so the local-only fields (`probes`, `rescan`)
 * survive. `players` is sorted numerically for a stable, comparable output
 * (star order is not a synced concept).
 *
 * @param {WatchListSyncSlot} slot
 * @returns {{ cfg: Record<string, any>, ledger: WatchListLedger }}
 */
export const decomposeWatchSlot = (slot) => {
  /** @type {WatchListLedger} */
  const ledger = {};
  /** @type {Record<string, Record<string, unknown>>} */
  const live = {};
  for (const fam of WATCH_FAMILIES) {
    ledger[fam] = {};
    live[fam] = {};
    for (const [k, rec] of Object.entries(slot[fam] || {})) {
      ledger[fam][k] = rec.ts;
      if ('v' in rec) live[fam][k] = rec.v;
    }
  }
  const players = Object.keys(live.watched)
    .sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  /** @type {Record<string, any>} */
  const cfg = {
    players,
    relationships: live.rel,
    scanMode: live.scan,
    galaxyMode: live.gal,
    mapHidden: live.hide,
  };
  if (SINGLE_KEY in live.scanBodies) cfg.scanBodies = live.scanBodies[SINGLE_KEY];
  if (SINGLE_KEY in live.cadence) cfg.cadence = live.cadence[SINGLE_KEY];
  if (SINGLE_KEY in live.moonStrike) cfg.moonStrike = live.moonStrike[SINGLE_KEY];
  if (SINGLE_KEY in live.patrol) cfg.patrolSystems = live.patrol[SINGLE_KEY];
  return { cfg, ledger };
};

/** @param {unknown} a @param {unknown} b @returns {boolean} Structural equality (plain JSON values). */
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Seed missing stamps for LIVE keys (first sync / migration from the
 * pre-ledger config). Stamping existing entries at `now` preserves them
 * against any remote state in the initial merge — "never wipe a device's
 * list" (SPYGLASS-SYNC-PLAN invariant 2). NEVER creates a tombstone (C6).
 *
 * The two single-value families are seeded only when their value DIFFERS from
 * the materialised default (`defaults`, supplied by the caller —
 * state/watchList owns those constants). Two reasons, one per direction:
 * a virgin universe stamping its defaults would contribute a junk slot for
 * every server the user merely visits (see {@link watchSlotHasData}); and a
 * fresh device seeding a DEFAULT cadence at `now` would win LWW over another
 * device's earlier-seeded TUNED one — a default needs no stamp at all (absent
 * remote keeps it; a stamped remote tuning should adopt). A non-default value
 * is evidence of a real pre-ledger edit and gets the protective `now` stamp.
 * A real edit of either single stamps via {@link stampWatchListDiff} regardless.
 *
 * @param {import('../state/watchList.js').WatchListConfig | Record<string, any>} cfg
 * @param {WatchListLedger} ledger
 * @param {number} now
 * @param {{ scanBodies?: unknown, cadence?: unknown, moonStrike?: unknown, patrol?: unknown }} [defaults]
 *   The materialised single-family defaults to compare against; a family with
 *   no supplied default seeds whenever unstamped.
 * @returns {{ ledger: WatchListLedger, changed: boolean }}
 */
export const seedWatchListLedger = (cfg, ledger, now, defaults = {}) => {
  let changed = false;
  /** @type {WatchListLedger} */
  const out = {};
  for (const fam of WATCH_FAMILIES) {
    out[fam] = { ...(ledger?.[fam] || {}) };
    const single = SINGLE_FAMILIES.has(fam);
    for (const [k, v] of Object.entries(liveValuesOf(cfg, fam))) {
      if (Number.isFinite(Number(out[fam][k]))) continue;
      if (single && fam in defaults && sameValue(v, defaults[/** @type {'scanBodies'|'cadence'|'moonStrike'|'patrol'} */ (fam)])) continue;
      out[fam][k] = now;
      changed = true;
    }
  }
  return { ledger: out, changed };
};

/**
 * Stamp the ledger for an explicit config transition `prev → next`: added or
 * value-changed keys get `ts = now`; keys DROPPED by the transition keep
 * their ledger entry re-stamped at `now` — that entry (with no live config
 * key) IS the tombstone that lets the removal propagate. This is the ONLY
 * place tombstones are born (C6 invariant — callers must pass a `next` that
 * came from a user edit, never from hydration). Also seeds unstamped live
 * keys (belt-and-braces for pre-ledger configs) and GCs long-dead tombstones.
 *
 * @param {import('../state/watchList.js').WatchListConfig | Record<string, any>} prevCfg
 * @param {import('../state/watchList.js').WatchListConfig | Record<string, any>} nextCfg
 * @param {WatchListLedger} ledger
 * @param {number} now
 * @returns {{ ledger: WatchListLedger, changed: boolean }}
 */
export const stampWatchListDiff = (prevCfg, nextCfg, ledger, now) => {
  let changed = false;
  /** @type {WatchListLedger} */
  const out = {};
  for (const fam of WATCH_FAMILIES) {
    out[fam] = { ...(ledger?.[fam] || {}) };
    const prev = liveValuesOf(prevCfg, fam);
    const next = liveValuesOf(nextCfg, fam);
    const single = SINGLE_FAMILIES.has(fam);
    for (const [k, v] of Object.entries(next)) {
      const isNew = !(k in prev) || !sameValue(prev[k], v);
      // Singles stamp only on a REAL value change — their materialised
      // defaults must not get seeded by an unrelated save on a virgin
      // universe (see seedWatchListLedger). Keyed families also backfill a
      // missing stamp (belt-and-braces for pre-ledger configs).
      if (isNew || (!single && !Number.isFinite(Number(out[fam][k])))) {
        out[fam][k] = now;
        changed = true;
      }
    }
    for (const k of Object.keys(prev)) {
      if (!(k in next)) {
        out[fam][k] = now; // the removal tombstone
        changed = true;
      }
    }
    // GC: a ledger entry that is dead in `next` and older than the horizon
    // has done its propagation job — drop it so the ledger can't grow forever.
    for (const [k, ts] of Object.entries(out[fam])) {
      if (!(k in next) && now - Number(ts) > WATCH_TOMBSTONE_GC_MS) {
        delete out[fam][k];
        changed = true;
      }
    }
  }
  return { ledger: out, changed };
};

/**
 * The uniform per-key merge of two wire slots — newest `ts` wins. Ties are
 * broken deterministically and SYMMETRICALLY (both devices must pick the same
 * winner regardless of which side is "local"): a live record beats a
 * tombstone, then the lexicographically larger serialized value wins.
 *
 * `changed` follows the sync/merge.js anti-loop contract: `true` iff the
 * REMOTE side contributed at least one winning record that local did not
 * already hold — callers write back to local stores only then.
 *
 * Tombstones older than the GC horizon (relative to `now`, injected by the
 * caller so this stays pure) are dropped from the merged output.
 *
 * @param {WatchListSyncSlot} local
 * @param {unknown} remote  Raw remote slot (normalized here — the gist is
 *   user-editable, so junk must be tolerated).
 * @param {number} now
 * @returns {{ merged: WatchListSyncSlot, changed: boolean }}
 */
export const mergeWatchList = (local, remote, now) => {
  const loc = normalizeWatchSlot(local);
  const rem = normalizeWatchSlot(remote);
  let changed = false;
  /** @type {any} */
  const merged = {};
  for (const fam of WATCH_FAMILIES) {
    /** @type {Family} */
    const out = {};
    const keys = new Set([...Object.keys(loc[fam]), ...Object.keys(rem[fam])]);
    for (const k of keys) {
      const l = loc[fam][k];
      const r = rem[fam][k];
      const winner = pickWinner(l, r);
      if (!winner) continue;
      // GC dead entries that outlived the propagation horizon.
      if (!('v' in winner) && now - winner.ts > WATCH_TOMBSTONE_GC_MS) continue;
      out[k] = winner;
      if (winner === r && (!l || !recordsEqual(l, r))) changed = true;
    }
    merged[fam] = out;
  }
  return { merged: /** @type {WatchListSyncSlot} */ (merged), changed };
};

/** @param {FamRecord} a @param {FamRecord} b @returns {boolean} */
const recordsEqual = (a, b) =>
  a.ts === b.ts && ('v' in a) === ('v' in b) && sameValue(a.v, b.v);

/**
 * Winner of one key: newer `ts`; tie → live beats tombstone; live-live tie →
 * larger serialized value (arbitrary but symmetric across devices).
 *
 * @param {FamRecord | undefined} l
 * @param {FamRecord | undefined} r
 * @returns {FamRecord | undefined}
 */
const pickWinner = (l, r) => {
  if (!l) return r;
  if (!r) return l;
  if (l.ts !== r.ts) return l.ts > r.ts ? l : r;
  const lLive = 'v' in l;
  const rLive = 'v' in r;
  if (lLive !== rLive) return lLive ? l : r;
  return JSON.stringify(l.v ?? null) >= JSON.stringify(r.v ?? null) ? l : r;
};
