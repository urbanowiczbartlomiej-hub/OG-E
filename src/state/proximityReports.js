// @ts-check

// Proximity-alert feed — per-universe store of the "foreign fleet spotted near
// your planet" alerts the player has OPENED. A bounded, newest-first ARRAY of
// {@link ProximityReport} (unlike state/targets.js's nested map, this is a flat
// log — "who's been probing me lately"). Feeds the dashboard Spyglass
// "Who's spying on you" strip.
//
// GIST-SYNCED since 1.50 (`proximityReportsPerUniverse`, union-dedup via
// sync/merge.mergeProximityReports): an alert is a ONE-SHOT observation — once
// dismissed in-game a second device can never re-derive it, which left each
// device with a different "who's spying" view. GREEN per docs/fair-play.md
// §"🟢/🟡 Spyglass intelligence workbench (v3)" — a passive read of the
// player's OWN opened reports (no extra requests, no automation).
//
// Reactive `createStore` + `persist` (not a plain key-owner) because two parties
// touch it across a burst: the in-game ingest consumer (`features/targetsIngest`)
// WRITES via `recordProximityReport`, and the dashboard READS the raw key.
// `recordProximityReport` gates its first write on hydration to avoid the
// late-hydrate clobber that bit `colonyRecorder` (see state/history.js).
//
// Per-universe key (`<universeId>:oge_proximityReports`).

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/** @typedef {import('../domain/espionageReport.js').ProximityReport} ProximityReport */

/** Newest-first cap — a rolling window of recent probes, older ones fall off.
 * Exported for the JSON-import reconciler (sync/merge.js), which re-caps the
 * merged log to the same window. */
export const PROXIMITY_CAP = 60;

/** Suffix of the per-universe chrome.storage.local key. */
export const PROXIMITY_REPORTS_KEY_BASE = 'oge_proximityReports';

/**
 * Compose the full key for a universe id (the dashboard composes it for the
 * selected universe; the in-game writer goes through {@link currentUniverseKey}).
 * @param {string} universeId
 * @returns {string}
 */
export const proximityReportsKeyFor = (universeId) => `${universeId}:${PROXIMITY_REPORTS_KEY_BASE}`;

const currentProximityReportsKey = () =>
  currentUniverseKey(PROXIMITY_REPORTS_KEY_BASE, proximityReportsKeyFor);

/** @type {import('../lib/createStore.js').Store<ProximityReport[]>} */
export const proximityReportsStore = createStore(/** @type {ProximityReport[]} */ ([]));

/** @type {(() => void) | null} */
let disposeFn = null;
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the store's hydrate phase has settled. Gating the first
 * {@link recordProximityReport} on this prevents an early write being wiped by a
 * late load (the colonyRecorder race — see state/history.js for the full story).
 * @returns {Promise<void>}
 */
export const whenProximityHydrated = () => hydratedPromise;

/**
 * Dedup identity for a proximity alert: the same scout, at the same body of ours,
 * at the same second. Re-opening the identical alert on a messages-page revisit
 * is then a no-op.
 * @param {ProximityReport} r
 * @returns {string}
 */
const proximityKey = (r) => `${r.byPlayerId}|${r.atCoords}|${r.ts ?? 0}`;

/**
 * Record one normalised proximity alert. Prepends (newest-first), de-dupes by
 * `${byPlayerId}|${atCoords}|${ts}`, and trims to {@link PROXIMITY_CAP}. Async +
 * hydration-gated; best-effort (a report with no scout id is ignored).
 * @param {ProximityReport | null | undefined} report
 * @returns {Promise<void>}
 */
export const recordProximityReport = async (report) => {
  if (!report || report.byPlayerId == null) return;
  await whenProximityHydrated();
  const id = proximityKey(report);
  proximityReportsStore.update((cur) => {
    // Already logged this exact alert → no-op, so we skip the subscriber
    // fan-out and the debounced persist (and dashboard re-render churn).
    if (cur.some((r) => proximityKey(r) === id)) return cur;
    return [report, ...cur].slice(0, PROXIMITY_CAP);
  });
};

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_proximityReports`, write through on change (200 ms debounce
 * so a burst of alert-opens collapses). Idempotent.
 * @returns {() => void}
 */
export const initProximityReportsStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: proximityReportsStore,
    load: async () => {
      const parsed = await chromeStore.get(currentProximityReportsKey());
      return Array.isArray(parsed) ? /** @type {ProximityReport[]} */ (parsed) : null;
    },
    save: (value) => chromeStore.set(currentProximityReportsKey(), value),
    debounceMs: 200,
    onHydrate: () => {
      resolveHydrated();
    },
  });
  return disposeFn;
};

/**
 * Tear down the persist wiring. Idempotent. Resets {@link whenProximityHydrated}
 * to the pre-resolved sentinel, matching the "no init has run" state.
 * @returns {void}
 */
export const disposeProximityReportsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
