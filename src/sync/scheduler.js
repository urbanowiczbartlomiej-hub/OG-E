// Sync scheduler — orchestrates local stores ↔ remote gist under one lock.
//
// # Role
//
// This is the glue that turns three independently-useful primitives —
// {@link scansStore}/{@link historyStore} (local state),
// {@link mergeScans}/{@link mergeHistory} (pure reconcilers), and the
// {@link fetchGistData}/{@link writeGistData} gist client — into a
// working cross-device sync round-trip. Every other sync module is
// stateless; this one owns the timers, the in-flight lock, and the
// store/event subscriptions that drive it.
//
// # Why a 15-second debounce
//
// OGame's galaxy page emits a burst of scans whenever the user scrolls
// — one XHR per system, potentially a dozen in a few seconds. Each
// scan flips {@link scansStore}, which on its own would queue an
// upload. Without debouncing we'd burn ~12 GitHub API requests to sync
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
// feature that reacts to scans / history updates), and — crucially
// — by US: any write to {@link scansStore} or {@link historyStore}
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
import { normalizeGalaxyScanConfig } from '../domain/galaxyScanConfig.js';
import { normalizeAlarmClockConfig } from '../domain/alarmClockConfig.js';
import {
  mergeHistory,
  mergeSettings,
  mergeDailyRunRoutes,
  mergeDailyState,
  mergeManualLandedFs,
  mergeGalaxyScanConfig,
  mergeAlarmClockConfig,
  mergeColonizeDecisions,
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
import { readManualLandedFsSlot, writeManualLandedFsSlot } from '../state/manualLandedFs.js';
import { SYNC_FORCE_EVENT, DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';
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
 * localStorage dirty flag: set whenever an upload is armed, cleared when one
 * completes. The on-load catch-up upload runs ONLY when this is set, so a plain
 * navigation with nothing pending does ZERO requests — while a `sent`/`taken`
 * decision whose 15-s debounce was killed by OGame's post-send reload still
 * gets flushed on the next load (the case the boot upload exists for).
 */
const UPLOAD_PENDING_KEY = 'oge_uploadPending';

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
  const fallback = () => ({ config: galaxyScanConfigStore.get(), updatedAt: 0 });
  if (!routesUniverseId) return fallback();
  const [raw, ts] = await Promise.all([
    chromeStore.get(galaxyScanConfigKeyFor(routesUniverseId)),
    chromeStore.get(galaxyScanConfigTsKeyFor(routesUniverseId)),
  ]);
  const config = raw === null || raw === undefined
    ? galaxyScanConfigStore.get()
    : normalizeGalaxyScanConfig(raw);
  return { config, updatedAt: typeof ts === 'number' ? ts : 0 };
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
 * `writeLocal` adopts a newer remote slot into local stores; the three config
 * entities guard that write with the keyed anti-loop suppressor (inside their
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
    merge: mergeGalaxyScanConfig,
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
    payloadKey: 'manualLandedFsPerUniverse',
    readLocal: readManualLandedFsSlot,
    writeLocal: writeManualLandedFsSlot,
    merge: mergeManualLandedFs,
    // Keep an empty set with a non-zero updatedAt — it's the removal tombstone
    // that lets an unmark / re-save propagate cross-device (last-writer-wins).
    hasData: (merged) => (merged.updatedAt || 0) > 0,
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

    // Galaxy scans, the player roster, and our own profile are NO LONGER
    // synced (§4b): occupancy + neighbour status/rank are re-derived from the
    // OGame public API per device, and our rank is re-scraped from the header
    // each load. Only the colonization DECISION log (below) carries
    // cross-device colonization state now — the rest stays local.
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
        if (changed) await s.writeLocal(merged);
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
      galaxyScanConfig: slotPayloads.galaxyScanConfig,
      alarmClockConfigPerUniverse: slotPayloads.alarmClockConfigPerUniverse,
      colonizeDecisionsPerUniverse: slotPayloads.colonizeDecisionsPerUniverse,
      manualLandedFsPerUniverse: slotPayloads.manualLandedFsPerUniverse,
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
    // dirty flag so the next boot doesn't re-push. Left intact on the error path
    // (outer catch) so a failed flush retries on the next load.
    safeLS.remove(UPLOAD_PENDING_KEY);
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
  safeLS.set(UPLOAD_PENDING_KEY, '1');
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
    const noop = () => {};
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
      const seeded = await seedUniverseTsIfAbsent(
        routesUniverseId,
        settingsStore.get(),
        Date.now(),
      );
      // Merge UNDER any stamps a user edit added during this async window: a
      // late `=` overwrite would revert that edit's fresh timestamp back to the
      // seed's stale value, letting an older remote win the next merge (C5).
      // The current in-memory map (already-stamped edits) wins per key.
      const base = seeded ?? (await readUniverseTsMap(routesUniverseId));
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

  // Colony history still syncs (the histogram is cross-device). Galaxy scans
  // and the player roster do NOT (§4b — re-derived from the API per device), so
  // their stores are no longer subscribed here.
  const unsubHistory = historyStore.subscribe(onStoreChange);
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

  const onForceSync = async () => {
    // A full UNCONDITIONAL round-trip (download THEN upload), back-to-back,
    // bypassing both the upload debounce and the boot gate. Two callers share
    // it: the user's explicit force-sync (settings "Sync now" / histogram
    // "Refresh") and the dashboard's `oge_syncRequestAt` tombstone — both are
    // deliberate "the data really changed, reconcile now" signals. Each
    // operation has its own in-flight guard; they serialise via the shared lock,
    // and each self-skips when cloudSync is off / no token / already current.
    await downloadAndMerge();
    await upload();
  };
  document.addEventListener(SYNC_FORCE_EVENT, onForceSync);

  // Daily-action state changes (rewarding done, trader bid/trade) — schedule
  // an upload so the updated state reaches the gist quickly.
  const onDailyStateChanged = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync })) return;
    scheduleUpload();
  };
  document.addEventListener(DAILY_STATE_CHANGED_EVENT, onDailyStateChanged);

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
      unsubDecisions();
      unsubSettings();
      unsubRoutes();
      unsubGalaxyConfig();
      unsubAlarmClockConfig();
      document.removeEventListener(SYNC_FORCE_EVENT, onForceSync);
      document.removeEventListener(DAILY_STATE_CHANGED_EVENT, onDailyStateChanged);
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
