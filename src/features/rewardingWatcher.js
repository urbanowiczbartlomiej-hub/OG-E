// Rewarding watcher — detects when all daily tasks on the Rewarding page
// are completed and stamps the current game-day so the event-menu highlight
// can be suppressed until the next 14:00 reset.
//
// # Problem
//
// The event menu button pulses orange to draw attention to an active event.
// But once the player has finished every task for the day, the pulse becomes
// noise — it fires the same every day, trained to be ignored. We need to
// know "player is done for today" and turn the highlight off.
//
// # Solution
//
// Only on the Rewarding page (`?page=ingame&component=rewarding`) we observe
// the task list. When EVERY `.rewardlist-item` carries a `.reward-claimed-text`
// badge the player has completed all available tasks for this game-day.
// We write the current game-day key (YYYY-MM-DD, 14:00 reset) to localStorage
// and dispatch `oge:dailyStateChanged` so the sync scheduler uploads the
// result to the gist.
//
// # Page detection
//
// `URLSearchParams(location.search).get('component') === 'rewarding'`
// is locale-independent and survives OGame renames of the button label.
//
// # Completion rule
//
// All `.rewardlist-item` nodes inside `#rewardings` must have a child
// `.reward-claimed-text`. The list is non-empty (guards against a transient
// empty DOM while the AJAX render is in flight).
//
// # Lifecycle
//
//   1. `installRewardingWatcher()` is a no-op on every page except the
//      Rewarding page.
//   2. On the Rewarding page a MutationObserver on `document.body` runs
//      `checkCompletion()` on every DOM change (debounced 200 ms).
//   3. A 3-second safety-poll covers the case where OGame re-renders the
//      list after a task is stamped server-side.
//   4. Once a done-day is written it is not re-written unnecessarily —
//      `checkCompletion` short-circuits when the stored key already matches
//      the current game-day.
//   5. Dispose disconnects the observer and clears the poll.
//
// Idempotent install: a second call returns the same dispose fn.
//
// @ts-check

/* global document, CustomEvent, location */

import { debounce } from '../lib/debounce.js';
import { gameDayKey } from '../domain/gameDayKey.js';
import { writeDailyState, readDailyState } from '../state/dailyActions.js';
import { DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';

/** Selectors local to this feature — only the Rewarding page uses them. */
const REWARDINGS_SEL = '#rewardings';
const ITEM_SEL = '.rewardlist-item';
const CLAIMED_SEL = '.reward-claimed-text';

/**
 * Return true iff the page is the Rewarding component. Locale-independent.
 *
 * @returns {boolean}
 */
const isRewardingPage = () => {
  try {
    return new URLSearchParams(location.search).get('component') === 'rewarding';
  } catch {
    return false;
  }
};

/**
 * Check whether all reward items are claimed. Returns true only when the
 * list is non-empty and every item carries a `.reward-claimed-text` badge.
 *
 * @param {Element} container  The `#rewardings` root element.
 * @returns {boolean}
 */
export const allRewardsClaimed = (container) => {
  const items = [...container.querySelectorAll(ITEM_SEL)];
  return items.length > 0 && items.every((item) => item.querySelector(CLAIMED_SEL) !== null);
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Inspect the page, write the done-day if all tasks are completed, and
 * dispatch the sync event.
 *
 * @returns {void}
 */
const checkCompletion = () => {
  const container = document.querySelector(REWARDINGS_SEL);
  if (!container) return;
  if (!allRewardsClaimed(container)) return;

  const today = gameDayKey(new Date());
  if (readDailyState().rewardingDoneDay === today) return; // already stamped

  writeDailyState({ rewardingDoneDay: today });
  document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/**
 * Install the rewarding-watcher feature.
 *
 * No-op (returns a trivial dispose) on pages other than `component=rewarding`.
 * Idempotent: a second call while already installed returns the existing
 * dispose fn.
 *
 * @returns {() => void} Dispose handle.
 */
export const installRewardingWatcher = () => {
  if (installed) return installed.dispose;
  if (!isRewardingPage()) {
    const noop = () => {};
    return noop;
  }

  checkCompletion();

  const scheduleCheck = debounce(() => {
    if (installed) checkCompletion();
  }, 200);

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body, { childList: true, subtree: true });

  const safetyPoll = setInterval(() => {
    if (installed) checkCompletion();
  }, 3000);

  installed = {
    dispose: () => {
      observer.disconnect();
      clearInterval(safetyPoll);
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
export const _resetRewardingWatcherForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
