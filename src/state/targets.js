// @ts-check

// Espionage-report cache — per-universe, device-local store of the spy reports
// the player has OPENED, keyed `playerId → bodyKey → { latest, history }`: the
// newest report per body plus a bounded ring of lean prior observations (watched
// players only). Feeds the dashboard Targets sub-tab's hidden-fleet estimate
// (military points minus the spied defense + visible fleet) + the routine
// tracker. The `{latest, history}` shape is owned by `domain/targetReports.js` —
// every reader goes through its `latestOf`/`historyOf` accessors (§10.1).
//
// GIST-SYNCED since 1.48 (`targetReportsPerUniverse`, additive union via
// sync/merge.mergeTargetReports — newer `latest` wins per body, history rings
// union): re-spying could in principle re-derive a report, but the OBSERVATION
// TIMELINE (when each look happened) cannot be re-derived, and per-device
// divergence was the root cause of the "two devices, two different Spyglass
// views" failure. The sync scheduler reads/writes the RAW chrome.storage key
// (cross-origin truth) and refreshes this store after hydration settles.
// Reactive `createStore` + `persist` (not a plain key-owner) because two
// parties touch it across a burst: the in-game ingest consumer
// (`features/targetsIngest`) WRITES via `recordReport`, and the dashboard
// READS the raw key. `recordReport` gates its first write on hydration to
// avoid the late-hydrate clobber that bit `colonyRecorder` (see
// `state/history.js` whenHistoryHydrated).
//
// Per-universe key (`<universeId>:oge_targetReports`).

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';
import { bodyKey, normalizeReportTimestamps } from '../domain/espionageReport.js';
import { latestOf, historyOf, toLite, HISTORY_CAP } from '../domain/targetReports.js';
import { watchListStore } from './watchList.js';

/** @typedef {import('../domain/espionageReport.js').SpyReport} SpyReport */
/** @typedef {import('../domain/targetReports.js').BodyEntry} BodyEntry */

/**
 * All recorded reports for the current universe: `playerId` → (`bodyKey` →
 * body entry). Each entry holds the NEWEST report (`latest`) plus a bounded ring
 * of lean prior observations (`history`), the latter accruing for WATCHED players
 * only — see {@link recordReport}. Each body key is a coord+type (planet OR moon).
 * @typedef {Record<string, Record<string, BodyEntry>>} TargetReports
 */

/** Suffix of the per-universe chrome.storage.local key. */
export const TARGET_REPORTS_KEY_BASE = 'oge_targetReports';

/**
 * Compose the full key for a universe id (dashboard composes it for the
 * selected universe; the in-game writer goes through {@link currentUniverseKey}).
 * @param {string} universeId
 * @returns {string}
 */
export const targetReportsKeyFor = (universeId) => `${universeId}:${TARGET_REPORTS_KEY_BASE}`;

const currentTargetReportsKey = () =>
  currentUniverseKey(TARGET_REPORTS_KEY_BASE, targetReportsKeyFor);

/** @type {import('../lib/createStore.js').Store<TargetReports>} */
export const targetReportsStore = createStore(/** @type {TargetReports} */ ({}));

/** @type {(() => void) | null} */
let disposeFn = null;
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the store's hydrate phase has settled. Gating the first
 * {@link recordReport} on this prevents an early write being wiped by a late
 * load (the colonyRecorder race — see state/history.js for the full story).
 * @returns {Promise<void>}
 */
export const whenTargetsHydrated = () => hydratedPromise;

/**
 * Record one normalised spy report. Newest-per-body wins (a re-spy supersedes
 * an older read; an accidental open of an OLDER archived report does not). Async
 * + hydration-gated; best-effort (a report with no owner id is ignored).
 * @param {SpyReport | null | undefined} report
 * @returns {Promise<void>}
 */
export const recordReport = async (report) => {
  if (!report || report.playerId == null) return;
  await whenTargetsHydrated();
  const pid = String(report.playerId);
  const key = bodyKey(report);
  // Retention gate (§10.1): the history ring accrues ONLY for players on the
  // watch list — the bounded intel we deliberately track. Everyone else keeps
  // `latest` only, so the store can't grow without bound and un-watch→re-watch
  // never wipes coverage. Read once, outside the update closure (sync). A report
  // arriving before the watch list has hydrated reads an empty set → treated as
  // unwatched → no history append, which is the safe direction.
  const isWatched = watchListStore.get().players.includes(pid);
  targetReportsStore.update((cur) => {
    const bucket = cur[pid] || {};
    const prevEntry = bucket[key];
    const prevLatest = latestOf(prevEntry);
    // Keep the stored entry unless the incoming report is STRICTLY newer. An
    // equal-ts re-ingest (re-opening the identical report on a messages-page
    // revisit) is a no-op — returning cur unchanged skips the store update, the
    // subscriber fan-out, the debounced persist, AND a duplicate history append.
    // An older archived report is likewise ignored.
    if (prevLatest && (prevLatest.timestamp ?? 0) >= (report.timestamp ?? 0)) return cur;
    const history = isWatched
      ? [...historyOf(prevEntry), toLite(report)].slice(-HISTORY_CAP)
      : historyOf(prevEntry);
    return { ...cur, [pid]: { ...bucket, [key]: { latest: report, history } } };
  });
};

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_targetReports`, write through on change (200 ms debounce so
 * a burst of report-opens collapses). Idempotent.
 * @returns {() => void}
 */
export const initTargetReportsStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: targetReportsStore,
    load: async () => {
      const parsed = await chromeStore.get(currentTargetReportsKey());
      // Unit repair on hydrate: pre-fix reports stored ms timestamps (they
      // read as perpetually fresh). Normalised in memory here; the next
      // write-through persists the fix.
      return parsed && typeof parsed === 'object'
        ? normalizeReportTimestamps(/** @type {TargetReports} */ (parsed))
        : null;
    },
    save: (value) => chromeStore.set(currentTargetReportsKey(), value),
    debounceMs: 200,
    onHydrate: () => {
      resolveHydrated();
    },
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent. Resets {@link whenTargetsHydrated}
 * to the pre-resolved sentinel, matching the "no init has run" state.
 * @returns {void}
 */
export const disposeTargetReportsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
