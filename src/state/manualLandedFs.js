// Manually-marked landed fleet-saves — the user's own "this fleet sitting here
// IS a fleet-save, watch it" flag, set from the fleet1 dispatch screen.
//
// Why a SEPARATE store from `state/fleetSaveSet.js`'s landed set: that set is
// single-writer — the alarmClock PRODUCER owns it and rewrites it from the
// in-flight event list on every sync. A manual mark has no event to derive
// from, so feeding it into the producer's set would either be clobbered on the
// next sync or force the producer to special-case sticky overrides. Instead this
// is a PARALLEL set the same consumers (`features/badges` + the guardian) read
// in UNION with the producer's: the producer stays the sole writer of its key,
// this module is the sole writer of its own. No invariant crossed.
//
// Entries are PERSISTENT (no `expiresAt`): a manual mark restores a watch the
// user wants kept until they clear it (unmark) or re-save the fleet — unlike the
// auto landed set, which self-expires at 120 min.
//
// Plain key-owner over `safeLS` (NO reactive store) — consumers pull on their
// own render cadence, same rationale as `state/fleetSaveSet.js`. Per-origin
// localStorage = per-universe scoping (each OGame universe is its own subdomain).
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON array of manual landed-FS marks. */
export const MANUAL_LANDED_FS_KEY = 'oge-fleetsave-manual';

/**
 * @typedef {object} ManualLandedFs
 * @property {string} bodyKey  `g:s:p:type` (type 1 = planet, 3 = moon).
 * @property {number} markedAt epoch seconds the user marked it (audit only).
 */

/**
 * The user's manual landed-FS marks. No TTL — they persist until unmarked.
 *
 * @returns {ManualLandedFs[]}
 */
export const readManualLandedFs = () => {
  const v = safeLS.json(MANUAL_LANDED_FS_KEY, []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.bodyKey === 'string') : [];
};

/**
 * @param {ManualLandedFs[]} entries
 * @returns {void}
 */
export const writeManualLandedFs = (entries) => {
  safeLS.setJSON(MANUAL_LANDED_FS_KEY, Array.isArray(entries) ? entries : []);
};

/**
 * Is this body manually marked?
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @returns {boolean}
 */
export const hasManualLandedFs = (bodyKey) =>
  readManualLandedFs().some((e) => e.bodyKey === bodyKey);

/**
 * Remove a body's mark (idempotent).
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @returns {void}
 */
export const removeManualLandedFs = (bodyKey) => {
  writeManualLandedFs(readManualLandedFs().filter((e) => e.bodyKey !== bodyKey));
};

/**
 * Toggle a body's mark; returns the NEW state (`true` = now marked). The caller
 * stamps `markedAt` (kept out of this module so it stays `Date.now()`-free).
 *
 * @param {string} bodyKey  `g:s:p:type`.
 * @param {number} markedAt epoch seconds (used only when marking).
 * @returns {boolean}
 */
export const toggleManualLandedFs = (bodyKey, markedAt) => {
  const cur = readManualLandedFs();
  if (cur.some((e) => e.bodyKey === bodyKey)) {
    writeManualLandedFs(cur.filter((e) => e.bodyKey !== bodyKey));
    return false;
  }
  cur.push({ bodyKey, markedAt });
  writeManualLandedFs(cur);
  return true;
};
