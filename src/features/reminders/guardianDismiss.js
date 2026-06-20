// @ts-check

// Durable, self-expiring suppression for DISMISSED guardian landings.
//
// Like `./fleetSaveCancel.js`: the landed-FS set is RE-DERIVED from the live
// event list on every producer run, so a one-off ntfy DELETE isn't enough — the
// next scan would re-arm the guardian push for a still-exposed body. We remember
// the dismissed landing (its `bodyKey` + the `landedAt` it was dismissed at) and
// re-apply the suppression every scan until the record's `expiresAt` passes (by
// then the landed flag's own TTL is gone anyway). A NEW landing on the same body
// has a different `landedAt`, so it re-arms — dismiss suppresses THIS landing,
// not the body forever. Local only (a single-device, in-game action); not synced.
//
// @see ./fleetSaveCancel.js — the same pattern for cancelled FS slots.
// @see ../../sync/reminders.js — folds the live map into the guardian reconcile.

import { safeLS } from '../../lib/storage.js';

/**
 * @typedef {{ landedAt: number, expiresAt: number }} GuardianDismissRecord
 * @typedef {Record<string, GuardianDismissRecord>} GuardianDismissMap
 */

/** @param {string} universeId @returns {string} */
const keyFor = (universeId) => `oge_guardianDismiss_${universeId}`;

/**
 * Read the raw dismiss map for a universe (always an object).
 *
 * @param {string} universeId
 * @returns {GuardianDismissMap}
 */
export const readGuardianDismiss = (universeId) => {
  const v = safeLS.json(keyFor(universeId), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {GuardianDismissMap} */ (v) : {};
};

/**
 * Replace the map, removing the key entirely when empty.
 *
 * @param {string} universeId
 * @param {GuardianDismissMap} map
 * @returns {void}
 */
const writeGuardianDismiss = (universeId, map) => {
  if (Object.keys(map).length) safeLS.setJSON(keyFor(universeId), map);
  else safeLS.remove(keyFor(universeId));
};

/**
 * Drop expired records (`expiresAt <= now`). Pure.
 *
 * @param {GuardianDismissMap} map
 * @param {number} now Epoch SECONDS.
 * @returns {GuardianDismissMap}
 */
const prune = (map, now) => {
  /** @type {GuardianDismissMap} */
  const out = {};
  for (const k of Object.keys(map)) {
    if (map[k] && map[k].expiresAt > now) out[k] = map[k];
  }
  return out;
};

/**
 * Persist a dismissal (synchronous — must land before any navigation), pruning
 * expired records in the same pass.
 *
 * @param {string} universeId
 * @param {string} bodyKey
 * @param {number} landedAt
 * @param {number} expiresAt
 * @param {number} now Epoch SECONDS.
 * @returns {void}
 */
export const addGuardianDismiss = (universeId, bodyKey, landedAt, expiresAt, now) => {
  const map = prune(readGuardianDismiss(universeId), now);
  map[bodyKey] = { landedAt, expiresAt: Math.max(map[bodyKey]?.expiresAt ?? 0, expiresAt) };
  writeGuardianDismiss(universeId, map);
};

/**
 * Live (non-expired) dismissed landings as `{ bodyKey: landedAt }` — the
 * scheduler suppresses a landed entry whose bodyKey maps to the SAME landedAt.
 * Prunes expired records back to storage as a side effect (self-cleaning).
 *
 * @param {string} universeId
 * @param {number} now Epoch SECONDS.
 * @returns {Record<string, number>}
 */
export const guardianDismissedLandings = (universeId, now) => {
  const pruned = prune(readGuardianDismiss(universeId), now);
  writeGuardianDismiss(universeId, pruned);
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of Object.keys(pruned)) out[k] = pruned[k].landedAt;
  return out;
};
