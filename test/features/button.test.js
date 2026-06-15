// @vitest-environment happy-dom
//
// Behavioural tests for the shared, config-driven Button component
// (features/shared/button.js). We drive real DOM events through happy-dom
// and assert observable output — structure, the label span, per-zone
// background/dim, resize, the long-press gesture and dispose — NOT pixels.
// The engraved-ring/ripple decoration and the drag/focus primitives have
// their own tests (buttonChrome.test.js, draggableButton.test.js); here we
// prove this component composes them and exposes the right surface.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createButton, LABEL_CLASS } from '../../src/features/shared/button.js';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
});

/** Read a zone's painted label text (the `.oge-btn-label` span only — so
 * the engraved ring title sharing a single-zone host doesn't pollute it). */
const labelOf = (/** @type {HTMLElement} */ el) =>
  el.querySelector('.' + LABEL_CLASS)?.textContent;

describe('single-zone button', () => {
  /** @returns {import('../../src/features/shared/button.js').Button} */
  const make = (onTap = () => {}) =>
    /** @type {any} */ (
      createButton({
        id: 'oge-test-single',
        title: 'Expeditions',
        ringId: 'oge-ring-test',
        size: 80,
        fontScale: 0.23,
        posKey: 'oge_test_pos',
        zones: [{ key: 'main', id: 'oge-test-single', ariaLabel: 'Do it', bg: 'red', onTap }],
      })
    );

  it('mounts a single <button> carrying the id, title and aria-label', () => {
    make();
    const btn = document.getElementById('oge-test-single');
    expect(btn?.tagName).toBe('BUTTON');
    expect(btn?.getAttribute('aria-label')).toBe('Do it');
    expect(btn?.title).toBe('Expeditions');
    expect(btn?.style.getPropertyValue('--rim')).toBe('red');
  });

  it('returns null on a redundant mount (idempotent)', () => {
    const first = make();
    const second = make();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(document.querySelectorAll('#oge-test-single').length).toBe(1);
  });

  it('setText paints the label span without clobbering the ring decoration', () => {
    const ctl = make();
    ctl.setText('main', 'Send Exp');
    const btn = /** @type {HTMLElement} */ (document.getElementById('oge-test-single'));
    expect(labelOf(btn)).toBe('Send Exp');
    // The engraved ring SVG appended by decorateButton survives a repaint.
    expect(btn.querySelector('.oge-ring')).not.toBeNull();
    ctl.setText('main', 'Sent!');
    expect(labelOf(btn)).toBe('Sent!');
    expect(btn.querySelector('.oge-ring')).not.toBeNull();
  });

  it('setDim greys the fill layer (not the host chrome); setBg updates --rim', () => {
    const ctl = make();
    const btn = /** @type {HTMLElement} */ (document.getElementById('oge-test-single'));
    const surface = /** @type {HTMLElement} */ (btn.querySelector('.oge-surface'));
    expect(surface).not.toBeNull();
    ctl.setDim('main', true);
    // The dim lands on the fill, leaving the host (rim/ring/lens) untouched.
    expect(surface.style.opacity).toBe('0.5');
    expect(btn.style.opacity).toBe('');
    ctl.setDim('main', false);
    expect(surface.style.opacity).toBe('1');
    ctl.setBg('main', '#38bdf8');
    expect(btn.style.getPropertyValue('--rim')).toBe('#38bdf8');
  });

  it('keeps the label and glyph lens inside/above the fill so the dim greys the label too', () => {
    const ctl = make();
    const btn = /** @type {HTMLElement} */ (document.getElementById('oge-test-single'));
    // Label rides the fill layer (so one dim greys both); the lens does not.
    expect(btn.querySelector('.oge-surface .' + LABEL_CLASS)).not.toBeNull();
    ctl.setText('main', 'Go');
    expect(labelOf(btn)).toBe('Go');
  });

  it('resize updates diameter and font-size', () => {
    const ctl = make();
    const btn = /** @type {HTMLElement} */ (document.getElementById('oge-test-single'));
    ctl.resize(120);
    expect(btn.style.width).toBe('120px');
    expect(btn.style.height).toBe('120px');
    // Single-zone labels render 1px under the raw scale.
    expect(btn.style.fontSize).toBe(Math.round(120 * 0.23) - 1 + 'px');
  });

  it('fires onTap on a plain click', () => {
    let taps = 0;
    make(() => (taps += 1));
    /** @type {HTMLElement} */ (document.getElementById('oge-test-single')).click();
    expect(taps).toBe(1);
  });

  it('dispose removes the element', () => {
    const ctl = make();
    ctl.dispose();
    expect(document.getElementById('oge-test-single')).toBeNull();
  });

  it('carries the glyph in a brand node (the module-coloured oczko)', () => {
    createButton({
      id: 'oge-test-wm',
      title: 'Exp',
      ringId: 'oge-ring-wm',
      size: 80,
      fontScale: 0.23,
      posKey: 'oge_test_wm_pos',
      zones: [
        { key: 'main', id: 'oge-test-wm', bg: 'red', glyph: '<circle r="10"/>', onTap: () => {} },
      ],
    });
    const btn = /** @type {HTMLElement} */ (document.getElementById('oge-test-wm'));
    // The oczko is the same `.oge-node` dome the FAB satellite orbs wear,
    // carrying the glyph in the shared `.oge-art` layer.
    const node = btn.querySelector('.oge-lens.oge-node');
    expect(node).not.toBeNull();
    expect(node?.querySelector('.oge-art svg')).not.toBeNull();
    // The gold orbit mark is retired from command buttons (now on the
    // dashboard button only).
    expect(btn.querySelector('.oge-lens-orbit')).toBeNull();
  });
});

describe('two-zone button', () => {
  /** @returns {import('../../src/features/shared/button.js').Button} */
  const make = (top = () => {}, bottom = () => {}, onHold = undefined) =>
    /** @type {any} */ (
      createButton({
        id: 'oge-test-split',
        title: 'Daily',
        ringId: 'oge-ring-split',
        size: 80,
        fontScale: 0.14,
        posKey: 'oge_test_split_pos',
        zones: [
          { key: 'top', id: 'oge-test-top', ariaLabel: 'Top', bg: 'green', onTap: top },
          { key: 'bottom', id: 'oge-test-bottom', ariaLabel: 'Bottom', bg: 'teal', onTap: bottom, onHold },
        ],
      })
    );

  it('mounts a wrap with two zone buttons carrying their own ids', () => {
    make();
    expect(document.getElementById('oge-test-split')?.tagName).toBe('DIV');
    expect(document.getElementById('oge-test-top')?.tagName).toBe('BUTTON');
    expect(document.getElementById('oge-test-bottom')?.tagName).toBe('BUTTON');
  });

  it('paints, recolours and dims each zone independently', () => {
    const ctl = make();
    ctl.paintLines('top', [
      { text: '1:2:3', em: '0.5em', opacity: 0.85 },
      { text: 'Send', em: '1em', marginTop: 2 },
    ]);
    ctl.setText('bottom', 'Scan');
    const top = /** @type {HTMLElement} */ (document.getElementById('oge-test-top'));
    const bottom = /** @type {HTMLElement} */ (document.getElementById('oge-test-bottom'));
    expect(labelOf(top)).toBe('1:2:3Send');
    expect(labelOf(bottom)).toBe('Scan');
    ctl.setDim('top', true);
    expect(top.style.opacity).toBe('0.5');
    expect(bottom.style.opacity).not.toBe('0.5');
    ctl.setBg('bottom', 'purple');
    expect(bottom.style.getPropertyValue('--rim')).toBe('purple');
    expect(top.style.getPropertyValue('--rim')).toBe('green');
  });

  it('routes each zone click to its own onTap', () => {
    let t = 0;
    let b = 0;
    make(() => (t += 1), () => (b += 1));
    /** @type {HTMLElement} */ (document.getElementById('oge-test-top')).click();
    /** @type {HTMLElement} */ (document.getElementById('oge-test-bottom')).click();
    expect(t).toBe(1);
    expect(b).toBe(1);
  });

  it('resize updates the wrap size and both zones font-size', () => {
    const ctl = make();
    ctl.resize(100);
    expect(document.getElementById('oge-test-split')?.style.width).toBe('100px');
    const expected = Math.round(100 * 0.14) + 'px';
    expect(document.getElementById('oge-test-top')?.style.fontSize).toBe(expected);
    expect(document.getElementById('oge-test-bottom')?.style.fontSize).toBe(expected);
  });

  it('hosts the glyph in one central brand node on the wrap', () => {
    createButton({
      id: 'oge-test-disc',
      title: 'Daily',
      ringId: 'oge-ring-disc',
      size: 80,
      fontScale: 0.14,
      posKey: 'oge_test_disc_pos',
      zones: [
        {
          key: 'top',
          id: 'oge-test-disc-top',
          bg: 'green',
          glyph: '<circle r="10"/>',
          onTap: () => {},
        },
        { key: 'bottom', id: 'oge-test-disc-bottom', bg: 'teal', onTap: () => {} },
      ],
    });
    const wrap = /** @type {HTMLElement} */ (document.getElementById('oge-test-disc'));
    const lens = wrap.querySelector('.oge-lens.oge-node');
    expect(lens).not.toBeNull();
    // One central node carrying the glyph (in the shared `.oge-art` layer);
    // the split zones carry no per-zone watermark of their own.
    expect(lens?.querySelector('.oge-art svg')).not.toBeNull();
    expect(wrap.querySelectorAll('.oge-art')).toHaveLength(1);
  });

  it('setProgress drives the progress arc stroke-dashoffset (0 = empty, 1 = full)', () => {
    const ctl = make();
    const arc = document.querySelector('.oge-ring-progress');
    expect(arc).not.toBeNull();
    // Initial state: dashoffset=100 (arc empty, invisible).
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('100');
    // Half filled: dashoffset=50.
    ctl.setProgress(0.5);
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('50');
    // Fully filled: dashoffset=0.
    ctl.setProgress(1);
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('0');
    // Reset: back to empty.
    ctl.setProgress(0);
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('100');
    // Clamps to [0,1].
    ctl.setProgress(2);
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('0');
    ctl.setProgress(-1);
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('100');
  });
});

describe('long-press (hold) gesture on a zone', () => {
  /** @returns {{ taps: () => number, holds: () => number, zone: HTMLElement }} */
  const setup = () => {
    let taps = 0;
    let holds = 0;
    createButton({
      id: 'oge-test-hold',
      title: 'Hold',
      ringId: 'oge-ring-hold',
      size: 80,
      fontScale: 0.14,
      posKey: 'oge_test_hold_pos',
      holdMs: 30,
      zones: [
        {
          // single-zone: the button itself IS the zone (id = cfg.id).
          key: 'z',
          id: 'oge-test-hold',
          ariaLabel: 'z',
          bg: 'teal',
          onTap: () => (taps += 1),
          onHold: () => (holds += 1),
        },
      ],
    });
    return {
      taps: () => taps,
      holds: () => holds,
      zone: /** @type {HTMLElement} */ (document.getElementById('oge-test-hold')),
    };
  };

  it('fires onHold (and swallows the trailing click) on a long press', async () => {
    const { taps, holds, zone } = setup();
    zone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    await new Promise((r) => setTimeout(r, 60));
    zone.dispatchEvent(new PointerEvent('pointerup'));
    zone.click(); // the trailing tap after a fired hold must be swallowed
    expect(holds()).toBe(1);
    expect(taps()).toBe(0);
  });

  it('fires onTap (not onHold) on a quick tap', async () => {
    const { taps, holds, zone } = setup();
    zone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    zone.dispatchEvent(new PointerEvent('pointerup'));
    zone.click();
    expect(taps()).toBe(1);
    expect(holds()).toBe(0);
  });

  it('cancels the hold when the pointer moves past the drag threshold', async () => {
    const { holds, zone } = setup();
    zone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    zone.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 0 }));
    await new Promise((r) => setTimeout(r, 60));
    zone.dispatchEvent(new PointerEvent('pointerup'));
    expect(holds()).toBe(0);
  });
});

describe('eventbox readiness gate (gateUntilEventBox)', () => {
  afterEach(() => {
    location.search = '';
  });

  /** @returns {{ taps: () => number, btn: HTMLElement }} */
  const make = () => {
    let taps = 0;
    createButton({
      id: 'oge-test-gate',
      title: 'Gate',
      ringId: 'oge-ring-gate',
      size: 80,
      fontScale: 0.23,
      posKey: 'oge_test_gate_pos',
      gateUntilEventBox: true,
      zones: [{ key: 'main', id: 'oge-test-gate', bg: 'red', onTap: () => (taps += 1) }],
    });
    return {
      taps: () => taps,
      btn: /** @type {HTMLElement} */ (document.getElementById('oge-test-gate')),
    };
  };

  it('on fleetdispatch starts disabled and swallows taps until oge:eventBoxLoaded', () => {
    location.search = '?page=ingame&component=fleetdispatch';
    const { taps, btn } = make();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    btn.click();
    expect(taps()).toBe(0); // swallowed while gated

    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    btn.click();
    expect(taps()).toBe(1); // taps flow once the eventbox is ready
  });

  it('off fleetdispatch the gate is a no-op (enabled, taps fire immediately)', () => {
    location.search = '?page=ingame&component=overview';
    const { taps, btn } = make();
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    btn.click();
    expect(taps()).toBe(1);
  });
});
