// @vitest-environment happy-dom

// Behavioural tests for the chip-group controls in
// features/dashboard/chips.js — the Galaxy Viewer's replacement for its
// small <select>s. A group is a `<div class="chip-group" data-value="…">`
// holding one `<button data-value="…">` per option; the container's
// data-value is the single source of truth and the `.on` class marks the
// active chip. These drive the four helpers through happy-dom and assert
// the observable DOM + delegated-click behaviour:
//
//   • chipValue reads the current data-value (and '' for a null element);
//   • setChipValue moves the selection + repaints `.on`, and REFUSES an
//     unknown value (returns false, leaves the group untouched);
//   • wireChips paints the initial `.on` and delegates clicks (clicking a
//     chip selects it + fires onChange; re-clicking the active one is a
//     no-op);
//   • setChipsEnabled(false) marks the group `.disabled` so a click no
//     longer changes the value, and writes the reason into a sibling note.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  chipValue,
  setChipValue,
  wireChips,
  setChipsEnabled,
} from '../../../src/features/dashboard/chips.js';

/**
 * Build a minimal chip group: `<div class="chip-group" data-value=initial>`
 * with one `<button data-value=v>` per option. The `.on` marker is NOT
 * pre-painted (that is wireChips/setChipValue's job) — mirrors the static
 * markup index.js emits.
 * @param {string} initial
 * @param {string[]} options
 */
const makeGroup = (initial, options) => {
  const el = document.createElement('div');
  el.className = 'chip-group';
  el.dataset.value = initial;
  for (const v of options) {
    const b = document.createElement('button');
    b.dataset.value = v;
    b.textContent = v;
    el.appendChild(b);
  }
  return el;
};

/** The set of button data-values currently carrying `.on`. @param {HTMLElement} el */
const onValues = (el) =>
  [...el.querySelectorAll('button.on')].map((b) => /** @type {HTMLElement} */ (b).dataset.value);

describe('chipValue', () => {
  it('reads the group\'s current data-value', () => {
    const el = makeGroup('farm', ['safe', 'farm', 'pvp']);
    expect(chipValue(el)).toBe('farm');
  });

  it('returns \'\' for a null element (DOM-less tests)', () => {
    expect(chipValue(null)).toBe('');
  });

  it('returns \'\' when the group carries no data-value', () => {
    const el = document.createElement('div');
    expect(chipValue(el)).toBe('');
  });
});

describe('setChipValue', () => {
  it('moves the selection to a valid value and repaints the `.on` marker', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    const applied = setChipValue(el, 'pvp');
    expect(applied).toBe(true);
    expect(el.dataset.value).toBe('pvp');
    expect(onValues(el)).toEqual(['pvp']);
  });

  it('moving to another value clears the previous `.on` (exactly one active)', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    setChipValue(el, 'farm');
    expect(onValues(el)).toEqual(['farm']);
    setChipValue(el, 'safe');
    expect(onValues(el)).toEqual(['safe']);
  });

  it('rejects a value no chip carries: returns false and leaves the group untouched', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    setChipValue(el, 'safe'); // paint a known-good `.on` first
    const applied = setChipValue(el, 'ghost');
    expect(applied).toBe(false);
    // data-value and the `.on` marker are unchanged.
    expect(el.dataset.value).toBe('safe');
    expect(onValues(el)).toEqual(['safe']);
  });

  it('returns false for a null element', () => {
    expect(setChipValue(null, 'safe')).toBe(false);
  });
});

describe('wireChips', () => {
  it('paints the initial `.on` from the static data-value', () => {
    const el = makeGroup('farm', ['safe', 'farm', 'pvp']);
    wireChips(el, () => {});
    expect(onValues(el)).toEqual(['farm']);
  });

  it('a click selects the clicked chip and fires onChange with its value', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    /** @type {string[]} */
    const changes = [];
    wireChips(el, (v) => changes.push(v));

    /** @type {HTMLButtonElement} */ (el.querySelector('button[data-value="pvp"]')).click();

    expect(chipValue(el)).toBe('pvp');
    expect(onValues(el)).toEqual(['pvp']);
    expect(changes).toEqual(['pvp']);
  });

  it('re-clicking the already-active chip is a no-op (no onChange, value stays)', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    /** @type {string[]} */
    const changes = [];
    wireChips(el, (v) => changes.push(v));

    /** @type {HTMLButtonElement} */ (el.querySelector('button[data-value="safe"]')).click();

    expect(changes).toEqual([]);
    expect(chipValue(el)).toBe('safe');
  });

  it('a click on non-chip content inside the group is ignored', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    const label = document.createElement('span');
    label.textContent = 'label';
    el.insertBefore(label, el.firstChild);
    /** @type {string[]} */
    const changes = [];
    wireChips(el, (v) => changes.push(v));

    label.click();

    expect(changes).toEqual([]);
    expect(chipValue(el)).toBe('safe');
  });

  it('a null element is a safe no-op (no throw)', () => {
    expect(() => wireChips(null, () => {})).not.toThrow();
  });
});

describe('setChipsEnabled', () => {
  it('disabling makes the wired group ignore clicks (value no longer changes)', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    /** @type {string[]} */
    const changes = [];
    wireChips(el, (v) => changes.push(v));

    setChipsEnabled(el, false, null, 'disabled because reasons');
    expect(el.classList.contains('disabled')).toBe(true);

    /** @type {HTMLButtonElement} */ (el.querySelector('button[data-value="pvp"]')).click();

    // The disabled guard short-circuits the delegated handler.
    expect(chipValue(el)).toBe('safe');
    expect(changes).toEqual([]);
  });

  it('re-enabling restores click handling', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    /** @type {string[]} */
    const changes = [];
    wireChips(el, (v) => changes.push(v));

    setChipsEnabled(el, false, null, 'off');
    /** @type {HTMLButtonElement} */ (el.querySelector('button[data-value="pvp"]')).click();
    expect(changes).toEqual([]);

    setChipsEnabled(el, true, null, 'off');
    expect(el.classList.contains('disabled')).toBe(false);
    /** @type {HTMLButtonElement} */ (el.querySelector('button[data-value="pvp"]')).click();
    expect(chipValue(el)).toBe('pvp');
    expect(changes).toEqual(['pvp']);
  });

  it('writes the note text only while disabled, and clears it when enabled', () => {
    const el = makeGroup('safe', ['safe', 'farm', 'pvp']);
    const noteEl = document.createElement('div');

    setChipsEnabled(el, false, noteEl, 'not applicable right now');
    expect(noteEl.textContent).toBe('not applicable right now');

    setChipsEnabled(el, true, noteEl, 'not applicable right now');
    expect(noteEl.textContent).toBe('');
  });

  it('tolerates null el / null noteEl without throwing', () => {
    const noteEl = document.createElement('div');
    expect(() => setChipsEnabled(null, false, noteEl, 'x')).not.toThrow();
    expect(noteEl.textContent).toBe('x');
    expect(() => setChipsEnabled(makeGroup('safe', ['safe']), false, null, 'x')).not.toThrow();
  });
});
