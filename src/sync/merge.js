// Pure merge helpers that reconcile local + remote slices of our two
// cross-device-synced stores (galaxy scans, colony history).
//
// # Central design decision — the `changed` flag is an anti-loop hint
//
// Every sync round-trip writes the merged result back to the local store.
// But the local store is watched by `storage.onChanged`, which schedules
// another upload, which on the next pull will re-merge, which will write
// back again, and so on. If that merge write is a NO-OP compared to what
// was already there, we just burned a GitHub API request for nothing —
// and at OGame's tick cadence we will exhaust the 5000 req/h quota in
// minutes.
//
// The fix is structural: callers only write to local when `changed ===
// true`. The merge functions here compute that flag precisely — `true`
// iff the remote contributed at least one entry (new key, or newer
// `scannedAt`, or new `cp`) that local did not already have. When both
// sides are already in agreement, `changed === false` and the caller
// short-circuits the write, breaking the feedback loop.
//
// # Why these are pure functions
//
// No I/O, no side effects, no timers. They take two snapshots and
// return one. That lets the callers (sync engine, upload scheduler,
// migration code) compose them freely — merge first, then decide whether
// to persist, then decide whether to upload, each step isolated. Tests
// run in Node env with no DOM, because there is nothing DOM-shaped
// about a Map union.
//
// # Why per-system grain for scans (not per-position)
//
// A galaxy scan is the authoritative snapshot of one system's 15 slots
// at one moment. If remote has a newer `scannedAt` for key `"4:30"`,
// its `positions` record is already the most-current view of that
// system — merging slot-by-slot would risk resurrecting stale slot
// data that the newer scan intentionally overwrote. Per-system
// max-timestamp is the correct unit of truth.
//
// # Why local wins on cp collision in history
//
// ColonyHistory entries are append-only observations. A local entry
// for cp=12345 was recorded at the moment we first loaded that
// planet's overview with usedFields===0 — a first-hand observation.
// A remote entry for the same cp is an older imported version.
// We trust our own observation; the remote is kept only to fill in
// cps we have never seen (which is exactly the point of the sync).
//
// @ts-check

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../state/scans.js').SystemScan} SystemScan
 * @typedef {import('../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../state/history.js').ColonyHistory} ColonyHistory
 */

/**
 * Merge local + remote galaxy scans, per-system, max-`scannedAt` wins.
 *
 * Behaviour:
 *   - Unions keys from local + remote.
 *   - For each shared key, the side with the larger (numerically
 *     greater-or-equal) `scannedAt` wins. Ties go to local — the only
 *     way local can be displaced is by a strictly newer remote scan.
 *   - Missing / non-numeric `scannedAt` is treated as 0, so a well-
 *     formed side always beats a malformed one.
 *
 * The `changed` flag is the caller's anti-loop hint (see file header):
 * `true` iff remote contributed at least one key local did not have
 * OR strictly displaced a shared key with a newer scan. If `false`,
 * callers MUST NOT write `merged` back to local storage.
 *
 * Edge cases:
 *   - `remote` undefined or null: `merged === local` (same reference),
 *     `changed === false`. We do not shallow-copy — callers that treat
 *     the merged value as frozen must not mutate it either way.
 *   - `remote` is `{}`: same as undefined (empty contributes nothing).
 *   - Both sides empty: `merged === local` (which is `{}`), `changed
 *     === false`.
 *
 * @param {GalaxyScans} local
 *   The in-memory galaxy-scan map. Treated as the source of truth
 *   when `scannedAt` ties or when remote is absent.
 * @param {GalaxyScans | undefined | null} remote
 *   The decoded remote payload. `undefined` or `null` is the common
 *   "no gist yet" shape and short-circuits to identity.
 * @returns {{ merged: GalaxyScans, changed: boolean }}
 *   `merged` is the reconciled map. `changed` is the anti-loop hint
 *   described above.
 */
export const mergeScans = (local, remote) => {
  if (!remote || Object.keys(remote).length === 0) {
    return { merged: local, changed: false };
  }
  /** @type {GalaxyScans} */
  const merged = {};
  const allKeys = new Set([
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  let changed = false;
  for (const key of allKeys) {
    const typedKey = /** @type {`${number}:${number}`} */ (key);
    const l = local[typedKey];
    const r = remote[typedKey];
    if (!l) {
      // Remote introduced a key local never had — classic "new data
      // from another device" path, the whole reason we sync.
      merged[typedKey] = r;
      changed = true;
      continue;
    }
    if (!r) {
      // Local-only key (the `Set` union means this branch only fires
      // when remote genuinely lacks the key, not when it has a falsy
      // value). Keep local untouched.
      merged[typedKey] = l;
      continue;
    }
    // Both sides have data. `||0` normalises missing/NaN `scannedAt`
    // to 0 so a well-formed side beats a malformed one. Ties go to
    // local (>=) — that is the source of the no-write path when
    // local === remote already.
    if ((l.scannedAt || 0) >= (r.scannedAt || 0)) {
      merged[typedKey] = l;
    } else {
      merged[typedKey] = r;
      changed = true;
    }
  }
  return { merged, changed };
};

/**
 * Merge local + remote colony history, deduped by `cp`, local-wins.
 *
 * Behaviour:
 *   - Builds a `Map<cp, ColonyEntry>` seeded from local (insertion
 *     order preserved).
 *   - Walks remote: for each entry whose `cp` is NOT already in the
 *     map, append it. Entries whose `cp` is already present are
 *     dropped — we trust our own first-hand observation over an
 *     older import.
 *   - Returns `[...map.values()]`, which by Map-iteration semantics
 *     yields locals first (in their original order) then new
 *     remotes (in remote's original order).
 *
 * The `changed` flag is the caller's anti-loop hint (see file
 * header): `true` iff remote contributed at least one cp local did
 * not already have. If `false`, callers MUST NOT write `merged` back
 * to local storage.
 *
 * Edge cases:
 *   - `remote` undefined / null / empty: `merged === local` (same
 *     reference), `changed === false`.
 *   - Local empty, remote non-empty: every remote entry survives,
 *     `changed === true`.
 *   - Fully overlapping cps: `changed === false`, `merged` contains
 *     every local entry (unchanged).
 *
 * NOTE: this function does NOT implement a `deletedSet` tombstone
 * filter. Tombstones are the caller's concern — they filter both
 * sides BEFORE passing in, or filter the merged result AFTER. Keeping
 * merge tombstone-free is what makes it a pure reconciliation
 * primitive independent of the tombstone store's schema/location.
 *
 * @param {ColonyHistory} local
 *   The in-memory colony-history list. Always wins on cp collision.
 * @param {ColonyHistory | undefined | null} remote
 *   The decoded remote payload. `undefined`/`null`/`[]` short-circuits
 *   to identity.
 * @returns {{ merged: ColonyHistory, changed: boolean }}
 *   `merged` is the deduped union array, local first then new remote
 *   cps in remote order. `changed` is the anti-loop hint above.
 */
export const mergeHistory = (local, remote) => {
  if (!remote || remote.length === 0) {
    return { merged: local, changed: false };
  }
  /** @type {Map<number, ColonyEntry>} */
  const byCp = new Map();
  for (const h of local) byCp.set(h.cp, h);
  let changed = false;
  for (const h of remote) {
    if (!byCp.has(h.cp)) {
      byCp.set(h.cp, h);
      changed = true;
    }
  }
  return { merged: [...byCp.values()], changed };
};
