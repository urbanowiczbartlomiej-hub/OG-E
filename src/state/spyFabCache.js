// Spyglass-FAB optimistic mount cache — what the button looked like when it was
// last reconciled, persisted so it can appear INSTANTLY on the next page load
// instead of after the async chrome.storage hydrates and the apiContext handoff
// land. Without it the button blinks on every navigation: absent for the first
// seconds, then popping in. The real reconcile then confirms (or corrects) the
// optimistic paint as soon as the live values arrive.
//
// Two verdicts, two keys: whether a button was shown at all
// ({@link SPY_FAB_SHOWN_KEY}) and how many unread home-watch arrivals it was
// nudging about ({@link SPY_FAB_HOME_KEY}).
//
// This is the sendSpy feature's OWN mount verdict, not shared state — but it
// still lives here (not written from the feature via raw `safeLS`) so all
// persistence stays in `state/`, matching `state/badgeCache.js`. Plain
// key-owner, per-origin localStorage = per-universe.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the flag ('1' = the button was mounted). */
export const SPY_FAB_SHOWN_KEY = 'oge-spy-fab-shown';

/**
 * Was the Spyglass button mounted the last time the watch-list was
 * reconciled? `false` when absent/unreadable — the safe default (no
 * optimistic mount; the hydrate-driven mount still happens as before).
 *
 * @returns {boolean}
 */
export const readSpyFabShown = () => safeLS.get(SPY_FAB_SHOWN_KEY) === '1';

/**
 * Record the reconciled mount verdict for the next page load's optimistic
 * mount. Absent (removed) rather than '0' when hidden, so the key only
 * exists on universes that actually use the watch-list.
 *
 * @param {boolean} shown
 * @returns {void}
 */
export const writeSpyFabShown = (shown) => {
  if (shown) safeLS.set(SPY_FAB_SHOWN_KEY, '1');
  else safeLS.remove(SPY_FAB_SHOWN_KEY);
};

/**
 * localStorage key holding the last reconciled count of UNREAD home-watch
 * arrivals — the "somebody new moved in next to you" nudge.
 */
export const SPY_FAB_HOME_KEY = 'oge-spy-fab-home';

/**
 * How many unread home-watch arrivals did the last real derive see? `0` when
 * absent/unreadable.
 *
 * Why this is cached at all: the arrivals themselves live in `chrome.storage`
 * (`state/homeWatch.js`), and the Spyglass button additionally holds a dim
 * "loading…" paint until the apiContext handoff lands — together worth 1-3 s on
 * every page load, during which the nudge is invisible and then pops in. The
 * nudge needs NONE of that machinery: it is a count and a "tap → dashboard"
 * navigation. Mirroring the count into synchronous localStorage lets the button
 * paint it on the very first frame and reconcile a beat later.
 *
 * @returns {number}
 */
export const readSpyHomeUnread = () => {
  const n = safeLS.int(SPY_FAB_HOME_KEY, 0);
  return n > 0 ? n : 0;
};

/**
 * Record the reconciled unread-arrival count for the next load's optimistic
 * paint. Removed rather than stored as `0`, so the key exists only while there
 * is actually something unread.
 *
 * @param {number} n
 * @returns {void}
 */
export const writeSpyHomeUnread = (n) => {
  if (n > 0) safeLS.set(SPY_FAB_HOME_KEY, String(n));
  else safeLS.remove(SPY_FAB_HOME_KEY);
};
