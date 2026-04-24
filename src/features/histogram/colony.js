// @ts-check

// Colony-size histogram renderer — builds the position-filter options,
// the five stat cards (Count / Min / Max / Average / Median), and the
// bar chart that maps `fields` values to their occurrence counts.
//
// Pure DOM module. Every node is produced with `document.createElement`
// so we never touch innerHTML and never need CSS sanitisation. All
// required styles already ship in `histogram.html` — this module only
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
// @see ../../../histogram.html       — CSS definitions for every class used

import {
  computeFieldStats,
  buildFieldBuckets,
} from '../../domain/histogram.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 */

// Bar-height constants. The chart container is 300px tall; we reserve
// ~55px for the top count label and bottom
// rotated fields label, leaving 240px of usable bar area. `MIN_BAR_PX`
// guarantees that a bucket with a single entry still renders visibly
// when another bucket dominates the scale.
const BAR_AREA_PX = 240;
const MIN_BAR_PX = 3;

/**
 * Populate the position filter `<select>` with one option per distinct
 * `position` observed in `entries`, sorted ascending.
 *
 * The first option (`<option value="all">`) is pre-rendered in
 * `histogram.html` and must survive re-renders — we preserve it and
 * pop only the Position-N entries added by previous calls. That keeps
 * the user's current selection valid across refreshes whenever they're
 * still on "all".
 *
 * @param {HTMLSelectElement} selectEl
 * @param {ReadonlyArray<ColonyEntry>} entries
 * @returns {void}
 */
export const populatePositionFilter = (selectEl, entries) => {
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
  // `Math.max(...[])` is -Infinity; buckets is guaranteed non-empty
  // here because entries.length > 0 was checked above.
  const maxCount = Math.max(...buckets.values());

  for (const [fields, count] of buckets) {
    // Compute height in pixels rather than percent: the bar lives
    // inside a nested flex chain, and `height:X%` resolves against
    // `.bar-group`'s content height instead of the intended 300px
    // chart area, which silently zeroes the bars.
    const barHeightPx = Math.max(
      Math.round((count / maxCount) * BAR_AREA_PX),
      MIN_BAR_PX,
    );

    const group = document.createElement('div');
    group.className = 'bar-group';

    const countLabel = document.createElement('div');
    countLabel.className = 'bar-count';
    countLabel.textContent = String(count);
    group.appendChild(countLabel);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = barHeightPx + 'px';
    bar.title = fields + ' fields: ' + count + 'x';
    group.appendChild(bar);

    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = String(fields);
    group.appendChild(label);

    chartEl.appendChild(group);
  }
};
