// @ts-check

// Long-horizon presence-ledger store — per-universe `pid → PresenceLedger`
// (domain/presenceLedger.js): the months-scale day×hour memory of "seen
// active / looked & quiet" that outlives the 45-day activity-ring sweep and
// the per-body ring caps. Feeds the dossier's presence-history explorer and
// the alliance pool; GIST-SYNCED (`presenceLedgerPerUniverse`, per-day OR —
// commutative and monotonic, so devices converge from any order).
//
// # How it accrues — re-fold, not per-event hooks
//
// The ledger folds from the COLLAPSED presence probes (domain/presence.js
// buildPresenceProbes over routineBodies) — already self-induced-discounted
// and correlation-collapsed, see the domain header's provenance note. Because
// the fold is an idempotent bitwise OR, we do not hook individual appends:
// a debounced subscriber re-folds EVERY watched player's current rings after
// a reports/activity burst settles. Re-folding already-folded data is a
// structural no-op (`changed === false`, no store write), and any observation
// is re-foldable for the full 45 days its ring survives, so a missed debounce
// (page nav) costs nothing. Watched-only growth is inherited from the rings
// themselves (they only accrue for watched/patrolled players).
//
// Reactive store (not a plain key-owner): the sync scheduler subscribes to it
// to arm uploads, and the persist write-through owns the chrome.storage key.
// The dashboard reads the raw key per selected universe.

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { debounce } from '../lib/debounce.js';
import { currentUniverseKey } from './universeKey.js';
import { targetReportsStore } from './targets.js';
import { activityObsStore } from './activityObs.js';
import { routineBodies } from '../domain/routine.js';
import { buildPresenceProbes } from '../domain/presence.js';
import {
  foldProbesIntoLedger,
  mergePresenceLedgers,
  sweepPresenceLedgerMap,
} from '../domain/presenceLedger.js';

/** @typedef {import('../domain/presenceLedger.js').PresenceLedger} PresenceLedger */

/**
 * The per-universe store value: `playerId → PresenceLedger`.
 * @typedef {Record<string, PresenceLedger>} PresenceLedgerMap
 */

/** Suffix of the per-universe chrome.storage.local key. */
export const PRESENCE_LEDGER_KEY_BASE = 'oge_presenceLedger';

/**
 * Compose the full key for a universe id (dashboard composes it for the
 * selected universe; the in-game writer resolves the current one).
 * @param {string} universeId
 * @returns {string}
 */
export const presenceLedgerKeyFor = (universeId) => `${universeId}:${PRESENCE_LEDGER_KEY_BASE}`;

const currentPresenceLedgerKey = () =>
  currentUniverseKey(PRESENCE_LEDGER_KEY_BASE, presenceLedgerKeyFor);

/**
 * Quiet window after a reports/activity burst before re-folding. Folding is
 * cheap (watched rings only) but a galaxy scroll fires dozens of store ticks;
 * one trailing fold covers them all. Longer than the rings' own 200 ms persist
 * debounce by design — the fold reads the stores directly, not storage.
 */
const FOLD_DEBOUNCE_MS = 5000;

/** @type {import('../lib/createStore.js').Store<PresenceLedgerMap>} */
export const presenceLedgerStore = createStore(/** @type {PresenceLedgerMap} */ ({}));

/** @type {(() => void) | null} */
let disposeFn = null;
/** @type {(() => void) | null} */
let disposeFoldFn = null;
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Resolves once the store's hydrate phase has settled (mirrors
 * `whenTargetsHydrated`). The sync scheduler and the fold both gate on it.
 * @returns {Promise<void>}
 */
export const whenPresenceLedgerHydrated = () => hydratedPromise;

/**
 * Fold every player's CURRENT rings into the ledger map. Idempotent (see
 * header) — writes the store only when a probe contributed a new bit.
 * Exported for the content bootstrap to run once on load (catching looks
 * recorded while no fold debounce survived) and for tests.
 * @returns {Promise<void>}
 */
export const foldPresenceLedger = async () => {
  await whenPresenceLedgerHydrated();
  const reports = targetReportsStore.get();
  const activity = activityObsStore.get();
  const nowMs = Date.now();
  const pids = new Set([...Object.keys(reports), ...Object.keys(activity)]);
  presenceLedgerStore.update((cur) => {
    /** @type {PresenceLedgerMap | null} */
    let next = null;
    for (const pid of pids) {
      const bodies = routineBodies(reports[pid], activity[pid]);
      const { probes } = buildPresenceProbes(bodies, nowMs);
      if (!probes.length) continue;
      const { merged, changed } = foldProbesIntoLedger((next || cur)[pid] || {}, probes);
      if (!changed) continue;
      if (!next) next = { ...cur };
      next[pid] = merged;
    }
    return next || cur;
  });
};

/**
 * Adopt a merged remote map from the sync scheduler: per-player OR into the
 * live store (never a `set` — a fold that landed mid-round must survive).
 * The caller (scheduler) persists the raw key itself and holds its anti-loop
 * suppressor around this call.
 * @param {PresenceLedgerMap} incoming
 * @returns {Promise<void>}
 */
export const adoptPresenceLedgerMap = async (incoming) => {
  await whenPresenceLedgerHydrated();
  presenceLedgerStore.update((cur) => {
    /** @type {PresenceLedgerMap | null} */
    let next = null;
    for (const pid of Object.keys(incoming || {})) {
      const { merged, changed } = mergePresenceLedgers((next || cur)[pid] || {}, incoming[pid]);
      if (!changed) continue;
      if (!next) next = { ...cur };
      next[pid] = merged;
    }
    return next || cur;
  });
};

/**
 * Wire the store to chrome.storage.local (hydrate with the retention sweep +
 * debounced write-through) and install the debounced re-fold subscriber on
 * the two ring stores. Idempotent.
 * @returns {() => void}
 */
export const initPresenceLedgerStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: presenceLedgerStore,
    load: async () => {
      const raw = await chromeStore.get(currentPresenceLedgerKey());
      return raw && typeof raw === 'object'
        ? sweepPresenceLedgerMap(
          /** @type {PresenceLedgerMap} */ (raw),
          Math.floor(Date.now() / 1000),
        )
        : null;
    },
    save: (value) => chromeStore.set(currentPresenceLedgerKey(), value),
    debounceMs: 1000,
    onHydrate: () => {
      resolveHydrated();
    },
  });

  const scheduleFold = debounce(() => {
    if (!disposeFn) return;
    void foldPresenceLedger();
  }, FOLD_DEBOUNCE_MS);
  const unsubReports = targetReportsStore.subscribe(scheduleFold);
  const unsubActivity = activityObsStore.subscribe(scheduleFold);
  disposeFoldFn = () => {
    unsubReports();
    unsubActivity();
    disposeFoldFn = null;
  };

  return disposeFn;
};

/**
 * Tear down the persist wiring + fold subscribers. Idempotent. Resets the
 * hydration promise to the pre-resolved sentinel.
 * @returns {void}
 */
export const disposePresenceLedgerStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  if (disposeFoldFn) disposeFoldFn();
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
