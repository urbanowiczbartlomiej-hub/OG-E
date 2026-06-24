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
// CROSS-DEVICE: the marks ARE synced (per universe) through the user's gist, via
// the `manualLandedFsPerUniverse` SYNC_SLOT. The persisted shape carries an
// `updatedAt` epoch the sync uses for LAST-WRITER-WINS on the whole set, so a
// REMOVAL (unmark / re-save) propagates instead of being resurrected by another
// device that still holds the mark. Every mutation here stamps `updatedAt` from
// a caller-supplied time — the module stays `Date.now()`-free for testability.
//
// Plain key-owner over `safeLS` (NO reactive store) — consumers pull on their
// own render cadence, same rationale as `state/fleetSaveSet.js`. Per-origin
// localStorage = per-universe scoping (each OGame universe is its own subdomain).
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON slot of manual landed-FS marks. */
export const MANUAL_LANDED_FS_KEY = 'oge-fleetsave-manual';

/**
 * @typedef {object} ManualLandedFs
 * @property {string} bodyKey  `g:s:p:type` (type 1 = planet, 3 = moon).
 * @property {number} markedAt epoch seconds the user marked it (audit only).
 */

/**
 * @typedef {object} ManualLandedFsSlot
 * @property {ManualLandedFs[]} marks
 * @property {number} updatedAt  Epoch seconds of the last add/remove — the
 *   cross-device last-writer-wins key. 0 = never touched on this device.
 */

/** @param {*} v @returns {ManualLandedFs[]} */
const cleanMarks = (v) =>
  Array.isArray(v) ? v.filter((e) => e && typeof e.bodyKey === 'string') : [];

/**
 * Read the raw slot, tolerant of the legacy bare-array shape (pre-sync). A
 * legacy array is adopted with `updatedAt: 0` so a device that already had
 * local marks still loses to any timestamped remote, but contributes its marks
 * on first add/remove.
 *
 * @returns {ManualLandedFsSlot}
 */
export const readManualLandedFsSlot = () => {
  const v = /** @type {any} */ (safeLS.json(MANUAL_LANDED_FS_KEY, { marks: [], updatedAt: 0 }));
  if (Array.isArray(v)) return { marks: cleanMarks(v), updatedAt: 0 };
  return { marks: cleanMarks(v?.marks), updatedAt: Number(v?.updatedAt) || 0 };
};

/** @param {ManualLandedFsSlot} slot @returns {void} */
export const writeManualLandedFsSlot = (slot) => {
  safeLS.setJSON(MANUAL_LANDED_FS_KEY, {
    marks: cleanMarks(slot?.marks),
    updatedAt: Number(slot?.updatedAt) || 0,
  });
};

/**
 * The user's manual landed-FS marks (consumer API — unchanged). No TTL — they
 * persist until unmarked.
 *
 * @returns {ManualLandedFs[]}
 */
export const readManualLandedFs = () => readManualLandedFsSlot().marks;

/**
 * Replace the mark set, stamping the sync clock. `at` is the mutation time
 * (epoch seconds, caller-supplied); omit only when not changing the set.
 *
 * @param {ManualLandedFs[]} entries
 * @param {number} [at]
 * @returns {void}
 */
export const writeManualLandedFs = (entries, at) => {
  writeManualLandedFsSlot({
    marks: cleanMarks(entries),
    updatedAt: at != null ? at : readManualLandedFsSlot().updatedAt,
  });
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
 * Remove a body's mark (idempotent), stamping the sync clock so the removal
 * propagates cross-device.
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @param {number} [at]    epoch seconds of the removal — bumps the sync clock so
 *   the removal propagates cross-device. Omit only off the sync path (tests).
 * @returns {void}
 */
export const removeManualLandedFs = (bodyKey, at) => {
  writeManualLandedFs(readManualLandedFs().filter((e) => e.bodyKey !== bodyKey), at);
};

/**
 * Toggle a body's mark; returns the NEW state (`true` = now marked). `markedAt`
 * stamps both the entry and the slot's sync clock (kept out of this module so it
 * stays `Date.now()`-free).
 *
 * @param {string} bodyKey  `g:s:p:type`.
 * @param {number} markedAt epoch seconds.
 * @returns {boolean}
 */
export const toggleManualLandedFs = (bodyKey, markedAt) => {
  const cur = readManualLandedFs();
  if (cur.some((e) => e.bodyKey === bodyKey)) {
    writeManualLandedFs(cur.filter((e) => e.bodyKey !== bodyKey), markedAt);
    return false;
  }
  cur.push({ bodyKey, markedAt });
  writeManualLandedFs(cur, markedAt);
  return true;
};
