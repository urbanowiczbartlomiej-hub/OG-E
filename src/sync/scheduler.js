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
// # Initial boot — download THEN catch-up upload
//
// On install we fire exactly one full round-trip (download + upload, fire-and-
// forget, we don't await). The download catches this device up with whatever
// another device uploaded while we were offline. The trailing upload is the
// catch-up PUSH: OGame force-reloads the page after every fleet send, which
// destroys the JS context — and with it any 15-s debounced upload still
// pending for the decision that very send just wrote. So a `sent`/`taken`
// decision can land in chrome.storage (flushed synchronously) yet never reach
// the gist, because its upload timer died with the page. Pushing once right
// after the boot download guarantees such a stranded write leaves on the next
// page load instead of waiting for a fragile 15-s idle window. `upload()` self-
// skips via `gistIsCurrent` when local + gist already agree, so a fully-synced
// boot pays at most one extra no-op GET. Local writes that happen DURING the
// boot round-trip are still safe — the lock serialises them and each upload
// pre-merges with remote at its own call site.
//
// # Periodic backstop
//
// Downloads otherwise happen only on boot / force-sync, so a tab left OPEN never
// learns of another device's changes. A visibility-gated `clock` DOWNLOAD every
// {@link PERIODIC_SYNC_MS} closes that gap. It is download-ONLY on purpose:
// uploads are covered by the on-install catch-up push + the store-change
// debounce, so the backstop never PATCHes — which keeps an idle tab quiet and,
// crucially, stops it ping-ponging with another open device (a download can't
// change the gist, so it can't trigger the peer's "remote changed → upload";
// the earlier 60 s full round-trip did exactly that and two open devices burned
// the 5000 req/h quota). It pauses while hidden, and fires once on regaining
// visibility — throttled to one run per interval so rapid tab-switching can't
// burst requests — so refocusing a stale tab pulls immediately.
//
// @ts-check

/* global document */

import { scansStore } from '../state/scans.js';
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
  reminderConfigStore,
  reminderConfigKeyFor,
  reminderConfigTsKeyFor,
} from '../state/reminderConfig.js';
import { parseDailyRunRoutes } from '../domain/dailyRunRoutes.js';
import { normalizeGalaxyScanConfig } from '../domain/galaxyScanConfig.js';
import { normalizeReminderConfig } from '../domain/reminderConfig.js';
import {
  mergeHistory,
  mergeSettings,
  mergeDailyRunRoutes,
  mergeDailyState,
  mergeGalaxyScanConfig,
  mergeReminderConfig,
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
import { clock } from '../lib/clock.js';
import { chromeStore } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';
import { readDailyState, writeDailyState } from '../state/dailyActions.js';
import { SYNC_FORCE_EVENT, DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';
import {
  canStartSync,
  shouldScheduleUpload,
  slotHasData,
  dailyStateHasData,
  galaxyConfigSlotHasData,
  reminderConfigSlotHasData,
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

/**
 * Per-galaxy reset tombstone suffix. Value is `"<galaxy>:<timestamp>"`
 * so two resets of the same galaxy back-to-back register as distinct
 * changes (chrome.storage.onChanged only fires when the value actually
 * changes).
 */
const RESET_GALAXY_KEY_BASE = 'oge_resetGalaxyAt';

/** @param {string} universeId */
export const syncRequestKeyFor = (universeId) =>
  `${universeId}:${SYNC_REQUEST_KEY_BASE}`;
/** @param {string} universeId */
export const resetGalaxyKeyFor = (universeId) =>
  `${universeId}:${RESET_GALAXY_KEY_BASE}`;

/**
 * Quiet-period length (ms) for {@link scheduleUpload}. See file header
 * for the 15-second rationale (burst-coalesce vs cross-device freshness
 * trade-off).
 */
const DEBOUNCE_MS = 15_000;

/**
 * Cadence (ms) of the periodic backstop — a clock-driven DOWNLOAD that pulls a
 * peer device's changes into an already-open tab. Deliberately a download, NOT a
 * round-trip: uploads are already covered by the on-install catch-up push and
 * the store-change debounce, so the backstop never PATCHes. That keeps an idle
 * tab quiet (one GET per interval, nothing while hidden) AND — crucially — means
 * it can't ping-pong with another open device, because a download doesn't change
 * the gist, so it can never trigger the peer's "remote changed → upload" (the
 * earlier 60 s full round-trip DID, and two open devices burned the 5000 req/h
 * quota between them). Five minutes is a fine staleness bound for cross-device
 * continuation; the clock's fire-on-visibility-regain still pulls immediately
 * when you return to the tab.
 */
const PERIODIC_SYNC_MS = 5 * 60 * 1000;

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
 * Anti-loop flag for SETTINGS sync, mirroring the scans/history
 * `changed`-guard at the value level. Raised while we write merged remote
 * settings back into {@link settingsStore} (in {@link applyMergedSettings})
 * so the settings subscriber installed by {@link installSync} doesn't
 * re-stamp those keys with `now` (which would clobber the remote
 * timestamps) or schedule a redundant upload.
 */
let applyingSettingsFromSync = false;

/**
 * The universe id this scheduler instance owns (from `location.host`),
 * captured in {@link installSync}. Fleet-save routes are per-universe, so
 * sync only ever touches THIS universe's slot in the gist's `dailyRunRoutes` map.
 * Empty string in non-DOM tests / when the host isn't a known universe.
 */
let routesUniverseId = '';

/**
 * Anti-loop flag for ROUTES sync, mirroring {@link applyingSettingsFromSync}.
 * Raised while we write a merged remote routes slot back into chrome.storage
 * + {@link dailyRunRoutesStore} so the dailyRunRoutes subscriber doesn't re-stamp the
 * change and schedule a redundant upload.
 */
let applyingRoutesFromSync = false;

/**
 * Anti-loop flag for GALAXY-SCAN CONFIG sync, mirroring
 * {@link applyingRoutesFromSync}. Raised while we write a merged remote
 * config slot back into chrome.storage + {@link galaxyScanConfigStore} so the
 * config subscriber doesn't re-stamp and schedule a redundant upload.
 */
let applyingGalaxyConfigFromSync = false;

/**
 * Anti-loop flag for REMINDER CONFIG sync, mirroring
 * {@link applyingGalaxyConfigFromSync}. Raised while we write a merged remote
 * config slot back into chrome.storage + {@link reminderConfigStore} so the
 * config subscriber doesn't re-stamp and schedule a redundant upload.
 */
let applyingReminderConfigFromSync = false;

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
  if (!routesUniverseId) return { routes: [], collectTarget: null, updatedAt: 0 };
  const [raw, ts] = await Promise.all([
    chromeStore.get(dailyRunRoutesKeyFor(routesUniverseId)),
    chromeStore.get(dailyRunRoutesTsKeyFor(routesUniverseId)),
  ]);
  const { routes, collectTarget } = parseDailyRunRoutes(raw);
  return { routes, collectTarget, updatedAt: typeof ts === 'number' ? ts : 0 };
};

/**
 * Write a merged remote routes slot back to local: the routes value + its
 * timestamp into chrome.storage, and the in-memory {@link dailyRunRoutesStore} so
 * the current game session reflects the adopted config without a reload.
 * Guarded by {@link applyingRoutesFromSync} so the dailyRunRoutes subscriber treats
 * it as a sync-origin write (no re-stamp, no upload reschedule).
 *
 * @param {import('./merge.js').DailyRunRoutesSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalRoutesSlot = async (slot) => {
  if (!routesUniverseId) return;
  applyingRoutesFromSync = true;
  try {
    await chromeStore.set(dailyRunRoutesKeyFor(routesUniverseId), {
      routes: slot.routes,
      collectTarget: slot.collectTarget,
    });
    await chromeStore.set(dailyRunRoutesTsKeyFor(routesUniverseId), slot.updatedAt);
    dailyRunRoutesStore.set(
      /** @type {import('../state/dailyRunRoutes.js').DailyRunRoutes} */ ({
        routes: slot.routes,
        collectTarget: slot.collectTarget,
      }),
    );
  } finally {
    applyingRoutesFromSync = false;
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
 * adopted config without a reload. Guarded by
 * {@link applyingGalaxyConfigFromSync}.
 *
 * @param {import('./merge.js').GalaxyScanConfigSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalGalaxyConfigSlot = async (slot) => {
  if (!routesUniverseId) return;
  applyingGalaxyConfigFromSync = true;
  try {
    const config = normalizeGalaxyScanConfig(slot.config);
    await chromeStore.set(galaxyScanConfigKeyFor(routesUniverseId), config);
    await chromeStore.set(galaxyScanConfigTsKeyFor(routesUniverseId), slot.updatedAt);
    galaxyScanConfigStore.set(config);
  } finally {
    applyingGalaxyConfigFromSync = false;
  }
};

/**
 * Read this universe's local reminder config slot from chrome.storage — NOT
 * from {@link reminderConfigStore} in memory (same cross-origin reason as
 * {@link readLocalGalaxyConfigSlot}: the dashboard edits a different origin).
 * The raw value is normalised so a partial/legacy blob still yields a complete
 * config. `updatedAt` comes from the separate per-universe timestamp key.
 *
 * @returns {Promise<import('./merge.js').ReminderConfigSlot>}
 */
const readLocalReminderConfigSlot = async () => {
  const fallback = () => ({ config: reminderConfigStore.get(), updatedAt: 0 });
  if (!routesUniverseId) return fallback();
  const [raw, ts] = await Promise.all([
    chromeStore.get(reminderConfigKeyFor(routesUniverseId)),
    chromeStore.get(reminderConfigTsKeyFor(routesUniverseId)),
  ]);
  const config = raw === null || raw === undefined
    ? reminderConfigStore.get()
    : normalizeReminderConfig(raw);
  return { config, updatedAt: typeof ts === 'number' ? ts : 0 };
};

/**
 * Write a merged remote reminder config slot back to local: the config value +
 * its timestamp into chrome.storage, and the in-memory
 * {@link reminderConfigStore} so the current game session reflects the adopted
 * config without a reload. Guarded by {@link applyingReminderConfigFromSync}.
 *
 * @param {import('./merge.js').ReminderConfigSlot} slot
 * @returns {Promise<void>}
 */
const writeLocalReminderConfigSlot = async (slot) => {
  if (!routesUniverseId) return;
  applyingReminderConfigFromSync = true;
  try {
    const config = normalizeReminderConfig(slot.config);
    await chromeStore.set(reminderConfigKeyFor(routesUniverseId), config);
    await chromeStore.set(reminderConfigTsKeyFor(routesUniverseId), slot.updatedAt);
    reminderConfigStore.set(config);
  } finally {
    applyingReminderConfigFromSync = false;
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
 * values into {@link settingsStore}. Guarded by
 * {@link applyingSettingsFromSync} so our own settings subscriber treats
 * this as a sync-origin write, not a user edit.
 *
 * @param {{ values: Record<string, unknown>, ts: Record<string, number> }} merged
 * @returns {Promise<void>}
 */
const writeLocalUniverseSettingsSlot = async (merged) => {
  if (!routesUniverseId) return;
  applyingSettingsFromSync = true;
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
    applyingSettingsFromSync = false;
  }
};

/**
 * Write a merged settings result back to local: persist the per-key ts map
 * and apply the values to {@link settingsStore} (excluded keys, absent from
 * `merged.values`, keep their current local value). Guarded by
 * {@link applyingSettingsFromSync} so our own settings subscriber treats
 * this as a sync-origin write, not a user edit.
 *
 * @param {{ values: Record<string, unknown>, ts: Record<string, number> }} merged
 * @returns {void}
 */
const applyMergedSettings = (merged) => {
  applyingSettingsFromSync = true;
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
    applyingSettingsFromSync = false;
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

    // Routes: per-universe newest-wins. Read local from chrome.storage (the
    // cross-origin source of truth) and adopt remote only when it's newer.
    const routesResult = mergeDailyRunRoutes(
      await readLocalRoutesSlot(),
      remote.dailyRunRoutes?.[routesUniverseId],
    );
    if (routesResult.changed) await writeLocalRoutesSlot(routesResult.merged);

    // Galaxy-Scan config: per-universe newest-wins, same shape as routes.
    if (routesUniverseId) {
      const cfgResult = mergeGalaxyScanConfig(
        await readLocalGalaxyConfigSlot(),
        remote.galaxyScanConfig?.[routesUniverseId],
      );
      if (cfgResult.changed) await writeLocalGalaxyConfigSlot(cfgResult.merged);
    }

    // Colony history: per-universe union (dedup by cp), keyed by universe — the
    // histogram is per-server, so the old single global list let one server's
    // observations land under another server's key on a second device.
    if (routesUniverseId) {
      const histResult = mergeHistory(
        historyStore.get(),
        remote.colonyHistoryPerUniverse?.[routesUniverseId],
      );
      if (histResult.changed) historyStore.set(histResult.merged);
    }

    // Daily-action state: per-universe, field-by-field max-wins.
    if (routesUniverseId) {
      const dailyResult = mergeDailyState(
        readDailyState(),
        remote.dailyStatePerUniverse?.[routesUniverseId],
      );
      if (dailyResult.changed) writeDailyState(dailyResult.merged);
    }

    // Reminder config: per-universe newest-wins, same shape as routes.
    if (routesUniverseId) {
      const remCfgResult = mergeReminderConfig(
        await readLocalReminderConfigSlot(),
        remote.reminderConfigPerUniverse?.[routesUniverseId],
      );
      if (remCfgResult.changed) await writeLocalReminderConfigSlot(remCfgResult.merged);
    }

    // Colonization decisions: per-universe, per-coord monotonic merge. Like
    // scans/players it needs no `applying*FromSync` flag — there's no timestamp
    // to re-stamp, so the `changed` guard plus the gistIsCurrent skip on the
    // follow-up upload break the loop. This is the cross-device handoff that
    // lets a second device continue with only the remaining free positions.
    if (routesUniverseId) {
      const decResult = mergeColonizeDecisions(
        colonizeDecisionsStore.get(),
        remote.colonizeDecisionsPerUniverse?.[routesUniverseId] ?? {},
      );
      if (decResult.changed) colonizeDecisionsStore.set(decResult.merged);
    }

    setStatus('down', new Date().toISOString());
    setStatus('err', null);
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

    // Routes: per-universe newest-wins. Adopt remote locally if newer, then
    // build the merged `dailyRunRoutes` map for the payload — PRESERVING every
    // OTHER universe's slot (we only own ours).
    const routesResult = mergeDailyRunRoutes(
      await readLocalRoutesSlot(),
      remote?.dailyRunRoutes?.[routesUniverseId],
    );
    if (routesResult.changed) await writeLocalRoutesSlot(routesResult.merged);
    const mergedDailyRunRoutes = { ...(remote?.dailyRunRoutes || {}) };
    // Only contribute our universe's slot when it actually carries data —
    // a never-configured universe (no routes, no target, ts 0) must NOT
    // write an empty slot, which would differ from the gist's absent field
    // and force a perpetual no-op PATCH.
    const slot = routesResult.merged;
    if (routesUniverseId && slotHasData(slot)) mergedDailyRunRoutes[routesUniverseId] = slot;
    // Normalise an empty map to `undefined` so a gist with no dailyRunRoutes field
    // and our empty map compare equal (sameJSON(undefined, {}) is false) —
    // otherwise we'd PATCH a no-op `dailyRunRoutes: {}` onto every upload.
    const mergedDailyRunRoutesOut = Object.keys(mergedDailyRunRoutes).length ? mergedDailyRunRoutes : undefined;

    // Galaxy-Scan config: per-universe newest-wins, same contribution guard
    // as dailyRunRoutes (only our universe's slot, only once it carries data).
    const mergedGalaxyConfig = { ...(remote?.galaxyScanConfig || {}) };
    if (routesUniverseId) {
      const cfgResult = mergeGalaxyScanConfig(
        await readLocalGalaxyConfigSlot(),
        remote?.galaxyScanConfig?.[routesUniverseId],
      );
      if (cfgResult.changed) await writeLocalGalaxyConfigSlot(cfgResult.merged);
      if (galaxyConfigSlotHasData(cfgResult.merged)) {
        mergedGalaxyConfig[routesUniverseId] = cfgResult.merged;
      }
    }
    const mergedGalaxyConfigOut = Object.keys(mergedGalaxyConfig).length
      ? mergedGalaxyConfig
      : undefined;

    // Colony history: per-universe union (dedup by cp), same contribution
    // guard as the config slots (only our universe's list, only once it has
    // entries — an empty list would differ from the gist's absent field).
    const mergedColonyHistory = { ...(remote?.colonyHistoryPerUniverse || {}) };
    if (routesUniverseId) {
      const histResult = mergeHistory(
        historyStore.get(),
        remote?.colonyHistoryPerUniverse?.[routesUniverseId],
      );
      if (histResult.changed) historyStore.set(histResult.merged);
      if (histResult.merged.length) mergedColonyHistory[routesUniverseId] = histResult.merged;
    }
    const mergedColonyHistoryOut = Object.keys(mergedColonyHistory).length
      ? mergedColonyHistory
      : undefined;

    // Build the per-universe settings map for the payload — preserving every
    // OTHER universe's slot (same pattern as dailyRunRoutes). Only contribute ours
    // when the ts map is non-empty: an empty ts means the user has never
    // explicitly changed any universe-scoped setting (all at defaults), which
    // is indistinguishable from "no slot" for another device and must not
    // force a perpetual no-op PATCH.
    const mergedPerUniverse = { ...(remote?.settingsPerUniverse || {}) };
    if (routesUniverseId && Object.keys(uniResult.merged.ts).length > 0) {
      mergedPerUniverse[routesUniverseId] = uniResult.merged;
    }
    const mergedPerUniverseOut = Object.keys(mergedPerUniverse).length
      ? mergedPerUniverse
      : undefined;

    // Daily-action state: per-universe, field-by-field max-wins. Only
    // contribute our universe's slot when at least one field is non-empty —
    // same no-op PATCH guard as dailyRunRoutes / settingsPerUniverse.
    const mergedDailyPerUniverse = { ...(remote?.dailyStatePerUniverse || {}) };
    if (routesUniverseId) {
      const dailyResult = mergeDailyState(
        readDailyState(),
        remote?.dailyStatePerUniverse?.[routesUniverseId],
      );
      if (dailyResult.changed) writeDailyState(dailyResult.merged);
      const ds = dailyResult.merged;
      if (dailyStateHasData(ds)) mergedDailyPerUniverse[routesUniverseId] = ds;
    }
    const mergedDailyPerUniverseOut = Object.keys(mergedDailyPerUniverse).length
      ? mergedDailyPerUniverse
      : undefined;

    // Reminder config: per-universe newest-wins, same contribution guard as
    // galaxyScanConfig (only our universe's slot, only once it carries data).
    const mergedReminderConfig = { ...(remote?.reminderConfigPerUniverse || {}) };
    if (routesUniverseId) {
      const remCfgResult = mergeReminderConfig(
        await readLocalReminderConfigSlot(),
        remote?.reminderConfigPerUniverse?.[routesUniverseId],
      );
      if (remCfgResult.changed) await writeLocalReminderConfigSlot(remCfgResult.merged);
      if (reminderConfigSlotHasData(remCfgResult.merged)) {
        mergedReminderConfig[routesUniverseId] = remCfgResult.merged;
      }
    }
    const mergedReminderConfigOut = Object.keys(mergedReminderConfig).length
      ? mergedReminderConfig
      : undefined;

    // Colonization decisions: per-universe, per-coord monotonic merge. Preserve
    // every OTHER universe's slot; contribute ours only when it carries data.
    const mergedDecisions = { ...(remote?.colonizeDecisionsPerUniverse || {}) };
    if (routesUniverseId) {
      const decResult = mergeColonizeDecisions(
        colonizeDecisionsStore.get(),
        remote?.colonizeDecisionsPerUniverse?.[routesUniverseId] ?? {},
      );
      if (decResult.changed) colonizeDecisionsStore.set(decResult.merged);
      if (decisionsSlotHasData(decResult.merged)) {
        mergedDecisions[routesUniverseId] = decResult.merged;
      }
    }
    const mergedDecisionsOut = Object.keys(mergedDecisions).length ? mergedDecisions : undefined;

    // Skip the PATCH when the gist already matches the merged state.
    // This is the common case when upload fires right after a download
    // from another device and both sides already agree — PATCHing
    // anyway would burn a request and produce a no-op revision.
    if (
      // galaxyScansPerUniverse / playersPerUniverse / ownProfilePerUniverse are
      // intentionally OMITTED (left `undefined`) — §4b stopped syncing them.
      // gistIsCurrent still compares them, so a gist that still carries those
      // (a pre-slim or old-client upload) reads "not current" against our
      // `undefined` and gets slimmed by this one PATCH.
      !gistIsCurrent(remote, {
        colonyHistoryPerUniverse: mergedColonyHistoryOut,
        settings: setResult.merged,
        dailyRunRoutes: mergedDailyRunRoutesOut,
        settingsPerUniverse: mergedPerUniverseOut,
        dailyStatePerUniverse: mergedDailyPerUniverseOut,
        galaxyScanConfig: mergedGalaxyConfigOut,
        reminderConfigPerUniverse: mergedReminderConfigOut,
        colonizeDecisionsPerUniverse: mergedDecisionsOut,
      })
    ) {
      await writeGistData({
        version: 1,
        updatedAt: new Date().toISOString(),
        colonyHistoryPerUniverse: mergedColonyHistoryOut,
        settings: setResult.merged,
        dailyRunRoutes: mergedDailyRunRoutesOut,
        settingsPerUniverse: mergedPerUniverseOut,
        dailyStatePerUniverse: mergedDailyPerUniverseOut,
        galaxyScanConfig: mergedGalaxyConfigOut,
        reminderConfigPerUniverse: mergedReminderConfigOut,
        colonizeDecisionsPerUniverse: mergedDecisionsOut,
      });
      setStatus('up', new Date().toISOString());
    }
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
const scheduleUpload = debounce(() => {
  // `void` the promise so tsc doesn't complain about an unhandled
  // PromiseLike. The function's own try/catch owns error reporting.
  void upload();
}, DEBOUNCE_MS);

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
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: applyingRoutesFromSync }))
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
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: applyingGalaxyConfigFromSync }))
      return;
    scheduleUpload();
  };
  const unsubGalaxyConfig = galaxyScanConfigStore.subscribe(onGalaxyConfigChange);

  // Reminder config: an in-game change flips the store → schedule an upload.
  // Dashboard edits arrive via the `oge_syncRequestAt` tombstone (onForceSync)
  // like the galaxy config; the sync-applied writes are skipped via the
  // anti-loop flag.
  const onReminderConfigChange = () => {
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: applyingReminderConfigFromSync }))
      return;
    scheduleUpload();
  };
  const unsubReminderConfig = reminderConfigStore.subscribe(onReminderConfigChange);

  // Settings sync: stamp the keys that changed since the last tick with
  // `now`, then schedule an upload. `applyingSettingsFromSync` skips
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
    if (!shouldScheduleUpload({ cloudSync: settingsStore.get().cloudSync, applying: applyingSettingsFromSync })) {
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
    // A full round-trip (download THEN upload), back-to-back, bypassing the
    // upload debounce. THREE callers share it: the user's explicit force-sync
    // (settings "Sync now" / histogram "Refresh"), the on-install catch-up kick
    // (A), and the periodic clock backstop (B). Each operation has its own
    // in-flight guard; they serialise naturally via the shared lock, and each
    // self-skips when cloudSync is off / no token / already current.
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
  const resetKey = universeId
    ? resetGalaxyKeyFor(universeId)
    : RESET_GALAXY_KEY_BASE;

  /**
   * Bridge from the extension-origin histogram page to this scheduler.
   * The histogram writes `<universeId>:oge_syncRequestAt = Date.now()`
   * for the selected universe's "Sync now" button and
   * `<universeId>:oge_resetGalaxyAt = "<galaxy>:<ts>"` for a per-galaxy
   * "Reset" button. chrome.storage.onChanged fires in THIS origin
   * (game), so we observe and act on the tombstones whose key matches
   * our universe — the histogram may have selected a different server
   * in the dropdown, in which case its tombstone has a different prefix
   * and we ignore it.
   *
   * @param {Record<string, unknown>} changes
   */
  const onStorageChange = (changes) => {
    if (syncKey in changes) {
      void onForceSync();
    }
    if (resetKey in changes) {
      // Value shape is `"<galaxy>:<timestamp>"`; we only care about the
      // galaxy id. Bad parses fall through silently — a corrupt
      // tombstone shouldn't take down the listener for the next one.
      const raw = /** @type {{ newValue?: unknown }} */ (
        changes[resetKey]
      ).newValue;
      const str = typeof raw === 'string' ? raw : '';
      const galaxy = parseInt(str.split(':')[0], 10);
      if (Number.isFinite(galaxy) && galaxy > 0) {
        // Drop the galaxy from scansStore IN MEMORY (+ its write-through to
        // chrome.storage). Galaxy scans are no longer synced (§4b), so this is
        // now a purely LOCAL reset — there is no gist slot to wipe (and the old
        // gist-clear path would have overwritten the gist with only the
        // scans/history fields, dropping every other slice; removing it fixes
        // that latent bug too).
        const current = scansStore.get();
        const prefix = galaxy + ':';
        /** @type {typeof current} */
        const filtered = {};
        for (const key of /** @type {(keyof typeof current)[]} */ (
          Object.keys(current)
        )) {
          if (!key.startsWith(prefix)) filtered[key] = current[key];
        }
        if (Object.keys(filtered).length !== Object.keys(current).length) {
          scansStore.set(filtered);
        }
      }
    }
  };
  const unsubStorage = chromeStore.onChanged(onStorageChange);

  // Kick off the initial round-trip fire-and-forget (download THEN upload). We
  // do not await — the content-script bootstrap shouldn't block on the network.
  // The trailing upload is the catch-up push (A): a decision written on a prior
  // page whose 15-s debounced upload was killed by the game's forced post-send
  // reload would otherwise sit unsynced until the next chance 15 s idle window;
  // pushing right after the initial download guarantees it leaves on THIS page
  // load. `upload()` self-skips via gistIsCurrent when local + gist already
  // agree, so this adds at most one no-op GET on a fully-synced load.
  void onForceSync();

  // Periodic backstop (B): a visibility-gated clock DOWNLOAD every
  // PERIODIC_SYNC_MS pulls a peer's changes into an ALREADY-OPEN tab — the case
  // neither the debounce nor the on-install catch-up covers. Download-ONLY by
  // design (see PERIODIC_SYNC_MS): it never PATCHes, so it can't ping-pong with
  // another open device. The clock also fires once on regaining visibility, so
  // refocusing a stale tab pulls immediately; we throttle that to one run per
  // interval so rapid tab-switching can't burst GitHub requests.
  let lastBackstopAt = 0;
  const unsubClock = clock.subscribe(() => {
    const t = Date.now();
    if (t - lastBackstopAt < PERIODIC_SYNC_MS - 1000) return;
    lastBackstopAt = t;
    void downloadAndMerge();
  }, { everyMs: PERIODIC_SYNC_MS });

  installed = {
    dispose: () => {
      unsubHistory();
      unsubDecisions();
      unsubSettings();
      unsubRoutes();
      unsubGalaxyConfig();
      unsubReminderConfig();
      unsubClock();
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
  applyingSettingsFromSync = false;
  applyingRoutesFromSync = false;
  applyingGalaxyConfigFromSync = false;
  applyingReminderConfigFromSync = false;
  routesUniverseId = '';
  localUniverseTsMap = {};
};
