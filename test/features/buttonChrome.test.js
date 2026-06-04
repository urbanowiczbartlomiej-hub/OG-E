// @vitest-environment happy-dom
//
// Behavioural tests for the shared OGame-style button chrome: a single
// idempotently-injected <style> element that decorates the three
// floating buttons (#oge-send-exp, #oge-send-col, #oge-fs-unified) with a
// rim + edge-vignette + sheen overlay. We assert the observable output
// (the injected element and the rules it carries), not pixels.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installButtonChrome,
  CHROME_STYLE_ID,
  BUTTON_CHROME_CSS,
} from '../../src/features/shared/buttonChrome.js';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('shared button chrome', () => {
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

  it('targets all three floating buttons with a pseudo-element overlay', () => {
    for (const id of ['oge-send-exp', 'oge-send-col', 'oge-fs-unified']) {
      expect(BUTTON_CHROME_CSS).toContain(`#${id}::after`);
    }
    // The overlay must not eat taps and must carry the inset edge-vignette.
    expect(BUTTON_CHROME_CSS).toContain('pointer-events:none');
    expect(BUTTON_CHROME_CSS).toContain('inset 0 0 16px 3px rgba(0,0,0,0.55)');
  });
});
