// @ts-check

// Colony-size histogram renderer — builds the position-filter options,
// the five stat cards (Count / Min / Max / Average / Median), and the
// bar chart that maps `fields` values to their occurrence counts.
//
// Pure DOM module. Every node is produced with `document.createElement`
// so we never touch innerHTML and never need CSS sanitisation. All
// required styles already ship in `dashboard.html` — this module only
// sets class names, text content, and a single inline `height` on each
// bar (see the bar-height algorithm note below).
//
// The caller owns data flow: it reads the filter value, runs the
// filter, and passes an already-filtered `entries` array in. Keeping
// the filter logic out here lets the page reuse these renderers from
// any data source (history, tests) without coupling them to the
// storage layer.
//
// @see ../../domain/histogram.js     — computeFieldStats / buildFieldBuckets
// @see ../../../dashboard.html       — CSS definitions for every class used

import {
  computeFieldStats,
  buildFieldBuckets,
  binFieldBuckets,
} from '../../domain/histogram.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../domain/histogram.js').FieldBin} FieldBin
 */

// Bar-height constants. The chart container is 300px tall; we reserve
// ~80px for the top count label (up to ~36px, vertical-rl) plus the
// bottom rotated fields label (40px) plus a few px of margin, leaving
// 220px of usable bar area. `MIN_BAR_PX` guarantees that a bucket
// with a single entry still renders visibly when another bucket
// dominates the scale.
//
// On narrow screens (≤640px) binning produces longer range labels
// ("318-320"); the dashboard.html media query grows BOTH the fields-label
// strip (72px) AND the chart container (336px) in lockstep, so this 220px
// bar area is unchanged — the extra height is absorbed by the label strip,
// not stolen from the bars.
const BAR_AREA_PX = 220;
const MIN_BAR_PX = 3;

/**
 * Minimum on-screen width (in CSS pixels) we want each rendered bar
 * to occupy. Below this, vertical-text labels start to overlap their
 * neighbours and the chart turns into a smear. The renderer measures
 * the chart's available width at render time and picks a `binSize`
 * such that `bucketCount / binSize ≤ availableWidth / MIN_BAR_WIDTH_PX`
 * — i.e. each rendered bar is at least this wide.
 *
 * The number is empirical: 8 px keeps the rotated 3-digit labels
 * (e.g. "200") just-readable on a typical 1366 px laptop with ~140
 * field-size buckets, and falls back to 2-step binning if the player
 * has even more distinct sizes.
 */
const MIN_BAR_WIDTH_PX = 8;

/**
 * Fallback width used when the chart container reports `clientWidth
 * === 0`. That happens when the colony tab is hidden behind another
 * tab (its `display: none` zeroes the layout) but the renderer still
 * runs to keep the data fresh. We estimate the on-screen width from
 * the viewport instead so binning still picks a sensible value.
 *
 * Subtracts twice the body's 20 px padding (see dashboard.html) so
 * the estimate matches what the chart will actually get once shown.
 *
 * @returns {number}
 */
const estimateChartWidth = () => Math.max(200, window.innerWidth - 40);

/**
 * Populate the position filter `<select>` with one option per distinct
 * `position` observed in `entries`, sorted ascending.
 *
 * The first option (`<option value="all">`) is pre-rendered in
 * `dashboard.html` and must survive re-renders — we preserve it and
 * pop only the Position-N entries added by previous calls.
 *
 * # Preserving the user's selection across re-populates
 *
 * Browsers reset `select.value` to the first option whenever the
 * currently-selected `<option>` is removed. Our re-populate wipes
 * every Position-N option and re-adds them fresh, which means a user
 * who had `"Position 8"` selected would silently snap back to
 * `"all"` on every render triggered by the `change` handler itself
 * — dropping the filter as soon as the user picked one. We save the
 * pre-rebuild `.value` here and set it back after the rebuild; if
 * the option is still present (usual case) it sticks, and if the
 * user filtered on a position that no longer exists in `entries` the
 * browser's own default-to-first-option behaviour takes over,
 * sending them to `"all"` — which is the correct fallback.
 *
 * @param {HTMLSelectElement} selectEl
 * @param {ReadonlyArray<ColonyEntry>} entries
 * @returns {void}
 */
export const populatePositionFilter = (selectEl, entries) => {
  const previousValue = selectEl.value;

  // Drop any Position-N entries from a previous render but keep option[0]
  // ("All positions") which is owned by the HTML template.
  while (selectEl.options.length > 1) {
    selectEl.remove(selectEl.options.length - 1);
  }

  const distinct = new Set(entries.map((e) => e.position));
  const sorted = [...distinct].sort((a, b) => a - b);
  for (const pos of sorted) {
    const opt = document.createElement('option');
    opt.value = String(pos);
    opt.textContent = 'Position ' + pos;
    selectEl.appendChild(opt);
  }

  // Restore the pre-rebuild selection. Assignment to a value that
  // doesn't match any option silently lands on `""` on Firefox and
  // the first option on Chrome; both behave as "fall back to all"
  // since the first option carries `value="all"`.
  if (previousValue && previousValue !== selectEl.value) {
    selectEl.value = previousValue;
  }
  // If the restore didn't stick (previousValue's option no longer exists),
  // some browsers leave `.value` as `""` rather than snapping to option[0]
  // ("all"). Force the fallback explicitly so callers always see a valid
  // filter value.
  if (selectEl.value === '') {
    selectEl.value = 'all';
  }
};

/**
 * Render the five stat cards into `statsEl` and the bar chart into
 * `chartEl`. When `entries` is empty, both containers are cleared and
 * an empty-state message is appended to `chartEl` only (stats stays
 * empty — an empty stats row reads as "no data" cleanly on its own).
 *
 * `countInfoEl` is updated to `"N colonies recorded"`, optionally
 * suffixed with `"(pos X)"` when `filterLabel !== 'all'`. On empty
 * data we blank it out and let the in-chart empty-state carry the
 * message — two "no data" lines would be redundant.
 *
 * Containers are emptied with `textContent = ''` rather than
 * `replaceChildren()` to preserve any layout wrappers or pseudo-
 * elements the page stylesheet attaches to the container itself.
 *
 * @param {{
 *   statsEl: HTMLElement,
 *   chartEl: HTMLElement,
 *   countInfoEl: HTMLElement,
 *   entries: ReadonlyArray<ColonyEntry>,
 *   filterLabel: string | 'all',
 * }} opts
 * @returns {void}
 */
export const renderColonyChart = (opts) => {
  const { statsEl, chartEl, countInfoEl, entries, filterLabel } = opts;

  statsEl.textContent = '';
  chartEl.textContent = '';

  if (entries.length === 0) {
    countInfoEl.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No colony data recorded yet. Open the overview of a freshly colonized planet (before anything is built on it) to start collecting.';
    chartEl.appendChild(empty);
    return;
  }

  countInfoEl.textContent =
    entries.length +
    ' colonies recorded' +
    (filterLabel !== 'all' ? ' (pos ' + filterLabel + ')' : '');

  const stats = computeFieldStats(entries);

  // Stat cards in the canonical order so users who scan the row by
  // position (not label) see the same numbers in the same slots.
  /** @type {Array<[string, number]>} */
  const cards = [
    ['Count', entries.length],
    ['Min', stats.min],
    ['Max', stats.max],
    ['Average', stats.avg],
    ['Median', stats.median],
  ];
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'stat-card';

    const valEl = document.createElement('div');
    valEl.className = 'stat-value';
    valEl.textContent = String(value);
    card.appendChild(valEl);

    const labEl = document.createElement('div');
    labEl.className = 'stat-label';
    labEl.textContent = label;
    card.appendChild(labEl);

    statsEl.appendChild(card);
  }

  const buckets = buildFieldBuckets(entries);

  // Adaptive binning: when the bucket count exceeds the number of
  // bars the chart can show without each one dropping below
  // MIN_BAR_WIDTH_PX, group consecutive field values together so the
  // chart still fits the viewport AND stays legible. With binSize=1
  // (small histograms / wide screens) `binFieldBuckets` is a no-op
  // passthrough — each output bin has start === end and count
  // matches the input bucket exactly.
  const availableWidth = chartEl.clientWidth || estimateChartWidth();
  const maxBars = Math.max(1, Math.floor(availableWidth / MIN_BAR_WIDTH_PX));
  const binSize = buckets.size > maxBars
    ? Math.ceil(buckets.size / maxBars)
    : 1;
  const bins = binFieldBuckets(buckets, binSize);

  // `Math.max(...[])` is -Infinity; bins is guaranteed non-empty here
  // because entries.length > 0 was checked above. Note: with binning,
  // counts are sums across the grouped fields, which means the y-axis
  // scale is the per-bin total, not the per-fields-value total. That
  // is the right scaling — a bar 2× as tall genuinely represents 2×
  // as many recorded colonies.
  const maxCount = Math.max(...bins.map((b) => b.count));

  for (const bin of bins) {
    // Compute height in pixels rather than percent: the bar lives
    // inside a nested flex chain, and `height:X%` resolves against
    // `.bar-group`'s content height instead of the intended 300px
    // chart area, which silently zeroes the bars.
    const barHeightPx = Math.max(
      Math.round((bin.count / maxCount) * BAR_AREA_PX),
      MIN_BAR_PX,
    );

    // Single-field bins (binSize === 1, OR a tail bin that happens to
    // contain only one field) render their label and tooltip exactly
    // like the pre-binning version. Multi-field bins use a `start-end`
    // range so the user can still see what range of sizes the bar
    // represents.
    const isRange = bin.start !== bin.end;
    const label = isRange ? `${bin.start}-${bin.end}` : String(bin.start);
    const tooltip = isRange
      ? `${bin.start}-${bin.end} fields: ${bin.count}x (binned)`
      : `${bin.start} fields: ${bin.count}x`;

    const group = document.createElement('div');
    group.className = 'bar-group';

    const countLabel = document.createElement('div');
    countLabel.className = 'bar-count';
    countLabel.textContent = String(bin.count);
    group.appendChild(countLabel);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = barHeightPx + 'px';
    bar.title = tooltip;
    group.appendChild(bar);

    const labelEl = document.createElement('div');
    labelEl.className = 'bar-label';
    labelEl.textContent = label;
    group.appendChild(labelEl);

    chartEl.appendChild(group);
  }
};
