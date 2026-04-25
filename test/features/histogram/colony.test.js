// @vitest-environment happy-dom
//
// Unit tests for `features/histogram/colony.js` — the colony-size
// histogram renderer. We exercise the `populatePositionFilter` helper
// in particular because it underpins the position filter on the
// histogram page; a regression there silently drops user selections
// and was observed in the wild.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';

import { populatePositionFilter } from '../../../src/features/histogram/colony.js';

/**
 * @typedef {import('../../../src/state/history.js').ColonyEntry} ColonyEntry
 */

/**
 * Build a `<select>` pre-seeded with the `<option value="all">` entry
 * the real histogram.html template ships. populatePositionFilter
 * assumes option[0] exists and represents "All positions".
 *
 * @returns {HTMLSelectElement}
 */
const makeSelect = () => {
  const sel = document.createElement('select');
  const opt = document.createElement('option');
  opt.value = 'all';
  opt.textContent = 'All positions';
  sel.appendChild(opt);
  return sel;
};

/**
 * Build a minimal ColonyEntry with the fields populatePositionFilter
 * actually reads (just `position`). Other fields are filled with
 * dummy values — we cast via `unknown` to avoid fighting the
 * structural type for tests.
 *
 * @param {number} position
 * @returns {ColonyEntry}
 */
const entry = (position) =>
  /** @type {ColonyEntry} */ (/** @type {unknown} */ ({
    cp: 1,
    fields: 200,
    coords: '[1:1:' + position + ']',
    position,
    timestamp: 1,
  }));

describe('populatePositionFilter', () => {
  /** @type {HTMLSelectElement} */
  let sel;

  beforeEach(() => {
    sel = makeSelect();
  });

  it('appends one option per distinct position in ascending order', () => {
    populatePositionFilter(sel, [entry(8), entry(15), entry(4), entry(8)]);
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toEqual(['all', '4', '8', '15']);
    expect(sel.options[1].textContent).toBe('Position 4');
  });

  it('drops old Position-N options on re-populate', () => {
    populatePositionFilter(sel, [entry(8)]);
    expect(sel.options.length).toBe(2);
    // Data shrinks — the previous Position-8 option should be gone.
    populatePositionFilter(sel, [entry(15)]);
    expect(sel.options.length).toBe(2);
    expect(sel.options[1].value).toBe('15');
  });

  it('preserves the current selection across re-populates', () => {
    // Regression guard. The previous revision wiped all non-first
    // options and let the browser default the select back to "all"
    // — which made the position filter appear dead: the user would
    // pick a value, the change handler would call this function,
    // and the selection would silently reset before the filter
    // applied. A user-visible "I select 8 but All stays highlighted"
    // bug straight to the histogram UI.
    populatePositionFilter(sel, [entry(8), entry(15)]);
    sel.value = '8';
    expect(sel.value).toBe('8');

    // Simulate a subsequent render with the same data — e.g. triggered
    // by the select's own `change` handler.
    populatePositionFilter(sel, [entry(8), entry(15)]);
    expect(sel.value).toBe('8');
  });

  it('falls back to "all" when the previously-selected position vanishes', () => {
    populatePositionFilter(sel, [entry(8), entry(15)]);
    sel.value = '8';

    // User (or data) removed Position 8 before the next render. Our
    // saved previous value no longer matches any option; the browser
    // defaults to the first option, which is `"all"`. We don't want
    // to silently keep a stale value visible.
    populatePositionFilter(sel, [entry(15)]);
    expect(['', 'all']).toContain(sel.value);
  });

  it('handles an empty entries array by keeping only "all"', () => {
    populatePositionFilter(sel, []);
    expect(sel.options.length).toBe(1);
    expect(sel.options[0].value).toBe('all');
  });
});
