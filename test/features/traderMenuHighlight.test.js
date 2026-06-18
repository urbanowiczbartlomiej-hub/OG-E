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
  AUCTION_QUIET_KEY,
  IMPORT_EVENT_KEY,
  IMPORT_NEXT_KEY,
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

  it('a future auction quiet-until suppresses yellow; once past it returns', () => {
    const now = at('2026-05-28T10:00:00');
    const quiet = { ...blank, auctionQuietUntil: now.getTime() + 18 * 60 * 1000 };
    expect(traderGlows(now, quiet).auctionPending).toBe(false); // next auction not yet
    const elapsed = { ...blank, auctionQuietUntil: now.getTime() - 1000 };
    expect(traderGlows(now, elapsed).auctionPending).toBe(true); // window passed
  });

  // ── 6×-today Import/Export event ──────────────────────────────────────

  it('event day: red lights BEFORE 14:00 (gate bypassed) when no next-refresh is known', () => {
    const now = at('2026-05-28T08:00:00'); // morning — normally no red
    const ev = { ...blank, importEventDay: localDayKey(now), importNextAt: null };
    const g = traderGlows(now, ev);
    expect(g.importPending).toBe(true);
    expect(g.menu).toBe('red'); // red > yellow on the menu
  });

  it('event day: a future next-refresh suppresses red; once past it returns', () => {
    const now = at('2026-05-28T10:00:00');
    const future = { ...blank, importEventDay: localDayKey(now), importNextAt: now.getTime() + 60 * 60 * 1000 };
    expect(traderGlows(now, future).importPending).toBe(false); // waiting for 11:00
    const passed = { ...blank, importEventDay: localDayKey(now), importNextAt: now.getTime() - 1000 };
    expect(traderGlows(now, passed).importPending).toBe(true); // refresh time reached
  });

  it('event day ignores the once-daily clear (importTradedDay is irrelevant)', () => {
    const now = at('2026-05-28T15:00:00');
    const traded = {
      ...blank,
      importTradedDay: localDayKey(now),
      importEventDay: localDayKey(now),
      importNextAt: null,
    };
    expect(traderGlows(now, traded).importPending).toBe(true); // more offers today
  });

  it("yesterday's event does NOT bypass the 14:00 gate today", () => {
    const now = at('2026-05-28T08:00:00');
    const stale = { ...blank, importEventDay: localDayKey(at('2026-05-27T08:00:00')), importNextAt: null };
    const g = traderGlows(now, stale);
    expect(g.importPending).toBe(false); // back to normal: no red before 14:00
  });
});

// ── DOM lifecycle ────────────────────────────────────────────────────

describe('installTraderMenuHighlight', () => {
  beforeEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(AUCTION_BID_KEY);
    localStorage.removeItem(IMPORT_TRADED_KEY);
    localStorage.removeItem(AUCTION_QUIET_KEY);
    localStorage.removeItem(IMPORT_EVENT_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
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
    localStorage.removeItem(AUCTION_QUIET_KEY);
    localStorage.removeItem(IMPORT_EVENT_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
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

// ── Trader sub-page scanning (passive, on navigation) ────────────────

describe('installTraderMenuHighlight — sub-page scanning', () => {
  beforeEach(() => {
    _resetTraderMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, traderMenuHighlight: true }));
    localStorage.removeItem(AUCTION_BID_KEY);
    localStorage.removeItem(IMPORT_TRADED_KEY);
    localStorage.removeItem(AUCTION_QUIET_KEY);
    localStorage.removeItem(IMPORT_EVENT_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T18:00:00')); // afternoon: both windows open
    buildMenu();
    buildTiles();
  });

  afterEach(() => {
    _resetTraderMenuHighlightForTest();
    localStorage.removeItem(AUCTION_BID_KEY);
    localStorage.removeItem(IMPORT_TRADED_KEY);
    localStorage.removeItem(AUCTION_QUIET_KEY);
    localStorage.removeItem(IMPORT_EVENT_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** @param {string} display Inline display for the done overlay. */
  const buildImportPage = (display) => {
    const div = document.createElement('div');
    div.id = 'div_traderImportExport';
    const overlay = document.createElement('div');
    overlay.className = 'bargain_overlay';
    overlay.style.display = display;
    div.appendChild(overlay);
    document.body.appendChild(div);
  };

  /** @param {string} display Inline display for `.noAuctionOverlay`. @param {string} countdown */
  const buildAuctioneerPage = (display, countdown) => {
    const noAuction = document.createElement('div');
    noAuction.className = 'noAuctionOverlay';
    noAuction.style.display = display;
    const next = document.createElement('span');
    next.id = 'nextAuction';
    next.textContent = countdown;
    document.body.appendChild(noAuction);
    document.body.appendChild(next);
  };

  const importTile = () =>
    /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderImportExport"]'));
  const auctionTile = () =>
    /** @type {HTMLElement} */ (document.querySelector('[data-ipi-hint="ipiTraderAuctioneer"]'));

  it('a visible "no more offers today" overlay stamps today and clears red', () => {
    buildImportPage('block');
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBe(localDayKey(new Date()));
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);
  });

  it('a hidden import overlay (offers still available) does NOT stamp; red stays', () => {
    buildImportPage('none');
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBeNull();
    expect(importTile().classList.contains(RED_CLASS)).toBe(true);
  });

  // ── 6×-today event detection + re-arm parsing ────────────────────────

  /** Build the news-message image that announces the 6× event. */
  const buildEventMessage = () => {
    const img = document.createElement('img');
    img.src = 'https://image.board.gameforge.com/uploads/ecdn/news_importexport_6.jpg';
    document.body.appendChild(img);
  };

  /** Build the import "done" overlay carrying a "come back at HH:MM" line. */
  const buildImportPageWithText = (/** @type {string} */ text) => {
    const div = document.createElement('div');
    div.id = 'div_traderImportExport';
    const overlay = document.createElement('div');
    overlay.className = 'bargain_overlay';
    overlay.style.display = 'block';
    const p = document.createElement('p');
    p.className = 'bargain_text';
    p.textContent = text;
    overlay.appendChild(p);
    div.appendChild(overlay);
    document.body.appendChild(div);
  };

  it('the 6× news message stamps the event day and lights red before 14:00', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00')); // morning: no red normally
    buildEventMessage();
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_EVENT_KEY)).toBe(localDayKey(new Date()));
    // Gate bypassed: import tile glows red even though it's only 08:00.
    expect(importTile().classList.contains(RED_CLASS)).toBe(true);
  });

  it('event day: "come back at 12:00" sets the next-refresh stamp and drops red until then', () => {
    vi.setSystemTime(new Date('2026-05-28T10:00:00'));
    localStorage.setItem(IMPORT_EVENT_KEY, localDayKey(new Date())); // event already detected
    buildImportPageWithText('Obecnie nie ma ofert. Wróć o godz. 12:00.');
    installTraderMenuHighlight();

    const expected = new Date('2026-05-28T12:00:00').getTime();
    expect(Number(localStorage.getItem(IMPORT_NEXT_KEY))).toBe(expected);
    // The once-daily clear must NOT be stamped during the event.
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBeNull();
    // 12:00 is still ahead → red is suppressed for now.
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);
  });

  it('event day: "come back tomorrow" (no time) re-arms at next midnight and drops red', () => {
    vi.setSystemTime(new Date('2026-05-28T22:00:00'));
    localStorage.setItem(IMPORT_EVENT_KEY, localDayKey(new Date())); // event already detected
    // Last container taken: the overlay no longer carries an HH:MM, just
    // "no more offers today, come back tomorrow".
    buildImportPageWithText('Dzisiaj nie ma już więcej ofert. Wróć jutro.');
    installTraderMenuHighlight();

    // Exhausted for the day → re-arm at the next local midnight (after which the
    // event flips off on its own), NOT a now-past time that would keep red stuck.
    const expected = new Date('2026-05-29T00:00:00').getTime();
    expect(Number(localStorage.getItem(IMPORT_NEXT_KEY))).toBe(expected);
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBeNull(); // still event mode
    expect(importTile().classList.contains(RED_CLASS)).toBe(false); // red off for the rest of today
  });

  it('event day: red returns once the next-refresh time passes (safety-poll re-eval)', () => {
    vi.setSystemTime(new Date('2026-05-28T11:59:00'));
    localStorage.setItem(IMPORT_EVENT_KEY, localDayKey(new Date()));
    buildImportPageWithText('Wróć o godz. 12:00.');
    installTraderMenuHighlight();
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);

    // Cross 12:00; remove the page so the re-scan can't re-stamp a new time.
    document.getElementById('div_traderImportExport')?.remove();
    vi.setSystemTime(new Date('2026-05-28T12:00:30'));
    vi.advanceTimersByTime(60_000);
    expect(importTile().classList.contains(RED_CLASS)).toBe(true);
  });

  it('between auctions, the countdown sets quiet-until and clears yellow', () => {
    buildAuctioneerPage('', '18min. 20sek.');
    installTraderMenuHighlight();
    const expected = Date.now() + (18 * 60 + 20) * 1000;
    expect(Number(localStorage.getItem(AUCTION_QUIET_KEY))).toBe(expected);
    expect(auctionTile().classList.contains(YELLOW_CLASS)).toBe(false);
  });

  it('does NOT set quiet-until while an auction is live (overlay hidden); yellow stays', () => {
    buildAuctioneerPage('none', '18min. 20sek.');
    installTraderMenuHighlight();
    expect(localStorage.getItem(AUCTION_QUIET_KEY)).toBeNull();
    expect(auctionTile().classList.contains(YELLOW_CLASS)).toBe(true);
  });

  it('once the quiet window elapses, the safety-poll brings yellow back', () => {
    buildAuctioneerPage('', '5sek.');
    installTraderMenuHighlight();
    expect(auctionTile().classList.contains(YELLOW_CLASS)).toBe(false);

    // Past the 5 s window; remove the page so the re-scan can't re-stamp.
    document.body.querySelector('#nextAuction')?.remove();
    vi.setSystemTime(new Date('2026-05-28T18:00:10'));
    vi.advanceTimersByTime(60_000);
    expect(auctionTile().classList.contains(YELLOW_CLASS)).toBe(true);
  });
});
