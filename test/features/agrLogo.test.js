// @vitest-environment happy-dom
//
// Unit tests for the AGR logo rewire feature.
//
// # Scene setup
//
// The module's only real dependency is an `#ago_menubutton_logo` anchor
// somewhere in `document.body`. For the "happy path" cases we paint
// that + a sibling `#ago_menubutton` + an `#oge-settings-header` in
// `beforeEach` so every piece the click flow touches is live. The
// "never appears" case leaves them absent.
//
// # browser.runtime.getURL mock
//
// The module tries `browser.runtime.getURL` first, `chrome.runtime.getURL`
// second. We install a `browser` polyfill on `globalThis` in beforeEach
// that returns a stub moz-extension URL so the module's image-swap path
// exercises the runtime branch rather than falling through to the
// no-runtime empty-string sentinel.
//
// # Fake timers
//
// `waitFor` polls at 200 ms; the install uses a 10 s timeout. The
// "never appears" case advances past that timeout. Everything else
// keeps real timers — happy-dom + microtask flushing is sufficient
// when the logo is synchronously present at install time.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installAgrLogo,
  _resetAgrLogoForTest,
} from '../../src/features/agrLogo.js';

/** DOM id of AGR's logo anchor — mirrors the module constant. */
const LOGO_ID = 'ago_menubutton_logo';

/** DOM id of the AGR menu toggle — mirrors the module constant. */
const MENU_BUTTON_ID = 'ago_menubutton';

/** DOM id of our settings tab header — mirrors the module constant. */
const OGE_TAB_HEADER_ID = 'oge-settings-header';

/** Stub icon URL returned by the browser.runtime.getURL mock. */
const STUB_ICON_URL = 'moz-extension://abc/icons/icon48.png';

/** Stable id for the hover-stylesheet — mirrors the module constant. */
const HOVER_STYLE_ID = 'oge-agr-logo-hover';

/**
 * Paint the minimum AGR surface the module interacts with: the logo
 * anchor, the menu toggle button, and our settings tab header. The
 * settings header is normally injected by `features/settingsUi.js`;
 * for these tests we paint it directly so the click flow has a
 * target even without the full settings install.
 *
 * @returns {void}
 */
const setupAgrDom = () => {
  document.body.innerHTML = `
    <a id="${LOGO_ID}" class="ago_menubutton_logo_inactive" href="javascript:void(0)"></a>
    <div id="${MENU_BUTTON_ID}"></div>
    <div id="${OGE_TAB_HEADER_ID}"></div>
  `;
};

/**
 * Flush microtasks so `waitFor`'s resolution chain has a chance to
 * settle. `waitFor` resolves synchronously when the predicate is truthy
 * on first check, but the `.then` callback still needs a microtask
 * tick to run.
 *
 * @returns {Promise<void>}
 */
const flushWaitFor = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Global setup / teardown
// ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetAgrLogoForTest();
  document.body.innerHTML = '';
  /** @type {any} */ (globalThis).browser = {
    runtime: {
      getURL: (/** @type {string} */ p) => `moz-extension://abc/${p}`,
    },
  };
});

afterEach(() => {
  _resetAgrLogoForTest();
  document.body.innerHTML = '';
  delete (/** @type {any} */ (globalThis)).browser;
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────
// install + wiring
// ──────────────────────────────────────────────────────────────────

describe('installAgrLogo — wiring', () => {
  it('finds #ago_menubutton_logo when present and leaves it in the DOM', async () => {
    setupAgrDom();
    installAgrLogo();
    await flushWaitFor();

    const logo = document.getElementById(LOGO_ID);
    expect(logo).not.toBeNull();
  });

  it('click → triggers AGR menu click + our tab expand', async () => {
    vi.useFakeTimers();
    setupAgrDom();

    const menuBtnSpy = vi.fn();
    const tabHeaderSpy = vi.fn();
    document
      .getElementById(MENU_BUTTON_ID)
      ?.addEventListener('click', menuBtnSpy);
    document
      .getElementById(OGE_TAB_HEADER_ID)
      ?.addEventListener('click', tabHeaderSpy);

    installAgrLogo();
    // Flush the waitFor resolution under fake timers.
    await vi.advanceTimersByTimeAsync(0);

    const logo = /** @type {HTMLElement} */ (document.getElementById(LOGO_ID));
    logo.click();

    // Menu button click is synchronous.
    expect(menuBtnSpy).toHaveBeenCalledTimes(1);
    // Tab header click is scheduled via setTimeout(80).
    expect(tabHeaderSpy).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(80);
    expect(tabHeaderSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second call returns same dispose, no duplicate listener', async () => {
    vi.useFakeTimers();
    setupAgrDom();

    const dispose1 = installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);
    const dispose2 = installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);

    expect(dispose2).toBe(dispose1);

    // Count menu-btn clicks — a single logo click should fire it once,
    // not twice. Duplicate listeners would produce two clicks.
    const menuBtnSpy = vi.fn();
    document
      .getElementById(MENU_BUTTON_ID)
      ?.addEventListener('click', menuBtnSpy);

    const logo = /** @type {HTMLElement} */ (document.getElementById(LOGO_ID));
    logo.click();
    expect(menuBtnSpy).toHaveBeenCalledTimes(1);
  });

  it('dispose removes click listener and restores the original background-image', async () => {
    vi.useFakeTimers();
    setupAgrDom();
    const logo = /** @type {HTMLElement} */ (document.getElementById(LOGO_ID));
    // Capture pristine style attribute shape (absent) for comparison.
    const originalStyleAttr = logo.getAttribute('style');
    expect(originalStyleAttr).toBeNull();

    const dispose = installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);

    // Confirm the image was actually swapped in.
    expect(logo.getAttribute('style') ?? '').toContain('background-image');

    // After dispose: style attribute back to absent, clicks no longer
    // route through our handler.
    dispose();
    expect(logo.getAttribute('style')).toBeNull();

    const menuBtnSpy = vi.fn();
    document
      .getElementById(MENU_BUTTON_ID)
      ?.addEventListener('click', menuBtnSpy);
    logo.click();
    expect(menuBtnSpy).not.toHaveBeenCalled();
  });

  it('silently no-ops when AGR never appears (10s timeout)', async () => {
    vi.useFakeTimers();
    // No AGR DOM painted. Install and push past the 10s timeout.
    installAgrLogo();
    await vi.advanceTimersByTimeAsync(10_001);
    // Nothing to assert DOM-wise; the main contract is "no throw,
    // dispose is still callable".
    // Calling dispose must not throw even though the wait timed out.
    expect(() => _resetAgrLogoForTest()).not.toThrow();
  });

  it('background-image is set to runtime.getURL result when available', async () => {
    vi.useFakeTimers();
    setupAgrDom();
    installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);

    const logo = /** @type {HTMLElement} */ (document.getElementById(LOGO_ID));
    const style = logo.getAttribute('style') ?? '';
    expect(style).toContain(STUB_ICON_URL);
    expect(style).toContain('background-image');
    expect(style).toContain('!important');
  });

  it('forces a 27×27 square on the logo anchor', async () => {
    vi.useFakeTimers();
    setupAgrDom();
    installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);

    const logo = /** @type {HTMLElement} */ (document.getElementById(LOGO_ID));
    const style = logo.getAttribute('style') ?? '';
    expect(style).toContain('width: 27px');
    expect(style).toContain('height: 27px');
    // `display: block` keeps the anchor rendering as a square box rather
    // than collapsing to its inline text-height dimensions.
    expect(style).toContain('display: block');
  });

  it('injects a hover stylesheet with the :hover rule', async () => {
    vi.useFakeTimers();
    setupAgrDom();
    installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);

    const styleEl = document.getElementById(HOVER_STYLE_ID);
    expect(styleEl).not.toBeNull();
    expect(styleEl?.tagName).toBe('STYLE');
    const css = styleEl?.textContent ?? '';
    expect(css).toContain(`#${LOGO_ID}:hover`);
    // The brightness filter is the perceptual "pulse" on pointer-over.
    expect(css).toContain('brightness');
  });

  it('dispose removes the hover stylesheet', async () => {
    vi.useFakeTimers();
    setupAgrDom();
    const dispose = installAgrLogo();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById(HOVER_STYLE_ID)).not.toBeNull();

    dispose();
    expect(document.getElementById(HOVER_STYLE_ID)).toBeNull();
  });
});
