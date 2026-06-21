// @ts-check

// Shared per-system tooltip text. Both the galaxy pixel map
// (`galaxy.js` → `renderSystemPixel`) and the Top-region strip
// (`freeStreak.js` → `buildStrip`) hover-describe a single system the
// same way: coordinates, scan time, then one line per occupied slot with
// its status, flags and owner. Centralised here so the two views can
// never drift — a fix to the breakdown shows up in both.
//
// PURE: produces a plain `\n`-joined string (rendered through the native
// `title` attribute, which honours `\n` everywhere worth caring about).
// No DOM, no storage, no clock beyond formatting the stored `scannedAt`.
//
// @see ./galaxy.js     — pixel-map consumer
// @see ./freeStreak.js — region-strip consumer

/**
 * @typedef {import('../../state/scans.js').SystemScan} SystemScan
 */

/**
 * Build the multi-line hover text for one system.
 *
 * Layout (each line):
 * ```
 *   [g:s] scanned 17.06.2026, 22:07:08
 *     8: vacation (hasMoon) [UP4DLY #11 2040]
 *    10: long_inactive [Doltra]
 * ```
 * Only slots that carry an observation are listed; an empty / never-seen
 * slot produces no line. Player suffix shows name, then `#rank` and the
 * alliance tag when we recorded them (raw material already stored on the
 * Position — surfacing it here costs nothing and answers "who is that?").
 *
 * @param {number} g  Galaxy.
 * @param {number} s  System.
 * @param {SystemScan | null | undefined} scan  The stored scan, or nullish
 *   for a never-scanned system (returns the single "not scanned" line).
 * @returns {string}
 */
export const buildSystemTooltip = (g, s, scan) => {
  const coord = '[' + g + ':' + s + ']';
  if (!scan || !scan.positions) return coord + ' not scanned';

  /** @type {string[]} */
  const lines = [];
  lines.push(coord + ' scanned ' + new Date(scan.scannedAt).toLocaleString());

  for (let pos = 1; pos <= 15; pos++) {
    const p = scan.positions[pos];
    if (!p) continue;
    // Flags only ever hold `true`, but the truthy filter keeps this robust
    // against future shape drift (same guard the renderers used inline).
    const flagStr = p.flags
      ? ' (' +
        Object.keys(p.flags)
          .filter((f) => /** @type {Record<string, unknown>} */ (p.flags)[f])
          .join(',') +
        ')'
      : '';
    let playerStr = '';
    if (p.player) {
      const rankStr = typeof p.player.rank === 'number' ? ' #' + p.player.rank : '';
      const allyStr = p.player.ally ? ' ' + p.player.ally : '';
      playerStr = ' [' + p.player.name + rankStr + allyStr + ']';
    }
    lines.push(
      '  ' + String(pos).padStart(2, ' ') + ': ' + p.status + flagStr + playerStr,
    );
  }

  return lines.join('\n');
};
