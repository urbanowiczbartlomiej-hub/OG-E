// @ts-check

// Danger-score → colour — single source of truth for mapping a 0..100 danger
// value onto its badge/cell colour. The green→amber→red thresholds
// (d <= 15, d <= 45) and their hexes used to be duplicated inline in
// features/dashboard/freeStreak.js and features/dashboard/targets.js, where
// the two copies had drifted to DIFFERENT greens/reds for the SAME thresholds.
// Unifying them here (on the brighter targets.js palette) kills that drift.
//
// Foundation module: zero app-layer deps, no DOM, no side effects.

/**
 * Map an integer danger score (0..100) to its display colour.
 *
 * @param {number} d Danger score, 0..100 (already rounded).
 * @returns {string} Hex colour: green (safe) → amber → red.
 */
export function dangerColor(d) {
  // Non-finite (NaN / ±Infinity) falls through to amber — never throw.
  if (!Number.isFinite(d)) return '#e0b020';
  return d <= 15 ? '#7fd6a8' : d <= 45 ? '#e0b020' : '#e2726a';
}

/**
 * The same mapping for the 0..1 FRACTION the danger model actually carries
 * (`DangerProfile.danger`), with an explicit colour for "we hold no profile".
 * Handing the raw fraction to {@link dangerColor} painted D 0.91 the same safe
 * green as D 0.02 — every dashboard surface that colours a row by Danger scales
 * through here so that trap can't be re-introduced one caller at a time.
 *
 * @param {number | null | undefined} d  Danger 0..1, or nothing when unknown.
 * @param {string} [unknown]  Colour for an unknown danger — NOT a zero danger.
 * @returns {string}
 */
export function dangerColor01(d, unknown = '#cfd6dd') {
  return typeof d === 'number' && Number.isFinite(d) ? dangerColor(Math.round(d * 100)) : unknown;
}
