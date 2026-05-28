// Trader menu highlight — gentle reminder to visit the in-game Trader
// (Handlarz) without nagging the player.
//
// # Problem
//
// The Trader gives one or two daily resource bonuses the player should
// pick up, but the menu entry is identical in styling to Officers and
// Shop and easy to forget about during a routine. A loud always-on
// highlight would be irritating because the Trader is NOT urgent — it's
// a "nice to remember" thing.
//
// # Solution
//
// Two-tier time-aware pulse on the Trader menu button, with a
// "snooze-until-next-slot" reaction to clicks:
//
//   - 00:00–06:00 (night)       → no highlight
//   - 06:00–14:00               → subtle yellow pulse, suppressed for
//                                 the current 30-minute slot if the user
//                                 has already clicked Trader inside it
//   - 14:00–24:00, BEFORE the
//     first click of the day    → intense red pulse (the daily reset
//                                 is by local calendar date)
//   - 14:00–24:00, AFTER the
//     first click of the day    → subtle yellow pulse with the same
//                                 30-minute-slot suppression
//
// "Slot" means a half-hour window aligned to :00 and :30 of local time
// (06:00–06:30, 06:30–07:00, …, 22:30–23:00, 23:00–23:30, 23:30–24:00).
// If you click Trader at 18:14 the pulse goes away until 18:30; at 18:30
// the subtle pulse comes back to remind you again. The intense red is a
// one-shot per day — first click in the day silences it for the rest of
// that calendar day even if the day rolls forward later.
//
// Reset boundary: a new calendar day (local midnight) re-enables the
// intense window. Slot suppression resets every 30 minutes because the
// "last click" timestamp moves slots as wall time advances.
//
// # Why not gate on eventMenuHighlight
//
// The Trader is a permanent menu item; the event highlight is for
// ephemeral OGame-injected entries. The two features draw attention to
// different things and the user should be able to disable one without
// disabling the other — hence a separate `traderMenuHighlight` setting.
//
// # Lifecycle
//
//   1. `installTraderMenuHighlight()` injects the stylesheet once.
//   2. `applyHighlight()` runs immediately, then on every debounced
//      MutationObserver tick (catches AJAX rebuilds of the toolbar) and
//      on a 60-second safety-poll (catches slot boundary crossings —
//      slots are 30 minutes so a minute of latency is invisible).
//   3. A delegated `click` listener on `document` records the click
//      timestamp under `TRADER_CLICK_KEY` whenever the user activates
//      the Trader anchor. Delegation survives AJAX rebuilds without a
//      per-element re-bind.
//   4. settingsStore subscription reacts to the on/off toggle.
//   5. Dispose strips classes, removes the style element, disconnects
//      the observer, clears the poll, removes the click listener, and
//      unsubscribes from settingsStore.

/** @ts-check */

import { injectStyle } from '../lib/dom.js';
import { debounce } from '../lib/debounce.js';
import { safeLS } from '../lib/storage.js';
import { settingsStore } from '../state/settings.js';

const STYLE_ID = 'oge-trader-highlight-style';

/** Base CSS class on the Trader menu button when highlighted. */
const HIGHLIGHT_CLASS = 'oge-trader-highlight';

/** Modifier classes that pick which color/intensity is active. */
const SUBTLE_CLASS = 'oge-trader-subtle';
const INTENSE_CLASS = 'oge-trader-intense';

/**
 * `data-ipi-hint` value identifying the Trader menu anchor. The hint is
 * the OGame engine's locale-independent identifier — "Handlarz" in PL,
 * "Trader" in EN, same hint everywhere.
 */
const TRADER_HINT = 'ipiToolbarTrader';

/**
 * localStorage key that stores the millisecond timestamp of the user's
 * last click on the Trader anchor. Used to derive both "first click
 * today" (suppress intense) and "click within current slot" (suppress
 * subtle) decisions.
 */
export const TRADER_CLICK_KEY = 'oge-trader-last-click';

/**
 * Slot length in milliseconds. 30 minutes — see file header for the
 * reason the slot grid is aligned to :00 / :30 local time.
 */
const SLOT_MS = 30 * 60 * 1000;

/**
 * Hour-of-day at which the intense (red) window opens. Inclusive.
 * Before this hour the highlight is subtle (yellow) if it shows at all.
 */
const INTENSE_START_HOUR = 14;

/**
 * Hour-of-day at which the night blackout begins (no highlight at all).
 * Exclusive lower bound: at HH=23:59 we are still in the intense window;
 * at HH=00:00 we are in the night blackout.
 */
const NIGHT_END_HOUR = 6;

const CSS = `
@keyframes oge-trader-subtle-bg {
  0%, 100% {
    box-shadow: inset 0 0 4px rgba(255, 235, 80, 0.20),
                0 0 2px rgba(255, 220, 60, 0.10);
  }
  50% {
    box-shadow: inset 0 0 12px rgba(255, 230, 70, 0.55),
                0 0 9px rgba(255, 215, 50, 0.35);
  }
}
@keyframes oge-trader-subtle-text {
  0%, 100% { color: #ffe680; text-shadow: 0 0 3px rgba(255, 220, 80, 0.25); }
  50%      { color: #fff2a8; text-shadow: 0 0 6px rgba(255, 225, 90, 0.50); }
}
@keyframes oge-trader-intense-bg {
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
@keyframes oge-trader-intense-text {
  0%, 100% { color: #ff9080; text-shadow: 0 0 4px rgba(255, 60, 40, 0.40); }
  50%      { color: #ffd0c0; text-shadow: 0 0 9px rgba(255, 80, 50, 0.75); }
}
.${HIGHLIGHT_CLASS} {
  border-radius: 3px;
}
.${HIGHLIGHT_CLASS}.${SUBTLE_CLASS} {
  animation: oge-trader-subtle-bg 4s ease-in-out infinite;
}
.${HIGHLIGHT_CLASS}.${SUBTLE_CLASS} span {
  animation: oge-trader-subtle-text 4s ease-in-out infinite;
  font-weight: bold;
}
.${HIGHLIGHT_CLASS}.${INTENSE_CLASS} {
  animation: oge-trader-intense-bg 4s ease-in-out infinite;
}
.${HIGHLIGHT_CLASS}.${INTENSE_CLASS} span {
  animation: oge-trader-intense-text 4s ease-in-out infinite;
  font-weight: bold;
}
.${HIGHLIGHT_CLASS}:hover,
.${HIGHLIGHT_CLASS}:active {
  animation-name: none;
}
.${HIGHLIGHT_CLASS}:hover span,
.${HIGHLIGHT_CLASS}:active span {
  animation-name: none;
}
`;

const REFRESH_DEBOUNCE_MS = 150;
const SAFETY_POLL_MS = 60_000;

/**
 * Start-of-slot timestamp for the given moment. A "slot" is a 30-minute
 * window aligned to :00 and :30 of local time. Two `Date`s share a slot
 * iff their slot-start timestamps are equal — that is the only
 * comparison this helper exists for.
 *
 * @param {Date} d
 * @returns {number} Milliseconds since epoch for the start of the slot.
 */
const slotStart = (d) => {
  const minute = d.getMinutes();
  const slotMinute = minute < 30 ? 0 : 30;
  const start = new Date(d);
  start.setMinutes(slotMinute, 0, 0);
  return start.getTime();
};

/**
 * True iff `a` and `b` fall on the same local calendar day. Used to
 * decide whether the "first click of the day" flag should silence the
 * intense pulse.
 *
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
const sameLocalDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Pure decision function for the highlight mode at a given moment.
 * Encapsulates the entire policy described in the file header so the
 * logic is testable without DOM or localStorage.
 *
 * @param {Date} now
 *   Current local time.
 * @param {number | null} lastClickMs
 *   Epoch milliseconds of the user's last Trader click, or `null` if
 *   they have never clicked.
 * @returns {'off' | 'subtle' | 'intense'}
 */
export const computeTraderMode = (now, lastClickMs) => {
  const hour = now.getHours();

  // Night blackout: 00:00–06:00 local time. The trader is closed in the
  // user's daily rhythm — no nudges while they're asleep.
  if (hour < NIGHT_END_HOUR) return 'off';

  const clickedToday =
    lastClickMs !== null && sameLocalDay(now, new Date(lastClickMs));

  // Intense window: 14:00–24:00 local time, ONLY until the first click
  // of the current calendar day. The user explicitly asked for this
  // late-day escalation — they're more likely to be active and the
  // Trader reset is still pending.
  if (hour >= INTENSE_START_HOUR && !clickedToday) return 'intense';

  // Subtle path. Suppressed inside the half-hour slot the user already
  // clicked in; comes back at the next :00 / :30 boundary.
  if (lastClickMs !== null && slotStart(now) === slotStart(new Date(lastClickMs))) {
    return 'off';
  }
  return 'subtle';
};

/**
 * Read the stored last-click timestamp. Returns `null` when the key is
 * missing or unparseable so callers can branch on "ever clicked" cleanly.
 *
 * @returns {number | null}
 */
const readLastClick = () => {
  const raw = safeLS.get(TRADER_CLICK_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Locate the Trader menu anchor in the current DOM, or `null` if the
 * menu hasn't rendered yet. Cheap enough to call on every refresh.
 *
 * @returns {HTMLElement | null}
 */
const findTraderAnchor = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector(`#menuTable [data-ipi-hint="${TRADER_HINT}"]`)
  );

/**
 * Strip the highlight classes from any element that has them. Used by
 * both the per-refresh re-application and teardown.
 *
 * @returns {void}
 */
const stripHighlight = () => {
  document
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) =>
      el.classList.remove(HIGHLIGHT_CLASS, SUBTLE_CLASS, INTENSE_CLASS),
    );
};

/**
 * Read settings + storage + clock, compute the mode, and reflect it on
 * the Trader anchor. No-op when the feature is disabled.
 *
 * @returns {void}
 */
const applyHighlight = () => {
  if (!settingsStore.get().traderMenuHighlight) return;
  const anchor = findTraderAnchor();
  if (!anchor) return;

  const mode = computeTraderMode(new Date(), readLastClick());
  anchor.classList.remove(HIGHLIGHT_CLASS, SUBTLE_CLASS, INTENSE_CLASS);
  if (mode === 'off') return;
  anchor.classList.add(HIGHLIGHT_CLASS, mode === 'intense' ? INTENSE_CLASS : SUBTLE_CLASS);
};

/**
 * Document-level click handler. We use delegation rather than binding
 * directly to the anchor because OGame may AJAX-replace the menu and
 * we don't want to chase those rebuilds with re-binds. `target.closest`
 * gives us the anchor regardless of which inner child the user actually
 * clicked.
 *
 * @param {Event} ev
 * @returns {void}
 */
const onDocumentClick = (ev) => {
  const target = /** @type {Element | null} */ (ev.target);
  if (!target || typeof target.closest !== 'function') return;
  const anchor = target.closest(`[data-ipi-hint="${TRADER_HINT}"]`);
  if (!anchor) return;
  safeLS.set(TRADER_CLICK_KEY, String(Date.now()));
  // Re-evaluate so the highlight disappears immediately — without this
  // the user sees the pulse persist until the next observer tick.
  applyHighlight();
};

/** Strip highlight + remove style — used when toggled off. */
const teardownDom = () => {
  stripHighlight();
  document.getElementById(STYLE_ID)?.remove();
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Trader menu highlight feature. Idempotent.
 *
 * @returns {() => void} Dispose handle.
 */
export const installTraderMenuHighlight = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);
  applyHighlight();

  const scheduleRefresh = debounce(() => {
    if (installed) applyHighlight();
  }, REFRESH_DEBOUNCE_MS);

  const observer = new MutationObserver(scheduleRefresh);
  const target = document.getElementById('menuTable') ?? document.body;
  observer.observe(target, { childList: true, subtree: true });

  // 60-second safety-poll: covers (a) crossing a slot boundary while
  // idle, (b) crossing midnight while idle, (c) observer gaps. Slots
  // are 30 minutes so a minute of latency at the boundary is invisible.
  const safetyPoll = setInterval(() => {
    if (installed) applyHighlight();
  }, SAFETY_POLL_MS);

  document.addEventListener('click', onDocumentClick, true);

  let prevEnabled = settingsStore.get().traderMenuHighlight;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.traderMenuHighlight === prevEnabled) return;
    prevEnabled = next.traderMenuHighlight;
    if (prevEnabled) {
      injectStyle(STYLE_ID, CSS);
      applyHighlight();
    } else {
      teardownDom();
    }
  });

  installed = {
    dispose: () => {
      observer.disconnect();
      clearInterval(safetyPoll);
      document.removeEventListener('click', onDocumentClick, true);
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
