// Own-profile key-owner — who WE are on this server: highscore rank, honour
// rank class, name, id.
//
// Unlike `scans` / `players` (reactive stores fed by the galaxy XHR), nothing
// SUBSCRIBES to our own profile: the in-game header reader
// (`features/ownProfile.js`) writes it once per page load, and the dashboard
// reads it on demand to score neighbours RELATIVE to us — a rank-11 neighbour
// means something very different when we sit at #250 than at #11. So this is a
// plain `read*/write*` key-owner over `chrome.storage`, NOT a `createStore` +
// `persist` reactive store — the sanctioned exception documented in CLAUDE.md
// (cf. `state/dailyActions.js`). It also sidesteps a hydrate-vs-fresh-read race
// a reactive store would have: the header is always current and authoritative
// in-game, so we simply overwrite; the persisted copy exists only so the
// dashboard origin (which has no header bar) can read it.
//
// Per-universe key (`<universeId>:oge_ownProfile`) so each server keeps its own
// standing.
//
// @ts-check

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * Our own player standing on this server, as read from the header bar.
 *
 * @typedef {object} OwnProfile
 * @property {number} [id]        Our `playerId`.
 * @property {string} [name]      Display name (e.g. `"Yoxid"`).
 * @property {number} [rank]      Highscore position (e.g. `250`). The anchor
 *   for relative-strength comparisons against neighbour ranks.
 * @property {string} [rankClass] Honour-rank CSS class (e.g. `"rank_starlord2"`).
 * @property {number} [updatedAt] ms timestamp of the last header read.
 */

/** Suffix of the per-universe chrome.storage.local key. */
// Exported: the dashboard's universe discovery counts this base as evidence a
// universe was played on this device (it is (re)written on every page load, so
// it exists even right after a storage wipe once the game is visited once).
export const OWN_PROFILE_KEY_BASE = 'oge_ownProfile';

/**
 * Compose the full key for a universe id. Used by the dashboard (which knows
 * the selected universe) and by the in-game writer via {@link currentUniverseKey}.
 * @param {string} universeId
 * @returns {string}
 */
export const ownProfileKeyFor = (universeId) => `${universeId}:${OWN_PROFILE_KEY_BASE}`;

/**
 * Persist the current tab's own profile (called in-game by the header reader).
 * Overwrites wholesale — the header read is complete and authoritative each
 * page load — and stamps `updatedAt`. Best-effort: a storage error is the
 * caller's to swallow.
 *
 * @param {OwnProfile} profile
 * @returns {Promise<void>}
 */
export const writeOwnProfile = (profile) => {
  const key = currentUniverseKey(OWN_PROFILE_KEY_BASE, ownProfileKeyFor);
  return chromeStore.set(key, { ...profile, updatedAt: Date.now() });
};

/**
 * Read a given universe's own profile (called on the dashboard). Returns an
 * empty object when nothing is stored yet, so callers never null-check.
 *
 * @param {string} universeId
 * @returns {Promise<OwnProfile>}
 */
export const readOwnProfile = async (universeId) => {
  const raw = await chromeStore.get(ownProfileKeyFor(universeId));
  return raw && typeof raw === 'object' ? /** @type {OwnProfile} */ (raw) : {};
};
