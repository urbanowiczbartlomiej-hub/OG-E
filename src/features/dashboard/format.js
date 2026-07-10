// @ts-check

// Dashboard-local formatting helpers shared across the sibling renderer files
// (targets.js / cards.js / dossier.js). A neutral leaf module so the renderers
// import ONE canonical formatter instead of each carrying a hand-copied clone
// that silently drifts. Pure: no DOM, no timers, no storage.

/**
 * Compact magnitude ("4.57B" / "47.9M" / "880K"), '—' when absent — keeps the
 * numeric columns/cards narrow. Exact values stay available in cell tooltips.
 * @param {number|undefined} n
 * @returns {string}
 */
export function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}
