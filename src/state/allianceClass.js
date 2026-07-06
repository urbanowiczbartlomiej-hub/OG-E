// @ts-check

// Alliance-class cache — per-device, per-universe map `allianceId → class slug`
// ('warrior' | 'trader' | 'explorer' | 'none'), harvested from the in-game
// ALLIANCE highscore DOM by `features/allianceClassIngest`. OGame does NOT expose
// the alliance class in the public XML API, so this is the machine-readable
// source the danger model joins — player→alliance (players.xml) then
// alliance→class here — to light the 'warrior alliance' apex tell WITHOUT needing
// a spy report on every member. 'none' is stored verbatim so a KNOWN "no class"
// is distinct from an UNKNOWN (never-harvested) alliance.
//
// Plain read*/merge* key-owner over `chrome.storage.local` — the sanctioned
// exception documented in CLAUDE.md (cf. `state/apiCache.js`): the in-game
// ingester merges on visit; the dashboard + apiContext read on demand at
// danger-compute time. Nothing subscribes, so a reactive store would be pure
// overhead.
//
// LOCAL ONLY — never gist-synced: re-harvestable by re-opening the ranking, and
// device-local like the API cache.
//
// Per-universe key (`<universeId>:oge_allianceClass`).

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/** @typedef {Record<string, string>} AllianceClassMap  allianceId → class slug. */

/** Suffix of the per-universe chrome.storage.local key. */
const ALLIANCE_CLASS_KEY_BASE = 'oge_allianceClass';

/**
 * Compose the full key for a universe id.
 * @param {string} universeId
 * @returns {string}
 */
export const allianceClassKeyFor = (universeId) => `${universeId}:${ALLIANCE_CLASS_KEY_BASE}`;

/**
 * Read a specific universe's alliance-class map (the dashboard / apiContext read
 * path — they select a universe explicitly). Returns `{}` when nothing is stored.
 * @param {string} universeId
 * @returns {Promise<AllianceClassMap>}
 */
export const readAllianceClassesFor = async (universeId) => {
  const raw = await chromeStore.get(allianceClassKeyFor(universeId));
  return raw && typeof raw === 'object' ? /** @type {AllianceClassMap} */ (raw) : {};
};

/**
 * Read the CURRENT universe's alliance-class map (in-game read path — resolves
 * the universe from `location`).
 * @returns {Promise<AllianceClassMap>}
 */
export const readAllianceClasses = async () => {
  const key = currentUniverseKey(ALLIANCE_CLASS_KEY_BASE, allianceClassKeyFor);
  const raw = await chromeStore.get(key);
  return raw && typeof raw === 'object' ? /** @type {AllianceClassMap} */ (raw) : {};
};

/**
 * Merge freshly-harvested `allianceId → class` pairs into the CURRENT universe's
 * map (accumulate across ranking pages / repeat visits). Writes ONLY when a value
 * actually changed, so an unchanged re-sweep of the same page doesn't rewrite the
 * key (no spurious storage-change fan-out to the dashboard).
 * @param {AllianceClassMap} updates
 * @returns {Promise<void>}
 */
export const mergeAllianceClasses = async (updates) => {
  const ids = updates ? Object.keys(updates) : [];
  if (ids.length === 0) return;
  const key = currentUniverseKey(ALLIANCE_CLASS_KEY_BASE, allianceClassKeyFor);
  const raw = await chromeStore.get(key);
  const cur = raw && typeof raw === 'object' ? /** @type {AllianceClassMap} */ (raw) : {};
  let changed = false;
  for (const id of ids) {
    if (cur[id] !== updates[id]) {
      cur[id] = updates[id];
      changed = true;
    }
  }
  if (changed) await chromeStore.set(key, cur);
};
