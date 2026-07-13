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
 * Whether the on-load (boot) DOWNLOAD should run. Three independent triggers,
 * each mapping to a real way the gist could hold data this tab hasn't applied:
 *
 *   1. Fresh tab — `appliedRev` empty means this tab session (sessionStorage,
 *      per-tab, survives reloads) has never pulled. A brand-new tab pulls once.
 *   2. Same-machine peer — `beaconRev` (chrome.storage, bumped by every PATCH on
 *      this machine) is ahead of what we applied: a sibling tab / the dashboard
 *      uploaded while our JS context was gone between navigations. Pull it.
 *   3. New session — a long quiet gap since this origin was last active. This is
 *      the ONLY signal for a CROSS-device change: another machine logging in
 *      ends our game session (OGame is single-session) and leaves NO local
 *      beacon, so we fall back to "were we away long enough that another device
 *      could have played?".
 *
 * Otherwise skip: mid-session navigation on the only active device can't have
 * changed the gist, so re-downloading on every click (the game reloads on every
 * click) is pure waste.
 *
 * @param {object} a
 * @param {string} a.appliedRev    Rev this tab has incorporated ('' = none yet).
 * @param {string} a.beaconRev     Latest same-machine PATCH rev ('' = none yet).
 * @param {number} a.lastActiveAt  Epoch-ms this origin was last active (0 = never).
 * @param {number} a.now           Epoch-ms now.
 * @param {number} a.sessionGapMs  Quiet gap that counts as a new session.
 * @returns {boolean}
 */
export const shouldDownloadOnLoad = ({ appliedRev, beaconRev, lastActiveAt, now, sessionGapMs }) => {
  if (!appliedRev) return true;
  if (beaconRev && beaconRev !== appliedRev) return true;
  if (!lastActiveAt || now - lastActiveAt > sessionGapMs) return true;
  return false;
};

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
      ds.traderImportNextAt,
  );

/**
 * @typedef {object} DailyState
 * @property {unknown} [rewardingDoneDay]
 * @property {unknown} [traderImportDay]
 * @property {unknown} [traderAuctionBidAt]
 * @property {unknown} [traderAuctionQuietUntil]
 * @property {unknown} [artifactShopDoneUntil]
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
 * Whether a per-universe alarmClock config slot is worth contributing to the
 * gist. Same no-op-PATCH guard as {@link galaxyConfigSlotHasData}: a
 * never-edited universe (ts 0, still at the local default/hydrate seed) must
 * NOT write a slot that would differ from the gist's absent field. Once the
 * user edits it the stamp bumps `updatedAt` and the slot starts syncing.
 *
 * @param {import('../merge.js').AlarmClockConfigSlot} slot
 * @returns {boolean}
 */
export const alarmClockConfigSlotHasData = (slot) => slot.updatedAt > 0;

/**
 * Whether a colonization-decision slot is worth contributing to the gist.
 * Same no-op-PATCH guard as the others: an empty decision map ({}) must NOT
 * write a slot that would differ from the gist's absent field.
 *
 * @param {import('../../domain/colonizeDecisions.js').DecisionMap | undefined} decisions
 * @returns {boolean}
 */
export const decisionsSlotHasData = (decisions) =>
  Boolean(decisions && Object.keys(decisions).length > 0);

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
 * @param {unknown} [merged.galaxyScansPerUniverse]  Omitted since §4b — left
 *   `undefined` so a gist still carrying scans reads "not current" and slims.
 * @param {unknown} merged.colonyHistoryPerUniverse
 * @param {unknown} merged.settings
 * @param {unknown} merged.dailyRunRoutes
 * @param {unknown} merged.settingsPerUniverse
 * @param {unknown} merged.dailyStatePerUniverse
 * @param {unknown} merged.galaxyScanConfig
 * @param {unknown} merged.alarmClockConfigPerUniverse
 * @param {unknown} [merged.playersPerUniverse]
 * @param {unknown} [merged.ownProfilePerUniverse]
 * @param {unknown} [merged.colonizeDecisionsPerUniverse]
 * @param {unknown} [merged.manualLandedFsPerUniverse]
 * @param {unknown} [merged.watchListPerUniverse]
 * @param {unknown} [merged.targetReportsPerUniverse]
 * @param {unknown} [merged.activityObsPerUniverse]
 * @param {unknown} [merged.playersLitePerUniverse]
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
  sameJSON(remote?.alarmClockConfigPerUniverse, merged.alarmClockConfigPerUniverse) &&
  sameJSON(remote?.playersPerUniverse, merged.playersPerUniverse) &&
  sameJSON(remote?.ownProfilePerUniverse, merged.ownProfilePerUniverse) &&
  sameJSON(remote?.colonizeDecisionsPerUniverse, merged.colonizeDecisionsPerUniverse) &&
  sameJSON(remote?.manualLandedFsPerUniverse, merged.manualLandedFsPerUniverse) &&
  sameJSON(remote?.watchListPerUniverse, merged.watchListPerUniverse) &&
  sameJSON(remote?.targetReportsPerUniverse, merged.targetReportsPerUniverse) &&
  sameJSON(remote?.activityObsPerUniverse, merged.activityObsPerUniverse) &&
  sameJSON(remote?.playersLitePerUniverse, merged.playersLitePerUniverse);
