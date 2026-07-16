// @ts-check

// Durable, self-expiring guardian ACK (snooze) store.
//
// Tapping the Fleet-reminder button bumps the body's escalation push to
// `ackedAt + interval` (the player is clearly present and dealing with it),
// without clearing the reminder. Like `./fleetSaveCancel.js`, the push
// schedule is RE-DERIVED on every producer run, so a one-off ntfy DELETE
// isn't enough — the ack is remembered and re-applied every scan until its
// `expiresAt` passes. Local only (a single-device, in-game presence signal);
// not synced.
//
// (The guardian DISMISS store that used to live alongside this is gone — a
// dismiss is now a synced tombstone in `state/fleetReminders.js`, so it
// propagates across devices instead of hiding in a local suppression map.)
//
// @see ./fleetSaveCancel.js — the same pattern for cancelled FS slots.
// @see ../../sync/alarmClock.js — folds the live map into the guardian reconcile.

import { safeLS } from '../../lib/storage.js';

/**
 * Drop expired records (`expiresAt <= now`). Pure.
 *
 * @template {{ expiresAt: number }} T
 * @param {Record<string, T>} map
 * @param {number} now Epoch SECONDS.
 * @returns {Record<string, T>}
 */
const prune = (map, now) => {
  /** @type {Record<string, T>} */
  const out = {};
  for (const k of Object.keys(map)) {
    if (map[k] && map[k].expiresAt > now) out[k] = map[k];
  }
  return out;
};

/**
 * @typedef {{ ackedAt: number, expiresAt: number }} GuardianAckRecord
 * @typedef {Record<string, GuardianAckRecord>} GuardianAckMap
 */

/** @param {string} universeId @returns {string} */
const ackKeyFor = (universeId) => `oge_guardianAck_${universeId}`;

/** @param {string} universeId @returns {GuardianAckMap} */
const readGuardianAck = (universeId) => {
  const v = safeLS.json(ackKeyFor(universeId), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {GuardianAckMap} */ (v) : {};
};

/** @param {string} universeId @param {GuardianAckMap} map @returns {void} */
const writeGuardianAck = (universeId, map) => {
  if (Object.keys(map).length) safeLS.setJSON(ackKeyFor(universeId), map);
  else safeLS.remove(ackKeyFor(universeId));
};

/**
 * Record a guardian ACK (the player tapped "I'm on it"). Synchronous — must
 * land before the tap navigates away.
 *
 * @param {string} universeId
 * @param {string} bodyKey
 * @param {number} ackedAt
 * @param {number} expiresAt
 * @param {number} now Epoch SECONDS.
 * @returns {void}
 */
export const addGuardianAck = (universeId, bodyKey, ackedAt, expiresAt, now) => {
  const map = prune(readGuardianAck(universeId), now);
  map[bodyKey] = { ackedAt, expiresAt: Math.max(map[bodyKey]?.expiresAt ?? 0, expiresAt) };
  writeGuardianAck(universeId, map);
};

/**
 * Live (non-expired) acks as `{ bodyKey: ackedAt }`. The scheduler fires the
 * push at `max(landedAt, ackedAt) + interval`, so a stale ack from a previous
 * landing (ackedAt < the new landedAt) is naturally ignored. Prunes as a side
 * effect (self-cleaning).
 *
 * @param {string} universeId
 * @param {number} now Epoch SECONDS.
 * @returns {Record<string, number>}
 */
export const guardianAckedLandings = (universeId, now) => {
  const pruned = prune(readGuardianAck(universeId), now);
  writeGuardianAck(universeId, pruned);
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of Object.keys(pruned)) out[k] = pruned[k].ackedAt;
  return out;
};
