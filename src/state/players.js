// Player-metadata cache — reactive store keyed by `playerId`.
//
// The companion to `state/scans.js`. The same `oge:galaxyScanned` event that
// feeds the per-system scan map also carries a `players` map (one
// {@link PlayerMeta} per occupied slot, built in the MAIN-world bridge via
// `domain/players.extractPlayerMeta`). This store de-duplicates those by id —
// a player with 20 colonies is stored ONCE — and keeps the newest sighting
// (newest-wins by the scan's `scannedAt`, see `domain/players.mergePlayerMeta`).
//
// Persisted to `chrome.storage.local` under a per-universe key
// (`<universeId>:oge_players`, see {@link playersKeyFor}) so each OGame
// server keeps its own roster, and the dashboard (extension origin) can read
// the selected universe's cache to enrich Colony Scout neighbourhood scoring.
//
// Mirrors `state/scans.js` in shape: lazy `initPlayersStore()` wiring (NOT on
// import), an auto-installed `oge:galaxyScanned` listener, and a uniform
// `disposePlayersStore()` teardown. Debounce rationale is identical — a
// galaxy scroll fires a burst of per-system scans; 200 ms collapses them into
// one trailing save.
//
// Retention: hydrate runs `domain/players.sweepStalePlayers` over the loaded
// map — records not refreshed for PLAYER_SWEEP_AFTER_MS (60 d) are dropped,
// EXCEPT watched players (`state/watchList.js`), whose meta the Spyglass
// dossiers read indefinitely. Without it this is THE unbounded key on a
// long-lived profile (one record per distinct player ever rendered, no cap —
// unlike activityObs' 45 d sweep + ring caps or proximityReports' cap of 60).
// The swept map is written back by persist's hydrate echo, so storage shrinks
// on the next page load even if no further scan ever fires.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { GALAXY_SCANNED_EVENT } from '../lib/ogeEvents.js';
import { currentUniverseKey } from './universeKey.js';
import { WATCH_LIST_KEY_BASE, watchListKeyFor, normalizeWatchList } from './watchList.js';
import { mergePlayerMeta, sweepStalePlayers } from '../domain/players.js';

/**
 * @typedef {import('../domain/players.js').PlayerMeta} PlayerMeta
 * @typedef {Record<number, PlayerMeta>} PlayerCache
 */

/**
 * Suffix of the chrome.storage.local key. The full key is
 * `<universeId>:<PLAYERS_KEY_BASE>` — see {@link playersKeyFor}. Exported so
 * the dashboard can compose a key for an arbitrary selected universe.
 */
const PLAYERS_KEY_BASE = 'oge_players';

/**
 * Compose the full chrome.storage.local key for a universe id.
 * @param {string} universeId e.g. `'s163-pl'`.
 * @returns {string}
 */
export const playersKeyFor = (universeId) => `${universeId}:${PLAYERS_KEY_BASE}`;

/** Resolve the key for the current tab's universe (falls back in node tests). */
const currentPlayersKey = () => currentUniverseKey(PLAYERS_KEY_BASE, playersKeyFor);

/**
 * Resolve the persisted watch-list key for the current universe. The hydrate
 * sweep reads that key RAW (through watchList's own composer + normalizer)
 * instead of `watchListStore.get()` on purpose: content.js init order is not
 * load-bearing and every store hydrates asynchronously, so at OUR hydrate
 * time the watch-list store may still hold its empty default — racing it
 * would sweep watched players' meta. The persisted key is the truth no matter
 * who initialized first. (Read-only: the "mutate only via the store" rule
 * bars writing someone else's key, not reading it.)
 */
const currentWatchListKey = () => currentUniverseKey(WATCH_LIST_KEY_BASE, watchListKeyFor);

/** Write-through debounce window (see header). */
const DEBOUNCE_MS = 200;

/**
 * The player cache store. Initial value is an empty map; hydration is async
 * via {@link initPlayersStore}.
 *
 * @type {import('../lib/createStore.js').Store<PlayerCache>}
 */
export const playersStore = createStore(/** @type {PlayerCache} */ ({}));

/** @type {(() => void) | null} */
let disposeFn = null;

/**
 * Wire the store to chrome.storage.local (hydrate + debounced write-through)
 * and auto-install the `oge:galaxyScanned` listener. Idempotent — repeat
 * calls return the same dispose handle. Call once from the content-script
 * bootstrap.
 *
 * @returns {() => void}
 */
export const initPlayersStore = () => {
  if (disposeFn) return disposeFn;
  disposeFn = persist({
    store: playersStore,
    load: async () => {
      const raw = await chromeStore.get(currentPlayersKey());
      if (!raw || typeof raw !== 'object') return null;
      const cache = /** @type {PlayerCache} */ (raw);
      // Retention sweep (see header; mirrors activityObs' hydrate sweep). If
      // the watch list can't be read we skip the sweep for THIS hydrate
      // rather than treat everyone as unwatched — dropping a watched player's
      // meta would break their dossier; the next page load simply retries.
      try {
        const wlRaw = await chromeStore.get(currentWatchListKey());
        const watched = wlRaw == null ? [] : normalizeWatchList(wlRaw).players;
        return sweepStalePlayers(cache, Date.now(), watched);
      } catch {
        return cache;
      }
    },
    save: (value) => chromeStore.set(currentPlayersKey(), value),
    debounceMs: DEBOUNCE_MS,
  });
  installPlayersListener();
  return disposeFn;
};

/**
 * Tear down the persist wiring + listener. Idempotent.
 * @returns {void}
 */
export const disposePlayersStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  disposePlayersListener();
};

/** @type {(() => void) | null} */
let disposeListenerFn = null;

/**
 * Install the bridge from `oge:galaxyScanned` into {@link playersStore}.
 * Each event's `players` map is merged newest-wins (by the event's
 * `scannedAt`) via {@link mergePlayerMeta}. Idempotent; a no-op (returning a
 * stub dispose) in node-env tests with no `document`.
 *
 * @returns {() => void}
 */
export const installPlayersListener = () => {
  if (disposeListenerFn) return disposeListenerFn;

  if (typeof document === 'undefined') {
    disposeListenerFn = () => {
      disposeListenerFn = null;
    };
    return disposeListenerFn;
  }

  /** @param {Event} e */
  const handler = (e) => {
    const detail = /** @type {CustomEvent<{
      players?: Record<number, PlayerMeta>,
      scannedAt?: number,
    }>} */ (e).detail;
    if (!detail || !detail.players) return;
    const seenAt = typeof detail.scannedAt === 'number' ? detail.scannedAt : Date.now();

    const current = playersStore.get();
    /** @type {PlayerCache} */
    let next = current;
    let changed = false;
    for (const key of Object.keys(detail.players)) {
      const id = Number(key);
      const fresh = detail.players[id];
      if (!fresh) continue;
      const merged = mergePlayerMeta(current[id], fresh, seenAt);
      // mergePlayerMeta returns the existing record by reference when the
      // sighting is stale, so identity is a sound "did anything change" test.
      if (merged !== current[id]) {
        if (!changed) {
          next = { ...current };
          changed = true;
        }
        next[id] = merged;
      }
    }
    if (changed) playersStore.set(next);
  };

  document.addEventListener(GALAXY_SCANNED_EVENT, handler);
  disposeListenerFn = () => {
    document.removeEventListener(GALAXY_SCANNED_EVENT, handler);
    disposeListenerFn = null;
  };
  return disposeListenerFn;
};

/**
 * Tear down the listener installed by {@link installPlayersListener}.
 * Idempotent.
 * @returns {void}
 */
export const disposePlayersListener = () => {
  if (disposeListenerFn) disposeListenerFn();
};
