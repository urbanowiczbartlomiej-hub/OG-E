// Sync scheduler — orchestrates local stores ↔ remote gist under one lock.
//
// # Role
//
// This is the glue that turns three independently-useful primitives —
// {@link historyStore} + the other synced stores (local state),
// {@link mergeScans}/{@link mergeHistory} (pure reconcilers), and the
// {@link fetchGistData}/{@link writeGistData} gist client — into a
// working cross-device sync round-trip. Every other sync module is
// stateless; this one owns the timers, the in-flight lock, and the
// store/event subscriptions that drive it. (Galaxy scans are no longer
// gist-synced — §4b — so the scans store is not watched here any more;
// the scan-burst story below survives as the debounce's design rationale.)
//
// # Why a 15-second debounce
//
// OGame's galaxy page emits a burst of scans whenever the user scrolls
// — one XHR per system, potentially a dozen in a few seconds. Each
// scan flipped the (then-synced) scans store, which on its own would
// queue an upload. Without debouncing we'd burn ~12 GitHub API requests to sync
// a single scrolling session; at OGame's tick cadence that exhausts
// the 5000 req/h quota in minutes. A 15 s quiet window lets the whole
// burst coalesce into one trailing upload. The price is staleness on
// the *other* device: fresh data takes up to 15 s + network RTT to
// reach it. That trade is conservative on purpose — a later device
// pulling on its next boot always gets the merged current state; we
// only lose a few seconds of real-time-ish freshness for a huge
// reduction in API pressure.
//
// # The anti-loop rule
//
// Every sync round-trip merges local and remote, and in the general
// case writes the merged result back to the local store. But the local
// store is watched by `storage.onChanged`-equivalent subscribers (any
// feature that reacts to history / decision updates), and — crucially
// — by US: any write to {@link historyStore} (or another synced store)
// fires {@link onStoreChange}, which schedules another upload. If the
// write was a no-op (merge produced exactly what was already there),
// that next upload will re-merge, re-write, re-schedule, forever.
//
// {@link mergeScans} and {@link mergeHistory} return a `changed` flag
// that is `true` iff remote contributed at least one entry local did
// not already have. We only call `store.set(merged)` when `changed ===
// true`. When `changed === false` the merged reference IS the local
// reference (same object), so the write would have been a no-op
// semantically anyway — but skipping it breaks the subscription loop
// at its source.
//
// # The in-flight lock
//
// {@link downloadAndMerge} and {@link upload} share one boolean
// `inFlight`. Either operation, while running, blocks the other. This
// avoids two classes of race:
//
//   1. Concurrent PATCHes clobbering each other (the second one wins
//      on GitHub's side, but the first one's work is lost).
//   2. A download + upload interleaving such that upload reads
//      `local.get()` before download has stored its merged result —
//      leading to upload writing a stale view of local over the gist.
//
// The lock is coarse but correct. Finer-grained locking would require
// per-field versioning, which the current schema doesn't carry.
//
// # Force-sync event
//
// The Settings UI's "Sync now" button needs to trigger a full round-trip
// immediately, bypassing the debounce. It dispatches a
// `CustomEvent('oge:syncForce')` on
// `document` and this module's listener runs
// {@link downloadAndMerge} + {@link upload} back-to-back. Using a DOM
// event (rather than a direct function import) keeps the cross-
// feature coupling loose — the Settings UI doesn't need to know the
// scheduler module exists, and tests can simulate user clicks with a
// plain `document.dispatchEvent`.
//
// # Boot — gated download, gated catch-up upload
//
// On install we no longer fire an unconditional round-trip. OGame is single-
// session, so while THIS device is the only one playing the gist cannot change
// underneath us — re-downloading on every page navigation (the game reloads on
// every click) was pure waste. Instead the boot:
//   - DOWNLOADS only when {@link shouldDownloadOnLoad} says we might be behind:
//     a fresh tab (per-tab applied-rev unset), a same-machine peer that bumped
//     the {@link gistRevKeyFor} beacon while our JS was gone, or a long quiet
//     gap that suggests another device may have played (the only signal for a
//     cross-device change — single-session leaves no local beacon).
//   - UPLOADS only when the {@link UPLOAD_PENDING_KEY} dirty flag is set — i.e.
//     a local write's 15-s debounced upload was killed by OGame's forced post-
//     send reload before it could flush. This is the catch-up PUSH the boot
//     upload has always been for; gating it means a navigation with nothing
//     pending costs zero requests. `upload()` still self-skips via
//     `gistIsCurrent` when local + gist already agree.
// The user's explicit "Sync now" and the dashboard tombstone still force an
// UNCONDITIONAL round-trip via {@link onForceSync} — those are deliberate.
//
// # Same-machine beacon (replaces the periodic backstop)
//
// A tab left OPEN still needs to learn when a SIBLING context on the same
// machine — a second tab of this universe, or the dashboard — changes the gist.
// The old solution polled (a download every 5 min), which both wasted requests
// and, with two open tabs, risked ping-ponging the quota. Instead every real
// PATCH writes the per-universe beacon ({@link gistRevKeyFor}) in
// chrome.storage; every tab listens via `chrome.storage.onChanged` and pulls
// the moment the beacon moves PAST what it has applied — instant, and with NO
// network call to discover that a change happened. The applied-rev is written
// BEFORE the beacon (see {@link noteApplied}) so the writer's own onChanged
// sees applied === beacon and self-skips — no ping-pong. The cross-DEVICE case
// needs no backstop here: single-session means another device logging in ends
// THIS tab's game session, so the user re-enters through a fresh load where the
// boot gap check pulls.
//
// @ts-check

/* global document */

import { historyStore } from '../state/history.js';
import { readLfDiscoverySlot, writeLfDiscoverySlot, scansStore } from '../state/scans.js';
import { colonizeDecisionsStore } from '../state/colonizeDecisions.js';
import { settingsStore } from '../state/settings.js';
import { dailyRunRoutesStore, dailyRunRoutesKeyFor, dailyRunRoutesTsKeyFor } from '../state/dailyRunRoutes.js';
import {
  galaxyScanConfigStore,
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../state/galaxyScanConfig.js';
import {
  alarmClockConfigStore,
  alarmClockConfigKeyFor,
  alarmClockConfigTsKeyFor,
} from '../state/alarmClockConfig.js';
import { parseDailyRunRoutes } from '../domain/dailyRunRoutes.js';
import { MISSION_DEPLOYMENT } from '../domain/rules.js';
import { normalizeGalaxyScanConfig, sanitizeGalaxyScanConfigForWire } from '../domain/galaxyScanConfig.js';
import { normalizeAlarmClockConfig } from '../domain/alarmClockConfig.js';
import {
  mergeHistory,
  mergeSettings,
  mergeDailyRunRoutes,
  mergeDailyState,
  mergeLfDiscovery,
  mergeFleetReminders,
  mergeGalaxyScanConfig,
  mergeAlarmClockConfig,
  mergeColonizeDecisions,
  mergeTargetReports,
  mergeActivityObs,
  mergeProximityReports,
  mergePlayerCache,
} from './merge.js';
import {
  fetchGistData,
  writeGistData,
  setStatus,
  getToken,
} from './gist.js';
import {
  pickSyncedValues,
  readTsMap,
  writeTsMap,
  stampChanged,
  seedSettingsTsIfAbsent,
  readUniverseTsMap,
  writeUniverseTsMap,
  seedUniverseTsIfAbsent,
} from './settingsSync.js';
import { debounce } from '../lib/debounce.js';
import { chromeStore, safeLS } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';
import { readDailyState, writeDailyState } from '../state/dailyActions.js';
import { readFleetReminderSlot, writeFleetReminderSlot } from '../state/fleetReminders.js';
import {
  watchListStore,
  normalizeWatchList,
  watchListKeyFor,
  ensureWatchListLedgerSeeded,
  applyWatchListSyncSlot,
} from '../state/watchList.js';
import {
  targetReportsStore,
  targetReportsKeyFor,
  whenTargetsHydrated,
} from '../state/targets.js';
import {
  activityObsStore,
  activityObsKeyFor,
  whenActivityObsHydrated,
} from '../state/activityObs.js';
import {
  proximityReportsStore,
  proximityReportsKeyFor,
  whenProximityHydrated,
} from '../state/proximityReports.js';
import { playersStore, playersKeyFor, whenPlayersHydrated } from '../state/players.js';
import {
  presenceLedgerStore,
  presenceLedgerKeyFor,
  adoptPresenceLedgerMap,
} from '../state/presenceLedger.js';
import { normalizeReportTimestamps } from '../domain/espionageReport.js';
import { sweepStaleActivityObs } from '../domain/activityObs.js';
import {
  mergePresenceLedgerMaps,
  sweepPresenceLedgerMap,
} from '../domain/presenceLedger.js';
import {
  composeWatchSlot,
  mergeWatchList,
  watchSlotHasData,
} from '../domain/watchListMerge.js';
import { SYNC_FORCE_EVENT, DAILY_STATE_CHANGED_EVENT, FLEET_REMINDER_CHANGED_EVENT } from '../lib/ogeEvents.js';
import {
  canStartSync,
  shouldScheduleUpload,
  shouldDownloadOnLoad,
  slotHasData,
  dailyStateHasData,
  galaxyConfigSlotHasData,
  alarmClockConfigSlotHasData,
  decisionsSlotHasData,
  gistIsCurrent,
} from './scheduler/pure.js';

/**
 * Tombstone key suffixes the histogram page (extension origin) writes
 * into `chrome.storage.local` to cross-origin-signal the game-origin
 * sync scheduler. The actual key written is
 * `<universeId>:<base>` — see {@link syncRequestKeyFor} etc. — so
 * each universe's scheduler only reacts to tombstones aimed at its
 * own server. A direct `document.dispatchEvent` wouldn't work because
 * histogram and game live in separate origins and JS realms; the
 * shared storage area is the only reliable cross-origin channel.
 *
 * Exported so `features/dashboard/io.js` (the writer) and any future
 * tooling can compose the same keys without redeclaring the suffix.
 */
const SYNC_REQUEST_KEY_BASE = 'oge_syncRequestAt';

/** @param {string} universeId */
export const syncRequestKeyFor = (universeId) =>
  `${universeId}:${SYNC_REQUEST_KEY_BASE}`;

/**
 * Quiet-period length (ms) for {@link scheduleUpload}. See file header
 * for the 15-second rationale (burst-coalesce vs cross-device freshness
 * trade-off).
 */
const DEBOUNCE_MS = 15_000;

/**
 * Per-universe `chrome.storage.local` BEACON base: the ISO `updatedAt` of the
 * most recent data-file PATCH made by ANY tab on THIS machine. Full key is
 * `<universeId>:oge_gistRev`. Written only after a real upload (see
 * {@link upload} / {@link noteApplied}); every same-machine context observes the
 * change via `chrome.storage.onChanged` and pulls iff the beacon is ahead of
 * what that tab has already applied. This is what lets two open tabs of one
 * universe (or the dashboard) converge WITHOUT polling — the old 5-min
 * backstop's job, done event-driven and network-free for the same-machine case.
 */
const GIST_REV_KEY_BASE = 'oge_gistRev';
/** @param {string} universeId */
const gistRevKeyFor = (universeId) => `${universeId}:${GIST_REV_KEY_BASE}`;

/**
 * localStorage (per-origin → already per-universe) epoch-ms of the last page
 * load on this origin. Read on boot to decide whether enough quiet time passed
 * that another DEVICE could have played (OGame is single-session, so a
 * cross-device change leaves no local beacon — time is the only signal). See
 * {@link shouldDownloadOnLoad}.
 */
const LAST_ACTIVE_KEY = 'oge_lastActiveAt';

/**
 * localStorage dirty flag: set (with a fresh token) whenever an upload is
 * armed, cleared when a round that covered the arming write completes — a
 * re-arm mid-flight keeps it set (token mismatch; see {@link scheduleUpload}).
 * The on-load catch-up upload runs ONLY when this is set, so a plain
 * navigation with nothing pending does ZERO requests — while a `sent`/`taken`
 * decision whose 15-s debounce was killed by OGame's post-send reload still
 * gets flushed on the next load (the case the boot upload exists for).
 */
const UPLOAD_PENDING_KEY = 'oge_uploadPending';

/**
 * Monotonic per-page counter feeding {@link scheduleUpload}'s arm tokens —
 * combined with `Date.now()` so two arms in the same millisecond (or from two
 * tabs) still produce distinct tokens.
 */
let uploadArmSeq = 0;

/**
 * True only for the synchronous prefix of upload()'s own pre-merge
 * `writeLocal` calls: those adopt REMOTE data the in-flight round already
 * carries, so their store notifications must not re-arm the dirty flag
 * (see {@link scheduleUpload}).
 */
let suppressUploadArm = false;

/**
 * sessionStorage (per-TAB, survives reload, cleared on tab close) rev this tab
 * has incorporated. Per-tab — NOT localStorage — so two tabs of one universe
 * compare independently against the shared beacon; a localStorage value would be
 * shared and a sibling would never see the beacon as "ahead".
 */
const APPLIED_REV_KEY = 'oge_gistRevApplied';

/**
 * Non-empty sentinel for "pulled, but the gist was empty". Keeps a fresh,
 * empty-gist account from re-downloading on every reload (the `!appliedRev`
 * trigger in {@link shouldDownloadOnLoad}) while never colliding with a real
 * ISO `updatedAt`.
 */
const EMPTY_REV = '∅';

/**
 * Quiet gap (ms) on this origin that counts as a NEW session on boot — long
 * enough that another device might have played since our last load. Tunable;
 * 10 min is a conservative proxy for "I switched devices", well under OGame's
 * own session timeout. Too small → needless re-downloads after every pause; too
 * large → a cross-device change waits for the next gap / explicit "Sync now".
 */
const SESSION_GAP_MS = 10 * 60 * 1000;

// SYNC_FORCE_EVENT (lib/ogeEvents.js) is dispatched on `document` by the
// Settings UI and histogram to request an immediate sync round-trip; this
// scheduler listens for it. Centralized so dispatcher and listener can't drift
// (a typo would silently break force-sync).

/**
 * Active install handle, or `null` when the scheduler is not installed.
 * Kept at module scope so a second {@link installSync} call can detect
 * the already-installed state and return the existing dispose fn
 * without duplicating subscriptions.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Single lock shared by {@link downloadAndMerge} and {@link upload}.
 * `true` while either operation is running; both short-circuit when
 * they find it set. See file header "The in-flight lock" for why this
 * is coarse-but-correct.
 */
let inFlight = false;

/**
 * Anti-loop suppressor for sync-origin writes, keyed by sync field. While we
 * write a merged remote slot back into a local store, the corresponding store
 * subscriber must treat it as a sync-origin write — NOT re-stamp the key with
 * `now` (which would clobber the remote timestamp) nor schedule a redundant
 * upload. A depth counter (not a bare boolean) keeps repeated/sequential
 * applies of the same field correct; `isApplyingFromSync(key)` is what the
 * subscribers gate on.
 *
 * Replaces the four former `applying*FromSync` booleans (settings, routes,
 * galaxy config, alarmClock config) with one keyed map. Entities with no local
 * timestamp to protect (history / dailyState / decisions) need NO suppressor —
 * their `changed` guard plus the {@link gistIsCurrent} skip already break the
 * subscription loop. Keys match each slot's gist payload field (plus the
 * bespoke `'settings'`), so they can't drift from the registry below.
 *
 * @type {Map<string, number>}
 */
const applyDepth = new Map();
/** @param {string} key */
const bumpApplying = (key) => applyDepth.set(key, (applyDepth.get(key) || 0) + 1);
/** @param {string} key */
const dropApplying = (key) => applyDepth.set(key, Math.max(0, (applyDepth.get(key) || 0) - 1));
/** @param {string} key @returns {boolean} */
const isApplyingFromSync = (key) => (applyDepth.get(key) || 0) > 0;

/** Suppressor key for the bespoke (non-registry) settings write-back. */
const APPLY_SETTINGS = 'settings';

/**
 * The universe id this scheduler instance owns (from `location.host`),
 * captured in {@link installSync}. Fleet-save routes are per-universe, so
 * sync only ever touches THIS universe's slot in the gist's `dailyRunRoutes` map.
 * Empty string in non-DOM tests / when the host isn't a known universe.
 */
let routesUniverseId = '';

/**
 * In-memory cache of the per-universe settings timestamp map, loaded from
 * chrome.storage at install time (see {@link installSync}). Updated
 * synchronously whenever a universe-scoped setting changes so the
 * `onSettingsChange` subscriber can stamp without an async chrome.storage
 * read on every keystroke. Written through to chrome.storage on every change.
 *
 * @type {Record<string, number>}
 */
let localUniverseTsMap = {};

// ── Same-machine sync beacon + per-tab applied-rev ──────────────────
//
// Together these replace the old 5-min polling backstop. The beacon
// (chrome.storage, written on every PATCH) is the cross-tab "the gist moved"
// signal; the per-tab applied-rev (sessionStorage) records how far THIS tab has
// caught up, so a tab only ever downloads when it is genuinely behind.

/** @returns {string} The rev this tab has applied, or '' if none this session. */
const readAppliedRev = () => {
  try {
    return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(APPLIED_REV_KEY)) || '';
  } catch {
    return '';
  }
};

/** @param {string} rev */
const writeAppliedRev = (rev) => {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(APPLIED_REV_KEY, rev);
  } catch {
    // private mode / disabled storage — degrade to "always pull on load".
  }
};

/**
 * Record that this tab has incorporated the gist up to `rev`. Writes the per-tab
 * applied-rev FIRST (synchronous) so that when a write also raises the beacon,
 * our OWN `chrome.storage.onChanged` sees applied === beacon and self-skips (no
 * ping-pong). `beacon: true` (a real PATCH) additionally raises the same-machine
 * beacon so sibling tabs pull; a download passes `false` — a read changes
 * nothing remotely, and the cross-device data it pulled would only re-arrive at
 * a sibling on that sibling's own next (re)load, which single-session forces.
 *
 * @param {string | undefined} rev  ISO updatedAt, or undefined for an empty gist.
 * @param {{ beacon?: boolean }} [opts]
 * @returns {Promise<void>}
 */
const noteApplied = async (rev, { beacon = false } = {}) => {
  writeAppliedRev(rev || EMPTY_REV);
  if (beacon && rev && routesUniverseId) {
    await chromeStore.set(gistRevKeyFor(routesUniverseId), rev);
  }
};

/**
 * Read this universe's local fleet-save routes slot from chrome.storage —
 * NOT from {@link dailyRunRoutesStore} in memory. Routes are edited from the
 * dashboard (a different origin) too, and the game tab's in-memory store
 * wouldn't see those edits; chrome.storage is the cross-origin source of
 * truth. `updatedAt` comes from the separate per-universe timestamp key.
 *
 * @returns {Promise<import('./merge.js').DailyRunRoutesSlot>}
 */
const readLocalRoutesSlot = async () => {
  if (!routesUniverseId) return { routes: [], collectTarget: null, collectMission: MISSION_DEPLOYMENT, collectShips: 'most', collectResources: 'most', updatedAt: 0 };
  const [raw, ts] = await Promise.all([
    chromeStore.get(dailyRunRoutesKeyFor(routesUniverseId)),
    chromeStore.get(dailyRunRoutesTsKeyFor(routesUniverseId)),
  ]);
  const { routes, collectTarget, collectMission, collectShips, collectResources } = parseDailyRunRoutes(raw);
  return { routes, collectTarget, collectMission, collectShips, collectResources, updatedAt: typeof ts === 'number' ? ts : 0 };
};

/**
 * Write a merged remote routes slot back to local: the routes value + its
 * timestamp into chrome.storage, and the in-memory {@link dailyRunRoutesStore} so
 * the current game session reflects the adopted config without a reload.
 * Guarded by the keyed anti-loop suppressor (`'dailyRunRoutes'`) so the
 * dailyRunRoutes subscriber treats it as a sync-origin write (no re-stamp, no
 * upload reschedule).
 *
 * @param {import('./merge.js').DailyRunRoutesSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalRoutesSlot = async (slot) => {
  if (!routesUniverseId) return;
  bumpApplying('dailyRunRoutes');
  try {
    await chromeStore.set(dailyRunRoutesKeyFor(routesUniverseId), {
      routes: slot.routes,
      collectTarget: slot.collectTarget,
      collectMission: slot.collectMission ?? MISSION_DEPLOYMENT,
      collectShips: slot.collectShips ?? 'most',
      collectResources: slot.collectResources ?? 'most',
    });
    await chromeStore.set(dailyRunRoutesTsKeyFor(routesUniverseId), slot.updatedAt);
    dailyRunRoutesStore.set(
      /** @type {import('../state/dailyRunRoutes.js').DailyRunRoutes} */ ({
        routes: slot.routes,
        collectTarget: slot.collectTarget,
        collectMission: slot.collectMission ?? MISSION_DEPLOYMENT,
        collectShips: slot.collectShips ?? 'most',
        collectResources: slot.collectResources ?? 'most',
      }),
    );
  } finally {
    dropApplying('dailyRunRoutes');
  }
};

/**
 * Read this universe's local Galaxy-Scan config slot from chrome.storage —
 * NOT from {@link galaxyScanConfigStore} in memory (same cross-origin reason
 * as {@link readLocalRoutesSlot}: the dashboard edits a different origin). The
 * raw value is normalised so a partial/legacy blob still yields a complete
 * config. `updatedAt` comes from the separate per-universe timestamp key.
 *
 * @returns {Promise<import('./merge.js').GalaxyScanConfigSlot>}
 */
const readLocalGalaxyConfigSlot = async () => {
  // Everything this returns is WIRE-BOUND (merge input + upload payload), so
  // the device-local `colonyPassword` is blanked here — see the domain
  // sanitizer's policy note. The stored config keeps it; only the slot loses it.
  const fallback = () => ({
    config: sanitizeGalaxyScanConfigForWire(galaxyScanConfigStore.get()), updatedAt: 0,
  });
  if (!routesUniverseId) return fallback();
  const [raw, ts] = await Promise.all([
    chromeStore.get(galaxyScanConfigKeyFor(routesUniverseId)),
    chromeStore.get(galaxyScanConfigTsKeyFor(routesUniverseId)),
  ]);
  const config = raw === null || raw === undefined
    ? galaxyScanConfigStore.get()
    : normalizeGalaxyScanConfig(raw);
  return { config: sanitizeGalaxyScanConfigForWire(config), updatedAt: typeof ts === 'number' ? ts : 0 };
};

/**
 * Write a merged remote Galaxy-Scan config slot back to local: the config
 * value + its timestamp into chrome.storage, and the in-memory
 * {@link galaxyScanConfigStore} so the current game session reflects the
 * adopted config without a reload. Guarded by the keyed anti-loop suppressor
 * (`'galaxyScanConfig'`).
 *
 * @param {import('./merge.js').GalaxyScanConfigSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalGalaxyConfigSlot = async (slot) => {
  if (!routesUniverseId) return;
  bumpApplying('galaxyScanConfig');
  try {
    const config = normalizeGalaxyScanConfig(slot.config);
    // colonyPassword is device-local: an adopted remote config (sanitized on
    // modern devices, possibly still carrying a password from a pre-sanitizer
    // one) must neither WIPE this device's password nor implant a remote one.
    // The edit clock travels with it — dropping it would zero the stamp and
    // let a stale localStorage backup win the next hydrate reconcile.
    const cur = normalizeGalaxyScanConfig(
      await chromeStore.get(galaxyScanConfigKeyFor(routesUniverseId)),
    );
    config.colonyPassword = cur.colonyPassword;
    config.colonyPasswordTs = cur.colonyPasswordTs;
    await chromeStore.set(galaxyScanConfigKeyFor(routesUniverseId), config);
    await chromeStore.set(galaxyScanConfigTsKeyFor(routesUniverseId), slot.updatedAt);
    galaxyScanConfigStore.set(config);
  } finally {
    dropApplying('galaxyScanConfig');
  }
};

/**
 * Read this universe's local alarmClock config slot from chrome.storage — NOT
 * from {@link alarmClockConfigStore} in memory (same cross-origin reason as
 * {@link readLocalGalaxyConfigSlot}: the dashboard edits a different origin).
 * The raw value is normalised so a partial/legacy blob still yields a complete
 * config. `updatedAt` comes from the separate per-universe timestamp key.
 *
 * @returns {Promise<import('./merge.js').AlarmClockConfigSlot>}
 */
const readLocalAlarmClockConfigSlot = async () => {
  const fallback = () => ({ config: alarmClockConfigStore.get(), updatedAt: 0 });
  if (!routesUniverseId) return fallback();
  const [raw, ts] = await Promise.all([
    chromeStore.get(alarmClockConfigKeyFor(routesUniverseId)),
    chromeStore.get(alarmClockConfigTsKeyFor(routesUniverseId)),
  ]);
  const config = raw === null || raw === undefined
    ? alarmClockConfigStore.get()
    : normalizeAlarmClockConfig(raw);
  return { config, updatedAt: typeof ts === 'number' ? ts : 0 };
};

/**
 * Write a merged remote alarmClock config slot back to local: the config value +
 * its timestamp into chrome.storage, and the in-memory
 * {@link alarmClockConfigStore} so the current game session reflects the adopted
 * config without a reload. Guarded by the keyed anti-loop suppressor
 * (`'alarmClockConfigPerUniverse'`).
 *
 * @param {import('./merge.js').AlarmClockConfigSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalAlarmClockConfigSlot = async (slot) => {
  if (!routesUniverseId) return;
  bumpApplying('alarmClockConfigPerUniverse');
  try {
    const config = normalizeAlarmClockConfig(slot.config);
    await chromeStore.set(alarmClockConfigKeyFor(routesUniverseId), config);
    await chromeStore.set(alarmClockConfigTsKeyFor(routesUniverseId), slot.updatedAt);
    alarmClockConfigStore.set(config);
  } finally {
    dropApplying('alarmClockConfigPerUniverse');
  }
};

/**
 * Read this universe's local per-universe settings slot — values from the
 * in-memory {@link settingsStore} and timestamps from the in-memory cache
 * {@link localUniverseTsMap} (backed by chrome.storage). Used by both
 * {@link downloadAndMerge} and {@link upload} to assemble the local side of
 * the per-universe merge.
 *
 * @returns {{ values: Record<string, unknown>, ts: Record<string, number> }}
 */
const readLocalUniverseSettingsSlot = () => ({
  values: pickSyncedValues(settingsStore.get(), 'universe'),
  ts: localUniverseTsMap,
});

/**
 * Write a merged per-universe settings result back to local: update the
 * in-memory timestamp cache, persist to chrome.storage, and spread the new
 * values into {@link settingsStore}. Guarded by the keyed anti-loop suppressor
 * ({@link APPLY_SETTINGS}) so our own settings subscriber treats this as a
 * sync-origin write, not a user edit.
 *
 * @param {{ values: Record<string, unknown>, ts: Record<string, number> }} merged
 * @returns {Promise<void>}
 */
const writeLocalUniverseSettingsSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying(APPLY_SETTINGS);
  try {
    localUniverseTsMap = merged.ts;
    await writeUniverseTsMap(routesUniverseId, merged.ts);
    settingsStore.update((cur) => {
      const spread = {
        .../** @type {Record<string, unknown>} */ (/** @type {unknown} */ (cur)),
        ...merged.values,
      };
      return /** @type {import('../state/settings.js').Settings} */ (
        /** @type {unknown} */ (spread)
      );
    });
  } finally {
    dropApplying(APPLY_SETTINGS);
  }
};

/**
 * Write a merged settings result back to local: persist the per-key ts map
 * and apply the values to {@link settingsStore} (excluded keys, absent from
 * `merged.values`, keep their current local value). Guarded by the keyed
 * anti-loop suppressor ({@link APPLY_SETTINGS}) so our own settings subscriber
 * treats this as a sync-origin write, not a user edit.
 *
 * @param {{ values: Record<string, unknown>, ts: Record<string, number> }} merged
 * @returns {void}
 */
const applyMergedSettings = (merged) => {
  bumpApplying(APPLY_SETTINGS);
  try {
    writeTsMap(merged.ts);
    settingsStore.update((cur) => {
      const spread = {
        .../** @type {Record<string, unknown>} */ (/** @type {unknown} */ (cur)),
        ...merged.values,
      };
      return /** @type {import('../state/settings.js').Settings} */ (
        /** @type {unknown} */ (spread)
      );
    });
  } finally {
    dropApplying(APPLY_SETTINGS);
  }
};

/**
 * Merge the global + per-universe settings slots for one sync round — the
 * shared core of {@link downloadAndMerge} and {@link upload}. `remote` may be
 * null (upload before any gist exists); optional chaining covers both.
 *
 * @param {*} remote  Parsed remote gist payload (or null).
 * @param {string} routesUniverseId  Current universe id ('' when unknown).
 * @returns {{ setResult: { changed: boolean, merged: * }, uniResult: { changed: boolean, merged: * } }}
 */
const mergeSyncSettings = (remote, routesUniverseId) => {
  // Scope-filter the remote slot symmetrically with how `local` is built
  // (pickSyncedValues). Two jobs: (1) strip per-device EXCLUDED keys
  // (gistToken, fabBtnSize) so mergeSettings' key-union can never leak them
  // from a corrupt/hand-edited gist; (2) keep each scope's keys in their own
  // slot. Unknown future GLOBAL keys are not universe-scoped, so they survive
  // the 'global' filter (forward-compat); the 'universe' filter keeps only the
  // declared universe-scoped keys.
  /**
   * @param {{ values?: Record<string, unknown>, ts?: Record<string, number> } | undefined | null} slot
   * @param {'global' | 'universe'} scope
   */
  const scopeRemote = (slot, scope) =>
    slot && slot.values
      ? { values: pickSyncedValues(slot.values, scope), ts: slot.ts }
      : slot;
  const setResult = mergeSettings(
    { values: pickSyncedValues(settingsStore.get(), 'global'), ts: readTsMap() },
    scopeRemote(remote?.settings, 'global'),
  );
  const remoteUniSlot = remote?.settingsPerUniverse?.[routesUniverseId] ?? remote?.settings;
  const uniResult = routesUniverseId
    ? mergeSettings(readLocalUniverseSettingsSlot(), scopeRemote(remoteUniSlot, 'universe'))
    : { changed: false, merged: readLocalUniverseSettingsSlot() };
  return { setResult, uniResult };
};

/**
 * Per-universe sync slot registry. Each descriptor folds the
 * read → merge → write-back → contribution-guard quadruple that
 * {@link downloadAndMerge} and {@link upload} would otherwise hand-unroll once
 * per entity (~15-20 near-identical lines each, twice). `payloadKey` is BOTH
 * the gist payload field AND the remote read path (`remote[payloadKey][uni]`),
 * so it can't drift between the two directions.
 *
 * Adding a synced per-universe entity = ONE entry here (+ its `merge`/`hasData`
 * in the pure layer) instead of edits scattered across both round-trip
 * functions and the anti-loop suppressor.
 *
 * `writeLocal` adopts a newer remote slot into local stores; the config
 * entities (routes, galaxy config, alarmClock config, watch list) guard that
 * write with the keyed anti-loop suppressor (inside their
 * `writeLocal*Slot` helper), while history / dailyState / decisions carry no
 * local timestamp to protect and rely on the `changed` guard + the
 * {@link gistIsCurrent} skip to break the subscription loop. `remoteDefault`
 * is what a slot merges against when the remote field is absent (decisions
 * wants `{}`, the rest `undefined`).
 *
 * @typedef {object} SyncSlot
 * @property {string} payloadKey
 * @property {() => (Promise<*> | *)} readLocal
 * @property {(merged: *) => (Promise<void> | void)} writeLocal
 * @property {(local: *, remote: *) => { merged: *, changed: boolean }} merge
 * @property {(merged: *) => boolean} hasData
 * @property {*} [remoteDefault]
 */

/**
 * Read this universe's watch-list sync slot: config + ts ledger from
 * chrome.storage (cross-origin source of truth — the dashboard edits it from
 * the extension origin, so the in-memory store can't be trusted here; same
 * reason as {@link readLocalRoutesSlot}), composed into the per-key
 * `{ v?, ts }` wire shape. Seeding is part of the read so a device that
 * never opens the dashboard still stamps its pre-1.40 list before its first
 * merge (first-sync safety) — the seed persists, keeping the slot stable
 * across rounds.
 *
 * @returns {Promise<import('../domain/watchListMerge.js').WatchListSyncSlot>}
 */
const readLocalWatchListSlot = async () => {
  if (!routesUniverseId) return composeWatchSlot(normalizeWatchList(null), { });
  const { cfg, ledger } = await ensureWatchListLedgerSeeded(routesUniverseId);
  return composeWatchSlot(cfg, ledger);
};

/**
 * Write a merged remote watch-list slot back to local: decompose into config
 * fields + ledger, overlay onto the stored config so the LOCAL-ONLY fields
 * (`probes`, `rescan`) survive, persist both keys, and refresh the in-memory
 * store so the live scan FAB reflects the adopted list without a reload.
 * Guarded by the keyed anti-loop suppressor (`'watchListPerUniverse'`) so the
 * store subscriber treats it as a sync-origin write (no upload reschedule) —
 * and the ledger is written with the REMOTE stamps, never re-stamped `now`
 * (re-stamping would let this device win LWW races it didn't earn).
 *
 * Config first, ledger second — same crash-ordering argument as
 * `state/watchList.js#writeWatchListConfig`.
 *
 * @param {import('../domain/watchListMerge.js').WatchListSyncSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalWatchListSlot = async (slot) => {
  if (!routesUniverseId) return;
  bumpApplying('watchListPerUniverse');
  try {
    const next = await applyWatchListSyncSlot(routesUniverseId, slot);
    watchListStore.set(next);
  } finally {
    dropApplying('watchListPerUniverse');
  }
};

// ── Spyglass observation slots (targetReports / activityObs / playersLite) ──
//
// Synced since 1.48. All three read the RAW chrome.storage key — not the
// in-memory store — because the dashboard import (extension origin) writes
// the same keys and the in-game store can't see those edits (same
// cross-origin argument as readLocalRoutesSlot). All three write back key
// FIRST (so a late hydrate loads the merged value), then refresh the
// in-memory store AFTER its hydration settles (so the hydrate echo can't
// clobber the refresh — the colonyRecorder race), via `store.update` with the
// same entity merge (so an in-game report/look that landed mid-round survives
// instead of being clobbered by `set`).

/** @typedef {import('../state/targets.js').TargetReports} TargetReports */
/** @typedef {import('../state/activityObs.js').ActivityObsMap} ActivityObsMap */
/** @typedef {import('../state/players.js').PlayerCache} PlayerCache */

/** @returns {Promise<TargetReports>} */
const readLocalTargetReportsSlot = async () => {
  if (!routesUniverseId) return {};
  const raw = await chromeStore.get(targetReportsKeyFor(routesUniverseId));
  // Same unit repair as the store's own hydrate: pre-fix reports stored ms
  // timestamps — without it a malformed local `latest` would win every
  // newer-timestamp merge against well-formed remote data.
  return raw && typeof raw === 'object'
    ? normalizeReportTimestamps(/** @type {TargetReports} */ (raw))
    : {};
};

/** @param {TargetReports} merged @returns {Promise<void>} */
const writeLocalTargetReportsSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying('targetReportsPerUniverse');
  try {
    await chromeStore.set(targetReportsKeyFor(routesUniverseId), merged);
    await whenTargetsHydrated();
    targetReportsStore.update((cur) => mergeTargetReports(cur, merged).merged);
  } finally {
    dropApplying('targetReportsPerUniverse');
  }
};

/** @typedef {import('../domain/espionageReport.js').ProximityReport} ProximityReport */

/** @returns {Promise<ProximityReport[]>} */
const readLocalProximityReportsSlot = async () => {
  if (!routesUniverseId) return [];
  const raw = await chromeStore.get(proximityReportsKeyFor(routesUniverseId));
  return Array.isArray(raw) ? /** @type {ProximityReport[]} */ (raw) : [];
};

/** @param {ProximityReport[]} merged @returns {Promise<void>} */
const writeLocalProximityReportsSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying('proximityReportsPerUniverse');
  try {
    await chromeStore.set(proximityReportsKeyFor(routesUniverseId), merged);
    await whenProximityHydrated();
    proximityReportsStore.update((cur) => mergeProximityReports(cur, merged).merged);
  } finally {
    dropApplying('proximityReportsPerUniverse');
  }
};

/** @returns {Promise<ActivityObsMap>} */
const readLocalActivityObsSlot = async () => {
  if (!routesUniverseId) return {};
  const raw = await chromeStore.get(activityObsKeyFor(routesUniverseId));
  return raw && typeof raw === 'object' ? /** @type {ActivityObsMap} */ (raw) : {};
};

/** @param {ActivityObsMap} merged @returns {Promise<void>} */
const writeLocalActivityObsSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying('activityObsPerUniverse');
  try {
    await chromeStore.set(activityObsKeyFor(routesUniverseId), merged);
    await whenActivityObsHydrated();
    activityObsStore.update((cur) => mergeActivityObs(cur, merged).merged);
  } finally {
    dropApplying('activityObsPerUniverse');
  }
};

/**
 * Read the "playersLite" slot: the full roster cache FILTERED to watched ∪
 * observed ids (the dashboard export's filter — §4b keeps the unbounded full
 * roster out of the gist). Observed = any id present in the targetReports /
 * activityObs RAW keys, which — because this slot is registered AFTER those
 * two in SYNC_SLOTS — already contain this round's merged union, so an id
 * only the OTHER device observed still keeps its meta in the slot (no
 * cross-device slim-and-readopt ping-pong).
 *
 * @returns {Promise<PlayerCache>}
 */
const readLocalPlayersLiteSlot = async () => {
  if (!routesUniverseId) return {};
  const [allRaw, wlRaw, reportsRaw, activityRaw] = await Promise.all([
    chromeStore.get(playersKeyFor(routesUniverseId)),
    chromeStore.get(watchListKeyFor(routesUniverseId)),
    chromeStore.get(targetReportsKeyFor(routesUniverseId)),
    chromeStore.get(activityObsKeyFor(routesUniverseId)),
  ]);
  const all = allRaw && typeof allRaw === 'object' ? /** @type {PlayerCache} */ (allRaw) : {};
  const keep = new Set(
    (wlRaw == null ? [] : normalizeWatchList(wlRaw).players).map(String),
  );
  for (const src of [reportsRaw, activityRaw]) {
    if (src && typeof src === 'object') {
      for (const pid of Object.keys(src)) keep.add(String(pid));
    }
  }
  /** @type {PlayerCache} */
  const lite = {};
  for (const [id, meta] of Object.entries(all)) {
    if (keep.has(String(id))) lite[/** @type {any} */ (id)] = meta;
  }
  return lite;
};

/**
 * Overlay a merged playersLite slot into the FULL local roster cache (never
 * replace it — the slot is a filtered subset; a `set` would wipe every
 * unwatched/unobserved player this device has legitimately cached).
 *
 * @param {PlayerCache} merged
 * @returns {Promise<void>}
 */
const writeLocalPlayersLiteSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying('playersLitePerUniverse');
  try {
    const key = playersKeyFor(routesUniverseId);
    const allRaw = await chromeStore.get(key);
    const all = allRaw && typeof allRaw === 'object' ? /** @type {PlayerCache} */ (allRaw) : {};
    await chromeStore.set(key, mergePlayerCache(all, merged).merged);
    await whenPlayersHydrated();
    playersStore.update((cur) => mergePlayerCache(cur, merged).merged);
  } finally {
    dropApplying('playersLitePerUniverse');
  }
};

/** @typedef {import('../state/presenceLedger.js').PresenceLedgerMap} PresenceLedgerMap */

/** @returns {Promise<PresenceLedgerMap>} */
const readLocalPresenceLedgerSlot = async () => {
  if (!routesUniverseId) return {};
  const raw = await chromeStore.get(presenceLedgerKeyFor(routesUniverseId));
  return raw && typeof raw === 'object' ? /** @type {PresenceLedgerMap} */ (raw) : {};
};

/** @param {PresenceLedgerMap} merged @returns {Promise<void>} */
const writeLocalPresenceLedgerSlot = async (merged) => {
  if (!routesUniverseId) return;
  bumpApplying('presenceLedgerPerUniverse');
  try {
    await chromeStore.set(presenceLedgerKeyFor(routesUniverseId), merged);
    // OR-adopt into the live store (never replace — a fold landing mid-round
    // must survive); gates itself on the store's hydration.
    await adoptPresenceLedgerMap(merged);
  } finally {
    dropApplying('presenceLedgerPerUniverse');
  }
};

/** @type {SyncSlot[]} */
const SYNC_SLOTS = [
  {
    payloadKey: 'dailyRunRoutes',
    readLocal: readLocalRoutesSlot,
    writeLocal: writeLocalRoutesSlot,
    merge: mergeDailyRunRoutes,
    hasData: slotHasData,
  },
  {
    payloadKey: 'galaxyScanConfig',
    readLocal: readLocalGalaxyConfigSlot,
    writeLocal: writeLocalGalaxyConfigSlot,
    // The merged slot is what gets UPLOADED, so sanitize it: when the remote
    // side wins it may still carry a colonyPassword written by a pre-sanitizer
    // version, and re-uploading it would keep the secret alive in the gist.
    // Sanitizing here also makes the merged slot DIFFER from such a dirty
    // remote, which schedules exactly one upload that scrubs the password out
    // of the gist for good. (`writeLocal` keeps this device's own password.)
    merge: (local, remote) => {
      const r = mergeGalaxyScanConfig(local, /** @type {any} */ (remote));
      return {
        changed: r.changed,
        merged: { ...r.merged, config: sanitizeGalaxyScanConfigForWire(r.merged.config) },
      };
    },
    hasData: galaxyConfigSlotHasData,
  },
  {
    payloadKey: 'colonyHistoryPerUniverse',
    readLocal: () => historyStore.get(),
    writeLocal: (merged) => historyStore.set(merged),
    merge: mergeHistory,
    hasData: (merged) => merged.length > 0,
  },
  {
    // Lifeform-discovery markers ONLY — deliberately not the scans map that
    // carries them locally (§4b keeps that out of the payload). See
    // `state/scans.js` `readLfDiscoverySlot` for why these markers are the one
    // part of it that has to travel.
    payloadKey: 'lfDiscoveryPerUniverse',
    readLocal: readLfDiscoverySlot,
    writeLocal: writeLfDiscoverySlot,
    merge: mergeLfDiscovery,
    hasData: (merged) => Object.keys(merged).length > 0,
  },
  {
    payloadKey: 'dailyStatePerUniverse',
    readLocal: readDailyState,
    writeLocal: writeDailyState,
    merge: mergeDailyState,
    hasData: dailyStateHasData,
  },
  {
    payloadKey: 'alarmClockConfigPerUniverse',
    readLocal: readLocalAlarmClockConfigSlot,
    writeLocal: writeLocalAlarmClockConfigSlot,
    merge: mergeAlarmClockConfig,
    hasData: alarmClockConfigSlotHasData,
  },
  {
    payloadKey: 'colonizeDecisionsPerUniverse',
    readLocal: () => colonizeDecisionsStore.get(),
    writeLocal: (merged) => colonizeDecisionsStore.set(merged),
    merge: mergeColonizeDecisions,
    hasData: decisionsSlotHasData,
    remoteDefault: {},
  },
  {
    // The unified fleet reminders (auto landings + manual marks). Per-body
    // LWW with `on:false` tombstones — `now` injected so the merge (and its
    // tombstone GC horizon) stays pure and test-clockable. Tombstones ARE
    // data (they carry a dismiss cross-device), hence the hasData on any key.
    payloadKey: 'fleetRemindersPerUniverse',
    readLocal: readFleetReminderSlot,
    writeLocal: writeFleetReminderSlot,
    merge: (local, remote) => mergeFleetReminders(local, remote, Math.floor(Date.now() / 1000)),
    hasData: (merged) => Object.keys(merged.marks).length > 0,
  },
  {
    payloadKey: 'watchListPerUniverse',
    readLocal: readLocalWatchListSlot,
    writeLocal: writeLocalWatchListSlot,
    // `now` is injected at the call so the domain merge (and its tombstone GC
    // horizon) stays pure and test-clockable.
    merge: (local, remote) => mergeWatchList(local, remote, Date.now()),
    hasData: watchSlotHasData,
  },
  {
    payloadKey: 'targetReportsPerUniverse',
    readLocal: readLocalTargetReportsSlot,
    writeLocal: writeLocalTargetReportsSlot,
    merge: mergeTargetReports,
    hasData: (merged) => Object.keys(merged).length > 0,
  },
  {
    payloadKey: 'activityObsPerUniverse',
    readLocal: readLocalActivityObsSlot,
    writeLocal: writeLocalActivityObsSlot,
    // Sweep the MERGED result to the routine horizon: a ring one device
    // already swept locally must not ping-pong back through the gist (the
    // union would re-adopt it every round, the local hydrate sweep would drop
    // it again, forever). Sweeping here both slims the contribution and, when
    // `changed` fires on stale-only remote data, writes back the already-swept
    // value — one PATCH later the gist has converged.
    merge: (local, remote) => {
      const r = mergeActivityObs(local, /** @type {ActivityObsMap} */ (remote) || {});
      return { changed: r.changed, merged: sweepStaleActivityObs(r.merged, Date.now()) };
    },
    hasData: (merged) => Object.keys(merged).length > 0,
  },
  {
    // "Who's spying on you" alert log. A probe another player flew at us is an
    // observation a second device can never re-derive (the alert is one-shot),
    // so it syncs like the other Spyglass observations. Union-dedup merge,
    // newest-first, capped — see mergeProximityReports.
    payloadKey: 'proximityReportsPerUniverse',
    readLocal: readLocalProximityReportsSlot,
    writeLocal: writeLocalProximityReportsSlot,
    merge: mergeProximityReports,
    hasData: (merged) => merged.length > 0,
  },
  {
    // MUST stay AFTER targetReports/activityObs: its readLocal filter derives
    // "observed ids" from those slots' raw keys, which the loop above has
    // already merged for this round (see readLocalPlayersLiteSlot).
    payloadKey: 'playersLitePerUniverse',
    readLocal: readLocalPlayersLiteSlot,
    writeLocal: writeLocalPlayersLiteSlot,
    merge: mergePlayerCache,
    hasData: (merged) => Object.keys(merged).length > 0,
  },
  {
    payloadKey: 'presenceLedgerPerUniverse',
    readLocal: readLocalPresenceLedgerSlot,
    writeLocal: writeLocalPresenceLedgerSlot,
    // Sweep the merged result to the retention horizon — same rationale as
    // the activityObs slot: a day one device already swept must not
    // ping-pong back through the gist; sweeping the contribution slims the
    // gist in one PATCH and converges.
    merge: (local, remote) => {
      const r = mergePresenceLedgerMaps(local, /** @type {PresenceLedgerMap} */ (remote) || {});
      return {
        changed: r.changed,
        merged: sweepPresenceLedgerMap(r.merged, Math.floor(Date.now() / 1000)),
      };
    },
    hasData: (merged) => Object.keys(merged).length > 0,
  },
];

/**
 * Pull the remote payload, merge it with local, and conditionally
 * write the merged result back to the local stores.
 *
 * Sequence:
 *   1. Early return when cloud sync is disabled or no token is set —
 *      this is how users opt out.
 *   2. Early return when {@link inFlight} is already set (a concurrent
 *      upload / download is in progress). The lock prevents a read
 *      from racing a write.
 *   3. {@link fetchGistData} — returns `null` when the gist exists but
 *      is empty / corrupt / schema-mismatched. Treat `null` the same as
 *      "nothing to merge", clear the error status, and finish.
 *   4. Merge each pair (scans, history). The merged result is the new
 *      source of truth for both local and remote — but see step 5.
 *   5. Anti-loop write: only `store.set(merged)` when `changed ===
 *      true`. That flag is `true` iff remote contributed something
 *      local didn't have; when it's `false` the merged reference IS the
 *      local reference, and writing it would fire our own
 *      subscription → schedule another upload → infinite loop.
 *   6. Stamp `down` with the ISO timestamp and clear any stale `err`.
 *      On exception, stamp `err` with a human-readable message so the
 *      Settings UI can surface what went wrong.
 *
 * @returns {Promise<void>}
 */
const downloadAndMerge = async () => {
  if (!canStartSync({ cloudSync: settingsStore.get().cloudSync, hasToken: !!getToken(), inFlight }))
    return;
  inFlight = true;
  try {
    const remote = await fetchGistData();
    if (!remote) {
      // Gist exists but is empty / corrupt / wrong schema: nothing to
      // merge in, but also not a failure — clear any stale error and
      // skip the timestamp (we didn't actually download data).
      setStatus('err', null);
      // Mark this tab as "pulled" so an empty-gist account doesn't re-download
      // on every reload (the `!appliedRev` boot trigger). Never clobber a real
      // rev we already hold.
      if (!readAppliedRev()) writeAppliedRev(EMPTY_REV);
      return;
    }

    // Galaxy scans, the FULL player roster, and our own profile are NO LONGER
    // synced (§4b): occupancy + neighbour status/rank are re-derived from the
    // OGame public API per device, and our rank is re-scraped from the header
    // each load. The colonization DECISION log carries cross-device
    // colonization state, and since 1.48 the Spyglass OBSERVATIONS
    // (targetReports / activityObs / the filtered playersLite roster subset)
    // sync too — those can't be re-derived on a second device.
    // Global + per-universe settings merge (shared with upload()).
    const { setResult, uniResult } = mergeSyncSettings(remote, routesUniverseId);

    // Anti-loop: see file header. Settings have their own value-level anti-loop
    // flag inside applyMergedSettings / writeLocalUniverseSettingsSlot.
    if (setResult.changed) applyMergedSettings(setResult.merged);
    if (uniResult.changed) await writeLocalUniverseSettingsSlot(uniResult.merged);

    // Per-universe slots (routes, galaxy config, colony history, daily-action
    // state, alarmClock config, colonization decisions): read local, merge our
    // universe's remote slot, and adopt only when the merge says remote
    // contributed (anti-loop: write back on `changed` only). One code path via
    // the SYNC_SLOTS registry — see its doc for which entities need an anti-loop
    // suppressor and which break the loop via the `changed` guard alone.
    const remoteRec = /** @type {Record<string, any>} */ (remote);
    if (routesUniverseId) {
      for (const s of SYNC_SLOTS) {
        const remoteSlot = remoteRec[s.payloadKey]?.[routesUniverseId] ?? s.remoteDefault;
        const { merged, changed } = s.merge(await s.readLocal(), remoteSlot);
        if (changed) await s.writeLocal(merged);
      }
    }

    setStatus('down', new Date().toISOString());
    setStatus('err', null);
    // Record how far this tab has caught up (no beacon bump — a download changes
    // nothing remotely), so the boot gate and the onChanged listener can tell
    // "already current" from "behind".
    await noteApplied(remote.updatedAt);
  } catch (err) {
    setStatus('err', `download: ${/** @type {Error} */ (err).message}`);
  } finally {
    inFlight = false;
  }
};

/**
 * Pre-merge with remote, PATCH the gist with the merged state, and
 * conditionally write the merged result back to the local stores.
 *
 * Sequence:
 *   1. Early return when cloud sync is disabled or no token is set.
 *   2. Early return when {@link inFlight} is already set.
 *   3. Read local from the two stores.
 *   4. Pre-merge: {@link fetchGistData} gives us what the gist
 *      currently contains. Merging local with remote BEFORE we write
 *      ensures we don't clobber another device's recent writes. A
 *      thrown fetch (network / HTTP / rate-limit) is NOT swallowed — it
 *      aborts the round via the outer catch (error status, no PATCH), so
 *      we never rebuild the payload from a null remote and wipe other
 *      universes' slots. A returned `null` (genuinely empty gist) is the
 *      first-upload path and proceeds normally.
 *   5. Same anti-loop write as {@link downloadAndMerge}: only call
 *      `store.set(merged)` when `changed === true`.
 *   6. Skip the PATCH when `sameJSON(remote, merged)` on both sides —
 *      a common case right after a download from another device where
 *      local and remote are already in agreement. Saves one API call
 *      and avoids a no-op gist revision on GitHub's end.
 *   7. When we do PATCH: build the full {@link GistPayload} (version
 *      1, fresh `updatedAt`, the merged per-universe slots), call
 *      {@link writeGistData}, stamp `up` on success.
 *   8. Stamp `err` with a human-readable message on exception.
 *
 * @returns {Promise<void>}
 */
const upload = async () => {
  if (!canStartSync({ cloudSync: settingsStore.get().cloudSync, hasToken: !!getToken(), inFlight }))
    return;
  inFlight = true;
  // Snapshot the dirty-flag token BEFORE any local read. A store write landing
  // mid-flight re-arms the flag with a FRESH token (see scheduleUpload), so the
  // success path below can tell "this round covered everything that armed the
  // flag" (tokens equal → clear) from "a write raced this round and is NOT in
  // the PATCH" (tokens differ → leave the flag for the next boot's catch-up).
  const pendingToken = safeLS.get(UPLOAD_PENDING_KEY);
  try {
    // Pre-merge: read remote and combine with local BEFORE writing, so a
    // concurrent write from another device isn't clobbered. Two "no remote"
    // cases are NOT the same and must be told apart:
    //   - fetchGistData() RETURNS null → the gist is genuinely empty (first
    //     upload / off-schema blob). Proceed: build the payload from local and
    //     seed the gist. Safe — there is nothing to clobber.
    //   - fetchGistData() THROWS (network / HTTP / rate-limit) → we have NO
    //     view of the remote at all. If we swallowed it and proceeded with
    //     remote = null, every OTHER universe's slot would be rebuilt from `{}`
    //     and the PATCH would WIPE them (and stamp a false success). So we do
    //     NOT catch here: the throw aborts this round via the outer try/catch
    //     (error status, no PATCH); the next round pre-merges cleanly.
    /** @type {import('./gist.js').GistPayload | null} */
    const remote = await fetchGistData();

    // Global + per-universe settings merge (shared with downloadAndMerge()).
    // Galaxy scans / players / own-profile are no longer synced (§4b) — their
    // payload fields are omitted below, so the next PATCH drops them from the
    // gist (the slim-down), and a stale field on an old gist compares "not
    // current" against our `undefined`, triggering that one slimming PATCH.
    const { setResult, uniResult } = mergeSyncSettings(remote, routesUniverseId);

    // Same anti-loop guard as downloadAndMerge.
    if (setResult.changed) applyMergedSettings(setResult.merged);
    if (uniResult.changed) await writeLocalUniverseSettingsSlot(uniResult.merged);

    // Per-universe slots: drive read → merge → write-back → contribute →
    // empty-normalise from the SYNC_SLOTS registry. For each entity: seed the
    // payload map from remote (PRESERVING every OTHER universe's slot — we only
    // own ours), merge our universe's slot and adopt-if-changed, contribute ours
    // only when it carries data, then normalise an empty map to `undefined` (so a
    // gist with no such field and our empty map compare equal and don't force a
    // perpetual no-op PATCH).
    const remoteRec = /** @type {Record<string, any> | null} */ (remote);
    /** @type {Record<string, Record<string, any> | undefined>} */
    const slotPayloads = {};
    for (const s of SYNC_SLOTS) {
      const map = { ...(remoteRec?.[s.payloadKey] || {}) };
      if (routesUniverseId) {
        const remoteSlot = remoteRec?.[s.payloadKey]?.[routesUniverseId] ?? s.remoteDefault;
        const { merged, changed } = s.merge(await s.readLocal(), remoteSlot);
        if (changed) {
          // The adopted value is REMOTE-origin data this very round carries
          // (see `map` below) — its store notification must not re-arm the
          // upload dirty flag or every remote-contributing round would end
          // with the flag stranded and the next boot would run a spurious
          // catch-up upload. Store notifications are synchronous (createStore
          // notifies inside set()), so suppress only the synchronous prefix
          // of the call: a user write interleaving during the awaited
          // persistence tail still arms normally.
          suppressUploadArm = true;
          /** @type {unknown} */
          let write;
          try {
            write = s.writeLocal(merged);
          } finally {
            suppressUploadArm = false;
          }
          await write;
        }
        if (s.hasData(merged)) map[routesUniverseId] = merged;
      }
      slotPayloads[s.payloadKey] = Object.keys(map).length ? map : undefined;
    }

    // Per-universe settings map (bespoke — a two-scope merge, not a registry
    // slot). Preserve every OTHER universe's slot; contribute ours only when the
    // ts map is non-empty (an all-defaults universe is indistinguishable from
    // "no slot" for another device and must not force a perpetual no-op PATCH).
    const mergedPerUniverse = { ...(remote?.settingsPerUniverse || {}) };
    if (routesUniverseId && Object.keys(uniResult.merged.ts).length > 0) {
      mergedPerUniverse[routesUniverseId] = uniResult.merged;
    }
    const mergedPerUniverseOut = Object.keys(mergedPerUniverse).length
      ? mergedPerUniverse
      : undefined;

    // The full set of synced slots we would write — built ONCE and reused for
    // both the already-current check and the PATCH (previously this field list
    // was spelled out twice). galaxyScansPerUniverse / playersPerUniverse /
    // ownProfilePerUniverse are intentionally omitted (left `undefined`) — §4b
    // stopped syncing them; gistIsCurrent still compares them, so a gist that
    // still carries those reads "not current" against our `undefined` and gets
    // slimmed by this one PATCH.
    const mergedSlots = {
      colonyHistoryPerUniverse: slotPayloads.colonyHistoryPerUniverse,
      settings: setResult.merged,
      dailyRunRoutes: slotPayloads.dailyRunRoutes,
      settingsPerUniverse: mergedPerUniverseOut,
      dailyStatePerUniverse: slotPayloads.dailyStatePerUniverse,
      lfDiscoveryPerUniverse: slotPayloads.lfDiscoveryPerUniverse,
      galaxyScanConfig: slotPayloads.galaxyScanConfig,
      alarmClockConfigPerUniverse: slotPayloads.alarmClockConfigPerUniverse,
      colonizeDecisionsPerUniverse: slotPayloads.colonizeDecisionsPerUniverse,
      fleetRemindersPerUniverse: slotPayloads.fleetRemindersPerUniverse,
      watchListPerUniverse: slotPayloads.watchListPerUniverse,
      targetReportsPerUniverse: slotPayloads.targetReportsPerUniverse,
      activityObsPerUniverse: slotPayloads.activityObsPerUniverse,
      proximityReportsPerUniverse: slotPayloads.proximityReportsPerUniverse,
      playersLitePerUniverse: slotPayloads.playersLitePerUniverse,
      presenceLedgerPerUniverse: slotPayloads.presenceLedgerPerUniverse,
    };

    // Skip the PATCH when the gist already matches the merged state — the common
    // case right after a download from another device. PATCHing anyway would
    // burn a request and produce a no-op gist revision.
    if (!gistIsCurrent(remote, mergedSlots)) {
      const updatedAt = new Date().toISOString();
      await writeGistData({
        version: 1,
        updatedAt,
        ...mergedSlots,
      });
      setStatus('up', updatedAt);
      // Real PATCH: raise the same-machine beacon so sibling tabs / the
      // dashboard pull (applied-rev is written first inside noteApplied, so our
      // own onChanged self-skips).
      await noteApplied(updatedAt, { beacon: true });
    } else {
      // Already current with the gist (common right after a peer's change):
      // record that we're caught up, no PATCH, no beacon bump.
      await noteApplied(remote?.updatedAt);
    }
    // Whatever armed this upload is now reflected remotely — drop the catch-up
    // dirty flag so the next boot doesn't re-push. Only when the token still
    // matches our entry snapshot, though: a write that landed mid-flight
    // re-armed the flag for data this PATCH did NOT carry, and clearing it
    // would strand that write if the post-send reload kills its debounce.
    // Left intact on the error path (outer catch) so a failed flush retries
    // on the next load.
    if (safeLS.get(UPLOAD_PENDING_KEY) === pendingToken) safeLS.remove(UPLOAD_PENDING_KEY);
    setStatus('err', null);
  } catch (err) {
    setStatus('err', `upload: ${/** @type {Error} */ (err).message}`);
  } finally {
    inFlight = false;
  }
};

/**
 * Debounced wrapper over {@link upload}: collapses a burst of store
 * changes into one trailing upload. See file header "Why a 15-second
 * debounce" for the rate-limit rationale.
 *
 * Note: `debounce` from `lib/debounce` ignores the wrapped fn's return
 * value (the signature is `(...args) => void`). That's fine here —
 * `upload` is fire-and-forget from the scheduler's perspective; any
 * error is captured by its internal try/catch and surfaced via
 * {@link setStatus}.
 */
const debouncedUpload = debounce(() => {
  if (!installed) return;
  // `void` the promise so tsc doesn't complain about an unhandled
  // PromiseLike. The function's own try/catch owns error reporting.
  void upload();
}, DEBOUNCE_MS);

/**
 * Arm the debounced upload AND set the {@link UPLOAD_PENDING_KEY} dirty flag.
 * The flag is what lets the next boot know a local write may not have reached
 * the gist (its 15-s debounce killed by OGame's post-send reload) and run the
 * catch-up upload; a clean navigation never sets it, so it stays quiet. The flag
 * is cleared by {@link upload} on success.
 *
 * @returns {void}
 */
const scheduleUpload = () => {
  // Self-inflicted change: upload()'s pre-merge adopting remote data. That
  // data is fully carried by the in-flight round — arming here would only
  // strand the flag (token mismatch at the round's end) and burn a spurious
  // boot catch-up upload.
  if (suppressUploadArm) return;
  // A FRESH token per arm (not a constant '1'): upload() snapshots the token at
  // entry and clears the flag only if it is unchanged at the end, so a write
  // that arms mid-flight (its data absent from that PATCH) keeps the flag alive
  // for the next boot's catch-up. Timestamp + counter — unique across tabs too.
  safeLS.set(UPLOAD_PENDING_KEY, `${Date.now()}:${++uploadArmSeq}`);
  debouncedUpload();
};

/**
 * Install the scheduler: subscribe local stores, listen for the force-
 * sync event, and kick off the initial download.
 *
 * Idempotent. A second call while already installed returns the same
 * dispose fn without duplicating subscriptions — matching the
 * convention used by `state/scans.js` and friends.
 *
 * When `cloudSync` is `false` at install time, this returns a no-op
 * dispose and registers nothing. The user can flip `cloudSync` on
 * later; the content-script bootstrap is expected to re-install the
 * scheduler in response to that settings change (the scheduler itself
 * doesn't subscribe to settings because the install/dispose lifecycle
 * is owned by the caller).
 *
 * @returns {() => void} Dispose fn: unsubscribes stores, removes the
 *   event listener, and clears the install handle. Idempotent.
 */
export const installSync = () => {
  if (installed) return installed.dispose;

  // Honour the opt-out. Returning a no-op (not throwing) means the
  // content-script bootstrap doesn't need to branch on cloudSync —
  // it can always call `installSync()` and pay at most one cheap
  // settings read for the decision.
  if (!settingsStore.get().cloudSync) {
    const noop = () => { installed = null; };
    installed = { dispose: noop };
    return noop;
  }

  // Per-universe tombstone keys — captured at install time so the
  // onStorageChange listener doesn't recompute them on every event.
  // `location.host` does not change for a tab's lifetime, so caching
  // is safe. Fallback to bare suffixes when `location` is undefined
  // (node tests) — production always has it because the manifest
  // restricts this module to game-origin tabs.
  const universeId =
    typeof location !== 'undefined' ? parseUniverseId(location.host) : '';
  // Fleet-save routes and per-universe settings both live per-universe in
  // the gist; this scheduler only ever touches its own universe's slot.
  routesUniverseId = universeId || '';

  // One-time seed of the global per-key settings timestamp map: stamp the
  // keys the user has already customised so a fresh device adopts them on
  // the first sync (see `seedSettingsTsIfAbsent`). No-op once a map exists.
  seedSettingsTsIfAbsent(settingsStore.get(), Date.now());

  // Load (or seed) the per-universe ts map into the in-memory cache.
  // `seedUniverseTsIfAbsent` returns the freshly-seeded map (first boot) or
  // null (already existed). When null, we fall back to a direct read so the
  // cache always ends up populated before the first downloadAndMerge runs.
  if (routesUniverseId) {
    void (async () => {
      /** @type {Record<string, number>} */
      let base;
      try {
        const seeded = await seedUniverseTsIfAbsent(
          routesUniverseId,
          settingsStore.get(),
          Date.now(),
        );
        base = seeded ?? (await readUniverseTsMap(routesUniverseId));
      } catch {
        // The seed WRITE can reject (chromeStore.set surfaces storage
        // failures) — the cache must still be populated from whatever a
        // plain read yields (reads degrade to empty, never reject).
        base = await readUniverseTsMap(routesUniverseId);
      }
      // Merge UNDER any stamps a user edit added during this async window: a
      // late `=` overwrite would revert that edit's fresh timestamp back to the
      // seed's stale value, letting an older remote win the next merge (C5).
      // The current in-memory map (already-stamped edits) wins per key.
      localUniverseTsMap = { ...base, ...localUniverseTsMap };
    })();
  }

  const onStoreChange = () => {
    // Re-check settings on every event: the user might have flipped
    // cloudSync off mid-session. We leave the subscription in place
    // (avoiding tear-down churn) and just skip scheduling.
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync })) return;
    scheduleUpload();
  };

  // Colony history still syncs (the histogram is cross-device). The player
  // roster does NOT (§4b — re-derived from the API per device), so that store
  // is no longer subscribed here.
  const unsubHistory = historyStore.subscribe(onStoreChange);
  // Galaxy scans are subscribed again, but ONLY the lifeform-discovery markers
  // ride along (see the `lfDiscoveryPerUniverse` slot) — the fat occupancy data
  // §4b removed is still never uploaded. A galaxy-browse therefore schedules an
  // upload that turns out to be a no-op; `gistIsCurrent` catches that before it
  // costs a request, so the extra wake-up is cheap and a discovery propagates
  // promptly instead of waiting for some unrelated store to change.
  const unsubScans = scansStore.subscribe(onStoreChange);
  // Colonization decisions: a send / checkTarget-refusal / colony / abandon
  // writes the decision log → schedule an upload (no stamping, so no anti-loop
  // flag — the `changed` guard + gistIsCurrent skip break the loop).
  const unsubDecisions = colonizeDecisionsStore.subscribe(onStoreChange);

  // Fleet-save routes: an in-game change (route pruning, set-collect-target)
  // flips dailyRunRoutesStore → schedule an upload. Skip sync-origin writes (those
  // carry a remote timestamp we must keep) and skip while cloudSync is off.
  // Dashboard edits (a different origin) instead arrive via the
  // `oge_syncRequestAt` tombstone handled in onStorageChange below.
  const onRoutesChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('dailyRunRoutes') }))
      return;
    scheduleUpload();
  };
  const unsubRoutes = dailyRunRoutesStore.subscribe(onRoutesChange);

  // Galaxy-Scan config: an in-game change (none today — edits happen in the
  // dashboard) flips the store → schedule an upload. Dashboard edits arrive
  // via the `oge_syncRequestAt` tombstone (onForceSync) like dailyRunRoutes; this
  // subscriber covers any future in-game writer and the sync-applied writes
  // (skipped via the anti-loop flag).
  const onGalaxyConfigChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('galaxyScanConfig') }))
      return;
    scheduleUpload();
  };
  const unsubGalaxyConfig = galaxyScanConfigStore.subscribe(onGalaxyConfigChange);

  // AlarmClock config: an in-game change flips the store → schedule an upload.
  // Dashboard edits arrive via the `oge_syncRequestAt` tombstone (onForceSync)
  // like the galaxy config; the sync-applied writes are skipped via the
  // anti-loop flag.
  const onAlarmClockConfigChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('alarmClockConfigPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubAlarmClockConfig = alarmClockConfigStore.subscribe(onAlarmClockConfigChange);

  // Watch-list: an in-game change (none today — all edits happen in the
  // dashboard, whose writes arrive via the `oge_syncRequestAt` tombstone like
  // the galaxy config) flips the store → schedule an upload. This subscriber
  // covers any future in-game writer; sync-applied writes are skipped via the
  // anti-loop flag (their ledger carries remote stamps that must be kept).
  const onWatchListChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('watchListPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubWatchList = watchListStore.subscribe(onWatchListChange);

  // Spyglass observations: an opened spy report (recordReport) or a galaxy
  // look at a watched/patrolled body (recordGalaxyActivity) flips its store →
  // schedule an upload; the 15-s debounce collapses a galaxy-scroll burst
  // (the store's own 200 ms persist debounce sits inside that window).
  // Sync-applied writes are skipped via the keyed anti-loop suppressors. The
  // players roster is deliberately NOT subscribed: it churns on every galaxy
  // scroll for ANY player, and name updates alone aren't worth a round —
  // playersLite rides along whenever a report/activity change (or anything
  // else) arms an upload.
  const onTargetReportsChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('targetReportsPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubTargetReports = targetReportsStore.subscribe(onTargetReportsChange);
  const onActivityObsChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('activityObsPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubActivityObs = activityObsStore.subscribe(onActivityObsChange);
  // Proximity alerts ("who's spying on you"): an opened alert flips the store →
  // schedule an upload. Sync-applied writes are skipped via the keyed suppressor.
  const onProximityChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('proximityReportsPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubProximity = proximityReportsStore.subscribe(onProximityChange);
  // Presence ledger: a debounced fold learned a new bit → schedule an upload
  // (the ledger only changes when a probe genuinely contributed, so this is
  // quieter than the ring subscriptions above).
  const onPresenceLedgerChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync('presenceLedgerPerUniverse') }))
      return;
    scheduleUpload();
  };
  const unsubPresenceLedger = presenceLedgerStore.subscribe(onPresenceLedgerChange);

  // Settings sync: stamp the keys that changed since the last tick with
  // `now`, then schedule an upload. The keyed suppressor (`'settings'`) skips
  // sync-origin writes (those carry remote timestamps we must keep), and
  // we also skip while cloudSync is off — but always advance `prev` so a
  // later edit diffs against the true last state, not a stale snapshot.
  //
  // Global and universe-scoped keys are stamped into separate timestamp maps:
  // - global → localStorage (sync read/write via readTsMap / writeTsMap)
  // - universe → in-memory localUniverseTsMap (async write-through to chromeStore)
  let prevSyncedSettings = pickSyncedValues(settingsStore.get());
  const onSettingsChange = () => {
    const next = pickSyncedValues(settingsStore.get());
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: isApplyingFromSync(APPLY_SETTINGS) })) {
      prevSyncedSettings = next;
      return;
    }
    const now = Date.now();

    // Global keys: sync stamp into localStorage ts map.
    const { ts: globalTs, changed: globalChanged } = stampChanged(
      pickSyncedValues(prevSyncedSettings, 'global'),
      pickSyncedValues(next, 'global'),
      readTsMap(),
      now,
    );

    // Universe-scoped keys: stamp into in-memory cache, async write-through.
    const { ts: uniTs, changed: uniChanged } = stampChanged(
      pickSyncedValues(prevSyncedSettings, 'universe'),
      pickSyncedValues(next, 'universe'),
      localUniverseTsMap,
      now,
    );

    prevSyncedSettings = next;

    if (globalChanged) writeTsMap(globalTs);
    if (uniChanged && routesUniverseId) {
      localUniverseTsMap = uniTs;
      void writeUniverseTsMap(routesUniverseId, uniTs);
    }
    if (globalChanged || uniChanged) scheduleUpload();
  };
  const unsubSettings = settingsStore.subscribe(onSettingsChange);

  // Coalesces overlapping force-syncs: a second SYNC_FORCE_EVENT while one
  // round is already waiting/running would reconcile the exact same state.
  let forceInFlight = false;
  const onForceSync = async () => {
    // A full UNCONDITIONAL round-trip (download THEN upload), back-to-back,
    // bypassing both the upload debounce and the boot gate. Two callers share
    // it: the user's explicit force-sync (settings "Sync now" / histogram
    // "Refresh") and the dashboard's `oge_syncRequestAt` tombstone — both are
    // deliberate "the data really changed, reconcile now" signals.
    if (forceInFlight) return;
    forceInFlight = true;
    try {
      // The shared inFlight lock may be held (a debounced upload, the boot
      // download). downloadAndMerge/upload SKIP when it is — so calling them
      // straight away would silently drop the user's explicit request. Wait
      // (bounded) for the lock to free instead; one-shot timers, not periodic
      // work, so no clock-bus obligation.
      const deadline = Date.now() + 30_000;
      while (inFlight && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!installed) return; // disposed while we waited
      await downloadAndMerge();
      await upload();
    } finally {
      forceInFlight = false;
    }
  };
  document.addEventListener(SYNC_FORCE_EVENT, onForceSync);

  // Daily-action state changes (rewarding done, trader bid/trade) — schedule
  // an upload so the updated state reaches the gist quickly.
  const onDailyStateChanged = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync })) return;
    scheduleUpload();
  };
  document.addEventListener(DAILY_STATE_CHANGED_EVENT, onDailyStateChanged);

  // Fleet-reminder changes (a landing armed by the producer, the fleet1 chip,
  // a guardian dismiss) — the FR store is a plain key-owner (no reactive
  // store), so its mutation sites announce via this DOM event; schedule an
  // upload so the change reaches the gist quickly. No anti-loop flag needed:
  // the slot's writeLocal is a plain slot write that dispatches nothing.
  const onFleetReminderChanged = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync })) return;
    scheduleUpload();
  };
  document.addEventListener(FLEET_REMINDER_CHANGED_EVENT, onFleetReminderChanged);

  const syncKey = universeId
    ? syncRequestKeyFor(universeId)
    : SYNC_REQUEST_KEY_BASE;
  const gistRevKey = gistRevKeyFor(routesUniverseId);

  /**
   * Bridge from the extension-origin histogram page to this scheduler.
   * The histogram writes `<universeId>:oge_syncRequestAt = Date.now()`
   * for the selected universe's "Sync now" button. chrome.storage.onChanged
   * fires in THIS origin (game), so we observe and act on the tombstones
   * whose key matches our universe — the histogram may have selected a
   * different server in the dropdown, in which case its tombstone has a
   * different prefix and we ignore it. (The old per-galaxy
   * `oge_resetGalaxyAt` reset tombstone is gone with the Scanned-data
   * accordion — the API TTL supersedes manual purges; stale keys from old
   * installs are inert and classified as plumbing by syncInventory.)
   *
   * @param {Record<string, unknown>} changes
   */
  const onStorageChange = (changes) => {
    if (syncKey in changes) {
      void onForceSync();
    }
    // Same-machine beacon: a sibling tab of this universe (or the dashboard, via
    // the game tab it signalled) PATCHed the gist. Pull iff the beacon moved
    // PAST what THIS tab has applied — a download-only reaction, no PATCH, so it
    // can't ping-pong. The tab that wrote the beacon set its applied-rev first,
    // so its own onChanged falls through here.
    if (gistRevKey in changes) {
      const raw = /** @type {{ newValue?: unknown }} */ (changes[gistRevKey]).newValue;
      const rev = typeof raw === 'string' ? raw : '';
      if (rev && rev !== readAppliedRev()) void downloadAndMerge();
    }
  };
  const unsubStorage = chromeStore.onChanged(onStorageChange);

  // Boot, fire-and-forget (we don't await — the bootstrap mustn't block on the
  // network). GATED, not unconditional (see file header "# Boot"):
  //   - DOWNLOAD only when shouldDownloadOnLoad says we might be behind (fresh
  //     tab / same-machine peer ahead via the beacon / long-enough gap that
  //     another device may have played). A plain mid-session navigation skips it
  //     — single-session means the gist can't have changed under us.
  //   - UPLOAD only when the catch-up dirty flag is set, i.e. a local write's
  //     debounce was killed by a post-send reload. `upload()` still self-skips
  //     via gistIsCurrent, so a stranded flag with already-synced data is cheap.
  // We stamp LAST_ACTIVE_KEY with now AFTER reading the old value for the gap.
  //
  // Fire-and-forget, and already OFF the synchronous boot path by construction:
  // the very first statement here is an `await` (chrome.storage), and the round's
  // heavy work — gzip decode, the payload JSON.parse, the per-slot merges — runs
  // only in the continuation AFTER `fetchGistData()`'s network round-trip
  // resolves, hundreds of ms later, never during the game's startup burst. (The
  // apiContext build, which DOES do MB-scale synchronous work at install, is the
  // one that's idle-deferred — see features/apiContext.)
  void (async () => {
    const beaconRev = /** @type {string} */ ((await chromeStore.get(gistRevKey)) || '');
    const now = Date.now();
    const lastActiveAt = safeLS.int(LAST_ACTIVE_KEY, 0);
    safeLS.set(LAST_ACTIVE_KEY, String(now));
    if (
      shouldDownloadOnLoad({
        appliedRev: readAppliedRev(),
        beaconRev,
        lastActiveAt,
        now,
        sessionGapMs: SESSION_GAP_MS,
      })
    ) {
      await downloadAndMerge();
    }
    if (safeLS.get(UPLOAD_PENDING_KEY)) await upload();
  })();

  installed = {
    dispose: () => {
      unsubHistory();
      unsubScans();
      unsubDecisions();
      unsubSettings();
      unsubRoutes();
      unsubGalaxyConfig();
      unsubAlarmClockConfig();
      unsubWatchList();
      unsubTargetReports();
      unsubActivityObs();
      unsubProximity();
      unsubPresenceLedger();
      document.removeEventListener(SYNC_FORCE_EVENT, onForceSync);
      document.removeEventListener(DAILY_STATE_CHANGED_EVENT, onDailyStateChanged);
      document.removeEventListener(FLEET_REMINDER_CHANGED_EVENT, onFleetReminderChanged);
      unsubStorage();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Reset module-local state so tests can exercise a clean install/
 * dispose cycle without bleeding across cases.
 *
 * NOT part of the public API. The leading underscore is a hard signal
 * — feature code must never call this. Resets both the install handle
 * (disposing first if currently installed) and the in-flight lock.
 *
 * @returns {void}
 */
export const _resetSchedulerForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  inFlight = false;
  applyDepth.clear();
  routesUniverseId = '';
  localUniverseTsMap = {};
  // Boot-gate state lives in local/session storage, not module scope — clear it
  // too so a fresh install in the next case starts from "never synced".
  safeLS.remove(UPLOAD_PENDING_KEY);
  safeLS.remove(LAST_ACTIVE_KEY);
  writeAppliedRev('');
};
