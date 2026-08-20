// @ts-check

// Dashboard-local formatting helpers shared across the sibling renderer files
// (targets.js / cards.js / dossier.js / homeWatch.js / index.js). A neutral leaf
// module so the renderers import ONE canonical formatter instead of each
// carrying a hand-copied clone that silently drifts. Pure: no DOM, no timers,
// no storage — everything here takes plain data and returns a string.

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

/**
 * Hover text for a player NAME on a glance surface — the Danger number, the
 * reasons that produced it, then what a click does. One wording for every
 * surface that shows a clickable nick ("Your neighbours", "Who's spying on
 * you"): they show the same kind of name and open the same thing, so a second
 * wording would read as a second action.
 *
 * The tooltip EXPLAINS only. The row itself already carries the verdict as
 * colour, and the profile carries the number — nothing here is the only place
 * a fact lives (CLAUDE.md: a tooltip may explain, it may never carry).
 *
 * An absent profile says so. An unknown Danger is not a zero Danger, and
 * printing `D 0` for "we have no public-statistics row yet" reads as
 * "harmless", which is the one thing it does not mean.
 *
 * @param {{ danger?: number, reasons?: string[] } | undefined | null} prof
 * @returns {string}
 */
export function playerHoverTitle(prof) {
  if (!prof || typeof prof.danger !== 'number' || !Number.isFinite(prof.danger)) {
    return 'Danger unknown — no public-statistics profile yet.\nClick for the full profile.';
  }
  const reasons = prof.reasons?.length ? `\n${prof.reasons.join('\n')}` : '';
  // 0–100 — the scale the dossier / target rows / map dots all print.
  return `Danger ${Math.round(prof.danger * 100)}${reasons}\nClick for the full profile.`;
}
