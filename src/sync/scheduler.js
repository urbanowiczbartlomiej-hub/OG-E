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
// # Initial boot
//
// On install, we fire exactly one {@link downloadAndMerge} (fire-
// and-forget, we don't await). That catches up this device with
// whatever another device uploaded while we were offline. Local
// writes that happen DURING the initial download are still safe
// because the lock serialises them: any store change during the boot
// download queues a debounced upload, and that upload pre-merges with
// remote at its own call site.
//
// @ts-check

/* global document */

import { scansStore } from '../state/scans.js';
import { historyStore } from '../state/history.js';
import { playersStore } from '../state/players.js';
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
  mergeScans,
  mergeHistory,
  mergeSettings,
  mergeDailyRunRoutes,
  mergeDailyState,
  mergeGalaxyScanConfig,
  mergeReminderConfig,
  mergePlayers,
  mergeOwnProfile,
} from './merge.js';
import {
  fetchGistData,
  writeGistData,
  setStatus,
  getToken,
  clearGistScansForGalaxy,
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
import { chromeStore } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';
import { readDailyState, writeDailyState } from '../state/dailyActions.js';
import { readOwnProfile, writeOwnProfileFor } from '../state/ownProfile.js';
import { SYNC_FORCE_EVENT, DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';
import {
  canStartSync,
  shouldScheduleUpload,
  slotHasData,
  dailyStateHasData,
  galaxyConfigSlotHasData,
  reminderConfigSlotHasData,
  playersSlotHasData,
  ownProfileHasData,
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

    const localScans = scansStore.get();

    // Scans are per-universe in the gist (`galaxyScansPerUniverse[id]`). We
    // merge ONLY our own universe's slot — never the legacy global field —
    // so another server's scans can't bleed into this universe's colonize
    // candidates. Off a known universe (`routesUniverseId === ''`) we keep
    // local untouched rather than guess a slot.
    const scansResult = routesUniverseId
      ? mergeScans(localScans, remote.galaxyScansPerUniverse?.[routesUniverseId])
      : { changed: false, merged: localScans };
    // Global + per-universe settings merge (shared with upload()).
    const { setResult, uniResult } = mergeSyncSettings(remote, routesUniverseId);

    // Anti-loop: see file header. `changed === false` means merge is a
    // structural no-op; skipping the write breaks the subscription
    // feedback loop at its source. Settings have their own value-level
    // anti-loop flag inside applyMergedSettings / writeLocalUniverseSettingsSlot.
    if (scansResult.changed) scansStore.set(scansResult.merged);
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

    // Players cache: per-universe, per-`playerId` union (newest `seenAt` wins).
    // Like scans/history this needs no `applying*FromSync` flag — there is no
    // timestamp to re-stamp, so the `changed` guard plus the gistIsCurrent skip
    // on the follow-up upload already break the loop.
    if (routesUniverseId) {
      const playersResult = mergePlayers(
        playersStore.get(),
        remote.playersPerUniverse?.[routesUniverseId],
      );
      if (playersResult.changed) playersStore.set(playersResult.merged);
    }

    // Own profile: per-universe, whole newest-`updatedAt` wins. Plain key-owner
    // (no store, nothing subscribes), so read the cross-origin source of truth
    // and apply via writeOwnProfileFor — which keeps the merged `updatedAt`
    // rather than re-stamping `now` (that would churn the next merge).
    if (routesUniverseId) {
      const ownResult = mergeOwnProfile(
        await readOwnProfile(routesUniverseId),
        remote.ownProfilePerUniverse?.[routesUniverseId],
      );
      if (ownResult.changed) await writeOwnProfileFor(routesUniverseId, ownResult.merged);
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

    // Snapshot scans AFTER the awaited fetch. Taken earlier (before the
    // network round-trip) a scan landing mid-fetch would be silently dropped
    // by the `scansStore.set(scansResult.merged)` below; no `await` sits
    // between this read and that set, so nothing can interleave from here on.
    const localScans = scansStore.get();

    const scansResult = routesUniverseId
      ? mergeScans(localScans, remote?.galaxyScansPerUniverse?.[routesUniverseId])
      : { changed: false, merged: localScans };
    // Global + per-universe settings merge (shared with downloadAndMerge()).
    const { setResult, uniResult } = mergeSyncSettings(remote, routesUniverseId);

    // Same anti-loop guard as downloadAndMerge. Without this, a store
    // subscription would fire on every upload-round and re-schedule
    // indefinitely.
    if (scansResult.changed) scansStore.set(scansResult.merged);
    if (setResult.changed) applyMergedSettings(setResult.merged);
    if (uniResult.changed) await writeLocalUniverseSettingsSlot(uniResult.merged);

    // Scans: per-universe map for the payload — PRESERVE every OTHER universe's
    // slot; contribute ours only when it carries data (an empty map must not
    // write an empty slot that would differ from the gist's absent field and
    // force a perpetual no-op PATCH).
    const mergedGalaxyScansPerUniverse = { ...(remote?.galaxyScansPerUniverse || {}) };
    if (routesUniverseId && Object.keys(scansResult.merged).length > 0) {
      mergedGalaxyScansPerUniverse[routesUniverseId] = scansResult.merged;
    }
    const mergedGalaxyScansPerUniverseOut = Object.keys(mergedGalaxyScansPerUniverse).length
      ? mergedGalaxyScansPerUniverse
      : undefined;

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

    // Players cache: per-universe union (newest `seenAt`). Preserve every OTHER
    // universe's slot; contribute ours only when the roster carries data.
    const mergedPlayers = { ...(remote?.playersPerUniverse || {}) };
    if (routesUniverseId) {
      const playersResult = mergePlayers(
        playersStore.get(),
        remote?.playersPerUniverse?.[routesUniverseId],
      );
      if (playersResult.changed) playersStore.set(playersResult.merged);
      if (playersSlotHasData(playersResult.merged)) {
        mergedPlayers[routesUniverseId] = playersResult.merged;
      }
    }
    const mergedPlayersOut = Object.keys(mergedPlayers).length ? mergedPlayers : undefined;

    // Own profile: per-universe whole newest-wins. Read the cross-origin source
    // of truth (chrome.storage), adopt remote if newer (verbatim, no re-stamp),
    // and contribute ours when present.
    const mergedOwnProfile = { ...(remote?.ownProfilePerUniverse || {}) };
    if (routesUniverseId) {
      const ownResult = mergeOwnProfile(
        await readOwnProfile(routesUniverseId),
        remote?.ownProfilePerUniverse?.[routesUniverseId],
      );
      if (ownResult.changed) await writeOwnProfileFor(routesUniverseId, ownResult.merged);
      if (ownProfileHasData(ownResult.merged)) {
        mergedOwnProfile[routesUniverseId] = ownResult.merged;
      }
    }
    const mergedOwnProfileOut = Object.keys(mergedOwnProfile).length ? mergedOwnProfile : undefined;

    // Skip the PATCH when the gist already matches the merged state.
    // This is the common case when upload fires right after a download
    // from another device and both sides already agree — PATCHing
    // anyway would burn a request and produce a no-op revision.
    if (
      !gistIsCurrent(remote, {
        galaxyScansPerUniverse: mergedGalaxyScansPerUniverseOut,
        colonyHistoryPerUniverse: mergedColonyHistoryOut,
        settings: setResult.merged,
        dailyRunRoutes: mergedDailyRunRoutesOut,
        settingsPerUniverse: mergedPerUniverseOut,
        dailyStatePerUniverse: mergedDailyPerUniverseOut,
        galaxyScanConfig: mergedGalaxyConfigOut,
        reminderConfigPerUniverse: mergedReminderConfigOut,
        playersPerUniverse: mergedPlayersOut,
        ownProfilePerUniverse: mergedOwnProfileOut,
      })
    ) {
      await writeGistData({
        version: 1,
        updatedAt: new Date().toISOString(),
        galaxyScansPerUniverse: mergedGalaxyScansPerUniverseOut,
        colonyHistoryPerUniverse: mergedColonyHistoryOut,
        settings: setResult.merged,
        dailyRunRoutes: mergedDailyRunRoutesOut,
        settingsPerUniverse: mergedPerUniverseOut,
        dailyStatePerUniverse: mergedDailyPerUniverseOut,
        galaxyScanConfig: mergedGalaxyConfigOut,
        reminderConfigPerUniverse: mergedReminderConfigOut,
        playersPerUniverse: mergedPlayersOut,
        ownProfilePerUniverse: mergedOwnProfileOut,
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

  const unsubScans = scansStore.subscribe(onStoreChange);
  const unsubHistory = historyStore.subscribe(onStoreChange);
  // Player cache: an `oge:galaxyScanned` event grows the roster → schedule an
  // upload, same path as scans/history (no stamping, so no anti-loop flag).
  const unsubPlayers = playersStore.subscribe(onStoreChange);

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
    // Force-sync is an explicit user action (settings "Sync now" or
    // histogram "Refresh"). Run a full round-trip back-to-back,
    // bypassing the debounce entirely. Each operation has its own
    // in-flight guard; they serialise naturally via the shared lock.
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
        // Drop the galaxy from scansStore IN MEMORY for the same
        // merge-round-trip reason as CLEAR_REMOTE above — the
        // histogram cleared chrome.storage but our in-memory copy
        // would otherwise re-introduce the keys via union merge.
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
        (async () => {
          try {
            await clearGistScansForGalaxy(galaxy, routesUniverseId);
          } catch (err) {
            setStatus(
              'err',
              `reset-galaxy: ${/** @type {Error} */ (err).message}`,
            );
          }
        })();
      }
    }
  };
  const unsubStorage = chromeStore.onChanged(onStorageChange);

  // Kick off the initial download fire-and-forget. We do not await —
  // the content-script bootstrap shouldn't block waiting for network.
  // Local writes that land during this download still upload correctly
  // because onStoreChange schedules the debounced upload, and the
  // in-flight lock serialises the two operations.
  void downloadAndMerge();

  installed = {
    dispose: () => {
      unsubScans();
      unsubHistory();
      unsubPlayers();
      unsubSettings();
      unsubRoutes();
      unsubGalaxyConfig();
      unsubReminderConfig();
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
