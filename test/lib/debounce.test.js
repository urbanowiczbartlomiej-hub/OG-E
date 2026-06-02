// Unit tests for the debounce rate limiter.
//
// Pure timer semantics only — no DOM, no happy-dom. Vitest fake timers
// drive `setTimeout` deterministically; using real timers here would make
// the tests nondeterministic, and happy-dom would add pointless overhead.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '../../src/lib/debounce.js';

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
