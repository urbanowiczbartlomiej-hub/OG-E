// @vitest-environment happy-dom
//
// Behavioural tests for the shared OGame-style button chrome: a single
// idempotently-injected <style> that decorates the three floating buttons
// (#oge-send-exp, #oge-send-col, #oge-fs-unified) with a vignette + sheen
// overlay, plus decorateButton(), which appends the engraved title ring
// and tap-ripple layer and wires per-zone press feedback. We assert the
// observable output (injected element, appended DOM, wired classes), not
// rendered pixels.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installButtonChrome,
  decorateButton,
  appendLens,
  ORBIT_DEFS_ID,
  CHROME_STYLE_ID,
  BUTTON_CHROME_CSS,
} from '../../src/features/shared/buttonChrome.js';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('shared button chrome stylesheet', () => {
  it('injects a single <style> element with the chrome CSS', () => {
    installButtonChrome();
    const style = document.getElementById(CHROME_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.tagName).toBe('STYLE');
    expect(style?.textContent).toBe(BUTTON_CHROME_CSS);
  });

  it('is idempotent — a second call adds no second element', () => {
    installButtonChrome();
    installButtonChrome();
    installButtonChrome();
    expect(document.querySelectorAll(`#${CHROME_STYLE_ID}`)).toHaveLength(1);
  });

  it('targets .oge-host with state rim colour and carries ring + ripple rules', () => {
    expect(BUTTON_CHROME_CSS).toContain('.oge-host');
    expect(BUTTON_CHROME_CSS).toContain('--rim');
    expect(BUTTON_CHROME_CSS).toContain('pointer-events:none');
    expect(BUTTON_CHROME_CSS).toContain('.oge-ring-title');
    expect(BUTTON_CHROME_CSS).toContain('.oge-ring-brand');
    expect(BUTTON_CHROME_CSS).toContain('@keyframes oge-ripple-kf');
    expect(BUTTON_CHROME_CSS).toContain('.oge-tap-active');
    expect(BUTTON_CHROME_CSS).toContain('.oge-lens');
    expect(BUTTON_CHROME_CSS).toContain('.oge-lens-orbit');
  });

  it('tints the oczko/glyph (not just the rim) when the host carries .is-error', () => {
    expect(BUTTON_CHROME_CSS).toContain('.oge-host.is-error .oge-node');
    expect(BUTTON_CHROME_CSS).toContain('.oge-host.is-error .oge-node .oge-art{color:var(--rim);}');
  });
});

describe('appendLens', () => {
  it('appends one glass lens with the glyph + orbit mark (idempotent per host)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    appendLens(host, '<circle r="10"/>');
    appendLens(host, '<circle r="10"/>');
    const lenses = host.querySelectorAll('.oge-lens');
    expect(lenses).toHaveLength(1);
    // The glyph SVG and the OG-E orbit-mark frame both live in the lens.
    expect(lenses[0].querySelector('.oge-lens-glyph')).not.toBeNull();
    expect(lenses[0].querySelector('.oge-lens-orbit')).not.toBeNull();
  });

  it('injects the orbit-mark gradient defs exactly once', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    appendLens(a, '<circle r="10"/>');
    appendLens(b, '<circle r="10"/>');
    expect(document.querySelectorAll(`#${ORBIT_DEFS_ID}`)).toHaveLength(1);
    expect(document.getElementById(ORBIT_DEFS_ID)?.querySelector('linearGradient')).not.toBeNull();
  });

  it('is a no-op without inner markup', () => {
    const host = document.createElement('div');
    appendLens(host, '');
    expect(host.querySelector('.oge-lens')).toBeNull();
  });
});

describe('decorateButton', () => {
  /** @returns {{ wrap: HTMLElement, a: HTMLButtonElement, b: HTMLButtonElement }} */
  const makeSplit = () => {
    const wrap = document.createElement('div');
    const a = document.createElement('button');
    const b = document.createElement('button');
    wrap.append(a, b);
    document.body.appendChild(wrap);
    return { wrap, a, b };
  };

  it('injects the stylesheet and appends a ripple layer + engraved ring', () => {
    const { wrap, a, b } = makeSplit();
    decorateButton({ host: wrap, zones: [a, b], title: 'Colonization', ringId: 'r1' });

    expect(document.getElementById(CHROME_STYLE_ID)).not.toBeNull();
    expect(wrap.querySelector('.oge-deco-layer')).not.toBeNull();
    const ring = wrap.querySelector('svg.oge-ring');
    expect(ring).not.toBeNull();
    // Title is engraved uppercase along an arc path referenced by ringId.
    expect(ring?.querySelector('textPath')?.textContent).toBe('COLONIZATION');
    expect(ring?.querySelector('path')?.getAttribute('id')).toBe('r1');
  });

  it('is idempotent per host — a second call adds no duplicate ring/layer', () => {
    const { wrap, a, b } = makeSplit();
    decorateButton({ host: wrap, zones: [a, b], title: 'X', ringId: 'r2' });
    decorateButton({ host: wrap, zones: [a, b], title: 'X', ringId: 'r2' });
    expect(wrap.querySelectorAll('.oge-deco-layer')).toHaveLength(1);
    expect(wrap.querySelectorAll('svg.oge-ring')).toHaveLength(1);
  });

  it('marks the pressed zone with .oge-tap-active and clears it on release', () => {
    const { wrap, a, b } = makeSplit();
    decorateButton({ host: wrap, zones: [a, b], title: 'X', ringId: 'r3' });

    a.dispatchEvent(new Event('pointerdown'));
    expect(a.classList.contains('oge-tap-active')).toBe(true);
    expect(b.classList.contains('oge-tap-active')).toBe(false);

    a.dispatchEvent(new Event('pointerup'));
    expect(a.classList.contains('oge-tap-active')).toBe(false);
  });
});
