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
// the task list. The player is "done" — nothing left worth a pulse — in EITHER
// of two ways:
//   (a) every `.rewardlist-item` carries a `.reward-claimed-text` badge (all
//       of today's tasks are collected), OR
//   (b) every rank tier (`.tierlist [data-tier]`) carries `undermark` — the
//       player has already reached the TOP rank of the event, so the remaining
//       daily tasks yield nothing more and the pulse is pure noise even though
//       individual items still show progress (0/20, 35/1337, …).
// On either, we write the current game-day key (YYYY-MM-DD, 14:00 reset) to
// localStorage and dispatch `oge:dailyStateChanged` so the sync scheduler
// uploads the result to the gist. (Both stamp the same per-day key, so the
// all-ranks case still needs a page visit each day to re-suppress — same model
// as the all-claimed case; kept intentionally small.)
//
// # Page detection
//
// `URLSearchParams(location.search).get('component') === 'rewarding'`
// is locale-independent and survives OGame renames of the button label.
//
// # Completion rule
//
// Done when EITHER: all `.rewardlist-item` nodes inside `#rewardings` have a
// child `.reward-claimed-text` (all tasks claimed), OR all `.tierlist [data-tier]`
// nodes carry `undermark` (all ranks reached). Each list must be non-empty
// (guards against a transient empty DOM while the AJAX render is in flight).
//
// # Lifecycle
//
//   1. `installRewardingWatcher()` is a no-op on every page except the
//      Rewarding page.
//   2. On the Rewarding page a MutationObserver on `document.body` runs
//      `checkCompletion()` on every DOM change (debounced 200 ms).
//   3. A 5-second safety-poll covers the case where OGame re-renders the
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
import { createVisibilityObserver } from '../lib/visibilityObserver.js';
import { gameDayKey } from '../domain/gameDayKey.js';
import { writeDailyState, readDailyState } from '../state/dailyActions.js';
import { DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';
import { clock } from '../lib/clock.js';

/** Selectors local to this feature — only the Rewarding page uses them. */
const REWARDINGS_SEL = '#rewardings';
const ITEM_SEL = '.rewardlist-item';
const CLAIMED_SEL = '.reward-claimed-text';
/** Each rank tier button; `[data-tier]` excludes the sibling "Zadania" btn. */
const TIER_SEL = '.tierlist [data-tier]';
/** Class the game stamps on a rank the player has already reached. */
const TIER_REACHED_CLASS = 'undermark';

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

/**
 * Return true iff every rank tier has been reached — i.e. the `.tierlist`
 * is non-empty and every `[data-tier]` button carries the `undermark` class.
 * When true the player has maxed the event's ranks, so nothing more can be
 * earned and the menu pulse is noise regardless of individual task progress.
 *
 * @param {Element} container  The `#rewardings` root element.
 * @returns {boolean}
 */
export const allTiersReached = (container) => {
  const tiers = [...container.querySelectorAll(TIER_SEL)];
  return tiers.length > 0 && tiers.every((t) => t.classList.contains(TIER_REACHED_CLASS));
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
  if (!allRewardsClaimed(container) && !allTiersReached(container)) return;

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

  const observer = createVisibilityObserver(scheduleCheck);
  observer.observe(document.body, { childList: true, subtree: true });

  // Backstop for a missed observer tick, on the shared visibility-aware
  // clock — pauses while the tab is hidden, snaps once on return.
  const unsubPoll = clock.subscribe(() => {
    if (installed) checkCompletion();
  }, { everyMs: 5000 });

  installed = {
    dispose: () => {
      observer.disconnect();
      unsubPoll();
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
