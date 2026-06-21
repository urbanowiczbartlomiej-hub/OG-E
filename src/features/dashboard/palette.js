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
// unused ones in callers that, for example, only render the legend.
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
 * Colour for the "no data yet" pixel in the galaxy map and the legend
 * swatch beside the "Not scanned" label. Distinct from any
 * {@link STATUS_COLORS} value so an unscanned system is visually
 * unmistakable. (Rare now the map is API-derived — every system is known —
 * but kept for the no-API-cache fallback.)
 */
export const UNSCANNED_COLOR = '#1a1a2a';

/**
 * Subtle border drawn around unscanned pixels — keeps them visible
 * against the page background, which is a similar dark shade.
 */
export const UNSCANNED_BORDER = '1px solid #222';
