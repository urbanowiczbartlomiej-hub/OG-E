// @ts-check

// Pure decision core of `sync/scheduler.js` — the lock / enablement /
// anti-loop predicates the orchestrator consults, with zero I/O.
//
// # Why this split exists
//
// `../scheduler.js` mixes three very different kinds of code:
//   1. DECISIONS — "may a round-trip start?", "should a store change
//      schedule an upload?", "does this slot carry data worth pushing?",
//      "does the gist already match what we'd write?". Pure functions of
//      plain inputs.
//   2. I/O — store reads/writes, gist fetch/PATCH, chrome.storage.
//   3. LIFECYCLE — install/dispose, timers, subscriptions, event reactors.
//
// Before this file the first bucket was inlined in `../scheduler.js`,
// reachable only by driving the whole orchestrator through mocked stores,
// fake timers, and a mocked gist client. Pulling the decisions out makes
// every input explicit (it arrives as a function argument, not a hidden
// module-local `let` or a `settingsStore.get()` deep in a handler) so the
// gating rules can be unit-tested directly. `../scheduler.js` keeps the
// timers/subscriptions and calls into here.
//
// The axiom for this file (same as every other `pure.js`): NO DOM
// reads/writes, NO timers, NO listeners, NO storage. Plain values in,
// plain values out.

/**
 * Whether a sync round-trip ({@link downloadAndMerge} / {@link upload})
 * may begin. Folds the two early-return guards both operations share:
 * the opt-out gate (cloud sync on AND a token present) and the in-flight
 * lock. Returns `false` if any condition blocks the start.
 *
 * @param {object} args
 * @param {unknown} args.cloudSync  The `cloudSync` setting (truthy = enabled).
 * @param {boolean} args.hasToken   Whether a gist token is configured.
 * @param {boolean} args.inFlight   Whether a download/upload is already running.
 * @returns {boolean}
 */
export const canStartSync = ({ cloudSync, hasToken, inFlight }) =>
  Boolean(cloudSync) && hasToken && !inFlight;

/**
 * Whether a store/event change should schedule a debounced upload. The
 * subscription handlers skip scheduling when cloud sync is off, and the
 * routes/settings handlers additionally skip writes they originated
 * themselves (the `applying*FromSync` anti-loop flags — a sync-origin
 * write carries a remote timestamp we must not re-stamp / re-upload).
 *
 * @param {object} args
 * @param {unknown} args.cloudSync  The `cloudSync` setting (truthy = enabled).
 * @param {boolean} [args.applying]  Whether the change is a sync-origin write.
 * @returns {boolean}
 */
export const shouldScheduleUpload = ({ cloudSync, applying = false }) =>
  Boolean(cloudSync) && !applying;

/**
 * Whether a fleet-save routes slot carries data worth contributing to the
 * gist. A never-configured universe (no routes, no target, ts 0) must NOT
 * write an empty slot — that would differ from the gist's absent field and
 * force a perpetual no-op PATCH.
 *
 * @param {import('../merge.js').DailyRunRoutesSlot} slot
 * @returns {boolean}
 */
export const slotHasData = (slot) =>
  slot.updatedAt > 0 || slot.routes.length > 0 || slot.collectTarget != null;

/**
 * Whether a daily-action state record carries any non-empty field. Same
 * no-op-PATCH guard as {@link slotHasData}: an all-empty record must not
 * write a slot that would differ from the gist's absent field.
 *
 * @param {import('./pure.js').DailyState} ds
 * @returns {boolean}
 */
export const dailyStateHasData = (ds) =>
  Boolean(
    ds.rewardingDoneDay ||
      ds.traderImportDay ||
      ds.traderAuctionBidAt ||
      ds.traderAuctionQuietUntil ||
      ds.artifactShopDoneUntil ||
      ds.traderImportEventDay ||
      ds.traderImportNextAt,
  );

/**
 * @typedef {object} DailyState
 * @property {unknown} [rewardingDoneDay]
 * @property {unknown} [traderImportDay]
 * @property {unknown} [traderAuctionBidAt]
 * @property {unknown} [traderAuctionQuietUntil]
 * @property {unknown} [artifactShopDoneUntil]
 * @property {unknown} [traderImportEventDay]
 * @property {unknown} [traderImportNextAt]
 */

/**
 * Whether a Galaxy-Scan config slot is worth contributing to the gist. Same
 * no-op-PATCH guard as {@link slotHasData}: a never-edited universe (ts 0,
 * config still at the local default/migration seed) must NOT write a slot
 * that would differ from the gist's absent field. Once the user edits the
 * config the stamp bumps `updatedAt` and the slot starts syncing.
 *
 * @param {import('../merge.js').GalaxyScanConfigSlot} slot
 * @returns {boolean}
 */
export const galaxyConfigSlotHasData = (slot) => slot.updatedAt > 0;

/**
 * Whether a per-universe reminder config slot is worth contributing to the
 * gist. Same no-op-PATCH guard as {@link galaxyConfigSlotHasData}: a
 * never-edited universe (ts 0, still at the local default/hydrate seed) must
 * NOT write a slot that would differ from the gist's absent field. Once the
 * user edits it the stamp bumps `updatedAt` and the slot starts syncing.
 *
 * @param {import('../merge.js').ReminderConfigSlot} slot
 * @returns {boolean}
 */
export const reminderConfigSlotHasData = (slot) => slot.updatedAt > 0;

/**
 * Whether a player-cache slot is worth contributing to the gist. Same
 * no-op-PATCH guard as the others: an empty roster ({}) must NOT write a slot
 * that would differ from the gist's absent field.
 *
 * @param {import('../../state/players.js').PlayerCache | undefined} players
 * @returns {boolean}
 */
export const playersSlotHasData = (players) =>
  Boolean(players && Object.keys(players).length > 0);

/**
 * Whether an own-profile slot is worth contributing to the gist. `readOwnProfile`
 * returns `{}` when nothing is stored; only a profile actually written by the
 * header reader carries `updatedAt > 0`, so that is the no-op-PATCH guard.
 *
 * @param {import('../../state/ownProfile.js').OwnProfile | undefined} profile
 * @returns {boolean}
 */
export const ownProfileHasData = (profile) => Boolean(profile && Number(profile.updatedAt) > 0);

/**
 * Compare two values by JSON structural equality. Cheap and good enough
 * for the "is the gist already current?" check — both sides are plain JSON
 * (nested records / arrays of primitives), no Dates, no cycles, no functions.
 *
 * Normalises `undefined` / `null` / missing to the literal `null` string so
 * `sameJSON(undefined, null)` is `true`. That matters because `fetchGistData`
 * may yield `undefined` for a missing field while our merge always produces a
 * concrete empty container — we want those shapes to register as "already
 * current" and skip the PATCH.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether the gist already matches the merged state we would otherwise
 * PATCH. True iff every synced field compares structurally equal — the
 * common case right after a download from another device, where local and
 * remote already agree. Skipping the PATCH then saves one API call and
 * avoids a no-op gist revision.
 *
 * @param {import('../gist.js').GistPayload | null | undefined} remote
 * @param {object} merged                         The state we'd write.
 * @param {unknown} merged.galaxyScansPerUniverse
 * @param {unknown} merged.colonyHistoryPerUniverse
 * @param {unknown} merged.settings
 * @param {unknown} merged.dailyRunRoutes
 * @param {unknown} merged.settingsPerUniverse
 * @param {unknown} merged.dailyStatePerUniverse
 * @param {unknown} merged.galaxyScanConfig
 * @param {unknown} merged.reminderConfigPerUniverse
 * @param {unknown} [merged.playersPerUniverse]
 * @param {unknown} [merged.ownProfilePerUniverse]
 * @returns {boolean}
 */
export const gistIsCurrent = (remote, merged) =>
  sameJSON(remote?.galaxyScansPerUniverse, merged.galaxyScansPerUniverse) &&
  sameJSON(remote?.colonyHistoryPerUniverse, merged.colonyHistoryPerUniverse) &&
  sameJSON(remote?.settings, merged.settings) &&
  sameJSON(remote?.dailyRunRoutes, merged.dailyRunRoutes) &&
  sameJSON(remote?.settingsPerUniverse, merged.settingsPerUniverse) &&
  sameJSON(remote?.dailyStatePerUniverse, merged.dailyStatePerUniverse) &&
  sameJSON(remote?.galaxyScanConfig, merged.galaxyScanConfig) &&
  sameJSON(remote?.reminderConfigPerUniverse, merged.reminderConfigPerUniverse) &&
  sameJSON(remote?.playersPerUniverse, merged.playersPerUniverse) &&
  sameJSON(remote?.ownProfilePerUniverse, merged.ownProfilePerUniverse);
