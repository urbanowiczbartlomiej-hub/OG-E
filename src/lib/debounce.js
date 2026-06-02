// Rate-limiting helper.
//
// `debounce` collapses a burst of calls into a single trailing invocation.
// Every call resets the pending timer; the wrapped fn runs once, `ms`
// after the quiet period begins, with the arguments from the LAST call.
// The arguments from earlier calls in the burst are discarded. This is
// the right tool for "fire when the user stops typing / finished
// fiddling / the store has settled" — e.g. auto-saving store changes
// to chromeStore without hammering the storage layer on every keystroke.
//
// Intentionally minimal: no `.cancel()`, no `.flush()`. OG-E doesn't need
// them; keeping the surface small keeps the type parameter `TArgs` honest
// and the behavior obvious from the signature alone.

/**
 * Debounce `fn`: collapse a burst of calls into one trailing invocation.
 *
 * Each call to the returned wrapper RESETS the pending timer and records
 * the latest arguments. `fn` runs once, exactly `ms` milliseconds after
 * the most recent wrapper call, with those latest arguments. Calls made
 * while a timer is pending overwrite the queued args — earlier args are
 * dropped.
 *
 * Example (ms = 100):
 *   debounced(1) at t=0
 *   debounced(2) at t=50
 *   debounced(3) at t=90
 *   → fn fires once at t=190 with args (3)
 *
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => void} fn Function to invoke after the
 *   quiet period. Return value is ignored (the wrapper is void).
 * @param {number} ms Quiet-period length in milliseconds. The wrapper
 *   treats the value as an opaque delay and forwards it to `setTimeout`.
 * @returns {(...args: TArgs) => void} Debounced wrapper. Callers see the
 *   same argument types as `fn` (`TArgs` is preserved end-to-end).
 */
export const debounce = (fn, ms) => {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timerId = null;

  return (...args) => {
    // Reset the timer on every call — earlier queued args are discarded
    // when we overwrite the timerId below. Only the most recent call's
    // args are captured in this closure.
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      fn(...args);
    }, ms);
  };
};
