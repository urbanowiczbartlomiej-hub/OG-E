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
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { GALAXY_SCANNED_EVENT } from '../lib/ogeEvents.js';
import { currentUniverseKey } from './universeKey.js';
import { mergePlayerMeta } from '../domain/players.js';

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
      return /** @type {PlayerCache | null | undefined} */ (raw);
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
