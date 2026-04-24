// Unit tests for the debounce / throttle rate limiters.
//
// Pure timer semantics only — no DOM, no happy-dom. Vitest fake timers
// advance both `setTimeout` AND `Date.now()` in lockstep, which matters
// because `throttle` measures its cool-down window off `Date.now()`
// rather than a timer handle. Using real timers here would make the
// tests nondeterministic; using happy-dom would add pointless overhead.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, throttle } from '../../src/lib/debounce.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('does not fire before ms has elapsed after a single call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires exactly once when ms elapses after a single call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of calls (each spaced < ms apart) into one firing', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    // At this point the latest call happened "now"; fn must not have
    // fired yet because the timer was reset with each call.
    expect(fn).not.toHaveBeenCalled();

    // Only after a full ms of silence does the trailing call fire.
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires with args from the LAST call in a burst (earlier args discarded)', () => {
    const fn = vi.fn();
    /** @type {(n: number) => void} */
    const debounced = debounce(fn, 100);

    debounced(1);
    debounced(2);
    debounced(3);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('fires twice when two calls are spaced strictly greater than ms apart', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(150); // first firing at t=100, then idle until t=150
    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('preserves the argument tuple type (TArgs) in the returned wrapper', () => {
    // Type-level contract: `debounce` must return a function whose
    // parameter list matches `fn`'s. tsc --strict catches a mismatch
    // at compile time; the runtime assertions below simply prove the
    // wrapper forwards the tuple untouched.
    /** @type {(a: number, b: string) => void} */
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced(7, 'hello');
    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(7, 'hello');
  });
});

describe('throttle', () => {
  it('fires the first call synchronously (leading edge, no timer advance)', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled();
    // No `advanceTimersByTime` — the leading call must have fired already.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores subsequent calls inside the cool-down window', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled(); // t=0, fires
    vi.advanceTimersByTime(30);
    throttled(); // dropped
    vi.advanceTimersByTime(30);
    throttled(); // dropped
    vi.advanceTimersByTime(30);
    throttled(); // dropped (t=90, still inside 100ms window)

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires again on the first call after ms has elapsed since the last firing', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled(); // t=0, fires (count=1)
    vi.advanceTimersByTime(100);
    throttled(); // t=100, boundary reached, fires (count=2)

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes args from the firing call — never from ignored calls', () => {
    const fn = vi.fn();
    /** @type {(n: number) => void} */
    const throttled = throttle(fn, 100);

    throttled(1); // fires with 1
    throttled(2); // ignored
    vi.advanceTimersByTime(100);
    throttled(3); // fires with 3

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 1);
    expect(fn).toHaveBeenNthCalledWith(2, 3);
  });

  it('on a continuous stream of calls, fires once per ms window', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Call every 10ms for 500ms — i.e. 50 calls spread across 5 windows.
    // Leading edge fires at t=0, then at t=100/200/300/400/500.
    for (let t = 0; t <= 500; t += 10) {
      throttled();
      if (t < 500) vi.advanceTimersByTime(10);
    }

    // 6 firings: t=0, 100, 200, 300, 400, 500.
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('preserves the argument tuple type (TArgs) in the returned wrapper', () => {
    // Mirror of the debounce type-preservation test — the tsc contract
    // is the real assertion, the runtime check just pins the behavior.
    /** @type {(a: number, b: string) => void} */
    const fn = vi.fn();
    const throttled = throttle(fn, 50);

    throttled(9, 'world');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(9, 'world');
  });
});
