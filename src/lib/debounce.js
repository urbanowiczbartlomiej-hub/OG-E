// Rate-limiting helpers — two flavors for two different shapes of work.
//
// `debounce` collapses a burst of calls into a single trailing invocation.
// Every call resets the pending timer; the wrapped fn runs once, `ms`
// after the quiet period begins, with the arguments from the LAST call.
// The arguments from earlier calls in the burst are discarded. This is
// the right tool for "fire when the user stops typing / finished
// fiddling / the store has settled" — e.g. auto-saving store changes
// to chromeStore without hammering the storage layer on every keystroke.
//
// `throttle` guarantees a minimum gap between invocations and fires on
// the LEADING edge. The first call runs immediately, further calls
// within `ms` are dropped, and after the cool-down the next call fires
// again. The arguments used are those of the call that actually runs
// (never the dropped ones). This is the right tool for high-frequency
// event streams that still need a first-responder — e.g. scroll /
// mousemove / resize handlers where doing work on every tick tanks the
// frame rate but the user expects an immediate visual response.
//
// Both helpers are intentionally minimal: no `.cancel()`, no `.flush()`,
// no trailing-on-throttle option. OG-E doesn't need them; keeping the
// surface small keeps the type parameter `TArgs` honest and the
// behavior obvious from the signature alone.

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

/**
 * Throttle `fn`: fire on the leading edge, then ignore calls for `ms`.
 *
 * The first call to the wrapper runs `fn` synchronously. Any calls made
 * in the following `ms` milliseconds are dropped (args included — we do
 * not queue a trailing invocation). Once `ms` has elapsed since the
 * last firing, the next call fires `fn` again with THAT call's args.
 *
 * Example (ms = 100):
 *   throttled(1) at t=0   → fires with (1)
 *   throttled(2) at t=50  → dropped
 *   throttled(3) at t=90  → dropped
 *   throttled(4) at t=150 → fires with (4)
 *
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => void} fn Function to invoke at most once
 *   per `ms`-millisecond window. Return value is ignored.
 * @param {number} ms Cool-down window length in milliseconds, measured
 *   from the last firing (not from the last call).
 * @returns {(...args: TArgs) => void} Throttled wrapper. `TArgs` is
 *   preserved so callers retain the original parameter types.
 */
export const throttle = (fn, ms) => {
  /** @type {number} */
  let lastFiredAt = Number.NEGATIVE_INFINITY;

  return (...args) => {
    const now = Date.now();
    // Strict `>=` keeps behavior predictable at the exact boundary: a
    // call that lands at `lastFiredAt + ms` is allowed to fire again,
    // matching the "ms elapsed since last fire" wording of the contract.
    if (now - lastFiredAt >= ms) {
      lastFiredAt = now;
      fn(...args);
    }
  };
};
