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
import {
  TRADER_AUCTION_BID_KEY,
  TRADER_IMPORT_KEY,
  TRADER_AUCTION_QUIET_KEY,
  DAILY_STATE_CHANGED_EVENT,
} from '../state/dailyActions.js';

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
const AUCTION_NEXT_COUNTDOWN_SEL = '#nextAuction';
const AUCTION_NO_AUCTION_OVERLAY_SEL = '.noAuctionOverlay';

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
  0%, 100% {
    box-shadow: inset 0 0 4px rgba(255, 235, 80, 0.20),
                0 0 2px rgba(255, 220, 60, 0.10);
  }
  50% {
    box-shadow: inset 0 0 12px rgba(255, 230, 70, 0.55),
                0 0 9px rgba(255, 215, 50, 0.35);
  }
}
@keyframes oge-trader-yellow-text {
  0%, 100% { color: #ffe680; text-shadow: 0 0 3px rgba(255, 220, 80, 0.25); }
  50%      { color: #fff2a8; text-shadow: 0 0 6px rgba(255, 225, 90, 0.50); }
}
@keyframes oge-trader-red-bg {
  0%, 100% {
    box-shadow: inset 0 0 6px rgba(255, 60, 40, 0.35),
                0 0 4px rgba(255, 40, 20, 0.20);
  }
  50% {
    box-shadow: inset 0 0 20px rgba(255, 70, 50, 0.85),
                0 0 16px rgba(255, 40, 20, 0.65),
                0 0 30px rgba(255, 30, 10, 0.30);
  }
}
@keyframes oge-trader-red-text {
  0%, 100% { color: #ff9080; text-shadow: 0 0 4px rgba(255, 60, 40, 0.40); }
  50%      { color: #ffd0c0; text-shadow: 0 0 9px rgba(255, 80, 50, 0.75); }
}
/* Menu-only pulses — deliberately gentler than the tile keyframes above
 * (the menu button is small and sits in a busy sidebar, so a softer frame
 * reads better). The tiles keep the stronger pulse. */
@keyframes oge-trader-menu-yellow-bg {
  0%, 70%, 100% { box-shadow: inset 0 0 3px rgba(255, 235, 80, 0.15); }
  85% {
    box-shadow: inset 0 0 7px rgba(255, 230, 70, 0.40),
                0 0 4px rgba(255, 215, 50, 0.20);
  }
}
@keyframes oge-trader-menu-red-bg {
  0%, 70%, 100% { box-shadow: inset 0 0 4px rgba(255, 60, 40, 0.25); }
  85% {
    box-shadow: inset 0 0 10px rgba(255, 70, 50, 0.55),
                0 0 7px rgba(255, 40, 20, 0.30);
  }
}
.${HIGHLIGHT_CLASS} {
  border-radius: 3px;
}
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} {
  animation: oge-trader-yellow-bg 4s ease-in-out infinite;
}
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} span,
.${HIGHLIGHT_CLASS}.${YELLOW_CLASS} h2 {
  animation: oge-trader-yellow-text 4s ease-in-out infinite;
  font-weight: bold;
}
.${HIGHLIGHT_CLASS}.${RED_CLASS} {
  animation: oge-trader-red-bg 4s ease-in-out infinite;
}
.${HIGHLIGHT_CLASS}.${RED_CLASS} span,
.${HIGHLIGHT_CLASS}.${RED_CLASS} h2 {
  animation: oge-trader-red-text 4s ease-in-out infinite;
  font-weight: bold;
}
/* TILES keep their pulse on hover on purpose: OGame only swaps their
 * background image, and a RUNNING animation outranks the game's static
 * hover declarations in the cascade, so the glow survives (we never touch
 * the background property — the swapped image and our glow coexist).
 *
 * The MENU button is different. It carries ${MENU_CLASS} and a gentler
 * pulse, and on :hover / :active / selected (.on) it stops pulsing and
 * shows a STEADY glow — mirroring eventMenuHighlight. A running pulse
 * would smother OGame's own hover/selected styling; a steady, softer glow
 * lets that native state read through while still marking the item. */
.${MENU_CLASS}.${YELLOW_CLASS} { animation-name: oge-trader-menu-yellow-bg; animation-timing-function: linear; }
.${MENU_CLASS}.${RED_CLASS} { animation-name: oge-trader-menu-red-bg; animation-timing-function: linear; }
.${MENU_CLASS}.${YELLOW_CLASS}:hover,
.${MENU_CLASS}.${YELLOW_CLASS}:active,
.${MENU_CLASS}.${YELLOW_CLASS}.on {
  animation-name: none;
  box-shadow: inset 0 0 8px rgba(255, 230, 70, 0.45),
              0 0 5px rgba(255, 215, 50, 0.25);
}
.${MENU_CLASS}.${YELLOW_CLASS}:hover span,
.${MENU_CLASS}.${YELLOW_CLASS}:active span,
.${MENU_CLASS}.${YELLOW_CLASS}.on span {
  animation-name: none;
  color: #fff2a8;
  text-shadow: 0 0 6px rgba(255, 225, 90, 0.50);
}
.${MENU_CLASS}.${RED_CLASS}:hover,
.${MENU_CLASS}.${RED_CLASS}:active,
.${MENU_CLASS}.${RED_CLASS}.on {
  animation-name: none;
  box-shadow: inset 0 0 10px rgba(255, 70, 50, 0.55),
              0 0 7px rgba(255, 40, 20, 0.30);
}
.${MENU_CLASS}.${RED_CLASS}:hover span,
.${MENU_CLASS}.${RED_CLASS}:active span,
.${MENU_CLASS}.${RED_CLASS}.on span {
  animation-name: none;
  color: #ffd0c0;
  text-shadow: 0 0 8px rgba(255, 80, 50, 0.65);
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

  // Yellow (Licytator): auction hours, suppressed while EITHER the ~30-min
  // post-bid snooze is active OR the "next auction" quiet window (read off
  // the Auctioneer page between auctions) has not yet elapsed.
  const inAuctionWindow = hour >= AUCTION_START_HOUR && hour < AUCTION_END_HOUR;
  const bidSnoozed =
    auctionBidAt !== null && now.getTime() - auctionBidAt < BID_SNOOZE_MS;
  const quietActive =
    auctionQuietUntil !== null && now.getTime() < auctionQuietUntil;
  const auctionPending = inAuctionWindow && !bidSnoozed && !quietActive;

  // Red (Import/Eksport): 14:00 onward, until taken today.
  const inImportWindow = hour >= IMPORT_START_HOUR;
  const importPending = inImportWindow && importTradedDay !== localDayKey(now);

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
 * Assemble the persisted state from localStorage.
 *
 * @returns {TraderState}
 */
const readState = () => ({
  auctionBidAt: readAuctionBidAt(),
  importTradedDay: safeLS.get(IMPORT_TRADED_KEY),
  auctionQuietUntil: readAuctionQuietUntil(),
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
 *   - Import/Export: a visible "done for today" overlay means today's
 *     container is already taken (or there are no more offers), so stamp
 *     today's import day-key — same end-state as `oge:traderImportTraded`.
 *     Lets the red glow clear from merely visiting the page, not only from
 *     trading through it in this session.
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
  // Import/Export — daily container taken / no more offers today.
  if (isShown(document.querySelector(IMPORT_DONE_OVERLAY_SEL))) {
    const today = localDayKey(now);
    if (safeLS.get(IMPORT_TRADED_KEY) !== today) safeLS.set(IMPORT_TRADED_KEY, today);
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

  document.addEventListener('oge:traderBidPlaced', onBidPlaced);
  document.addEventListener('oge:traderImportTraded', onImportTraded);

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
      document.removeEventListener('oge:traderBidPlaced', onBidPlaced);
      document.removeEventListener('oge:traderImportTraded', onImportTraded);
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
