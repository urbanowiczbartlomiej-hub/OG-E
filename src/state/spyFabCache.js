// Spyglass-FAB optimistic mount cache — the last reconciled "watch-list has
// players" verdict, persisted so the Spyglass button can mount INSTANTLY on
// the next page load, before the async chrome.storage watch-list hydrate
// lands. Without it the button blinks on every navigation: absent for the
// first few hundred ms, then popping in when the hydrate resolves. The real
// watch-list reconcile then confirms (or removes) the optimistic mount as
// soon as the hydrated value arrives.
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
