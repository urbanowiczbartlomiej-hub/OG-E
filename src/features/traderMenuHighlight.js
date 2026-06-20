// Trader highlight — two independent daily-action reminders, drawn as
// coloured glows on the Trader menu button AND on the matching tiles of
// the Trader overview, cleared by the player's ACTUAL action (not a mere
// menu open).
//
// # Problem
//
// Two daily Trader chores are easy to forget and the menu entry looks
// like any other:
//
//   - Licytator (Auctioneer): place a bid on the rotating auction.
//   - Import/Eksport: take the daily container.
//
// The old design pulsed a single time-escalating glow and cleared it on a
// click of the Trader MENU button. But opening the menu proves nothing —
// the bid/trade button might be disabled, the server may reject, or the
// player just looks and leaves. So the reminder must clear on the action,
// and the two chores are independent things with different colours.
//
// # Solution
//
// Two glows, each its own colour, each its own clear-condition:
//
//   YELLOW — Licytator. Shown during auction hours (~06:00–23:00). A gentle
//            persistent nag: it stays until the player actually places a
//            bid. A successful bid snoozes it for ~30 minutes (a proxy for
//            "this auction", since auctions rotate roughly every 30 min but
//            their exact times are unknowable without polling — which TOS
//            forbids), then it returns to nag about the next auction.
//
//   RED    — Import/Eksport. Shown ONLY from 14:00 onward (not earlier):
//            the daily import is once-per-day and resets at local midnight,
//            but in-game quests that require a once-daily import purchase
//            activate only after 14:00 — nudging import before 14 risks the
//            player "burning" their one daily import before such a quest
//            appears. Cleared by a successful trade; re-arms next local day.
//            EXCEPTION — the occasional "import refreshes 6× today" event
//            (detected from its news message, see `IMPORT_EVENT_IMG_SEL`):
//            for that local day the 14:00 gate and once-daily clear are
//            dropped, and the glow re-arms off the page's "come back at HH:MM"
//            overlay instead of next midnight, so each of the day's several
//            offers gets nudged. Reverts to the normal rule next local day.
//
// Surfaces:
//   - Menu button (`#menuTable [data-ipi-hint=ipiToolbarTrader]`): one
//     element, so RED takes priority over YELLOW when both are pending.
//   - Overview tiles (`[data-ipi-hint=ipiTraderAuctioneer]` → yellow,
//     `[data-ipi-hint=ipiTraderImportExport]` → red): independent, each
//     shows its own colour. The `ipi*` hints are OGame's locale-independent
//     identifiers — same in every language, like the menu hint.
//
// The clear signal arrives from the MAIN-world `traderActionHook` bridge
// as `oge:traderBidPlaced` / `oge:traderImportTraded` CustomEvents on
// `document`; this module stamps the bid timestamp / trade day in
// localStorage and re-renders.
//
// # Why two windows but only one night blackout knob
//
// The auction window (06–23) already silences the night, and the import
// window (14–24) never reaches the night, so no separate blackout constant
// is needed. Times are read off the local clock (`now.getHours()`), which
// matches the player's day and — for a PL player on a PL server — the
// game's reset clock too.
//
// # Lifecycle
//
//   1. `installTraderMenuHighlight()` injects the stylesheet once.
//   2. `applyHighlight()` runs immediately, on every debounced
//      MutationObserver tick (catches AJAX menu rebuilds and the overview
//      rendering), and on a 60-second safety-poll (catches window/day
//      boundaries and bid-snooze expiry while idle).
//   3. Document-level listeners for `oge:traderBidPlaced` /
//      `oge:traderImportTraded` stamp storage and re-render immediately.
//   4. settingsStore subscription reacts to the on/off toggle.
//   5. Dispose strips classes, removes the style, disconnects the
//      observer, clears the poll, removes the event listeners, and
//      unsubscribes from settingsStore.

/** @ts-check */

import { injectStyle } from '../lib/dom.js';
import { debounce } from '../lib/debounce.js';
import { safeLS } from '../lib/storage.js';
import { settingsStore } from '../state/settings.js';
import { GAME } from '../lib/gameDom.js';
import { parseTraderCountdown } from '../domain/traderCountdown.js';
import { parseClockTime, nextDailyOccurrence } from '../domain/traderClock.js';
import {
  TRADER_AUCTION_BID_KEY,
  TRADER_IMPORT_KEY,
  TRADER_AUCTION_QUIET_KEY,
  TRADER_IMPORT_EVENT_KEY,
  TRADER_IMPORT_NEXT_KEY,
} from '../state/dailyActions.js';
import {
  DAILY_STATE_CHANGED_EVENT,
  TRADER_BID_PLACED_EVENT,
  TRADER_IMPORT_TRADED_EVENT,
} from '../lib/ogeEvents.js';

const STYLE_ID = 'oge-trader-highlight-style';

/** Base CSS class on any highlighted element. */
const HIGHLIGHT_CLASS = 'oge-trader-highlight';

/** Modifier classes that pick the colour. */
const YELLOW_CLASS = 'oge-trader-yellow';
const RED_CLASS = 'oge-trader-red';

/**
 * Marker added only to the menu button (never the overview tiles). Scopes
 * the gentler menu pulse and the hover/active/selected "yield to a steady
 * glow" rules so the tiles can keep their stronger always-pulsing look.
 */
const MENU_CLASS = 'oge-trader-menu';

/**
 * `data-ipi-hint` values — OGame's locale-independent element identifiers.
 * `ipiToolbarTrader` is the global menu button; the two `ipiTrader*` hints
 * are the Auctioneer / Import-Export tiles on the Trader overview.
 */
const MENU_HINT = 'ipiToolbarTrader';
const AUCTION_HINT = 'ipiTraderAuctioneer';
const IMPORT_HINT = 'ipiTraderImportExport';

// Re-exported under their historical names so existing tests and any external
// tooling that imports from this module continue to work unchanged.
export const AUCTION_BID_KEY = TRADER_AUCTION_BID_KEY;
export const IMPORT_TRADED_KEY = TRADER_IMPORT_KEY;
export const AUCTION_QUIET_KEY = TRADER_AUCTION_QUIET_KEY;
export const IMPORT_EVENT_KEY = TRADER_IMPORT_EVENT_KEY;
export const IMPORT_NEXT_KEY = TRADER_IMPORT_NEXT_KEY;

/**
 * Trader sub-page selectors (game DOM — fragile, locale-independent where
 * possible). Local to this feature: no other feature reads the Trader pages.
 *   - The Import/Export "done for today" overlay is shown (display ≠ none)
 *     once the daily container is taken; its visibility is our "no more
 *     offers today" signal.
 *   - The Auctioneer shows `#nextAuction` (a live countdown) and a visible
 *     `.noAuctionOverlay` only between auctions; both together mean "no
 *     auction live right now", which is when we may push the quiet window.
 */
const IMPORT_DONE_OVERLAY_SEL = '#div_traderImportExport .bargain_overlay';
const IMPORT_DONE_TEXT_SEL = '#div_traderImportExport .bargain_overlay .bargain_text';
const AUCTION_NEXT_COUNTDOWN_SEL = '#nextAuction';
const AUCTION_NO_AUCTION_OVERLAY_SEL = '.noAuctionOverlay';

/**
 * The "import refreshes 6× today" event is announced by an in-game news
 * message whose body carries this image. Matching the filename substring is
 * locale-independent — the message TEXT is translated, the asset name is not.
 * Seeing it anywhere in the document (the message list / open message) is our
 * signal that today is a 6×-import day.
 */
const IMPORT_EVENT_IMG_SEL = 'img[src*="importexport_6"]';

/**
 * Device-local detection scratchpad — the last Import/Export "come back at
 * HH:MM" refresh we recorded, tagged with the local day it was seen, stored as
 * `"YYYY-MM-DD|<epochMs>"`. NOT synced (unlike the keys re-exported above).
 *
 * Why it exists: a multi-day "import refreshes 6× today" event only announces
 * itself ONCE — the news message on day 1. On day 2+ that message is gone, so
 * without another signal the import nudge silently falls back to the normal
 * once-daily / 14:00-gate rule even though the event is still running. The one
 * signal that is locale-independent AND needs no knowledge of what a normal
 * day's overlay shows: TWO DISTINCT intraday come-back times on the SAME local
 * day. A normal day has at most one daily reset, so it can NEVER show two
 * different same-day come-back times — only a >1×/day refresh can. Seeing the
 * second distinct time re-confirms the event for that day (re-stamping
 * {@link IMPORT_EVENT_KEY}); the event thus self-sustains across midnight for
 * as long as it actually runs, and lapses on its own the first normal day
 * (which cannot produce the second distinct time → no false positive, ever).
 *
 * Local-only on purpose: each device observes its own Trader visits, and the
 * CONFIRMATION it yields ({@link IMPORT_EVENT_KEY}) is the part that syncs. A
 * max-merge of two devices' distinct same-day times would erase the very
 * distinctness this detection depends on.
 */
const IMPORT_SEEN_KEY = 'oge-trader-import-seen-today';

/** Auction hours — yellow shows in `[start, end)` local time. */
const AUCTION_START_HOUR = 6;
const AUCTION_END_HOUR = 23;

/** Import nudge opens at this local hour (inclusive); never before. */
const IMPORT_START_HOUR = 14;

/**
 * How long a successful bid silences the yellow glow. ~30 minutes mirrors
 * the rough auction cadence; after it elapses the nag returns for the next
 * auction. Tunable — the exact auction lengths are unknowable to us.
 */
const BID_SNOOZE_MS = 30 * 60 * 1000;

const CSS = `
@keyframes oge-trader-yellow-bg {
  0%, 70%, 100% {
    box-shadow: inset 0 0 6px rgba(255, 235, 80, 0.32),
                0 0 3px rgba(255, 220, 60, 0.16);
  }
  85% {
    box-shadow: inset 0 0 18px rgba(255, 230, 70, 0.85),
                0 0 14px rgba(255, 215, 50, 0.55),
                0 0 28px rgba(255, 210, 40, 0.28);
  }
}
@keyframes oge-trader-yellow-text {
  0%, 70%, 100% { color: #ffe680; text-shadow: 0 0 3px rgba(255, 220, 80, 0.30); }
  85%           { color: #fff2a8; text-shadow: 0 0 7px rgba(255, 225, 90, 0.60); }
}
@keyframes oge-trader-red-bg {
  0%, 70%, 100% {
    box-shadow: inset 0 0 7px rgba(255, 60, 40, 0.40),
                0 0 4px rgba(255, 40, 20, 0.22);
  }
  85% {
    box-shadow: inset 0 0 22px rgba(255, 70, 50, 0.92),
                0 0 16px rgba(255, 40, 20, 0.68),
                0 0 34px rgba(255, 30, 10, 0.36);
  }
}
@keyframes oge-trader-red-text {
  0%, 70%, 100% { color: #ff9080; text-shadow: 0 0 4px rgba(255, 60, 40, 0.45); }
  85%           { color: #ffd0c0; text-shadow: 0 0 9px rgba(255, 80, 50, 0.78); }
}
/* Menu-only pulses. Still a touch softer than the tiles (the button is small
 * and sits in a busy sidebar), but now use the same punchy flash profile as
 * eventMenuHighlight so the Trader entry reads as clearly as an event entry —
 * the old version was nearly invisible. */
@keyframes oge-trader-menu-yellow-bg {
  0%, 70%, 100% {
    box-shadow: inset 0 0 6px rgba(255, 235, 80, 0.30),
                0 0 3px rgba(255, 215, 50, 0.15);
  }
  85% {
    box-shadow: inset 0 0 16px rgba(255, 230, 70, 0.78),
                0 0 12px rgba(255, 215, 50, 0.50),
                0 0 24px rgba(255, 210, 40, 0.24);
  }
}
@keyframes oge-trader-menu-red-bg {
  0%, 70%, 100% {
    box-shadow: inset 0 0 6px rgba(255, 60, 40, 0.34),
                0 0 3px rgba(255, 40, 20, 0.18);
  }
  85% {
    box-shadow: inset 0 0 18px rgba(255, 70, 50, 0.85),
                0 0 14px rgba(255, 40, 20, 0.60),
                0 0 28px rgba(255, 30, 10, 0.28);
  }
}
.${HIGHLIGHT_CLASS} {
  border-radius: 3px;
}
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} {
  animation: oge-trader-yellow-bg 4s linear infinite;
}
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} span,
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} h2 {
  animation: oge-trader-yellow-text 4s linear infinite;
  font-weight: bold;
}
.${HIGHLIGHT_CLASS}.${RED_CLASS} {
  animation: oge-trader-red-bg 4s linear infinite;
}
.${HIGHLIGHT_CLASS}.${RED_CLASS} span,
.${HIGHLIGHT_CLASS}.${RED_CLASS} h2 {
  animation: oge-trader-red-text 4s linear infinite;
  font-weight: bold;
}
/* TILES keep their pulse on hover on purpose: OGame only swaps their
 * background image, and a RUNNING animation outranks the game's static
 * hover declarations in the cascade, so the glow survives (we never touch
 * the background property — the swapped image and our glow coexist).
 *
 * The MENU button is different. It carries ${MENU_CLASS} and a (slightly)
 * softer pulse, and on :hover / :active / selected (.on) it stops pulsing and
 * shows a STEADY glow — mirroring eventMenuHighlight. A running pulse
 * would smother OGame's own hover/selected styling; a steady, strong glow
 * lets that native state read through while still clearly marking the item. */
.${MENU_CLASS}.${YELLOW_CLASS} { animation-name: oge-trader-menu-yellow-bg; animation-timing-function: linear; }
.${MENU_CLASS}.${RED_CLASS} { animation-name: oge-trader-menu-red-bg; animation-timing-function: linear; }
.${MENU_CLASS}.${YELLOW_CLASS}:hover,
.${MENU_CLASS}.${YELLOW_CLASS}:active,
.${MENU_CLASS}.${YELLOW_CLASS}.on {
  animation-name: none;
  box-shadow: inset 0 0 14px rgba(255, 230, 70, 0.65),
              0 0 9px rgba(255, 215, 50, 0.40),
              0 0 20px rgba(255, 210, 40, 0.22);
}
.${MENU_CLASS}.${YELLOW_CLASS}:hover span,
.${MENU_CLASS}.${YELLOW_CLASS}:active span,
.${MENU_CLASS}.${YELLOW_CLASS}.on span {
  animation-name: none;
  color: #fff2a8;
  text-shadow: 0 0 7px rgba(255, 225, 90, 0.55);
}
.${MENU_CLASS}.${RED_CLASS}:hover,
.${MENU_CLASS}.${RED_CLASS}:active,
.${MENU_CLASS}.${RED_CLASS}.on {
  animation-name: none;
  box-shadow: inset 0 0 16px rgba(255, 70, 50, 0.75),
              0 0 11px rgba(255, 40, 20, 0.45),
              0 0 26px rgba(255, 30, 10, 0.26);
}
.${MENU_CLASS}.${RED_CLASS}:hover span,
.${MENU_CLASS}.${RED_CLASS}:active span,
.${MENU_CLASS}.${RED_CLASS}.on span {
  animation-name: none;
  color: #ffd0c0;
  text-shadow: 0 0 9px rgba(255, 80, 50, 0.72);
}
`;

const REFRESH_DEBOUNCE_MS = 150;
const SAFETY_POLL_MS = 60_000;

/**
 * Local calendar-day key (`YYYY-MM-DD`) for the given moment. Used to
 * decide whether the import was already taken "today".
 *
 * @param {Date} d
 * @returns {string}
 */
export const localDayKey = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * @typedef {object} TraderState
 * @property {number | null} auctionBidAt Epoch ms of the last successful
 *   bid, or `null` if never.
 * @property {string | null} importTradedDay Local day-key of the last
 *   successful import trade, or `null` if never.
 * @property {number | null} [auctionQuietUntil] Epoch ms until which the
 *   yellow glow is suppressed (from the Auctioneer "next auction in"
 *   countdown), `null`/absent if none.
 * @property {string | null} [importEventDay] Local day-key on which the
 *   "import refreshes 6× today" event was detected, or `null`/absent if not.
 * @property {number | null} [importNextAt] Epoch ms of the next import refresh
 *   during that event (from the "come back at HH:MM" overlay); `null`/absent
 *   means an offer is waiting now. Used only while `importEventDay` is today.
 */

/**
 * @typedef {object} TraderGlows
 * @property {'off' | 'yellow' | 'red'} menu Colour for the menu button.
 * @property {boolean} auctionPending Whether the auctioneer tile glows yellow.
 * @property {boolean} importPending Whether the import tile glows red.
 */

/**
 * Pure decision function for the whole policy. No DOM, no storage, no
 * clock read beyond the `now` argument — fully testable.
 *
 * @param {Date} now Current local time.
 * @param {TraderState} state Persisted action history.
 * @returns {TraderGlows}
 */
export const traderGlows = (now, state) => {
  const hour = now.getHours();
  const auctionBidAt = state?.auctionBidAt ?? null;
  const importTradedDay = state?.importTradedDay ?? null;
  const auctionQuietUntil = state?.auctionQuietUntil ?? null;
  const importEventDay = state?.importEventDay ?? null;
  const importNextAt = state?.importNextAt ?? null;

  // Yellow (Licytator): auction hours, suppressed while EITHER the ~30-min
  // post-bid snooze is active OR the "next auction" quiet window (read off
  // the Auctioneer page between auctions) has not yet elapsed.
  const inAuctionWindow = hour >= AUCTION_START_HOUR && hour < AUCTION_END_HOUR;
  const bidSnoozed =
    auctionBidAt !== null && now.getTime() - auctionBidAt < BID_SNOOZE_MS;
  const quietActive =
    auctionQuietUntil !== null && now.getTime() < auctionQuietUntil;
  const auctionPending = inAuctionWindow && !bidSnoozed && !quietActive;

  // Red (Import/Eksport). Two modes:
  //   - 6×-today EVENT (importEventDay is today): the import isn't once-daily
  //     and the 14:00 gate doesn't apply — an offer can be waiting at any hour.
  //     Pending whenever we're past the parsed "come back at HH:MM" time (or no
  //     such time is known yet, i.e. right after detection / between refreshes).
  //   - NORMAL day: 14:00 onward, until taken today.
  const eventActive = importEventDay !== null && importEventDay === localDayKey(now);
  const importPending = eventActive
    ? importNextAt === null || now.getTime() >= importNextAt
    : hour >= IMPORT_START_HOUR && importTradedDay !== localDayKey(now);

  // Menu button is a single element — red wins over yellow when both pend.
  const menu = importPending ? 'red' : auctionPending ? 'yellow' : 'off';

  return { menu, auctionPending, importPending };
};

/**
 * Read the stored bid timestamp, or `null` when missing / unparseable.
 *
 * @returns {number | null}
 */
const readAuctionBidAt = () => {
  const raw = safeLS.get(AUCTION_BID_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read the stored auction quiet-until timestamp, or `null` when missing /
 * unparseable.
 *
 * @returns {number | null}
 */
const readAuctionQuietUntil = () => {
  const raw = safeLS.get(AUCTION_QUIET_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read the stored next-import timestamp, or `null` when missing / unparseable.
 *
 * @returns {number | null}
 */
const readImportNextAt = () => {
  const raw = safeLS.get(IMPORT_NEXT_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the {@link IMPORT_SEEN_KEY} scratchpad (`"YYYY-MM-DD|<epochMs>"`).
 *
 * @param {string | null} raw
 * @returns {{ day: string, target: number } | null} `null` when absent/garbage.
 */
const parseSeenRefresh = (raw) => {
  if (typeof raw !== 'string') return null;
  const bar = raw.indexOf('|');
  if (bar < 0) return null;
  const day = raw.slice(0, bar);
  const target = Number(raw.slice(bar + 1));
  return day !== '' && Number.isFinite(target) ? { day, target } : null;
};

/**
 * Assemble the persisted state from localStorage.
 *
 * @returns {TraderState}
 */
const readState = () => ({
  auctionBidAt: readAuctionBidAt(),
  importTradedDay: safeLS.get(IMPORT_TRADED_KEY),
  auctionQuietUntil: readAuctionQuietUntil(),
  importEventDay: safeLS.get(IMPORT_EVENT_KEY),
  importNextAt: readImportNextAt(),
});

/**
 * Whether an element is present AND not hidden by an inline `display:none`.
 * OGame toggles these Trader overlays via inline display, so the inline
 * style is the reliable (and happy-dom-testable) visibility signal.
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
const isShown = (el) =>
  !!el && /** @type {HTMLElement} */ (el).style.display !== 'none';

/** @param {string} hint @returns {HTMLElement | null} */
const findByHint = (hint) =>
  /** @type {HTMLElement | null} */ (
    document.querySelector(`[data-ipi-hint="${hint}"]`)
  );

/** The global Trader menu button, scoped to `#menuTable`. */
const findMenuAnchor = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector(`${GAME.MENU_TABLE} [data-ipi-hint="${MENU_HINT}"]`)
  );

/**
 * Reflect a colour decision onto one element. `'off'` strips the glow.
 * The menu button additionally gets the `MENU_CLASS` marker so its CSS
 * (gentler pulse + hover/selected yield) applies without touching tiles.
 *
 * @param {HTMLElement | null} el
 * @param {'off' | 'yellow' | 'red'} color
 * @param {boolean} [isMenu] Whether `el` is the menu button.
 * @returns {void}
 */
const paint = (el, color, isMenu = false) => {
  if (!el) return;
  el.classList.remove(HIGHLIGHT_CLASS, YELLOW_CLASS, RED_CLASS, MENU_CLASS);
  if (color === 'off') return;
  el.classList.add(HIGHLIGHT_CLASS, color === 'red' ? RED_CLASS : YELLOW_CLASS);
  if (isMenu) el.classList.add(MENU_CLASS);
};

/**
 * Strip the highlight classes from every element that has them. Used by
 * teardown and the disabled-setting path.
 *
 * @returns {void}
 */
const stripHighlight = () => {
  document
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) =>
      el.classList.remove(HIGHLIGHT_CLASS, YELLOW_CLASS, RED_CLASS, MENU_CLASS),
    );
};

/**
 * Read settings + storage + clock, compute the policy, and reflect it on
 * the menu button and the two overview tiles. No-op when disabled.
 *
 * @returns {void}
 */
const applyHighlight = () => {
  if (!settingsStore.get().traderMenuHighlight) return;
  const { menu, auctionPending, importPending } = traderGlows(
    new Date(),
    readState(),
  );
  paint(findMenuAnchor(), menu, true);
  paint(findByHint(AUCTION_HINT), auctionPending ? 'yellow' : 'off');
  paint(findByHint(IMPORT_HINT), importPending ? 'red' : 'off');
};

/**
 * Read the Trader sub-pages (if the player is on them) and stamp storage
 * from what they show — the passive counterpart to the action XHR events:
 *
 *   - Import/Export EVENT detection: an in-game news message carrying the
 *     `importexport_6` image means today is a "refreshes 6× today" day. Stamp
 *     the event day-key (and clear any stale next-refresh stamp) so the import
 *     glow lights immediately, ignoring the 14:00 gate and the once-daily clear.
 *   - Import/Export: a visible "done for today" overlay. During the 6× event it
 *     carries a "come back at HH:MM" time — parse that (digits only, never the
 *     localised words) into the next-refresh stamp so the glow re-arms exactly
 *     then. On a NORMAL day it just means the daily container is taken, so we
 *     stamp today's import day-key — same end-state as `oge:traderImportTraded`,
 *     letting the red glow clear from merely visiting the page.
 *   - Auctioneer: between auctions the page shows a live `#nextAuction`
 *     countdown behind a visible `.noAuctionOverlay`. Convert the countdown
 *     to an absolute quiet-until so the yellow glow returns exactly when the
 *     next auction opens. Guarded on the overlay so we never suppress yellow
 *     while an auction is actually live (overlay hidden).
 *
 * Idempotent and cheap: each branch writes only when the value would
 * actually change / move forward, so re-running on every refresh tick is a
 * no-op once stamped.
 *
 * @param {Date} now
 * @returns {void}
 */
const scanTraderSubpages = (now) => {
  const today = localDayKey(now);

  // Event detection — the 6×-today news message is open/listed somewhere.
  // Stamp the event day once; clearing the next-refresh stamp re-arms the
  // glow immediately ("mark Import/Export now"). Idempotent: only the first
  // sighting of the day writes.
  if (document.querySelector(IMPORT_EVENT_IMG_SEL) && safeLS.get(IMPORT_EVENT_KEY) !== today) {
    safeLS.set(IMPORT_EVENT_KEY, today);
    safeLS.remove(IMPORT_NEXT_KEY);
  }

  const eventActive = safeLS.get(IMPORT_EVENT_KEY) === today;

  // Import/Export — a visible overlay means no offer is currently available.
  if (isShown(document.querySelector(IMPORT_DONE_OVERLAY_SEL))) {
    let eventNow = eventActive;

    // Parse the (locale-independent) "come back at HH:MM" the overlay may
    // carry: present → another offer is coming at that wall-clock time today;
    // absent ("come back tomorrow") → the day's offers are exhausted.
    const time = parseClockTime(
      document.querySelector(IMPORT_DONE_TEXT_SEL)?.textContent ?? '',
    );
    const target = time !== null ? nextDailyOccurrence(now, time) : null;

    // Self-sustaining event detection (no news message needed): a SECOND,
    // DISTINCT intraday come-back time on the same local day can only happen
    // when the import refreshes more than once a day → the 6× event. A normal
    // day has a single daily reset, so it can never show two different same-day
    // come-back times — which is why this needs no knowledge of what a normal
    // day's overlay looks like, and never false-positives on one. Re-confirm
    // the event for today so a multi-day event survives past midnight without
    // re-reading the (once-only) news message. See {@link IMPORT_SEEN_KEY}.
    if (target !== null) {
      const seen = parseSeenRefresh(safeLS.get(IMPORT_SEEN_KEY));
      if (!eventNow && seen !== null && seen.day === today && seen.target !== target) {
        safeLS.set(IMPORT_EVENT_KEY, today);
        eventNow = true;
      }
      safeLS.set(IMPORT_SEEN_KEY, `${today}|${target}`);
    }

    if (eventNow) {
      // 6× event: re-arm at the parsed refresh time, or — when the overlay
      // carries no time (offers EXHAUSTED for the day) — at next local
      // midnight, after which `eventActive` flips off on its own and the normal
      // once-daily rule resumes. Without the midnight fallback the glow stayed
      // stuck red after the last container (importNextAt held a now-past time,
      // so `now >= importNextAt` kept it pending). Never stamp the once-daily
      // clear here (the event ignores it); only move the stamp FORWARD so
      // re-scans of the same overlay don't churn.
      const arm =
        target !== null ? target : nextDailyOccurrence(now, { hours: 0, minutes: 0 });
      const stored = readImportNextAt();
      if (stored === null || arm > stored) safeLS.set(IMPORT_NEXT_KEY, String(arm));
    } else if (safeLS.get(IMPORT_TRADED_KEY) !== today) {
      // Normal day: the single daily import was taken.
      safeLS.set(IMPORT_TRADED_KEY, today);
    }
  }

  // Auctioneer — no auction live; push the quiet window to the next auction.
  if (isShown(document.querySelector(AUCTION_NO_AUCTION_OVERLAY_SEL))) {
    const sec = parseTraderCountdown(
      document.querySelector(AUCTION_NEXT_COUNTDOWN_SEL)?.textContent ?? '',
    );
    if (sec !== null && sec > 0) {
      const target = now.getTime() + sec * 1000;
      const stored = readAuctionQuietUntil();
      // Only ever extend forward; a ±1 s wobble across ticks must not churn.
      if (stored === null || target > stored + 1000) {
        safeLS.set(AUCTION_QUIET_KEY, String(target));
      }
    }
  }
};

/**
 * Scan the Trader sub-pages, then re-render. The single refresh path used
 * by the MutationObserver, the safety-poll, and install. No-op when the
 * feature is toggled off (so navigating the Trader pages with it disabled
 * neither stamps storage nor paints).
 *
 * @returns {void}
 */
const refresh = () => {
  if (!settingsStore.get().traderMenuHighlight) return;
  scanTraderSubpages(new Date());
  applyHighlight();
};

/** Stamp the bid time and re-render. Driven by `oge:traderBidPlaced`. */
const onBidPlaced = () => {
  safeLS.set(AUCTION_BID_KEY, String(Date.now()));
  applyHighlight();
  document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/** Stamp today's import and re-render. Driven by `oge:traderImportTraded`. */
const onImportTraded = () => {
  safeLS.set(IMPORT_TRADED_KEY, localDayKey(new Date()));
  applyHighlight();
  document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/** Strip highlight + remove style — used when toggled off. */
const teardownDom = () => {
  stripHighlight();
  document.getElementById(STYLE_ID)?.remove();
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Trader highlight feature. Idempotent.
 *
 * @returns {() => void} Dispose handle.
 */
export const installTraderMenuHighlight = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);
  refresh();

  const scheduleRefresh = debounce(() => {
    if (installed) refresh();
  }, REFRESH_DEBOUNCE_MS);

  // Observe the whole body: the menu rebuilds via AJAX, and the Trader
  // overview (with our two tiles) is a separate region that renders on
  // navigation. We only watch childList/subtree — text-only mutations
  // (eventbox countdowns) don't fire it, so the cost stays low and the
  // 150 ms debounce coalesces bursts.
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

  // 60-second safety-poll: covers idle crossings of the auction/import
  // window boundaries, local midnight, and bid-snooze expiry.
  const safetyPoll = setInterval(() => {
    if (installed) refresh();
  }, SAFETY_POLL_MS);

  document.addEventListener(TRADER_BID_PLACED_EVENT, onBidPlaced);
  document.addEventListener(TRADER_IMPORT_TRADED_EVENT, onImportTraded);

  let prevEnabled = settingsStore.get().traderMenuHighlight;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.traderMenuHighlight === prevEnabled) return;
    prevEnabled = next.traderMenuHighlight;
    if (prevEnabled) {
      injectStyle(STYLE_ID, CSS);
      refresh();
    } else {
      teardownDom();
    }
  });

  installed = {
    dispose: () => {
      observer.disconnect();
      clearInterval(safetyPoll);
      document.removeEventListener(TRADER_BID_PLACED_EVENT, onBidPlaced);
      document.removeEventListener(TRADER_IMPORT_TRADED_EVENT, onImportTraded);
      unsubSettings();
      teardownDom();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetTraderMenuHighlightForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
