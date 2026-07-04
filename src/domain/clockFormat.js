// @ts-check

// Pure formatting of an epoch time into a locale `HH:MM` clock string.
//
// Lives in its own domain module (NOT `domain/duration.js`, whose contract
// forbids `Date`) because two surfaces must print the SAME clock: the
// alarmClock event-list tooltips and the ntfy push wildcard renderer. A single
// shared formatter keeps the tooltip and the push in lockstep by construction
// rather than by parallel copies.
//
// `new Date(arg)` is deterministic given its input (no `Date.now()`), so this
// stays a pure function; the OUTPUT is locale/timezone-dependent by design — it
// renders the viewer's local clock, matching how the rest of the game UI shows
// times.

/**
 * Format epoch SECONDS as a locale `HH:MM` clock string, e.g. `1783156148`
 * → `"14:29"` (24h where the locale uses it).
 *
 * @param {number} epochSec Epoch time in SECONDS.
 * @returns {string}
 */
export const clockHHMM = (epochSec) =>
  new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
