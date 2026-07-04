// @ts-check

// Espionage-report cache — per-universe, device-local store of the spy reports
// the player has OPENED, keyed `playerId → bodyKey → newest SpyReport`. Feeds
// the dashboard Targets sub-tab's hidden-fleet estimate (military points minus
// the spied defense + visible fleet).
//
// LOCAL ONLY — never gist-synced: it's per-device intel, fully re-derivable by
// re-spying, exactly like `state/scans.js` / `state/apiCache.js`. Reactive
// `createStore` + `persist` (not a plain key-owner) because two parties touch
// it across a burst: the in-game ingest consumer (`features/targetsIngest`)
// WRITES via `recordReport`, and the dashboard READS the raw key. `recordReport`
// gates its first write on hydration to avoid the late-hydrate clobber that bit
// `colonyRecorder` (see `state/history.js` whenHistoryHydrated).
//
// Per-universe key (`<universeId>:oge_targetReports`).

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';
import { bodyKey, normalizeReportTimestamps } from '../domain/espionageReport.js';

/** @typedef {import('../domain/espionageReport.js').SpyReport} SpyReport */

/**
 * All recorded reports for the current universe: `playerId` → (`bodyKey` →
 * newest report for that body). Planets only (we never spy moons under the
 * planets-only decision), so each body key is a planet coord+type.
 * @typedef {Record<string, Record<string, SpyReport>>} TargetReports
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
  targetReportsStore.update((cur) => {
    const bucket = cur[pid] || {};
    const prev = bucket[key];
    // Keep the stored report unless the incoming one is STRICTLY newer. An
    // equal-ts re-ingest (re-opening the identical report on a messages-page
    // revisit) is a no-op — returning cur unchanged skips the store update,
    // the subscriber fan-out, and the debounced persist, killing dashboard
    // re-render churn. An older archived report is likewise ignored.
    if (prev && (prev.timestamp ?? 0) >= (report.timestamp ?? 0)) return cur;
    return { ...cur, [pid]: { ...bucket, [key]: report } };
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
