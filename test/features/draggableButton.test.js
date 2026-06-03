// @vitest-environment happy-dom
//
// Tests for the shared draggable-button stacking behaviour: the most
// recently touched button is raised above the others via a monotonic
// z-index dispenser (so a growing pile of floating buttons stays usable).
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import { installDrag } from '../../src/features/shared/draggableButton.js';

/**
 * Make a positioned element wired with installDrag, appended to body.
 * @param {string} id
 */
const makeButton = (id) => {
  const el = document.createElement('button');
  el.id = id;
  el.style.zIndex = '99999';
  document.body.appendChild(el);
  installDrag({ element: el, posKey: `pos_${id}` });
  return el;
};

/**
 * Simulate a pointer press (drag/tap start) on an element.
 * @param {HTMLElement} el
 */
const press = (el) => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }));
  // Release immediately so we don't leave document-level mousemove bound.
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('draggable button stacking (last touched on top)', () => {
  it('raises a button above the others when touched', () => {
    const a = makeButton('a');
    const b = makeButton('b');
    press(a);
    expect(Number(a.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
  });

  it('promotes whichever was touched most recently', () => {
    const a = makeButton('a');
    const b = makeButton('b');
    press(a);
    press(b);
    expect(Number(b.style.zIndex)).toBeGreaterThan(Number(a.style.zIndex));
    press(a);
    expect(Number(a.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
  });

  it('lifts the touched button above the static 99999 baseline', () => {
    const a = makeButton('a');
    press(a);
    expect(Number(a.style.zIndex)).toBeGreaterThan(99999);
  });
});
