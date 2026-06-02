// @ts-check

// Pure parser for OGame's Auctioneer "next auction in …" countdown text.
// No DOM, no clock — a plain string→seconds function so the trader feature
// can turn the displayed countdown into an absolute "quiet until" timestamp
// without any of the parsing living in the DOM layer.
//
// OGame renders the countdown in the player's locale as a worded list of
// magnitude+unit tokens, e.g. (Polish) `18min. 20sek.`, `1g. 5min. 0sek.`,
// `45sek.`. We classify each unit by its leading letters rather than an
// exact word so the common locales work without a translation table:
//   - hours   — `g`/`godz` (PL), `h` (EN), `std` (DE)
//   - minutes — `min` (most), bare `m`
//   - seconds — `sek`/`sec`/`s`
// A bare `H:MM` / `H:MM:SS` colon form is also accepted as a fallback.

/**
 * Classify a unit token (already lower-cased) to its multiplier in seconds,
 * or `null` if it isn't a recognised time unit. Order matters: `std` (DE
 * hours) starts with `s` like `sek`, so hours are tested before seconds.
 *
 * @param {string} u
 * @returns {number | null}
 */
const unitSeconds = (u) => {
  if (u.startsWith('g') || u.startsWith('h') || u.startsWith('std')) return 3600;
  if (u.startsWith('min') || u === 'm') return 60;
  if (u.startsWith('s')) return 1; // sek / sec / s
  return null;
};

/**
 * Parse a countdown string into whole seconds.
 *
 * @param {unknown} text Raw element text (e.g. `"18min. 20sek."`).
 * @returns {number | null} Non-negative seconds, or `null` when nothing
 *   parseable / time-unit-bearing is found (so callers can skip stamping).
 */
export const parseTraderCountdown = (text) => {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Worded form: a run of `<number><unit>` tokens. Sum every recognised one;
  // require at least one so a bare number (no unit) doesn't read as seconds.
  let total = 0;
  let matched = false;
  for (const m of trimmed.matchAll(/(\d+)\s*([\p{L}]+)/gu)) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    const mult = unitSeconds(m[2].toLowerCase());
    if (mult === null) continue;
    total += n * mult;
    matched = true;
  }
  if (matched) return total;

  // Fallback: `H:MM` or `H:MM:SS` (or `M:SS`) colon notation.
  const colon = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colon) {
    const a = parseInt(colon[1], 10);
    const b = parseInt(colon[2], 10);
    const c = colon[3] === undefined ? null : parseInt(colon[3], 10);
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  return null;
};
