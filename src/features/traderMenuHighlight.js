// Trader highlight — two independent daily-action alarmClock, drawn as
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
// player just looks and leaves. So the alarmClock must clear on the action,
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
//   RED    — Import/Eksport. Two player-chosen MODES, switched with the chips
//            OG-E injects on the Import/Export page (see `renderTraderModeChips`):
//              • DAILY (default) — the once-per-day container. Shown ONLY from
//                14:00 onward (not earlier): it resets at local midnight, but
//                in-game quests that require a once-daily import purchase
//                activate only after 14:00 — nudging before 14 risks the player
//                "burning" their one daily import before such a quest appears.
//                Cleared by a successful trade; re-arms next local day.
//              • 6× ("event") — during the occasional "import refreshes 6×
//                today" event the offer refreshes every 4 hours from local
//                midnight (00/04/08/12/16/20). The 14:00 gate and once-daily
//                clear are dropped; the glow tracks the fixed 4-hour SLOTS — it
//                lights whenever the current slot's offer has not yet been taken
//                and clears for the rest of that slot once it is (all six slots
//                nudge, including the night ones).
//            We deliberately do NOT auto-detect which mode applies — that proved
//            unreliable (the event is announced inconsistently), so the PLAYER
//            picks it. As a convenience we auto-switch INTO 6× (once, never back)
//            when a RECENT "6× today" news message is seen in the inbox; the
//            player switches back to DAILY when the event ends. The mode is a
//            per-device preference (local, not synced).
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
//      rendering), and — for purely time-based crossings while idle (window
//      edges, midnight, snooze expiry) — when a single `clock.scheduleAt`
//      timer fires at the next boundary (see `nextTraderBoundary`).
//   3. Document-level listeners for `oge:traderBidPlaced` /
//      `oge:traderImportTraded` stamp storage and re-render immediately.
//   4. settingsStore subscription reacts to the on/off toggle.
//   5. Dispose strips classes, removes the style, disconnects the
//      observer, disposes the boundary timer, removes the event listeners, and
//      unsubscribes from settingsStore.

/** @ts-check */

import { injectStyle } from '../lib/dom.js';
import { createVisibilityObserver } from '../lib/visibilityObserver.js';
import { debounce } from '../lib/debounce.js';
import { safeLS } from '../lib/storage.js';
import { settingsStore } from '../state/settings.js';
import { GAME } from '../lib/gameDom.js';
import { parseTraderCountdown } from '../domain/traderCountdown.js';
import { nextDailyOccurrence, slotStartMs, nextSlotStartMs } from '../domain/traderClock.js';
import { clock } from '../lib/clock.js';
import {
  TRADER_AUCTION_BID_KEY,
  TRADER_IMPORT_KEY,
  TRADER_AUCTION_QUIET_KEY,
  TRADER_IMPORT_NEXT_KEY,
  readDailyState,
  writeDailyState,
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
 * OG-E's own mode-chooser chips, injected at the top of the Import/Export panel.
 * These are OUR ids/classes (not a game contract), so they live next to the code
 * that emits them. `CHIP_MODE_ATTR` tags each chip with the {@link MODE_DAILY} /
 * {@link MODE_6X} value it selects.
 */
const CHIPS_CLASS = 'oge-trader-mode-chips';
const CHIP_CLASS = 'oge-chip';
const CHIP_ON_CLASS = 'oge-chip-on';
const CHIP_LABEL_CLASS = 'oge-chip-label';
const CHIP_MODE_ATTR = 'data-oge-mode';

/**
 * The Import/Export panel we prepend the chips to (game DOM — fragile, local).
 * OGame renamed this id at the 1.13 bump: `div_traderImportExport` (≤1.12) →
 * `div_importexport` (1.13+, the `trader` prefix was dropped across the panel's
 * ids). Match BOTH so the chips AND the passive "offer gone" overlay scan keep
 * working across the version bump.
 */
const IMPORT_PANEL_SEL = '#div_traderImportExport, #div_importexport';

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
export const IMPORT_NEXT_KEY = TRADER_IMPORT_NEXT_KEY;

/**
 * Player's chosen Import/Export alarmClock mode. PER-DEVICE and NOT synced — it's
 * a preference, not server-wide state (see the header note): each device shows
 * its own chips and is auto-switched independently when its own inbox is read.
 */
export const IMPORT_MODE_KEY = 'oge-trader-import-mode';

/**
 * Epoch-ms START time of the "6× today" message we last auto-switched INTO 6×
 * for. One auto-switch per distinct message: this lets a manual switch-BACK to
 * daily stick (re-reading the inbox won't undo it) and stops a long-expired
 * message from re-arming 6× mode. Local, not synced.
 */
export const IMPORT_EVENT_SEEN_KEY = 'oge-trader-import-event-seen';

/**
 * Import/Export alarmClock modes (the values persisted in {@link IMPORT_MODE_KEY}).
 * Cast to their literal types so the exported symbols stay `'daily'`/`'6x'` (not
 * widened to `string`) for every consumer — the {@link TraderState} `mode` union
 * depends on it.
 */
export const MODE_DAILY = /** @type {'daily'} */ ('daily');
export const MODE_6X = /** @type {'6x'} */ ('6x');

/**
 * Trader sub-page selectors (game DOM — fragile, locale-independent where
 * possible). Local to this feature: no other feature reads the Trader pages.
 *   - The Import/Export "no offer now" overlay is shown (display ≠ none) once
 *     the current container is taken; its visibility is our "offer gone" signal
 *     (a once-daily clear on a normal day, the current 4h slot on an event day).
 *   - The Auctioneer shows `#nextAuction` (a live countdown) and a visible
 *     `.noAuctionOverlay` only between auctions; both together mean "no
 *     auction live right now", which is when we may push the quiet window.
 */
const IMPORT_DONE_OVERLAY_SEL =
  '#div_traderImportExport .bargain_overlay, #div_importexport .bargain_overlay';
const AUCTION_NEXT_COUNTDOWN_SEL = '#nextAuction';
const AUCTION_NO_AUCTION_OVERLAY_SEL = '.noAuctionOverlay';

/**
 * The "import refreshes 6× today" event is announced by an in-game news
 * message whose body carries this image. Matching the filename substring is
 * locale-independent — the message TEXT is translated, the asset name is not.
 */
const IMPORT_EVENT_IMG_SEL = 'img[src*="importexport_6"]';

/**
 * The message-list row wrapping one message, and the (hidden) metadata block
 * inside it that carries the server timestamp. We read the 6× message's OWN
 * `data-raw-timestamp` (epoch SECONDS) rather than merely "the image is on
 * screen": that dates the event so a single visit to the inbox covers the
 * whole multi-day run, AND a long-since-expired message reopened weeks later
 * can no longer re-trigger event mode (its window is already in the past).
 * The `.msg` row + `data-raw-timestamp` attribute are local to this feature;
 * the `.rawMessageData` block is shared with `features/targetsIngest`, so it
 * lives in `GAME.MESSAGES_RAW_DATA`.
 */
const MSG_ROW_SEL = '.msg';
const MSG_TIMESTAMP_ATTR = 'data-raw-timestamp';

/**
 * Recency window for the 6× AUTO-switch: an "import refreshes 6× today" inbox
 * message older than this (events run ~3 days) no longer flips the mode to 6×,
 * so a stale announcement reopened weeks later can't re-arm event mode. Only the
 * auto-switch is time-bounded — the player's manual choice never expires.
 */
const EVENT_RECENCY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Offer cadence during the event: the Import/Export container refreshes every
 * 4 hours counted from local midnight (00/04/08/12/16/20). The red nudge tracks
 * these slots — it never blacks out at night (all six slots nudge).
 */
const EVENT_SLOT_HOURS = 4;

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
/* OG-E mode-chooser chips on the Import/Export page. A compact pill row in
 * OGame's dark palette: the active mode reads in the accent blue, the inactive
 * one is muted. Our own UI — no game contract — so styled freely. */
.${CHIPS_CLASS} {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 6px 8px;
  background: rgba(20, 30, 40, 0.55);
  border: 1px solid #2a4a5a;
  border-radius: 4px;
  font-size: 12px;
}
.${CHIPS_CLASS} .${CHIP_LABEL_CLASS} {
  color: #9fb3c8;
  margin-right: 2px;
}
.${CHIPS_CLASS} button.${CHIP_CLASS} {
  padding: 3px 10px;
  border: 1px solid #2a4a5a;
  border-radius: 12px;
  background: #16222e;
  color: #9fb3c8;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.${CHIPS_CLASS} button.${CHIP_CLASS}:hover {
  border-color: #4a9eff;
  color: #cfe3f7;
}
.${CHIPS_CLASS} button.${CHIP_CLASS}.${CHIP_ON_CLASS} {
  background: #1a2a3a;
  border-color: #4a9eff;
  color: #4a9eff;
  font-weight: bold;
}
`;

const REFRESH_DEBOUNCE_MS = 300;

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
 * @property {'daily' | '6x'} [mode] Player-chosen Import/Export alarmClock mode.
 *   `'6x'` runs the 4-hour-slot event cadence; `'daily'` (default) the
 *   once-a-day 14:00 rule.
 * @property {number | null} [importNextAt] Epoch ms of the START of the last
 *   4-hour slot whose offer was taken; `null`/absent means the current slot's
 *   offer is still waiting. Used only in `'6x'` mode.
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
  const mode = state?.mode ?? MODE_DAILY;
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

  // Red (Import/Eksport). Two player-chosen modes:
  //   - 6× (mode === '6x'): the import isn't once-daily and the 14:00 gate
  //     doesn't apply. The offer refreshes every 4 h from midnight; pending
  //     whenever the CURRENT slot's offer has not yet been taken — i.e. the last
  //     taken slot (`importNextAt`) is older than the current slot's start (or
  //     nothing taken yet). All six slots nudge, incl. the 00:00 / 04:00 night.
  //   - DAILY (default): 14:00 onward, until taken today.
  const eventActive = mode === MODE_6X;
  const importPending = eventActive
    ? importNextAt === null || importNextAt < slotStartMs(now, EVENT_SLOT_HOURS)
    : hour >= IMPORT_START_HOUR && importTradedDay !== localDayKey(now);

  // Menu button is a single element — red wins over yellow when both pend.
  const menu = importPending ? 'red' : auctionPending ? 'yellow' : 'off';

  return { menu, auctionPending, importPending };
};

/**
 * The next epoch-ms at which {@link traderGlows} could change its verdict for
 * the given `state` — the soonest of: the auction window edges (open at
 * {@link AUCTION_START_HOUR}, close at {@link AUCTION_END_HOUR}), the import
 * gate ({@link IMPORT_START_HOUR}), local midnight (day rollover), the post-bid
 * snooze expiry, the auctioneer quiet-until, and — in 6× mode — the next 4-hour
 * slot boundary. Lets the feature wake EXACTLY at the next boundary instead of
 * polling. The daily hour/midnight terms guarantee a future result; `null`
 * only if nothing is computable.
 *
 * @param {Date} now
 * @param {TraderState} state
 * @returns {number | null}
 */
export const nextTraderBoundary = (now, state) => {
  const nowMs = now.getTime();
  const candidates = [
    nextDailyOccurrence(now, { hours: AUCTION_START_HOUR, minutes: 0 }),
    nextDailyOccurrence(now, { hours: AUCTION_END_HOUR, minutes: 0 }),
    nextDailyOccurrence(now, { hours: IMPORT_START_HOUR, minutes: 0 }),
    nextDailyOccurrence(now, { hours: 0, minutes: 0 }), // local midnight
  ];
  const bidAt = state?.auctionBidAt ?? null;
  if (bidAt !== null) candidates.push(bidAt + BID_SNOOZE_MS);
  const quietUntil = state?.auctionQuietUntil ?? null;
  if (quietUntil !== null) candidates.push(quietUntil);
  // 6× mode: wake at the next 4-hour slot boundary so the red glow re-arms for
  // each fresh offer without needing a Trader-page visit.
  if ((state?.mode ?? MODE_DAILY) === MODE_6X) {
    candidates.push(nextSlotStartMs(now, EVENT_SLOT_HOURS));
  }

  const future = candidates.filter((t) => t > nowMs);
  return future.length ? Math.min(...future) : null;
};

/**
 * The player's chosen Import/Export mode, defaulting to {@link MODE_DAILY} for
 * any missing / unrecognised value.
 *
 * @returns {'daily' | '6x'}
 */
const readMode = () => (safeLS.get(IMPORT_MODE_KEY) === MODE_6X ? MODE_6X : MODE_DAILY);

/**
 * Persist the chosen Import/Export mode (normalised to one of the two values).
 *
 * @param {'daily' | '6x'} mode
 * @returns {void}
 */
const writeMode = (mode) =>
  safeLS.set(IMPORT_MODE_KEY, mode === MODE_6X ? MODE_6X : MODE_DAILY);

/**
 * The start-ms of the 6× message we last auto-switched for, or `null` when none
 * / unparseable. Compared against the newest inbox announcement so each distinct
 * message triggers at most one auto-switch (see {@link IMPORT_EVENT_SEEN_KEY}).
 *
 * @returns {number | null}
 */
const readEventSeen = () => {
  const raw = safeLS.get(IMPORT_EVENT_SEEN_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Assemble the persisted state from the synced {@link DailyState}.
 *
 * `readDailyState()` is the single reader for the four synced trader keys; it
 * reports an absent epoch-ms field as `0` and an absent day-key as `''`. The
 * pure policy functions ({@link traderGlows} / {@link nextTraderBoundary}) use
 * `null` as their "unset" sentinel, so we translate `0`/`''` → `null` right
 * here at the read boundary — the one place the two conventions meet.
 *
 * @returns {TraderState}
 */
const readState = () => {
  const daily = readDailyState();
  return {
    auctionBidAt: daily.traderAuctionBidAt || null,
    importTradedDay: daily.traderImportDay || null,
    auctionQuietUntil: daily.traderAuctionQuietUntil || null,
    mode: readMode(),
    importNextAt: daily.traderImportNextAt || null,
  };
};

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

/** Every glow class this module manages on an element. */
const MANAGED_CLASSES = [HIGHLIGHT_CLASS, YELLOW_CLASS, RED_CLASS, MENU_CLASS];

/**
 * Reflect a colour decision onto one element. `'off'` strips the glow.
 * The menu button additionally gets the `MENU_CLASS` marker so its CSS
 * (gentler pulse + hover/selected yield) applies without touching tiles.
 *
 * IDEMPOTENT: when the element already carries exactly the wanted classes it is
 * left untouched. This matters because removing and re-adding an animated class
 * RESTARTS its CSS animation — and the MutationObserver fires often on Trader
 * sub-pages (the Auctioneer's live countdown rebuilds the DOM), so a naive
 * remove+add would restart the glow on every tick, making it flicker / "jump".
 *
 * @param {HTMLElement | null} el
 * @param {'off' | 'yellow' | 'red'} color
 * @param {boolean} [isMenu] Whether `el` is the menu button.
 * @returns {void}
 */
const paint = (el, color, isMenu = false) => {
  if (!el) return;
  const want =
    color === 'off'
      ? []
      : isMenu
        ? [HIGHLIGHT_CLASS, color === 'red' ? RED_CLASS : YELLOW_CLASS, MENU_CLASS]
        : [HIGHLIGHT_CLASS, color === 'red' ? RED_CLASS : YELLOW_CLASS];
  const current = MANAGED_CLASSES.filter((c) => el.classList.contains(c));
  if (current.length === want.length && want.every((c) => el.classList.contains(c))) {
    return; // already correct — don't touch classList (would restart the pulse)
  }
  el.classList.remove(...MANAGED_CLASSES);
  if (want.length) el.classList.add(...want);
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
  // Re-arm the boundary wake from fresh state — covers every repaint path
  // (refresh after a scan, bid placed, import traded).
  boundary?.reschedule();
};

/**
 * Newest "import refreshes 6× today" announcement currently in the inbox,
 * returned as its server START time in epoch-ms (the message's own
 * `data-raw-timestamp`, which is in SECONDS). `null` when no such message is
 * present. Reading the message's OWN timestamp — rather than merely "the image
 * is on screen" — is what dates the event: one inbox visit covers the whole
 * multi-day run, and a long-expired message reopened later cannot re-trigger
 * event mode because its derived window is already in the past.
 *
 * @returns {number | null}
 */
const readNewestEventStartMs = () => {
  let newest = 0;
  document.querySelectorAll(IMPORT_EVENT_IMG_SEL).forEach((img) => {
    const raw = img.closest(MSG_ROW_SEL)?.querySelector(GAME.MESSAGES_RAW_DATA);
    const sec = Number(raw?.getAttribute(MSG_TIMESTAMP_ATTR));
    if (Number.isFinite(sec) && sec > 0) newest = Math.max(newest, sec * 1000);
  });
  return newest > 0 ? newest : null;
};

/**
 * Record that the Import/Export container was just taken at `now`. In 6× mode
 * stamp the CURRENT 4-hour slot (suppresses red until the next boundary);
 * otherwise stamp today's once-daily clear. Only ever moves the slot stamp
 * forward, so repeated calls within a slot don't churn. Shared by the
 * `oge:traderImportTraded` XHR signal and the passive "overlay shown" scan.
 *
 * Writes go through {@link writeDailyState} (the sanctioned key-owner) so the
 * synced `dailyStatePerUniverse` slot stays consistent; returns whether a value
 * actually changed so the caller can gate the {@link DAILY_STATE_CHANGED_EVENT}
 * upload nudge on real progress.
 *
 * @param {Date} now
 * @returns {boolean} `true` when a stamp was written (state changed).
 */
const markImportTaken = (now) => {
  const today = localDayKey(now);
  const daily = readDailyState();
  if (readMode() === MODE_6X) {
    const slot = slotStartMs(now, EVENT_SLOT_HOURS);
    // `traderImportNextAt` is 0 when unset; `slot` is always > 0, so this also
    // covers the "nothing taken yet" case (old null-guard) without a branch.
    if (slot > daily.traderImportNextAt) {
      writeDailyState({ traderImportNextAt: slot });
      return true;
    }
  } else if (daily.traderImportDay !== today) {
    writeDailyState({ traderImportDay: today });
    return true;
  }
  return false;
};

/**
 * Read the Trader sub-pages / message inbox (if the player is on them) and
 * stamp storage from what they show — the passive counterpart to the action
 * XHR events:
 *
 *   - 6× AUTO-switch (message inbox only): a RECENT `importexport_6`
 *     announcement (within {@link EVENT_RECENCY_MS} of its own timestamp) flips
 *     the mode to 6×, once per distinct message (see {@link IMPORT_EVENT_SEEN_KEY}).
 *     A stale, long-expired message can't re-arm it, and a manual switch-back to
 *     daily is never undone by re-reading the inbox.
 *   - Import/Export: a visible "offer gone" overlay means the current container
 *     was taken — record it via {@link markImportTaken} (current 4h slot during
 *     the event, today's once-daily clear otherwise), so the red glow clears
 *     from merely visiting the page.
 *   - Auctioneer: between auctions the page shows a live `#nextAuction`
 *     countdown behind a visible `.noAuctionOverlay`. Convert the countdown
 *     to an absolute quiet-until so the yellow glow returns exactly when the
 *     next auction opens. Guarded on the overlay so we never suppress yellow
 *     while an auction is actually live (overlay hidden).
 *
 * Idempotent and cheap: each branch writes only when the value would actually
 * change / move forward, so re-running on every refresh tick is a no-op once
 * stamped. The whole-document image scan is gated to the messages page so it
 * never runs on the hot Auctioneer path.
 *
 * @param {Date} now
 * @returns {void}
 */
const scanTraderSubpages = (now) => {
  // 6× auto-switch — only on the messages page (keeps the attribute-substring
  // image scan off the hot Trader / Auctioneer paths). A RECENT "import refreshes
  // 6× today" announcement flips the mode to 6× ONCE per distinct message (keyed
  // on its own start time): re-reading the inbox won't undo a manual switch-back,
  // and a stale/old message can't re-arm it. Switching back to daily is manual.
  if (location.search.includes('component=messages')) {
    const startMs = readNewestEventStartMs();
    if (
      startMs !== null &&
      now.getTime() - startMs < EVENT_RECENCY_MS &&
      readEventSeen() !== startMs
    ) {
      safeLS.set(IMPORT_EVENT_SEEN_KEY, String(startMs));
      writeMode(MODE_6X);
    }
  }

  // Import/Export — a visible overlay means the current offer is gone (taken).
  // Route through the key-owner + nudge sync only when the stamp actually moved.
  if (
    isShown(document.querySelector(IMPORT_DONE_OVERLAY_SEL)) &&
    markImportTaken(now)
  ) {
    document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
  }

  // Auctioneer — no auction live; push the quiet window to the next auction.
  if (isShown(document.querySelector(AUCTION_NO_AUCTION_OVERLAY_SEL))) {
    const sec = parseTraderCountdown(
      document.querySelector(AUCTION_NEXT_COUNTDOWN_SEL)?.textContent ?? '',
    );
    if (sec !== null && sec > 0) {
      const target = now.getTime() + sec * 1000;
      // `traderAuctionQuietUntil` is 0 when unset. Only ever extend forward;
      // a ±1 s wobble across ticks must not churn. When unset (0), any
      // positive target clears the guard (target > 0 + 1000) exactly as the
      // old `stored === null` case did.
      const stored = readDailyState().traderAuctionQuietUntil;
      if (target > stored + 1000) {
        writeDailyState({ traderAuctionQuietUntil: target });
        document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
      }
    }
  }
};

/**
 * The two mode chips, as `[mode, label, tooltip]` rows. Labels stay in OG-E's
 * own English (matching the settings panel); the cadence + start hour are baked
 * into each label so the choice is self-explanatory.
 *
 * @type {ReadonlyArray<readonly ['daily' | '6x', string, string]>}
 */
const MODE_CHIPS = [
  [
    MODE_DAILY,
    '1×/day · from 14:00',
    'One glow per day, from 14:00 (the normal once-a-day import).',
  ],
  [
    MODE_6X,
    '6×/day · every 4 h',
    'Six glows per day on the 4-hour event slots ' +
      '(00/04/08/12/16/20). Auto-enabled when a "refreshes 6× today" ' +
      'message is seen; switch back here when the event ends.',
  ],
];

/**
 * Apply the player's mode choice from a chip click: persist it and repaint both
 * the chips (selected state) and the glows.
 *
 * @param {'daily' | '6x'} mode
 * @returns {void}
 */
const onModeChipClick = (mode) => {
  writeMode(mode);
  renderTraderModeChips();
  applyHighlight();
};

/**
 * Build the chips bar (label + the two mode buttons). Each button stops event
 * propagation so a click can't bubble into OGame's own panel handlers.
 *
 * @returns {HTMLDivElement}
 */
const buildModeChipsBar = () => {
  const bar = document.createElement('div');
  bar.className = CHIPS_CLASS;

  const label = document.createElement('span');
  label.className = CHIP_LABEL_CLASS;
  label.textContent = 'OG-E trader:';
  bar.appendChild(label);

  for (const [mode, text, tooltip] of MODE_CHIPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CHIP_CLASS;
    btn.setAttribute(CHIP_MODE_ATTR, mode);
    btn.textContent = text;
    btn.title = tooltip;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onModeChipClick(mode);
    });
    bar.appendChild(btn);
  }
  return bar;
};

/**
 * Inject (once) the mode chips at the top of the Import/Export panel and reflect
 * the current mode on them. No-op when the panel isn't on screen (the player
 * isn't on the Import/Export page). Idempotent: re-uses an existing bar and only
 * flips a chip's selected class when it is actually wrong, so re-running on every
 * MutationObserver tick neither duplicates the bar nor needlessly feeds the
 * observer (which would loop).
 *
 * @returns {void}
 */
const renderTraderModeChips = () => {
  const panel = document.querySelector(IMPORT_PANEL_SEL);
  if (!panel) return;
  let bar = panel.querySelector(`.${CHIPS_CLASS}`);
  if (!bar) {
    bar = buildModeChipsBar();
    panel.insertBefore(bar, panel.firstChild);
  }
  const mode = readMode();
  bar.querySelectorAll(`[${CHIP_MODE_ATTR}]`).forEach((btn) => {
    const on = btn.getAttribute(CHIP_MODE_ATTR) === mode;
    if (btn.classList.contains(CHIP_ON_CLASS) !== on) {
      btn.classList.toggle(CHIP_ON_CLASS, on);
    }
  });
};

/** Remove the injected chips bar(s). Used by teardown / the disabled path. */
const removeTraderModeChips = () => {
  document.querySelectorAll(`.${CHIPS_CLASS}`).forEach((el) => el.remove());
};

/**
 * Scan the Trader sub-pages, render the mode chips, then re-render the glows.
 * The single refresh path used by the MutationObserver, the boundary timer, and
 * install. No-op when the feature is toggled off (so navigating the Trader pages
 * with it disabled neither stamps storage, injects chips, nor paints).
 *
 * @returns {void}
 */
const refresh = () => {
  if (!settingsStore.get().traderMenuHighlight) return;
  scanTraderSubpages(new Date());
  renderTraderModeChips();
  applyHighlight();
};

/** Stamp the bid time and re-render. Driven by `oge:traderBidPlaced`. */
const onBidPlaced = () => {
  writeDailyState({ traderAuctionBidAt: Date.now() });
  applyHighlight();
  document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/** Record the import (slot during the event, day otherwise) and re-render.
 *  Driven by `oge:traderImportTraded`. */
const onImportTraded = () => {
  const changed = markImportTaken(new Date());
  applyHighlight();
  if (changed) document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/** Strip highlight + chips + style — used when toggled off / on dispose. */
const teardownDom = () => {
  stripHighlight();
  removeTraderModeChips();
  document.getElementById(STYLE_ID)?.remove();
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/** @type {{ reschedule: () => void, dispose: () => void } | null} */
let boundary = null;

/**
 * Install the Trader highlight feature. Idempotent.
 *
 * @returns {() => void} Dispose handle.
 */
export const installTraderMenuHighlight = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);
  // Wake exactly at the next policy boundary (window edges, midnight, snooze
  // expiry, the next 6× slot) instead of polling. Re-armed by every
  // `applyHighlight()`; the initial `refresh()` below makes the first arm.
  boundary = clock.scheduleAt(
    () => nextTraderBoundary(new Date(), readState()),
    applyHighlight,
  );
  refresh();

  const scheduleRefresh = debounce(() => {
    if (installed) refresh();
  }, REFRESH_DEBOUNCE_MS);

  // Observe the whole body: the menu rebuilds via AJAX, and the Trader
  // overview (with our two tiles) is a separate region that renders on
  // navigation. We only watch childList/subtree — text-only mutations
  // (eventbox countdowns) don't fire it, so the cost stays low and the
  // 300 ms debounce coalesces bursts.
  const observer = createVisibilityObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

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
      boundary?.dispose();
      boundary = null;
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
