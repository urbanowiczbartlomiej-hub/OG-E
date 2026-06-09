// @ts-check

/**
 * Return the current "game day" key as YYYY-MM-DD.
 *
 * OGame's daily rewarding tasks reset at 14:00 local time, not at midnight.
 * Before 14:00 the game considers it still the previous calendar day's cycle.
 *
 * @param {Date} now
 * @returns {string}
 */
export const gameDayKey = (now) => {
  const d = new Date(now.getTime());
  if (d.getHours() < 14) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
