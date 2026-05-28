// @vitest-environment happy-dom
//
// Unit tests for the Trader menu highlight feature.
//
// Coverage split:
//
//   - Pure policy:    `computeTraderMode(now, lastClickMs)` — covers all
//                     time-of-day × click-history combinations without
//                     touching DOM or localStorage.
//   - DOM lifecycle:  install / settings toggle / dispose / click handler
//                     write-through to localStorage and immediate visual
//                     update on click.
//
// Date handling uses `vi.useFakeTimers` + `setSystemTime` so the install
// path picks up a deterministic clock. The pure function tests pass
// `Date`s directly and don't need the fake-timer setup.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  installTraderMenuHighlight,
  computeTraderMode,
  _resetTraderMenuHighlightForTest,
  TRADER_CLICK_KEY,
} from '../../src/features/traderMenuHighlight.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-trader-highlight-style';
const HIGHLIGHT_CLASS = 'oge-trader-highlight';
const SUBTLE_CLASS = 'oge-trader-subtle';
const INTENSE_CLASS = 'oge-trader-intense';

/** Build a `#menuTable` containing only the Trader anchor. */
const buildMenu = () => {
  const ul = document.createElement('ul');
  ul.id = 'menuTable';
  const a = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
  a.className = 'menubutton premiumHighligt';
  a.dataset.ipiHint = 'ipiToolbarTrader';
  a.href = '#trader';
  const span = document.createElement('span');
  span.className = 'textlabel';
  span.textContent = 'Handlarz';
  a.appendChild(span);
  const li = document.createElement('li');
  li.appendChild(a);
  ul.appendChild(li);
  document.body.appendChild(ul);
  return a;
};

const findTrader = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector('[data-ipi-hint="ipiToolbarTrader"]')
  );

// ── Pure policy ──────────────────────────────────────────────────────

describe('computeTraderMode', () => {
  // Build a local-time Date that survives DST/timezone surprises: the
  // browser interprets a "no-Z" string as local, which is exactly what
  // the production code does (it reads `now.getHours()` etc).
  /** @param {string} iso */
  const at = (iso) => new Date(iso);

  it('returns "off" during night (00:00–06:00) regardless of clicks', () => {
    expect(computeTraderMode(at('2026-05-28T00:00:00'), null)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T03:30:00'), null)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T05:59:00'), null)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T05:59:00'), Date.now())).toBe('off');
  });

  it('returns "subtle" in the morning band (06:00–14:00) with no prior click', () => {
    expect(computeTraderMode(at('2026-05-28T06:00:00'), null)).toBe('subtle');
    expect(computeTraderMode(at('2026-05-28T10:15:00'), null)).toBe('subtle');
    expect(computeTraderMode(at('2026-05-28T13:59:00'), null)).toBe('subtle');
  });

  it('returns "off" inside the same 30-min slot as the last click (morning)', () => {
    const click = at('2026-05-28T10:14:00').getTime();
    // Same slot (10:00–10:30): suppressed.
    expect(computeTraderMode(at('2026-05-28T10:20:00'), click)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T10:29:59'), click)).toBe('off');
  });

  it('returns "subtle" in the very next 30-min slot after a click (morning)', () => {
    const click = at('2026-05-28T10:14:00').getTime();
    // 10:30 starts a new slot — the reminder comes back.
    expect(computeTraderMode(at('2026-05-28T10:30:00'), click)).toBe('subtle');
    expect(computeTraderMode(at('2026-05-28T10:45:00'), click)).toBe('subtle');
  });

  it('returns "intense" in the afternoon band (14:00–24:00) when no click today', () => {
    expect(computeTraderMode(at('2026-05-28T14:00:00'), null)).toBe('intense');
    expect(computeTraderMode(at('2026-05-28T18:42:00'), null)).toBe('intense');
    expect(computeTraderMode(at('2026-05-28T23:59:00'), null)).toBe('intense');
  });

  it('returns "intense" in the afternoon when last click was on a PREVIOUS day', () => {
    const yesterdayClick = at('2026-05-27T22:00:00').getTime();
    expect(computeTraderMode(at('2026-05-28T15:00:00'), yesterdayClick)).toBe('intense');
  });

  it('downgrades to "subtle" after the first click of the day (in next slot)', () => {
    const click = at('2026-05-28T15:10:00').getTime();
    // Same slot as click: off.
    expect(computeTraderMode(at('2026-05-28T15:20:00'), click)).toBe('off');
    // Next slot: subtle (NOT intense — first click of the day already
    // happened so the intense escalation is silenced for the rest of
    // the calendar day).
    expect(computeTraderMode(at('2026-05-28T15:35:00'), click)).toBe('subtle');
    expect(computeTraderMode(at('2026-05-28T22:00:00'), click)).toBe('subtle');
  });

  it('treats a click at 06:00 morning identically to one at 06:00 evening for slot suppression', () => {
    // Slot boundary alignment: a click exactly at :30 puts us in the
    // :30 slot; the :00 slot just before is the previous slot.
    const click = at('2026-05-28T10:30:00').getTime();
    expect(computeTraderMode(at('2026-05-28T10:29:59'), click)).toBe('subtle');
    expect(computeTraderMode(at('2026-05-28T10:30:00'), click)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T10:59:59'), click)).toBe('off');
    expect(computeTraderMode(at('2026-05-28T11:00:00'), click)).toBe('subtle');
  });
});

// ── DOM lifecycle ────────────────────────────────────────────────────

describe('installTraderMenuHighlight', () => {
  beforeEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(TRADER_CLICK_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('menuTable')?.remove();
    vi.useFakeTimers();
    // Default: afternoon, no clicks → intense expected.
    vi.setSystemTime(new Date('2026-05-28T18:00:00'));
    buildMenu();
  });

  afterEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(TRADER_CLICK_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('menuTable')?.remove();
    vi.useRealTimers();
  });

  it('injects the trader-highlight stylesheet', () => {
    installTraderMenuHighlight();
    expect(document.getElementById(STYLE_ID)?.tagName).toBe('STYLE');
  });

  it('is idempotent — second install returns same dispose and does not duplicate <style>', () => {
    const a = installTraderMenuHighlight();
    const b = installTraderMenuHighlight();
    expect(a).toBe(b);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
  });

  it('applies the intense modifier in the afternoon when no click today', () => {
    installTraderMenuHighlight();
    const trader = findTrader();
    expect(trader?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(trader?.classList.contains(INTENSE_CLASS)).toBe(true);
    expect(trader?.classList.contains(SUBTLE_CLASS)).toBe(false);
  });

  it('applies the subtle modifier in the morning when no click today', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    installTraderMenuHighlight();
    const trader = findTrader();
    expect(trader?.classList.contains(SUBTLE_CLASS)).toBe(true);
    expect(trader?.classList.contains(INTENSE_CLASS)).toBe(false);
  });

  it('applies no class during night hours', () => {
    vi.setSystemTime(new Date('2026-05-28T03:00:00'));
    installTraderMenuHighlight();
    const trader = findTrader();
    expect(trader?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('click on Trader anchor writes a timestamp to localStorage and downgrades to off (same slot)', () => {
    installTraderMenuHighlight();
    const trader = findTrader();
    expect(trader?.classList.contains(INTENSE_CLASS)).toBe(true);

    trader?.click();

    const stored = localStorage.getItem(TRADER_CLICK_KEY);
    expect(stored).not.toBeNull();
    expect(Number.isFinite(Number(stored))).toBe(true);

    // Same slot as the click → highlight goes away.
    expect(trader?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('click via an inner child element is detected via event delegation', () => {
    installTraderMenuHighlight();
    const span = document.querySelector(
      '[data-ipi-hint="ipiToolbarTrader"] .textlabel',
    );
    /** @type {HTMLElement} */ (span)?.click();
    expect(localStorage.getItem(TRADER_CLICK_KEY)).not.toBeNull();
  });

  it('after a click, advancing into the next slot brings back subtle (not intense)', () => {
    installTraderMenuHighlight();
    const trader = findTrader();
    trader?.click();
    expect(trader?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    // Advance past the 30-min slot. The safety-poll fires every 60s,
    // so 31 minutes of fake time guarantees at least one re-evaluation.
    vi.setSystemTime(new Date('2026-05-28T18:31:00'));
    vi.advanceTimersByTime(60_000);

    expect(trader?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    // First click of the day already happened → intense is silenced.
    expect(trader?.classList.contains(SUBTLE_CLASS)).toBe(true);
    expect(trader?.classList.contains(INTENSE_CLASS)).toBe(false);
  });

  it('disabling the setting strips classes and removes the stylesheet', () => {
    installTraderMenuHighlight();
    expect(findTrader()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    settingsStore.update((s) => ({ ...s, traderMenuHighlight: false }));

    expect(findTrader()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('re-enabling the setting restores the highlight', () => {
    installTraderMenuHighlight();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: false }));
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));

    expect(findTrader()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });

  it('dispose tears down style, classes, listeners, and observer', () => {
    const dispose = installTraderMenuHighlight();
    expect(findTrader()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    dispose();

    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(findTrader()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    // A click after dispose must NOT mutate localStorage — the
    // delegated listener was removed.
    findTrader()?.click();
    expect(localStorage.getItem(TRADER_CLICK_KEY)).toBeNull();
  });
});
