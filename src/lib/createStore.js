// Mini reactive store — observer pattern, zero dependencies.
//
// The whole state layer (per-feature domain stores, shared settings,
// runtime flags) sits on top of this primitive. We deliberately keep it
// tiny: a single mutable cell plus a Set of subscribers. No batching,
// no equality checks, no middleware — if a feature needs any of that
// it composes on top.
//
// `subscribe` does NOT fire the callback on registration; subscribers
// only see future changes. This matches how the rest of the codebase
// thinks about stores (pull current value via `get`, react via the
// subscription) and keeps the primitive unsurprising.

/**
 * @template T
 * @typedef {object} Store
 * @property {() => T} get Read the current state synchronously.
 * @property {(next: T) => void} set Replace state and notify subscribers.
 * @property {(fn: (prev: T) => T) => void} update Derive next state from prev and notify.
 * @property {(fn: (state: T) => void) => () => void} subscribe
 *   Register a listener. The listener is NOT invoked immediately — only on
 *   subsequent `set` / `update` calls, in registration order. Returns an
 *   idempotent unsubscribe function (safe to call any number of times).
 */

/**
 * Create a reactive store holding a single value.
 *
 * @template T
 * @param {T} initial Initial state value.
 * @returns {Store<T>} Store handle — see the {@link Store} typedef for semantics.
 */
export const createStore = (initial) => {
  let state = initial;
  /** @type {Set<(state: T) => void>} */
  const subs = new Set();

  // `for ... of` over the Set (instead of `subs.forEach(...)`) so an
  // error thrown by a subscriber produces a clean, shallow stack trace
  // rooted at this line rather than inside the Set's internal iterator
  // machinery. Set iteration order is insertion order, so subscribers
  // are notified in the order they were added.
  const notify = () => {
    for (const fn of subs) fn(state);
  };

  return {
    get: () => state,
    set: (next) => {
      state = next;
      notify();
    },
    update: (fn) => {
      state = fn(state);
      notify();
    },
    subscribe: (fn) => {
      subs.add(fn);
      // Unsubscribe is idempotent: Set.delete is a no-op when the
      // entry is already gone, so calling the returned function more
      // than once is harmless.
      return () => {
        subs.delete(fn);
      };
    },
  };
};
