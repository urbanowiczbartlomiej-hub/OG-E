// @ts-check

// Durable, self-expiring suppression store for cancelled fleet-save SLOTS.
//
// # Why this exists (and isn't the pending queue)
//
// Ad-hoc reminders are USER-armed and live in the synced gist, so a `disarm`
// command applied once stays applied. Fleet-saves are different: they are
// RE-DERIVED from the live event list on every producer run. So deleting a
// slot's ntfy message is not enough — the very next scan re-detects the
// still-in-flight fleet and re-queues the slot. To cancel a slot durably we
// must remember the suppression and re-apply it every scan until the fleet
// is gone.
//
// Unlike the pending queue (drained after one successful sync), this store
// persists per universe and self-expires: each record carries an `expiresAt`
// (just past the latest suppressed slot's fire time), after which it is
// pruned — by then the fleet has landed and its row is gone anyway. Local
// only (a last-moment, in-game, single-device action); not synced.
//
// @see ../../domain/fleetSave.js — fsOffsetsToCancel / reconcileFleetSaves
// @see ./producer.js             — reads the map, folds it into the sync
// @see ./eventList.js            — writes a record on the cancel click

import { safeLS } from '../../lib/storage.js';

/**
 * @typedef {{ offsets: number[], expiresAt: number }} FleetSaveCancelRecord
 * @typedef {Record<string, FleetSaveCancelRecord>} FleetSaveCancelMap
 */

/**
 * @param {string} universeId @returns {string}
 */
const keyFor = (universeId) => `oge_fleetSaveCancel_${universeId}`;

/**
 * Read the raw suppression map for a universe (always an object).
 *
 * @param {string} universeId
 * @returns {FleetSaveCancelMap}
 */
export const readFleetSaveCancel = (universeId) => {
  const v = safeLS.json(keyFor(universeId), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {FleetSaveCancelMap} */ (v) : {};
};

/**
 * Replace the map, removing the key entirely when empty.
 *
 * @param {string} universeId
 * @param {FleetSaveCancelMap} map
 * @returns {void}
 */
export const writeFleetSaveCancel = (universeId, map) => {
  if (Object.keys(map).length) safeLS.setJSON(keyFor(universeId), map);
  else safeLS.remove(keyFor(universeId));
};

/**
 * Drop expired records (`expiresAt <= now`). Pure.
 *
 * @param {FleetSaveCancelMap} map
 * @param {number} now Epoch SECONDS.
 * @returns {FleetSaveCancelMap}
 */
export const pruneFleetSaveCancel = (map, now) => {
  /** @type {FleetSaveCancelMap} */
  const out = {};
  for (const id of Object.keys(map)) {
    if (map[id] && map[id].expiresAt > now) out[id] = map[id];
  }
  return out;
};

/**
 * Merge a cancellation into the map: union the offsets onto any existing
 * record for the id and keep the later `expiresAt`. Pure.
 *
 * @param {FleetSaveCancelMap} map
 * @param {string} id
 * @param {number[]} offsets
 * @param {number} expiresAt
 * @returns {FleetSaveCancelMap}
 */
export const mergeFleetSaveCancel = (map, id, offsets, expiresAt) => {
  const prev = map[id];
  const union = prev ? [...new Set([...prev.offsets, ...offsets])] : [...offsets];
  return { ...map, [id]: { offsets: union, expiresAt: Math.max(prev?.expiresAt ?? 0, expiresAt) } };
};

/**
 * Persist a cancellation (synchronous — must land before any navigation),
 * pruning expired records in the same pass.
 *
 * @param {string} universeId
 * @param {string} id
 * @param {number[]} offsets
 * @param {number} expiresAt
 * @param {number} now Epoch SECONDS.
 * @returns {void}
 */
export const addFleetSaveCancel = (universeId, id, offsets, expiresAt, now) => {
  writeFleetSaveCancel(universeId, mergeFleetSaveCancel(pruneFleetSaveCancel(readFleetSaveCancel(universeId), now), id, offsets, expiresAt));
};

/**
 * The live (non-expired) suppression as a plain `{ id: offsets[] }` map —
 * the shape `reconcileFleetSaves` / the render path consume. Prunes expired
 * records back to storage as a side effect so the store self-cleans.
 *
 * @param {string} universeId
 * @param {number} now Epoch SECONDS.
 * @returns {Record<string, number[]>}
 */
export const fleetSaveCancelOffsets = (universeId, now) => {
  const pruned = pruneFleetSaveCancel(readFleetSaveCancel(universeId), now);
  writeFleetSaveCancel(universeId, pruned);
  /** @type {Record<string, number[]>} */
  const out = {};
  for (const id of Object.keys(pruned)) out[id] = pruned[id].offsets;
  return out;
};
