// @ts-check

// API cache — per-device, per-universe cache of the PARSED OGame public
// statistics feeds (universe / players / highscore total+military / serverData).
//
// Plain `read*/write*` key-owner over `chrome.storage.local` — the sanctioned
// exception documented in CLAUDE.md (cf. `state/ownProfile.js`,
// `state/dailyActions.js`): only `features/apiContext` reads this, on demand,
// so a reactive store would be pure overhead.
//
// LOCAL ONLY — this never enters the gist. The data is fully re-fetchable from
// the API, so it's a device cache, not state we own: its sole purpose is to
// avoid re-downloading the multi-MB `universe.xml` on every page navigation
// (OGame full-page navs reload the content script each time). Each feed carries
// its own `fetchedAt` so `apiContext` can apply a per-cadence TTL, plus the
// feed's own data `timestamp` for diagnostics.
//
// Per-universe key (`<universeId>:oge_apiCache`).

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/** @typedef {import('../domain/apiOccupancy.js').ApiPlanet} ApiPlanet */
/** @typedef {import('../domain/apiOccupancy.js').ApiPlayerMeta} ApiPlayerMeta */
/** @typedef {import('../domain/apiOccupancy.js').ApiRank} ApiRank */
/** @typedef {import('../domain/apiOccupancy.js').ServerData} ServerData */

/**
 * @typedef {object} ApiCache
 * @property {{ planets: ApiPlanet[], timestamp?: number, fetchedAt: number, regenProbeTs?: number }} [universe]
 *   `regenProbeTs` — self-timestamp observed by a fruitless regen-due probe;
 *   disarms the early-refetch trigger until OGame actually rolls the file.
 * @property {{ players: Record<string, ApiPlayerMeta>, timestamp?: number, fetchedAt: number }} [players]
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [total]
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [military]
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [honor]
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [economy]
 *   Economy highscore (type 1) — the civil baseline for the danger model.
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [destroyed]
 *   Military destroyed (type 5) — lifetime kill history; only combat moves it.
 * @property {{ ranks: Record<string, ApiRank>, timestamp?: number, fetchedAt: number }} [lost]
 *   Military lost (type 6) — war involvement / crash recency.
 * @property {{ data: ServerData, fetchedAt: number }} [server]
 */

/** Suffix of the per-universe chrome.storage.local key. */
const API_CACHE_KEY_BASE = 'oge_apiCache';

/**
 * Compose the full key for a universe id.
 * @param {string} universeId
 * @returns {string}
 */
export const apiCacheKeyFor = (universeId) => `${universeId}:${API_CACHE_KEY_BASE}`;

/**
 * Read the current universe's API cache. Returns `{}` when nothing is stored
 * yet, so callers never null-check the envelope.
 * @returns {Promise<ApiCache>}
 */
export const readApiCache = async () => {
  const key = currentUniverseKey(API_CACHE_KEY_BASE, apiCacheKeyFor);
  const raw = await chromeStore.get(key);
  return raw && typeof raw === 'object' ? /** @type {ApiCache} */ (raw) : {};
};

/**
 * Read a specific universe's API cache (used on the dashboard, which runs on
 * the extension origin and selects a universe explicitly rather than parsing
 * `location.host`). Returns `{}` when nothing is stored.
 * @param {string} universeId
 * @returns {Promise<ApiCache>}
 */
export const readApiCacheFor = async (universeId) => {
  const raw = await chromeStore.get(apiCacheKeyFor(universeId));
  return raw && typeof raw === 'object' ? /** @type {ApiCache} */ (raw) : {};
};

/**
 * Persist the current universe's API cache (overwrites wholesale).
 * @param {ApiCache} cache
 * @returns {Promise<void>}
 */
export const writeApiCache = (cache) => {
  const key = currentUniverseKey(API_CACHE_KEY_BASE, apiCacheKeyFor);
  return chromeStore.set(key, cache);
};
