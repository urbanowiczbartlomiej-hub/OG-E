// @ts-check

// Histogram palette — display constants (colours, labels, tooltip text)
// for the histogram extension page.
//
// PURE PRESENTATION ONLY. The corresponding domain ordering / interest
// hierarchy lives in `domain/histogram.js` (see {@link STATUS_PRIORITY}
// there). This module is a presentation-layer mapping from the canonical
// {@link PositionStatus} enum to the strings the UI renders. Keeping the
// two concerns split means a colour-scheme refresh never touches domain
// logic and vice versa.
//
// Constants are exported individually so tree-shaking can eliminate
// unused ones in callers that, for example, only render the legend
// (without needing the rescan tooltip text).
//
// @see ../../domain/histogram.js — STATUS_PRIORITY (interest order)
// @see ../../domain/scans.js     — PositionStatus enum

/**
 * @typedef {import('../../domain/scans.js').PositionStatus} PositionStatus
 */

/**
 * Colour for each {@link PositionStatus}, used by:
 *   - galaxy pixel map (one pixel per system, coloured by best status)
 *   - per-galaxy progress bar segments
 *   - legend swatches
 *   - per-status stat-card values
 *
 * Hex values map status → familiar colour ("green = colonisable, blue
 * = sent, orange = abandoned debris, etc."). Changing them would be a
 * UX regression masquerading as a refresh.
 *
 * @type {Record<PositionStatus, string>}
 */
export const STATUS_COLORS = {
  empty:         '#0c0',     // green: colonizable
  empty_sent:    '#4a9eff',  // blue: our fleet in flight
  abandoned:     '#fa0',     // orange: destroyed planet (incl. ours)
  reserved:      '#a060c0',  // violet: reserved for planet-move (DM)
  inactive:      '#dd4',     // yellow: i (7-28d)
  long_inactive: '#a855f7',  // purple: I (28+d)
  vacation:      '#888',     // light gray
  banned:        '#822',     // dark red
  admin:         '#e08fb3',  // pink
  occupied:      '#555',     // gray: active player
  mine:          '#37a',     // dim blue: our colony
};

/**
 * Human-readable label for each {@link PositionStatus}. Drives the legend
 * row, stat-card labels, and tooltip lines in the per-system pixel
 * tooltip.
 *
 * Inactive variants get the in-game `(i)` / `(I)` suffix the user is
 * already familiar with.
 *
 * @type {Record<PositionStatus, string>}
 */
export const STATUS_LABELS = {
  empty:         'Empty',
  empty_sent:    'Sent',
  abandoned:     'Abandoned',
  reserved:      'Reserved',
  inactive:      'Inactive (i)',
  long_inactive: 'Inactive (I)',
  vacation:      'Vacation',
  banned:        'Banned',
  admin:         'Admin',
  occupied:      'Occupied',
  mine:          'Mine',
};

/**
 * Tooltip text for the rescan-policy ⓘ icon next to the target-positions
 * filter bar. Multi-line plain text rendered through the native HTML
 * `title` attribute (which preserves `\n` on every browser worth caring
 * about).
 *
 * Mirrors the policy in `domain/scheduling.js` — when the user hovers
 * the icon they should see the same thresholds the actual scan
 * scheduler will use, not a separately maintained rendering. If the
 * policy changes there, this string changes here.
 */
export const RESCAN_TOOLTIP = [
  'Re-scan policy (when Scan will revisit a system with this status):',
  '',
  '  empty                    — never (stable, awaits Send)',
  '  empty_sent (our fleet)   — 4 hours after send',
  '  abandoned (debris)       — dynamic 25-47h (next 3 AM after 24h grace)',
  '  inactive (i) 7-28d       — 5 days',
  '  inactive (I) 28+d        — 5 days',
  '  vacation                 — 30 days',
  '  banned                   — 30 days',
  '  occupied (active player) — 30 days',
  '  mine                     — never (we know the state)',
  '  admin                    — never (untouchable)',
  '  not scanned              — highest priority, immediate',
  '',
  'A system is eligible for re-scan as soon as ANY of its 15 positions',
  'has exceeded its threshold.',
].join('\n');

/**
 * Colour for the "no data yet" pixel in the galaxy map and the legend
 * swatch beside the "Not scanned" label. Distinct from any
 * {@link STATUS_COLORS} value so an unscanned system is visually
 * unmistakable.
 */
export const UNSCANNED_COLOR = '#1a1a2a';

/**
 * Subtle border drawn around unscanned pixels — keeps them visible
 * against the page background, which is a similar dark shade.
 */
export const UNSCANNED_BORDER = '1px solid #222';

/**
 * Colour of the "stale — due for rescan" inset ring drawn around
 * system pixels whose scan is older than the per-status threshold. A
 * warm amber that reads distinctly from every {@link STATUS_COLORS}
 * entry while leaning "attention, but not alarm" — stale scans are a
 * nudge, not a problem.
 */
export const STALE_COLOR = '#ffd84d';

/**
 * Label used next to the {@link STALE_COLOR} swatch in the galaxy-map
 * legend. Explicit about the recommended user action so hovering the
 * legend is enough — no secondary tooltip needed.
 */
export const STALE_LABEL = 'Stale — rescan recommended';
