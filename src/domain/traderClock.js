// @ts-check

// Pure clock/slot helpers for the Trader Import/Export re-arm timing.
//
// During the occasional "import refreshes 6× today" event, the Import/Export
// offer refreshes on fixed 4-hour boundaries (00/04/08/12/16/20 local). The
// trader feature reads the on-page countdown to the next refresh and turns it
// into an absolute re-arm timestamp using the slot boundaries below. These
// functions are pure: no DOM and no clock read beyond the `now` argument.

/**
 * @typedef {object} ClockTime
 * @property {number} hours   0–23
 * @property {number} minutes 0–59
 */

/**
 * The epoch-ms of the next moment the local wall clock reads `time`. If that
 * time has already passed today, it is tomorrow's occurrence — so a "come back
 * at 12:00" read at 14:00 resolves to 12:00 the next day, never the past.
 *
 * @param {Date} now Current local time.
 * @param {ClockTime} time Target wall-clock time.
 * @returns {number} Epoch ms of the next occurrence.
 */
export const nextDailyOccurrence = (now, { hours, minutes }) => {
  const at = new Date(now.getTime());
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
};

/**
 * Epoch-ms of the start of the `slotHours`-wide slot containing `now`, counted
 * from local midnight. With `slotHours = 4` the boundaries are
 * 00/04/08/12/16/20 — exactly the cadence on which the Import/Export offer
 * refreshes during the "6× today" event. Computed on the LOCAL wall clock (via
 * `setHours`), so it stays aligned to midnight across DST shifts. `slotHours`
 * is assumed to divide 24.
 *
 * @param {Date} now Current local time.
 * @param {number} slotHours Slot width in hours (e.g. 4).
 * @returns {number} Epoch ms of the current slot's start.
 */
export const slotStartMs = (now, slotHours) => {
  const at = new Date(now.getTime());
  at.setHours(Math.floor(at.getHours() / slotHours) * slotHours, 0, 0, 0);
  return at.getTime();
};

/**
 * Epoch-ms of the NEXT slot boundary strictly after `now`. The 20:00 slot rolls
 * over to the following local midnight: `setHours(24, …)` normalises to 00:00 of
 * the next day, keeping the result wall-clock correct across DST.
 *
 * @param {Date} now Current local time.
 * @param {number} slotHours Slot width in hours (e.g. 4).
 * @returns {number} Epoch ms of the next slot's start.
 */
export const nextSlotStartMs = (now, slotHours) => {
  const at = new Date(now.getTime());
  at.setHours(Math.floor(at.getHours() / slotHours) * slotHours + slotHours, 0, 0, 0);
  return at.getTime();
};
