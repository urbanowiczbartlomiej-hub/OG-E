// @vitest-environment happy-dom
//
// Behavioral tests for the AGR-missing guard.
//
// # Scene setup
//
// The module's only real dependency is AGR's menu-toggle button —
// `#ago_menubutton` (GAME.AGO_MENU_BUTTON) — somewhere in `document.body`.
// "AGR present" cases paint that button before install (so the probe
// resolves truthy → no banner). "AGR absent" cases leave it out and let
// the 10 s `waitFor` time out → the banner is injected.
//
// # Timers
//
// `waitFor` resolves SYNCHRONOUSLY on the first truthy check (AGR present),
// but its `.then` still needs a microtask tick to run — hence `flushWaitFor`.
// The absent path resolves `null` only after the 10 s timeout, so those
// cases use fake timers and advance past `AGR_TIMEOUT_MS`. We never sleep on
// real time.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installAgrGuard,
  _resetAgrGuardForTest,
} from '../../src/features/agrGuard.js';

/** DOM id of AGR's menu-toggle button — the AGR-present probe (mirrors GAME.AGO_MENU_BUTTON). */
const AGR_BUTTON_ID = 'ago_menubutton';

/** Stable id of the warning banner — mirrors the module constant. */
const BANNER_ID = 'oge-agr-missing';

/** Stable id of the banner stylesheet — mirrors the module constant. */
const BANNER_STYLE_ID = 'oge-agr-missing-style';

/** Class of the × dismiss button inside the banner. */
const CLOSE_CLASS = 'oge-agr-missing-close';

/** AGR's 10 s hydrate timeout; cases that want the absent path advance past it. */
const AGR_TIMEOUT_MS = 10_000;

/** Paint AGR's menu button so the present-probe resolves truthy. */
const paintAgrButton = () => {
  const btn = document.createElement('div');
  btn.id = AGR_BUTTON_ID;
  document.body.appendChild(btn);
};

/** The injected warning banner, or null. */
const getBanner = () => document.getElementById(BANNER_ID);

/**
 * Flush microtasks so `waitFor`'s synchronous-resolve `.then` chain runs.
 * Used by the AGR-present cases, which need no timer advance.
 *
 * @returns {Promise<void>}
 */
const flushWaitFor = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Global teardown
// ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetAgrGuardForTest();
  document.body.innerHTML = '';
});

afterEach(() => {
  _resetAgrGuardForTest();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────
// AGR absent → warn
// ──────────────────────────────────────────────────────────────────

describe('installAgrGuard — AGR absent', () => {
  it('injects the warning banner after the hydrate timeout', async () => {
    vi.useFakeTimers();
    installAgrGuard();

    // Before the timeout fires, nothing is shown yet.
    expect(getBanner()).toBeNull();

    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);

    const banner = getBanner();
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('alert');
    // Names the extension to install and carries a dismiss control.
    expect(banner?.textContent).toContain('AntiGameReborn');
    expect(banner?.querySelector(`.${CLOSE_CLASS}`)).not.toBeNull();
  });

  it('injects the banner stylesheet alongside the banner', async () => {
    vi.useFakeTimers();
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);

    expect(document.getElementById(BANNER_STYLE_ID)).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// AGR present → stay quiet
// ──────────────────────────────────────────────────────────────────

describe('installAgrGuard — AGR present', () => {
  it('never shows the banner when #ago_menubutton is already in the DOM', async () => {
    paintAgrButton();
    installAgrGuard();
    // Probe resolves truthy synchronously; only the microtask needs flushing.
    await flushWaitFor();

    expect(getBanner()).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();
  });

  it('stays quiet even after the would-be timeout elapses', async () => {
    vi.useFakeTimers();
    paintAgrButton();
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS * 2);

    expect(getBanner()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Dismissal
// ──────────────────────────────────────────────────────────────────

describe('installAgrGuard — dismiss', () => {
  it('× click removes the banner and its stylesheet', async () => {
    vi.useFakeTimers();
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);

    const close = /** @type {HTMLElement} */ (
      getBanner()?.querySelector(`.${CLOSE_CLASS}`)
    );
    close.click();

    expect(getBanner()).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Late-AGR self-heal (false-positive guard)
// ──────────────────────────────────────────────────────────────────

describe('installAgrGuard — late AGR', () => {
  it('tears the banner down when AGR hydrates after the banner is up', async () => {
    vi.useFakeTimers();
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);
    expect(getBanner()).not.toBeNull();

    // AGR finally hydrates → the late-AGR MutationObserver should remove
    // the banner on the next childList mutation.
    paintAgrButton();
    // Let the MutationObserver callback drain (happy-dom delivers records via
    // a queued task, which fake timers gate).
    await vi.advanceTimersByTimeAsync(0);
    await flushWaitFor();

    expect(getBanner()).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Idempotency + dispose / reset
// ──────────────────────────────────────────────────────────────────

describe('installAgrGuard — lifecycle', () => {
  it('is idempotent — second call returns the same dispose, no duplicate banner', async () => {
    vi.useFakeTimers();
    const dispose1 = installAgrGuard();
    const dispose2 = installAgrGuard();
    expect(dispose2).toBe(dispose1);

    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);

    expect(document.querySelectorAll(`#${BANNER_ID}`).length).toBe(1);
  });

  it('dispose removes the banner and lets a later install warn again', async () => {
    vi.useFakeTimers();
    const dispose = installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);
    expect(getBanner()).not.toBeNull();

    dispose();
    expect(getBanner()).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();

    // A fresh install after dispose can warn again (no leaked sentinel).
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);
    expect(getBanner()).not.toBeNull();
  });

  it('dispose before the probe resolves suppresses the banner entirely', async () => {
    vi.useFakeTimers();
    const dispose = installAgrGuard();

    // Tear down before the 10 s timeout — the in-flight wait must no-op.
    dispose();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS * 2);

    expect(getBanner()).toBeNull();
  });

  it('_resetAgrGuardForTest clears an up banner', async () => {
    vi.useFakeTimers();
    installAgrGuard();
    await vi.advanceTimersByTimeAsync(AGR_TIMEOUT_MS);
    expect(getBanner()).not.toBeNull();

    _resetAgrGuardForTest();
    expect(getBanner()).toBeNull();
  });
});
