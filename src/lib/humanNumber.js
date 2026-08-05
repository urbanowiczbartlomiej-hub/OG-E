// @ts-check

// Human number I/O — parse and print the magnitudes OGame players actually
// type. A raw `<input type="number">` for a military score means typing
// 15000000 and then counting the zeros to check it; nobody does that. So the
// filter boxes take what the game's own community writes:
//
//   15M · 2.5b · 800k · 15kk · 1 250 000 · 1,25M
//
// `kk`/`kkk` are not a typo: in OGame trade and raid talk "kk" IS the million
// (and "kkk" the billion), and a filter that rejected it would look broken to
// the people most likely to use it.
//
// Pure string↔number: no DOM, no storage — the `lib/` contract (zero app deps).

/** Suffix → multiplier. `kk`/`kkk` are the community's million/billion. */
const SUFFIX = /** @type {Record<string, number>} */ ({
  k: 1e3,
  kk: 1e6,
  kkk: 1e9,
  m: 1e6,
  b: 1e9,
});

/**
 * Parse a typed magnitude into a plain number.
 *
 * Tolerant on purpose: thousands separators (spaces, dots, commas,
 * apostrophes) are noise from a copy-paste, and both `.` and `,` show up as the
 * decimal comma depending on the player's locale. Anything that isn't a number
 * with an optional known suffix returns `null` — the caller decides what an
 * unparseable box means (here: "no bound").
 *
 * @param {string | number | null | undefined} raw
 * @returns {number | null}  Non-negative number, or null when there is nothing
 *   parseable in the input.
 */
export const parseHumanNumber = (raw) => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/[\s'_]/g, '');
  if (!s) return null;
  const m = s.match(/^(\d+(?:[.,]\d+)?|\d{1,3}(?:[.,]\d{3})+)(k{1,3}|m|b)?$/);
  if (!m) return null;
  let digits = m[1];
  const suffix = m[2] || '';
  // "1.250.000" / "1,250,000" — repeated 3-digit groups are thousands
  // separators, not a decimal point. A single group (1.25) is a decimal.
  if (/^\d{1,3}([.,]\d{3})+$/.test(digits)) digits = digits.replace(/[.,]/g, '');
  else digits = digits.replace(',', '.');
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * (SUFFIX[suffix] ?? 1);
};

/**
 * Print a number the way it is typed back in — the round trip of
 * {@link parseHumanNumber}, with trailing zeros trimmed (`15M`, not `15.0M`),
 * so re-reading a stored filter shows what a person would have written.
 *
 * @param {number | null | undefined} n
 * @returns {string}  Empty string for null/0 — an empty box is "no bound".
 */
export const formatHumanNumber = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  /** @type {Array<[number, string]>} */
  const steps = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [unit, tag] of steps) {
    if (n < unit) continue;
    const v = n / unit;
    // Two decimals max, and only while they say something (2.5M, 1.25B, 15M).
    const txt = v >= 100 ? v.toFixed(0) : String(Math.round(v * 100) / 100);
    return `${txt}${tag}`;
  }
  return String(Math.round(n));
};
