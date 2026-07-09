// @ts-check

// Galaxy-activity observation store — per-universe, device-local rings of
// activity markers for WATCHED players' bodies, harvested passively from the
// galaxy views the user themselves browses (`oge:galaxyScanned`, the same
// MAIN-world bridge event `state/scans.js` and `state/players.js` already
// consume). This is the dense, probe-free second source of the routine
// tracker (SPYGLASS-REDESIGN.md §6.6bis): the user scrolls the galaxy
// constantly while playing, so markers accrue far faster than spy reports —
// for zero probes and zero extra requests (fair-play GREEN, classified in
// docs/fair-play.md under "Galaxy-view activity capture").
//
// Shape: `playerId → bodyKey("g:s:p:type") → ActivityObs[]` (bounded ring,
// oldest→newest). The append rules — self-induced-probe discount, same-
// interaction dedup, negative-evidence throttle, ring cap — are PURE and live
// in `domain/activityObs.js`; this module only wires event → watched-gate →
// ring append → persist.
//
// Watched-only, structurally: an observation is recorded ONLY while its owner
// is on the watch list (`state/watchList.js`), mirroring `recordReport`'s
// history retention gate — so the store cannot grow with the whole server,
// and un-watch → re-watch never wipes what was already gathered (rings stay,
// appends pause). Bodies of ever-watched players are additionally swept on
// hydrate once their newest observation ages past the routine horizon.
//
// LOCAL ONLY — never gist-synced (per-device intel, like targetReports).
// Reactive store because two parties read it live: the in-game scan FAB
// (windowBonus needs it synchronously each repaint) and this module's own
// event writer; the dashboard reads the raw key per selected universe.

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { GALAXY_SCANNED_EVENT } from '../lib/ogeEvents.js';
import { readSpySentMap } from '../lib/spySentSession.js';
import { currentUniverseKey } from './universeKey.js';
import { watchListStore } from './watchList.js';
import { targetReportsStore } from './targets.js';
import { latestOf, historyOf } from '../domain/targetReports.js';
import { appendActivityObs } from '../domain/activityObs.js';

/** @typedef {import('../domain/activityObs.js').ActivityObs} ActivityObs */

/**
 * All recorded galaxy-activity rings for the current universe:
 * `playerId → (bodyKey "g:s:p:type" → ring)`.
 * @typedef {Record<string, Record<string, ActivityObs[]>>} ActivityObsMap
 */

/** Suffix of the per-universe chrome.storage.local key. */
export const ACTIVITY_OBS_KEY_BASE = 'oge_activityObs';

/**
 * Compose the full key for a universe id (the dashboard composes it for the
 * selected universe; the in-game writer resolves the current one).
 * @param {string} universeId
 * @returns {string}
 */
export const activityObsKeyFor = (universeId) => `${universeId}:${ACTIVITY_OBS_KEY_BASE}`;

const currentActivityObsKey = () =>
  currentUniverseKey(ACTIVITY_OBS_KEY_BASE, activityObsKeyFor);

/**
 * Observations whose newest entry is older than this are swept on hydrate —
 * they can no longer influence the 30-day routine window (domain/routine.js
 * RECENCY_MS) and only cost storage.
 */
const SWEEP_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/** @type {import('../lib/createStore.js').Store<ActivityObsMap>} */
export const activityObsStore = createStore(/** @type {ActivityObsMap} */ ({}));

/** @type {(() => void) | null} */
let disposeFn = null;
/** @type {(() => void) | null} */
let disposeListenerFn = null;
/** @type {() => void} */
let resolveHydrated = () => {};
/** @type {Promise<void>} */
let hydratedPromise = Promise.resolve();

/**
 * Drop rings whose newest observation predates the sweep horizon, and empty
 * player buckets. Pure over the map value.
 * @param {ActivityObsMap} map
 * @param {number} nowMs
 * @returns {ActivityObsMap}
 */
const sweepStale = (map, nowMs) => {
  const cutoffSec = (nowMs - SWEEP_AFTER_MS) / 1000;
  /** @type {ActivityObsMap} */
  const out = {};
  for (const pid of Object.keys(map)) {
    const bucket = map[pid];
    if (!bucket || typeof bucket !== 'object') continue;
    /** @type {Record<string, ActivityObs[]>} */
    const kept = {};
    for (const key of Object.keys(bucket)) {
      const ring = bucket[key];
      if (!Array.isArray(ring) || !ring.length) continue;
      if ((ring[ring.length - 1].t ?? 0) < cutoffSec) continue;
      kept[key] = ring;
    }
    if (Object.keys(kept).length) out[pid] = kept;
  }
  return out;
};

/**
 * A galaxy activity marker only reflects interaction in the last hour, so only
 * probe arrivals inside this look-back of the scan can be the one that lit it.
 */
const PROBE_LOOKBACK_S = 60 * 60;

/**
 * Our own probe ARRIVALS for one body within the hour before `tSec`, epoch
 * seconds — the timestamps of the spy reports we already hold for it (`latest`
 * + `history`). Durable, cross-tab evidence of "we probed this body at ~T" that
 * anchors the self-induced-activity discount even when the per-tab
 * `spySentSession` map is gone: tab closed, probe sent manually (outside OG-E),
 * or the galaxy look happened in a different tab than the send. `undefined`
 * when we hold no recent report — the discount then falls back to the session
 * map alone (the pre-existing behaviour).
 * @param {import('../domain/targetReports.js').BodyEntry
 *   | import('../domain/espionageReport.js').SpyReport | undefined} entry
 * @param {number} tSec
 * @returns {number[] | undefined}
 */
const recentProbeArrivals = (entry, tSec) => {
  if (!entry) return undefined;
  /** @type {number[]} */
  const out = [];
  /** @param {number | undefined} t */
  const consider = (t) => {
    if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t >= tSec - PROBE_LOOKBACK_S) {
      out.push(t);
    }
  };
  consider(latestOf(entry).timestamp);
  for (const h of historyOf(entry)) consider(h.ts);
  return out.length ? out : undefined;
};

/**
 * Record one galaxy system snapshot: for every slot owned by a WATCHED player,
 * append the planet's and (independently) the moon's activity marker to that
 * body's ring. Hydration-gated like `recordReport` so an early event can't be
 * clobbered by a late load. No-op when nothing changed.
 *
 * The self-induced-probe discount is anchored on BOTH our per-tab send map
 * (`spySentSession`, keyed by body so a moon send doesn't discount its planet)
 * AND the durable probe arrivals from reports we already hold for the body
 * (`recentProbeArrivals`) — so an induced "active" marker is dropped even when
 * the session map was never populated (tab closed / manual send / look from
 * another tab), which is the common way a probe's own marker used to leak.
 *
 * @param {{ galaxy: number, system: number, scannedAt: number,
 *   positions: Record<number, import('../domain/scans.js').Position> }} detail
 * @returns {Promise<void>}
 */
export const recordGalaxyActivity = async (detail) => {
  if (!detail || !detail.positions) return;
  const watched = watchListStore.get().players;
  if (!watched.length) return;
  await whenActivityObsHydrated();
  const sentMap = readSpySentMap();
  const reports = targetReportsStore.get();
  const tSec = Math.floor((detail.scannedAt ?? 0) / 1000);
  if (!tSec) return;

  activityObsStore.update((cur) => {
    /** @type {ActivityObsMap} */
    let next = cur;
    let changed = false;
    for (const posKey of Object.keys(detail.positions)) {
      const pos = detail.positions[Number(posKey)];
      const pid = pos && pos.player ? String(pos.player.id) : null;
      if (!pid || !watched.includes(pid)) continue;
      const coord = `${detail.galaxy}:${detail.system}:${posKey}`;
      const pidReports = reports[pid];
      for (const [type, m] of [[1, pos.activity], [3, pos.moonActivity]]) {
        if (typeof m !== 'number') continue;
        const bodyKey = `${coord}:${type}`;
        // Session send key mirrors sendSpy.sentKey: planet `g:s:p`, moon `g:s:p:3`.
        const sentKey = type === 3 ? `${coord}:3` : coord;
        const bucket = next[pid] || {};
        const ring = appendActivityObs(bucket[bodyKey], { t: tSec, m }, {
          sentAtMs: sentMap[sentKey],
          probeTimesSec: recentProbeArrivals(pidReports && pidReports[bodyKey], tSec),
        });
        if (!ring) continue;
        if (!changed) { next = { ...cur }; changed = true; }
        next[pid] = { ...(next[pid] || {}), [bodyKey]: ring };
      }
    }
    return changed ? next : cur;
  });
};

/**
 * Resolves once the store's hydrate phase has settled (mirrors
 * `whenTargetsHydrated` — see state/targets.js for the race story).
 * @returns {Promise<void>}
 */
export const whenActivityObsHydrated = () => hydratedPromise;

/**
 * Install the `oge:galaxyScanned` → activity-ring bridge. Idempotent; a no-op
 * (stub dispose) in node-env tests with no `document`. Mirrors
 * `state/players.installPlayersListener`.
 * @returns {() => void}
 */
export const installActivityObsListener = () => {
  if (disposeListenerFn) return disposeListenerFn;
  if (typeof document === 'undefined') {
    disposeListenerFn = () => { disposeListenerFn = null; };
    return disposeListenerFn;
  }
  /** @param {Event} e */
  const handler = (e) => {
    const detail = /** @type {CustomEvent} */ (e).detail;
    if (detail) void recordGalaxyActivity(detail);
  };
  document.addEventListener(GALAXY_SCANNED_EVENT, handler);
  disposeListenerFn = () => {
    document.removeEventListener(GALAXY_SCANNED_EVENT, handler);
    disposeListenerFn = null;
  };
  return disposeListenerFn;
};

/**
 * Wire the store to chrome.storage.local: hydrate from
 * `<universeId>:oge_activityObs` (sweeping stale rings), write through on
 * change (200 ms debounce collapses a galaxy-scroll burst). Auto-installs the
 * event listener, like `initScansStore`. Idempotent.
 * @returns {() => void}
 */
export const initActivityObsStore = () => {
  if (disposeFn) return disposeFn;
  hydratedPromise = new Promise((resolve) => {
    resolveHydrated = resolve;
  });
  disposeFn = persist({
    store: activityObsStore,
    load: async () => {
      const raw = await chromeStore.get(currentActivityObsKey());
      return raw && typeof raw === 'object'
        ? sweepStale(/** @type {ActivityObsMap} */ (raw), Date.now())
        : null;
    },
    save: (value) => chromeStore.set(currentActivityObsKey(), value),
    debounceMs: 200,
    onHydrate: () => {
      resolveHydrated();
    },
  });
  installActivityObsListener();
  return disposeFn;
};

/**
 * Tear down the persist wiring + listener. Idempotent. Resets the hydration
 * promise to the pre-resolved sentinel, matching the "no init has run" state.
 * @returns {void}
 */
export const disposeActivityObsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  if (disposeListenerFn) disposeListenerFn();
  hydratedPromise = Promise.resolve();
  resolveHydrated = () => {};
};
