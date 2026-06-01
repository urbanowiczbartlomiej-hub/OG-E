// @vitest-environment happy-dom
//
// Unit tests for the Trader highlight feature.
//
// Coverage split:
//
//   - Pure policy:   `traderGlows(now, state)` — every window × history
//                    combination, the ~30-min bid snooze, the daily import
//                    reset, and the red-over-yellow menu priority. No DOM,
//                    no storage.
//   - DOM lifecycle: install / settings toggle / dispose, painting the
//                    menu button and the two overview tiles, and the
//                    action events (`oge:traderBidPlaced` /
//                    `oge:traderImportTraded`) stamping localStorage and
//                    clearing the matching glow.
//
// Date handling uses `vi.useFakeTimers` + `setSystemTime` so install/event
// paths pick up a deterministic clock. The pure tests pass `Date`s directly.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  installTraderMenuHighlight,
  traderGlows,
  localDayKey,
  _resetTraderMenuHighlightForTest,
  AUCTION_BID_KEY,
  IMPORT_TRADED_KEY,
} from '../../src/features/traderMenuHighlight.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-trader-highlight-style';
const HIGHLIGHT_CLASS = 'oge-trader-highlight';
const YELLOW_CLASS = 'oge-trader-yellow';
const RED_CLASS = 'oge-trader-red';

/** Build `#menuTable` with the Trader anchor; return the anchor. */
const buildMenu = () => {
  const ul = document.createElement('ul');
  ul.id = 'menuTable';
  const a = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
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

/** Build the two overview tiles; return `{ auction, importTile }`. */
const buildTiles = () => {
  const make = (/** @type {string} */ hint, /** @type {string} */ label) => {
    const div = document.createElement('div');
    div.dataset.ipiHint = hint;
    const h2 = document.createElement('h2');
    h2.textContent = label;
    div.appendChild(h2);
    document.body.appendChild(div);
    return div;
  };
  return {
    auction: make('ipiTraderAuctioneer', 'Licytator'),
    importTile: make('ipiTraderImportExport', 'Import / Eksport'),
  };
};

const findMenu = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector('#menuTable [data-ipi-hint="ipiToolbarTrader"]')
  );

// ── Pure policy ──────────────────────────────────────────────────────

describe('traderGlows', () => {
  /** @param {string} iso */
  const at = (iso) => new Date(iso);
  /** @type {import('../../src/features/traderMenuHighlight.js').TraderState} */
  const blank = { auctionBidAt: null, importTradedDay: null };

  it('everything off during the night (00:00–06:00)', () => {
    const g = traderGlows(at('2026-05-28T03:30:00'), blank);
    expect(g).toEqual({ menu: 'off', auctionPending: false, importPending: false });
  });

  it('yellow-only in auction morning (06:00–14:00), no import nudge before 14', () => {
    for (const iso of ['2026-05-28T06:00:00', '2026-05-28T10:00:00', '2026-05-28T13:59:00']) {
      const g = traderGlows(at(iso), blank);
      expect(g.auctionPending).toBe(true);
      expect(g.importPending).toBe(false);
      expect(g.menu).toBe('yellow');
    }
  });

  it('red takes the menu from 14:00 while the auction tile stays yellow', () => {
    const g = traderGlows(at('2026-05-28T15:00:00'), blank);
    expect(g.auctionPending).toBe(true);
    expect(g.importPending).toBe(true);
    expect(g.menu).toBe('red'); // red > yellow on the single menu button
  });

  it('after 23:00 the auction window closes; red still nags until midnight', () => {
    const g = traderGlows(at('2026-05-28T23:30:00'), blank);
    expect(g.auctionPending).toBe(false);
    expect(g.importPending).toBe(true);
    expect(g.menu).toBe('red');
  });

  it('a successful bid snoozes yellow for ~30 min, then it returns', () => {
    const now = at('2026-05-28T10:00:00');
    const justBid = { auctionBidAt: now.getTime() - 5 * 60 * 1000, importTradedDay: null };
    expect(traderGlows(now, justBid).auctionPending).toBe(false); // within 30 min
    const staleBid = { auctionBidAt: now.getTime() - 31 * 60 * 1000, importTradedDay: null };
    expect(traderGlows(now, staleBid).auctionPending).toBe(true); // snooze expired
  });

  it('a bid does not affect the import (red) reminder', () => {
    const now = at('2026-05-28T15:00:00');
    const bid = { auctionBidAt: now.getTime(), importTradedDay: null };
    const g = traderGlows(now, bid);
    expect(g.auctionPending).toBe(false); // snoozed
    expect(g.importPending).toBe(true); // untouched
    expect(g.menu).toBe('red');
  });

  it('taking the import today clears red for the rest of the day', () => {
    const now = at('2026-05-28T15:00:00');
    const traded = { auctionBidAt: null, importTradedDay: localDayKey(now) };
    const g = traderGlows(now, traded);
    expect(g.importPending).toBe(false);
    expect(g.menu).toBe('yellow'); // auction still pending → menu falls back to yellow
  });

  it('an import taken YESTERDAY re-arms red today', () => {
    const now = at('2026-05-28T15:00:00');
    const yesterday = { auctionBidAt: null, importTradedDay: localDayKey(at('2026-05-27T15:00:00')) };
    expect(traderGlows(now, yesterday).importPending).toBe(true);
  });
});

// ── DOM lifecycle ────────────────────────────────────────────────────

describe('installTraderMenuHighlight', () => {
  beforeEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(AUCTION_BID_KEY);
    localStorage.removeItem(IMPORT_TRADED_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    vi.useFakeTimers();
    // Default: afternoon, nothing done → menu red, both tiles glowing.
    vi.setSystemTime(new Date('2026-05-28T18:00:00'));
    buildMenu();
    buildTiles();
  });

  afterEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(AUCTION_BID_KEY);
    localStorage.removeItem(IMPORT_TRADED_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('injects the stylesheet', () => {
    installTraderMenuHighlight();
    expect(document.getElementById(STYLE_ID)?.tagName).toBe('STYLE');
  });

  it('is idempotent — second install returns same dispose, no duplicate <style>', () => {
    const a = installTraderMenuHighlight();
    const b = installTraderMenuHighlight();
    expect(a).toBe(b);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
  });

  it('afternoon, nothing done: menu red, auction tile yellow, import tile red', () => {
    installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(RED_CLASS)).toBe(true);
    const auction = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderAuctioneer"]'));
    const importTile = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderImportExport"]'));
    expect(auction.classList.contains(YELLOW_CLASS)).toBe(true);
    expect(importTile.classList.contains(RED_CLASS)).toBe(true);
  });

  it('tags the menu button with the menu marker but not the tiles', () => {
    installTraderMenuHighlight(); // 18:00 → menu red, both tiles lit
    expect(findMenu()?.classList.contains('oge-trader-menu')).toBe(true);
    const auction = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderAuctioneer"]'));
    const importTile = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderImportExport"]'));
    expect(auction.classList.contains('oge-trader-menu')).toBe(false);
    expect(importTile.classList.contains('oge-trader-menu')).toBe(false);
  });

  it('morning: menu yellow and import tile not lit (before 14:00)', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(YELLOW_CLASS)).toBe(true);
    const importTile = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderImportExport"]'));
    expect(importTile.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('night: nothing lit', () => {
    vi.setSystemTime(new Date('2026-05-28T03:00:00'));
    installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(
      /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderAuctioneer"]')).classList.contains(HIGHLIGHT_CLASS),
    ).toBe(false);
  });

  it('oge:traderBidPlaced stamps the bid time and clears yellow (snoozed)', () => {
    // Morning so the menu is yellow-only (isolates the auction reminder).
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(YELLOW_CLASS)).toBe(true);

    document.dispatchEvent(new CustomEvent('oge:traderBidPlaced'));

    expect(localStorage.getItem(AUCTION_BID_KEY)).not.toBeNull();
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    const auction = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderAuctioneer"]'));
    expect(auction.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('oge:traderImportTraded stamps today and clears red (menu falls back to yellow)', () => {
    installTraderMenuHighlight(); // 18:00 → menu red
    expect(findMenu()?.classList.contains(RED_CLASS)).toBe(true);

    document.dispatchEvent(new CustomEvent('oge:traderImportTraded'));

    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBe(localDayKey(new Date()));
    const importTile = /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderImportExport"]'));
    expect(importTile.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    // Auction still pending → the single menu button now shows yellow.
    expect(findMenu()?.classList.contains(YELLOW_CLASS)).toBe(true);
  });

  it('yellow returns after the bid snooze expires (safety-poll re-eval)', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    installTraderMenuHighlight();
    document.dispatchEvent(new CustomEvent('oge:traderBidPlaced'));
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    // Past the 30-min snooze; the 60s poll re-evaluates.
    vi.setSystemTime(new Date('2026-05-28T08:31:00'));
    vi.advanceTimersByTime(60_000);

    expect(findMenu()?.classList.contains(YELLOW_CLASS)).toBe(true);
  });

  it('disabling the setting strips classes and removes the stylesheet', () => {
    installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    settingsStore.update((s) => ({ ...s, traderMenuHighlight: false }));

    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('re-enabling restores the highlight', () => {
    installTraderMenuHighlight();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: false }));
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });

  it('dispose tears down style, classes, listeners, observer, and poll', () => {
    const dispose = installTraderMenuHighlight();
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(true);

    dispose();

    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    // Events after dispose must NOT mutate storage — listeners were removed.
    document.dispatchEvent(new CustomEvent('oge:traderBidPlaced'));
    expect(localStorage.getItem(AUCTION_BID_KEY)).toBeNull();
  });
});
