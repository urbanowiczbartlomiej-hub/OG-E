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

// The colonization decision log's merge is pure domain logic (monotonic +
// LWW, terminal states never regress); re-exported here so the sync scheduler
// imports every reconciler from one place. See domain/colonizeDecisions.js.
export { mergeColonizeDecisions } from '../domain/colonizeDecisions.js';

// The JSON-import reconcilers at the bottom of this file (target reports,
// proximity log, activity rings, player cache, alliance classes, body
// inventory) serve the dashboard Export/Import (features/dashboard/io.js).
// They live HERE — not in io.js — because this file is the single home of
// "two snapshots in, one out" reconciliation: an import must behave exactly
// like a gist download, and keeping every reconciler on one shelf is what
// keeps that promise honest.
import { latestOf, historyOf, HISTORY_CAP } from '../domain/targetReports.js';
import { ACTIVITY_RING_CAP } from '../domain/activityObs.js';
import { trimProximityLog } from '../state/proximityReports.js';
import { FR_TOMBSTONE_TTL_SEC } from '../state/fleetReminders.js';

/**
 * Whether two lifeform-position maps (slot → discovery epoch-ms) carry the
 * identical data. Missing maps are treated as empty. Used to decide when the
 * LF reconciliation left a scan untouched so {@link mergeScans} can reuse the
 * existing reference (preserving the anti-loop no-write path).
 *
 * @param {Record<number, number> | undefined} a
 * @param {Record<number, number> | undefined} b
 * @returns {boolean}
 */
const lfPositionsEqual = (a, b) => {
  const av = /** @type {Record<string, number>} */ (a || {});
  const bv = /** @type {Record<string, number>} */ (b || {});
  const ak = Object.keys(av);
  if (ak.length !== Object.keys(bv).length) return false;
  for (const k of ak) {
    if ((Number(av[k]) || 0) !== (Number(bv[k]) || 0)) return false;
  }
  return true;
};

/**
 * Reconcile the lifeform-discovery markers of two scans of the SAME system,
 * INDEPENDENTLY of `scannedAt`. A plain galaxy rescan carries no LF fields,
 * so letting it win the whole entry (it well may, on a newer `scannedAt`)
 * would silently erase a discovery recorded on another device. Rule: newer
 * `lfScannedAt` wins; `lfPositions` union with max-ts per slot.
 *
 * Returns `null` on the fast path where NEITHER side carries any LF data —
 * the caller then keeps the original whole-entry-by-`scannedAt` behaviour and
 * its reference identity. Otherwise returns the reconciled markers plus
 * `remoteAdded`: `true` iff remote contributed an LF marker/position local
 * lacked (an anti-loop `changed` input).
 *
 * @param {SystemScan} l
 * @param {SystemScan} r
 * @returns {{ lfScannedAt: number, lfPositions: Record<number, number> | null, remoteAdded: boolean } | null}
 */
const reconcileLf = (l, r) => {
  const lLf = Number(l.lfScannedAt) || 0;
  const rLf = Number(r.lfScannedAt) || 0;
  const lp = l.lfPositions && typeof l.lfPositions === 'object' ? l.lfPositions : null;
  const rp = r.lfPositions && typeof r.lfPositions === 'object' ? r.lfPositions : null;
  if (!lLf && !rLf && !lp && !rp) return null;

  let remoteAdded = rLf > lLf;
  /** @type {Record<number, number> | null} */
  let lfPositions = null;
  if (lp || rp) {
    lfPositions = { ...(lp || {}) };
    const rpKeys = rp ? Object.keys(/** @type {Record<string, number>} */ (rp)) : [];
    for (const k of rpKeys) {
      const key = /** @type {number} */ (/** @type {unknown} */ (k));
      const rv = Number(/** @type {Record<string, number>} */ (rp)[k]) || 0;
      if (rv > (Number(lfPositions[key]) || 0)) {
        lfPositions[key] = rv;
        remoteAdded = true;
      }
    }
  }
  return { lfScannedAt: Math.max(lLf, rLf), lfPositions, remoteAdded };
};

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
 *   - Lifeform markers (`lfScannedAt` / `lfPositions`) reconcile
 *     INDEPENDENTLY of `scannedAt` (newer `lfScannedAt` wins, positions
 *     union) so a plain rescan winning on `scannedAt` can't erase a
 *     discovery the other side recorded. See {@link reconcileLf}.
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
    // Both sides have data. The base scan snapshot (`scannedAt` +
    // `positions`) goes to the side with the larger `scannedAt`; `||0`
    // normalises missing/NaN so a well-formed side beats a malformed one,
    // and ties go to local (the no-write path when local === remote).
    const remoteScanWins = (r.scannedAt || 0) > (l.scannedAt || 0);
    const base = remoteScanWins ? r : l;
    // Lifeform markers reconcile INDEPENDENTLY of `scannedAt` (see
    // reconcileLf): a plain rescan winning on `scannedAt` must NOT erase a
    // discovery the other device recorded. `null` = no LF on either side,
    // so the original whole-entry-by-reference behaviour stands.
    const lf = reconcileLf(l, r);
    if (!lf) {
      merged[typedKey] = base;
      if (remoteScanWins) changed = true;
      continue;
    }
    const sameAsBase =
      lf.lfScannedAt === (Number(base.lfScannedAt) || 0) &&
      lfPositionsEqual(base.lfPositions, lf.lfPositions ?? undefined);
    if (sameAsBase) {
      // Reconciliation added nothing over the base — keep its reference so
      // an identical round-trip stays a no-op.
      merged[typedKey] = base;
    } else {
      const entry = { ...base };
      if (lf.lfScannedAt > 0) entry.lfScannedAt = lf.lfScannedAt;
      if (lf.lfPositions && Object.keys(lf.lfPositions).length > 0) {
        entry.lfPositions = lf.lfPositions;
      }
      merged[typedKey] = entry;
    }
    if (remoteScanWins || lf.remoteAdded) changed = true;
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

/**
 * Merge local + remote synced settings, PER KEY, newer-`ts`-wins.
 *
 * Unlike scans/history (additive collections), settings are a scalar bag
 * where each key has an independent "most recently changed" truth. So the
 * grain is the key, and the tie-breaker is the per-key change timestamp
 * (`ts`), not a collection union.
 *
 * Behaviour:
 *   - Iterates the UNION of local + remote keys. Local keys reconcile by
 *     timestamp (below). A key present only on REMOTE — a setting a
 *     newer-version peer knows but this build's schema doesn't yet — is
 *     adopted when it carries a real (>0) timestamp, so it survives the
 *     round-trip instead of being silently dropped (which would also delete
 *     it from the gist on our next upload). It is the CALLER's job to strip
 *     excluded / out-of-scope keys from `remote` first (as it already does
 *     for `local`), so a remote-only `gistToken` or cross-scope key can never
 *     leak into `values` here.
 *   - For each key, the side with the strictly greater `ts` wins. Ties (and
 *     missing/0 timestamps) go to LOCAL — that's the anti-loop no-write
 *     path and the reason a key nobody has explicitly changed (ts 0 both
 *     sides) keeps the local value. A remote-only key with ts 0 is skipped
 *     (nothing meaningful to adopt).
 *
 * The `changed` flag is the caller's anti-loop hint (see file header):
 * `true` iff remote strictly displaced at least one key with a newer
 * timestamp. If `false`, callers MUST NOT write `merged` back.
 *
 * @param {{ values: Record<string, unknown>, ts: Record<string, number> }} local
 * @param {{ values?: Record<string, unknown>, ts?: Record<string, number> } | undefined | null} remote
 * @returns {{ merged: { values: Record<string, unknown>, ts: Record<string, number> }, changed: boolean }}
 */
export const mergeSettings = (local, remote) => {
  if (!remote || !remote.values) return { merged: local, changed: false };
  const lv = local.values || {};
  const lt = local.ts || {};
  const rv = remote.values || {};
  const rt = remote.ts || {};
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, number>} */
  const ts = {};
  let changed = false;
  const keys = new Set([...Object.keys(lv), ...Object.keys(rv)]);
  for (const key of keys) {
    const hasLocal = key in lv;
    const lTime = Number(lt[key]) || 0;
    const rTime = Number(rt[key]) || 0;
    // Remote wins a SHARED key on a strictly-newer ts, and adopts a
    // remote-ONLY key only when it carries a real (>0) ts (forward-compat for
    // a newer peer's setting). A remote-only key with ts 0 falls through and,
    // having no local value either, is simply not emitted.
    const remoteWins = key in rv && rTime > lTime && (hasLocal || rTime > 0);
    if (remoteWins) {
      values[key] = rv[key];
      ts[key] = rTime;
      changed = true;
    } else if (hasLocal) {
      values[key] = lv[key];
      // Keep the ts map SPARSE — only carry a real (>0) timestamp. Emitting
      // an explicit 0 for every untouched key would bloat the map and, worse,
      // make `merged.ts` differ from the sparse local/remote maps on every
      // round-trip, defeating the sameJSON "already current" skip.
      if (lTime) ts[key] = lTime;
    }
  }
  return { merged: { values, ts }, changed };
};

/**
 * @typedef {object} DailyRunRoutesSlot
 * @property {import('../domain/dailyRunRoutes.js').Route[]} routes
 * @property {import('../domain/dailyRunRoutes.js').TargetCoord | null} collectTarget
 * @property {number} collectMission  Mission id the in-game "Send All" (collect) action uses.
 * @property {'all' | 'most'} collectShips  How "Send All" selects ships.
 * @property {'all' | 'most'} collectResources  How "Send All" loads cargo.
 * @property {number} updatedAt  Epoch-ms of the last local edit (0 = never).
 */

/**
 * Merge one universe's fleet-save routes slice, WHOLE-UNIVERSE
 * newest-`updatedAt`-wins. Unlike scans/history (additive collections) a
 * route config is a single edited unit per universe, so the grain is the
 * whole slot and the tie-breaker is its `updatedAt` (set by whichever device
 * last edited the routes/collectTarget — dashboard or in-game). The newer
 * side wins the ENTIRE slot (routes + collectTarget + collectMission together);
 * ties and a missing/0 remote timestamp keep local (the anti-loop no-write path).
 *
 * The whole-universe grain is a deliberate trade: concurrent edits to the
 * SAME universe on two devices resolve last-writer-wins (the older edit is
 * lost). Route configs are edited rarely by a single user, so this is
 * acceptable and far simpler than per-route id/timestamp reconciliation.
 *
 * Clock-skew caveat: `updatedAt` is each device's own `Date.now()`, so a
 * device with a fast/skewed clock always "wins" the LWW even when its edit is
 * OLDER in real time. Bounded in practice — single-user, rarely-edited config;
 * additive collections (history/decisions) use a monotonic union and are
 * immune. If it ever bites, a Lamport counter or the gist's server-side
 * `updatedAt` would remove the wall-clock dependency. The same caveat applies
 * to {@link mergeNewestConfigSlot} (galaxy-scan + alarmClock config).
 *
 * `changed` is `true` only when remote strictly displaced local — the caller
 * writes the merged slot back to local storage only then (anti-loop).
 *
 * @param {DailyRunRoutesSlot} local
 * @param {Partial<DailyRunRoutesSlot> | undefined | null} remote
 * @returns {{ merged: DailyRunRoutesSlot, changed: boolean }}
 */
export const mergeDailyRunRoutes = (local, remote) => {
  if (!remote || typeof remote !== 'object') return { merged: local, changed: false };
  const lT = Number(local?.updatedAt) || 0;
  const rT = Number(remote.updatedAt) || 0;
  if (rT > lT) {
    return {
      merged: {
        routes: Array.isArray(remote.routes) ? remote.routes : [],
        collectTarget: remote.collectTarget ?? null,
        collectMission: remote.collectMission ?? local.collectMission,
        collectShips: remote.collectShips ?? local.collectShips,
        collectResources: remote.collectResources ?? local.collectResources,
        updatedAt: rT,
      },
      changed: true,
    };
  }
  return { merged: local, changed: false };
};

/**
 * @typedef {object} GalaxyScanConfigSlot
 * @property {import('../domain/galaxyScanConfig.js').GalaxyScanConfig} config
 *   The full per-universe Galaxy-Scan config (positions, preference, rescan).
 * @property {number} updatedAt  Epoch-ms of the last local edit (0 = never).
 */

/**
 * Whole-universe newest-`updatedAt`-wins for a `{ config, updatedAt }` slot —
 * the shared core of {@link mergeGalaxyScanConfig} and {@link mergeAlarmClockConfig}.
 * Newer side wins the whole config; ties / missing-or-0 remote ts keep local.
 * (Same wall-clock LWW clock-skew caveat as {@link mergeDailyRunRoutes}.)
 *
 * @template T
 * @param {{ config: T, updatedAt: number }} local
 * @param {Partial<{ config: T, updatedAt: number }> | undefined | null} remote
 * @returns {{ merged: { config: T, updatedAt: number }, changed: boolean }}
 */
const mergeNewestConfigSlot = (local, remote) => {
  if (!remote || typeof remote !== 'object') return { merged: local, changed: false };
  const lT = Number(local?.updatedAt) || 0;
  const rT = Number(remote.updatedAt) || 0;
  if (rT > lT && remote.config && typeof remote.config === 'object') {
    return { merged: { config: remote.config, updatedAt: rT }, changed: true };
  }
  return { merged: local, changed: false };
};

/**
 * Merge one universe's Galaxy-Scan config slot, WHOLE-UNIVERSE
 * newest-`updatedAt`-wins — identical strategy to {@link mergeDailyRunRoutes}
 * (the config is a single edited unit per universe, edited rarely by one
 * user from either origin, so per-field reconciliation isn't worth it). The
 * newer side wins the entire config; ties and a missing/0 remote timestamp
 * keep local (the anti-loop no-write path).
 *
 * `changed` is `true` only when remote strictly displaced local — the caller
 * writes the merged slot back to local storage only then (anti-loop).
 *
 * @param {GalaxyScanConfigSlot} local
 * @param {Partial<GalaxyScanConfigSlot> | undefined | null} remote
 * @returns {{ merged: GalaxyScanConfigSlot, changed: boolean }}
 */
export const mergeGalaxyScanConfig = (local, remote) => mergeNewestConfigSlot(local, remote);

/**
 * @typedef {object} AlarmClockConfigSlot
 * @property {import('../domain/alarmClockConfig.js').AlarmClockConfig} config
 *   The full per-universe alarmClock config (wave enable + schedule, ad-hoc lead
 *   time, message templates).
 * @property {number} updatedAt  Epoch-ms of the last local edit (0 = never).
 */

/**
 * Merge one universe's alarmClock config slot, WHOLE-UNIVERSE
 * newest-`updatedAt`-wins — identical strategy to {@link mergeGalaxyScanConfig}
 * (the alarmClock config is a single edited unit per universe). The newer side
 * wins the entire config; ties and a missing/0 remote timestamp keep local
 * (the anti-loop no-write path).
 *
 * `changed` is `true` only when remote strictly displaced local — the caller
 * writes the merged slot back to local storage only then (anti-loop).
 *
 * @param {AlarmClockConfigSlot} local
 * @param {Partial<AlarmClockConfigSlot> | undefined | null} remote
 * @returns {{ merged: AlarmClockConfigSlot, changed: boolean }}
 */
export const mergeAlarmClockConfig = (local, remote) => mergeNewestConfigSlot(local, remote);

/**
 * @typedef {import('../state/dailyActions.js').DailyState} DailyState
 */

/**
 * Merge local + remote per-universe daily-action state, field-by-field
 * max-wins.
 *
 * Merge rules:
 *   - String fields (day keys): lexicographic max — a later YYYY-MM-DD date
 *     string is always larger, so "2026-06-09" beats "2026-06-08".
 *   - Numeric fields (epoch-ms timestamps): larger number is newer.
 *   - A missing / falsy remote value is treated as 0 / ""; local keeps.
 *
 * `changed` is `true` iff remote contributed a strictly newer value for at
 * least one field (anti-loop hint for the caller — see file header).
 *
 * @param {DailyState} local
 * @param {Partial<DailyState> | undefined | null} remote
 * @returns {{ merged: DailyState, changed: boolean }}
 */
export const mergeDailyState = (local, remote) => {
  if (!remote || typeof remote !== 'object') return { merged: local, changed: false };

  /** @param {string} a @param {string} b @returns {string} */
  const maxStr = (a, b) => ((b ?? '') > (a ?? '') ? b : a);
  /** @param {number} a @param {number} b @returns {number} */
  const maxNum = (a, b) => ((b ?? 0) > (a ?? 0) ? b : a);

  const merged = {
    rewardingDoneDay: maxStr(local.rewardingDoneDay, remote.rewardingDoneDay ?? ''),
    traderImportDay: maxStr(local.traderImportDay, remote.traderImportDay ?? ''),
    traderAuctionBidAt: maxNum(local.traderAuctionBidAt, remote.traderAuctionBidAt ?? 0),
    traderAuctionQuietUntil: maxNum(
      local.traderAuctionQuietUntil,
      remote.traderAuctionQuietUntil ?? 0,
    ),
    artifactShopDoneUntil: maxNum(
      local.artifactShopDoneUntil,
      remote.artifactShopDoneUntil ?? 0,
    ),
    traderImportNextAt: maxNum(local.traderImportNextAt, remote.traderImportNextAt ?? 0),
  };

  const changed =
    merged.rewardingDoneDay !== local.rewardingDoneDay ||
    merged.traderImportDay !== local.traderImportDay ||
    merged.traderAuctionBidAt !== local.traderAuctionBidAt ||
    merged.traderAuctionQuietUntil !== local.traderAuctionQuietUntil ||
    merged.artifactShopDoneUntil !== local.artifactShopDoneUntil ||
    merged.traderImportNextAt !== local.traderImportNextAt;

  return { merged, changed };
};

/**
 * @typedef {import('../state/fleetReminders.js').FleetReminderSlot} FleetReminderSlot
 * @typedef {import('../state/fleetReminders.js').FleetReminderEntry} FleetReminderEntry
 */

/**
 * Cross-device merge for the fleet reminders (FR): per-BODY last-writer-wins
 * on each entry's `ts`, ties keeping local (both sides stamping the same
 * landing produce identical entries anyway). `on: false` entries are the
 * tombstones that carry a dismiss across devices; tombstones older than
 * {@link FR_TOMBSTONE_TTL_SEC} (against `now`) are GC'd from the merged
 * result so the slot can't accumulate dead bodies forever.
 *
 * `changed` is `true` when any remote entry was adopted or a tombstone was
 * GC'd — i.e. whenever the merged slot differs from `local`.
 *
 * @param {FleetReminderSlot} local
 * @param {Partial<FleetReminderSlot> | undefined | null} remote
 * @param {number} nowSec  Epoch SECONDS (injected — keeps the merge pure).
 * @returns {{ merged: FleetReminderSlot, changed: boolean }}
 */
export const mergeFleetReminders = (local, remote, nowSec) => {
  const localMarks = local?.marks ?? {};
  const remoteMarks = (remote && typeof remote === 'object' && remote.marks && typeof remote.marks === 'object')
    ? remote.marks
    : {};
  let changed = false;
  /** @type {Record<string, FleetReminderEntry>} */
  const marks = {};
  const keys = new Set([...Object.keys(localMarks), ...Object.keys(remoteMarks)]);
  for (const k of keys) {
    const l = localMarks[k];
    const r = remoteMarks[k];
    const win = r && Number.isFinite(Number(r.ts)) && (!l || Number(r.ts) > l.ts) ? r : l;
    if (!win) continue;
    if (!win.on && Number(win.ts) < nowSec - FR_TOMBSTONE_TTL_SEC) {
      if (l) changed = true; // a local tombstone got GC'd
      continue;
    }
    if (win !== l) changed = true;
    marks[k] = /** @type {FleetReminderEntry} */ (win);
  }
  return { merged: { marks }, changed };
};

// ── Spyglass / dashboard-import reconcilers ─────────────────────────────────
//
// Everything below merges an INCOMING snapshot into the local one, serving
// TWO callers with the same semantics: the dashboard Export/Import
// (features/dashboard/io.js) for every dataset, and — since 1.48 — the gist
// sync scheduler for the Spyglass observations (mergeTargetReports,
// mergeActivityObs, mergeProximityReports, mergePlayerCache via the
// `playersLitePerUniverse` slot), which were promoted from per-device intel to
// synced state because a second device can never re-derive an observation
// timeline. The rest (alliance classes, body inventory) remains import-only
// per-device data.
// The discipline is uniform either way: pure `{ merged, changed }`, additive,
// local observations trusted first — an import behaves exactly like a gist
// download.

/** @typedef {import('../state/targets.js').TargetReports} TargetReports */
/** @typedef {import('../state/activityObs.js').ActivityObsMap} ActivityObsMap */
/** @typedef {import('../domain/espionageReport.js').ProximityReport} ProximityReport */
/** @typedef {import('../state/players.js').PlayerCache} PlayerCache */
/** @typedef {import('../state/bodies.js').BodyInventory} BodyInventory */

/**
 * Merge spy-report caches: per body, the newer `latest` (by the report's own
 * `timestamp`) wins; the lean history rings union by content, time-ordered,
 * re-capped to {@link HISTORY_CAP} newest-last. Tolerates BOTH persisted
 * entry shapes (`{latest, history}` and the legacy bare report) on both
 * sides via the `latestOf` / `historyOf` accessors — the same tolerance the
 * store itself guarantees (SPYGLASS-REDESIGN §10.1).
 *
 * @param {TargetReports} local
 * @param {TargetReports} incoming
 * @returns {{ merged: TargetReports, changed: boolean }}
 */
export const mergeTargetReports = (local, incoming) => {
  let changed = false;
  /** @type {TargetReports} */
  const merged = {};
  const pids = new Set([...Object.keys(local || {}), ...Object.keys(incoming || {})]);
  for (const pid of pids) {
    const l = local?.[pid] || {};
    const r = incoming?.[pid] || {};
    /** @type {Record<string, import('../domain/targetReports.js').BodyEntry>} */
    const bodies = {};
    const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
    for (const bk of keys) {
      const le = l[bk];
      const re = r[bk];
      const lLatest = le ? latestOf(le) : undefined;
      const rLatest = re ? latestOf(re) : undefined;
      // Newer report wins the `latest` slot; ties keep local (our own copy of
      // the same observation).
      const latest =
        rLatest && (!lLatest || (rLatest.timestamp || 0) > (lLatest.timestamp || 0))
          ? rLatest
          : lLatest;
      if (!latest) continue;
      if (latest === rLatest && latest !== lLatest) changed = true;
      // History union: content-dedup (the lite entries are tiny bags of
      // numbers — structural identity IS identity), time-ordered, newest-last
      // ring cap. An imported ring can only ADD observations.
      const seen = new Set();
      /** @type {import('../domain/targetReports.js').SpyReportLite[]} */
      const hist = [];
      for (const src of [le ? historyOf(le) : [], re ? historyOf(re) : []]) {
        for (const h of src) {
          const key = JSON.stringify(h ?? null);
          if (seen.has(key)) continue;
          seen.add(key);
          hist.push(h);
        }
      }
      hist.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const capped = hist.slice(-HISTORY_CAP);
      // Content compare, not length: an import can ADD a newer observation
      // while the cap EVICTS the oldest — same length, different ring.
      if (JSON.stringify(capped) !== JSON.stringify(le ? historyOf(le) : [])) changed = true;
      bodies[bk] = { latest, history: capped };
    }
    if (Object.keys(bodies).length) merged[pid] = bodies;
  }
  return { merged, changed };
};

/**
 * Merge galaxy-activity observation rings: per body, union by content
 * (`t` + `m` identify one look), time-ordered, re-capped to the newest
 * {@link ACTIVITY_RING_CAP} — exactly the shape the append path maintains.
 * Past looks are the one thing a new device can NEVER re-derive (the moment
 * is gone), which is why this heatmap fuel is worth carrying in a backup.
 *
 * @param {ActivityObsMap} local
 * @param {ActivityObsMap} incoming
 * @returns {{ merged: ActivityObsMap, changed: boolean }}
 */
export const mergeActivityObs = (local, incoming) => {
  let changed = false;
  /** @type {ActivityObsMap} */
  const merged = {};
  const pids = new Set([...Object.keys(local || {}), ...Object.keys(incoming || {})]);
  for (const pid of pids) {
    const l = local?.[pid] || {};
    const r = incoming?.[pid] || {};
    /** @type {Record<string, import('../domain/activityObs.js').ActivityObs[]>} */
    const bodies = {};
    const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
    for (const bk of keys) {
      const seen = new Set();
      /** @type {import('../domain/activityObs.js').ActivityObs[]} */
      const ring = [];
      for (const src of [l[bk] || [], r[bk] || []]) {
        for (const obs of src) {
          if (!obs || typeof obs.t !== 'number') continue;
          const key = `${obs.t}|${obs.m}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ring.push(obs);
        }
      }
      ring.sort((a, b) => a.t - b.t);
      const capped = ring.slice(-ACTIVITY_RING_CAP);
      // Content compare, not length — same cap-eviction blindness as the
      // spy-report history ring above.
      if (JSON.stringify(capped) !== JSON.stringify(l[bk] || [])) changed = true;
      if (capped.length) bodies[bk] = capped;
    }
    if (Object.keys(bodies).length) merged[pid] = bodies;
  }
  return { merged, changed };
};

/**
 * Merge proximity logs ("who's been near you"): union deduped by the same
 * identity triple the store's writer uses (`byPlayerId|atCoords|ts`), local
 * first (local wins a duplicate), newest-first, re-trimmed by the store's own
 * retention policy ({@link trimProximityLog}: the age window, then
 * {@link PROXIMITY_CAP}).
 *
 * @param {ProximityReport[]} local
 * @param {ProximityReport[]} incoming
 * @returns {{ merged: ProximityReport[], changed: boolean }}
 */
export const mergeProximityReports = (local, incoming) => {
  const seen = new Set();
  /** @type {ProximityReport[]} */
  const union = [];
  for (const src of [local || [], incoming || []]) {
    for (const rep of src) {
      if (!rep || typeof rep !== 'object') continue;
      const key = `${rep.byPlayerId}|${rep.atCoords}|${rep.ts ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(rep);
    }
  }
  union.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const merged = trimProximityLog(union, Math.floor(Date.now() / 1000));
  const localLen = (local || []).length;
  const changed =
    merged.length !== localLen || merged.some((rep, i) => rep !== (local || [])[i]);
  return { merged, changed };
};

/**
 * Merge player-metadata caches: per id, the newer sighting (`seenAt`) wins;
 * ties keep local. Used by the import path with the incoming side already
 * FILTERED to watched ids (`playersLite` — the export never carries the
 * unbounded server-wide roster).
 *
 * @param {PlayerCache} local
 * @param {PlayerCache} incoming
 * @returns {{ merged: PlayerCache, changed: boolean }}
 */
export const mergePlayerCache = (local, incoming) => {
  let changed = false;
  /** @type {PlayerCache} */
  const merged = { ...(local || {}) };
  for (const [id, meta] of Object.entries(incoming || {})) {
    if (!meta || typeof meta !== 'object') continue;
    const cur = merged[/** @type {any} */ (id)];
    if (!cur || (meta.seenAt ?? 0) > (cur.seenAt ?? 0)) {
      merged[/** @type {any} */ (id)] = meta;
      changed = true;
    }
  }
  return { merged, changed };
};

/**
 * Merge alliance-class maps (`allianceId → class slug`): fill-gaps only —
 * the map carries no timestamps, so the local harvest (verifiably from THIS
 * server's current ranking) outranks whatever the file says on a conflict.
 *
 * @param {Record<string, string>} local
 * @param {Record<string, string>} incoming
 * @returns {{ merged: Record<string, string>, changed: boolean }}
 */
export const mergeAllianceClassMap = (local, incoming) => {
  let changed = false;
  /** @type {Record<string, string>} */
  const merged = { ...(local || {}) };
  for (const [id, slug] of Object.entries(incoming || {})) {
    if (typeof slug !== 'string' || id in merged) continue;
    merged[id] = slug;
    changed = true;
  }
  return { merged, changed };
};

/**
 * Merge own-body inventories: the planet bar snapshot is REPLACED wholesale
 * on every capture (state/bodies.js), so the merge is whole-snapshot
 * newest-`capturedAt`-wins — never a body-level union, which could stitch two
 * half-truths (e.g. resurrect an abandoned moon from an older snapshot).
 *
 * @param {BodyInventory} local
 * @param {Partial<BodyInventory> | null | undefined} incoming
 * @returns {{ merged: BodyInventory, changed: boolean }}
 */
export const mergeBodyInventory = (local, incoming) => {
  const incomingAt = (incoming && typeof incoming === 'object' && Number(incoming.capturedAt)) || 0;
  if (incomingAt > (local.capturedAt || 0) && Array.isArray(incoming?.bodies)) {
    return { merged: { bodies: incoming.bodies, capturedAt: incomingAt }, changed: true };
  }
  return { merged: local, changed: false };
};
