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
  IMPORT_MODE_KEY,
  IMPORT_EVENT_SEEN_KEY,
  IMPORT_NEXT_KEY,
  MODE_DAILY,
  MODE_6X,
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

  it('a bid does not affect the import (red) alarmClock', () => {
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

  // ── 6× ("event") import mode ──────────────────────────────────────────

  it('6× mode: red lights BEFORE 14:00 (gate bypassed) when no slot has been taken', () => {
    const now = at('2026-05-28T08:00:00'); // morning — normally no red
    const ev = { ...blank, mode: MODE_6X, importNextAt: null };
    const g = traderGlows(now, ev);
    expect(g.importPending).toBe(true);
    expect(g.menu).toBe('red'); // red > yellow on the menu
  });

  it('6× mode: taking the CURRENT 4h slot suppresses red; a fresh slot re-lights it', () => {
    // `importNextAt` is the START of the last-taken 4-hour slot. At 10:00 the
    // current slot started at 08:00 (00/04/08/12/16/20 cadence).
    const now = at('2026-05-28T10:00:00');
    const slotStart = at('2026-05-28T08:00:00').getTime();
    const taken = { ...blank, mode: MODE_6X, importNextAt: slotStart };
    expect(traderGlows(now, taken).importPending).toBe(false); // this slot's offer is gone
    // A slot taken earlier (the 04:00 slot) is older than the current start →
    // the 08:00 offer is waiting, so red re-lights.
    const prevSlot = { ...blank, mode: MODE_6X, importNextAt: at('2026-05-28T04:00:00').getTime() };
    expect(traderGlows(now, prevSlot).importPending).toBe(true); // a fresh slot's offer waits
  });

  it('6× mode ignores the once-daily clear (importTradedDay is irrelevant)', () => {
    const now = at('2026-05-28T15:00:00');
    const traded = {
      ...blank,
      importTradedDay: localDayKey(now),
      mode: MODE_6X,
      importNextAt: null,
    };
    expect(traderGlows(now, traded).importPending).toBe(true); // more offers today
  });

  it('daily mode (the default) still honours the 14:00 gate', () => {
    const now = at('2026-05-28T08:00:00');
    const daily = { ...blank, mode: MODE_DAILY, importNextAt: null };
    expect(traderGlows(now, daily).importPending).toBe(false); // no red before 14:00
    // An absent mode behaves as daily, too.
    expect(traderGlows(now, { ...blank, importNextAt: null }).importPending).toBe(false);
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
    localStorage.removeItem(IMPORT_MODE_KEY);
    localStorage.removeItem(IMPORT_EVENT_SEEN_KEY);
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
    localStorage.removeItem(IMPORT_MODE_KEY);
    localStorage.removeItem(IMPORT_EVENT_SEEN_KEY);
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
    // Morning so the menu is yellow-only (isolates the auction alarmClock).
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

  it('yellow returns after the bid snooze boundary fires', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    installTraderMenuHighlight();
    document.dispatchEvent(new CustomEvent('oge:traderBidPlaced'));
    expect(findMenu()?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    // The bid arms a single boundary wake at bid + 30-min snooze (no more 60s
    // poll). Crossing it fires the scheduled timeout, which re-evaluates from
    // fresh state — the snooze has lapsed, so yellow returns.
    vi.advanceTimersByTime(31 * 60_000);

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
    localStorage.removeItem(IMPORT_MODE_KEY);
    localStorage.removeItem(IMPORT_EVENT_SEEN_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    // Neutral page: the event-detection scan is gated on `component=messages`,
    // so default it OFF — only the event tests opt in.
    location.search = '?page=ingame&component=traderOverview';
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
    localStorage.removeItem(IMPORT_MODE_KEY);
    localStorage.removeItem(IMPORT_EVENT_SEEN_KEY);
    localStorage.removeItem(IMPORT_NEXT_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.body.innerHTML = '';
    location.search = ''; // don't leak the messages-page gate into other files
    vi.useRealTimers();
  });

  /**
   * @param {string} display Inline display for the done overlay.
   * @param {string} [id] Panel id — `div_traderImportExport` (≤1.12, default)
   *   or `div_importexport` (1.13+, the `trader` prefix dropped).
   */
  const buildImportPage = (display, id = 'div_traderImportExport') => {
    const div = document.createElement('div');
    div.id = id;
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

  it('the 1.13 panel id (div_importexport) is scanned the same way', () => {
    buildImportPage('block', 'div_importexport');
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBe(localDayKey(new Date()));
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);
  });

  // ── 6× auto-switch detection + slot re-arm parsing ───────────────────

  /**
   * Build a message-list row announcing the 6× event: the `importexport_6`
   * image plus the hidden `.rawMessageData` block whose `data-raw-timestamp`
   * (epoch SECONDS) dates the event. The feature reads that timestamp — only a
   * RECENT message (within the recency window) auto-switches the mode to 6×.
   *
   * @param {number} startMs Server start time of the announcement, epoch ms.
   */
  const buildEventMessage = (startMs) => {
    const row = document.createElement('li');
    row.className = 'msg';
    const img = document.createElement('img');
    img.src = 'https://image.board.gameforge.com/uploads/ecdn/news_importexport_6.jpg';
    row.appendChild(img);
    const raw = document.createElement('span');
    raw.className = 'rawMessageData';
    raw.setAttribute('data-raw-timestamp', String(Math.floor(startMs / 1000)));
    row.appendChild(raw);
    document.body.appendChild(row);
  };

  it('a RECENT 6× message (on the messages page) auto-switches to 6× and lights red before 14:00', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00')); // morning: no red normally
    location.search = '?page=messages&component=messages'; // event scan is gated here
    const startMs = new Date('2026-05-28T08:00:00').getTime();
    buildEventMessage(startMs);
    installTraderMenuHighlight();
    // Mode flipped to 6×, keyed on the message's own start (one switch per msg).
    expect(localStorage.getItem(IMPORT_MODE_KEY)).toBe(MODE_6X);
    expect(localStorage.getItem(IMPORT_EVENT_SEEN_KEY)).toBe(String(startMs));
    // Gate bypassed: import tile glows red even though it's only 08:00.
    expect(importTile().classList.contains(RED_CLASS)).toBe(true);
  });

  it('the 6× image is ignored off the messages page (no auto-switch)', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    location.search = '?page=ingame&component=traderOverview'; // NOT the inbox
    buildEventMessage(new Date('2026-05-28T08:00:00').getTime());
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_MODE_KEY)).toBeNull(); // still daily (default)
    expect(importTile().classList.contains(RED_CLASS)).toBe(false); // no red before 14:00
  });

  it('a long-expired 6× message cannot auto-switch the mode (outside the recency window)', () => {
    vi.setSystemTime(new Date('2026-05-28T08:00:00'));
    location.search = '?page=messages&component=messages';
    // Announced 10 days ago → older than the 3-day recency window → no switch.
    buildEventMessage(new Date('2026-05-18T08:00:00').getTime());
    installTraderMenuHighlight();
    expect(localStorage.getItem(IMPORT_MODE_KEY)).toBeNull();
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);
  });

  it('6× mode: a visible overlay stamps the CURRENT 4h slot and drops red for the rest of it', () => {
    vi.setSystemTime(new Date('2026-05-28T10:00:00')); // 08:00 slot
    localStorage.setItem(IMPORT_MODE_KEY, MODE_6X); // player picked 6× mode
    buildImportPage('block'); // "offer gone" overlay visible → current slot taken
    installTraderMenuHighlight();

    // The slot stamp is the START of the containing 4h slot (08:00), not the
    // localised overlay text — the come-back parsing is gone.
    const expected = new Date('2026-05-28T08:00:00').getTime();
    expect(Number(localStorage.getItem(IMPORT_NEXT_KEY))).toBe(expected);
    // The once-daily clear must NOT be stamped during the event.
    expect(localStorage.getItem(IMPORT_TRADED_KEY)).toBeNull();
    // Current slot's offer is gone → red suppressed for the rest of the slot.
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);
  });

  it('6× mode: red returns at the next 4h slot boundary (boundary wake re-eval)', () => {
    vi.setSystemTime(new Date('2026-05-28T11:59:00')); // late in the 08:00 slot
    localStorage.setItem(IMPORT_MODE_KEY, MODE_6X);
    buildImportPage('block'); // 08:00 slot taken
    installTraderMenuHighlight();
    expect(importTile().classList.contains(RED_CLASS)).toBe(false);

    // Cross into the 12:00 slot; remove the page so the re-scan can't re-stamp
    // the new slot. The fresh slot's offer is waiting → red re-lights.
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
