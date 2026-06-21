// @ts-check

// Pure helpers for the Trader Import/Export "come back at HH:MM" overlay.
//
// During the occasional "import refreshes 6× today" event, the Import/Export
// page replaces the daily-offer panel with a "no offers now, come back at
// HH:MM" overlay once a container is taken. We must NOT key on the localised
// sentence ("Wróć o godz. 12:00." / "Come back at 12:00." / …) — only on the
// locale-independent clock time it contains. These two functions do exactly
// that, with no DOM and no clock read beyond the `now` argument, so the trader
// feature can turn the displayed time into an absolute re-arm timestamp.

/**
 * @typedef {object} ClockTime
 * @property {number} hours   0–23
 * @property {number} minutes 0–59
 */

/**
 * Extract the first `HH:MM` clock time from arbitrary (localised) text.
 * Locale-independent: matches the digits only, never the surrounding words.
 *
 * @param {unknown} text Raw element text (e.g. `"Obecnie nie ma ofert. Wróć o godz. 12:00."`).
 * @returns {ClockTime | null} The parsed time, or `null` if none is present.
 */
export const parseClockTime = (text) => {
  if (typeof text !== 'string') return null;
  // `\b` around the match keeps `12:00` from matching inside a longer run of
  // digits (a price like `13.500`), and the hour/minute sub-patterns reject
  // out-of-range values (24:61) so a stray number pair can't read as a time.
  const m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  return { hours: parseInt(m[1], 10), minutes: parseInt(m[2], 10) };
};

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
