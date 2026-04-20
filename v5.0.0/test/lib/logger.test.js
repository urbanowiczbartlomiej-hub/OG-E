// @vitest-environment happy-dom
//
// Unit tests for the opt-in diagnostic logger.
//
// The module under test is a singleton: its enabled flag and ring
// buffer live at module-eval time, so every case must reset BOTH the
// public state (`logger.disable()`, `logger.clear()`) and the backing
// `localStorage` + console spies. The `beforeEach` below covers all
// four. `vi.restoreAllMocks()` ensures `console.log/warn/error` start
// each case un-spied; individual cases re-spy as needed and assert
// against that spy only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, loggerEnabled } from '../../src/lib/logger.js';

const ENABLED_KEY = 'oge5_debugLoggerEnabled';

beforeEach(() => {
  localStorage.clear();
  logger.disable();
  logger.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loggerEnabled store', () => {
  it('reports false after disable() (baseline for every other case)', () => {
    expect(loggerEnabled.get()).toBe(false);
  });

  it('logger.enable() flips the store to true', () => {
    logger.enable();
    expect(loggerEnabled.get()).toBe(true);
  });

  it('logger.enable() auto-persists "true" to localStorage', () => {
    logger.enable();
    expect(localStorage.getItem(ENABLED_KEY)).toBe('true');
  });

  it('logger.disable() auto-persists "false" to localStorage', () => {
    logger.enable();
    logger.disable();
    expect(localStorage.getItem(ENABLED_KEY)).toBe('false');
  });

  it('loggerEnabled.subscribe receives the new value when logger.enable() fires', () => {
    const listener = vi.fn();
    const unsubscribe = loggerEnabled.subscribe(listener);
    try {
      logger.enable();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
    } finally {
      unsubscribe();
    }
  });
});

describe('logger methods when disabled', () => {
  it('logger.log is a full no-op: buffer stays empty and console.log is not called', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.log('x');
    expect(logger.getEntries().length).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('logger methods when enabled', () => {
  beforeEach(() => {
    logger.enable();
  });

  it('logger.log records a log-level entry AND forwards to console.log with the prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.log('hello', 42);

    const snap = logger.getEntries();
    expect(snap.length).toBe(1);
    expect(snap[0].level).toBe('log');
    expect(snap[0].args).toEqual(['hello', 42]);
    expect(typeof snap[0].timestamp).toBe('number');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[OG-E v5]', 'hello', 42);
  });

  it('logger.warn records a warn-level entry AND forwards to console.warn with the prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger.warn('watch out', { code: 7 });

    const snap = logger.getEntries();
    expect(snap.length).toBe(1);
    expect(snap[0].level).toBe('warn');
    expect(snap[0].args).toEqual(['watch out', { code: 7 }]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[OG-E v5]', 'watch out', { code: 7 });
  });

  it('logger.error records an error-level entry AND forwards to console.error with the prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('boom');
    logger.error('oops', err);

    const snap = logger.getEntries();
    expect(snap.length).toBe(1);
    expect(snap[0].level).toBe('error');
    expect(snap[0].args).toEqual(['oops', err]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[OG-E v5]', 'oops', err);
  });

  it('preserves insertion order across mixed log/warn/log calls', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger.log('a');
    logger.warn('b');
    logger.log('c');

    const snap = logger.getEntries();
    expect(snap.map((e) => e.args[0])).toEqual(['a', 'b', 'c']);
    expect(snap.map((e) => e.level)).toEqual(['log', 'warn', 'log']);
  });
});

describe('ring buffer MAX_ENTRIES (500)', () => {
  it('keeps exactly the last 500 entries after overfilling; oldest are dropped', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.enable();

    // Push 501 entries labelled 'n0' through 'n500'. The buffer cap is
    // 500, so 'n0' must be evicted and 'n1'..'n500' must remain, in
    // order.
    for (let i = 0; i <= 500; i += 1) {
      logger.log(`n${i}`);
    }

    const snap = logger.getEntries();
    expect(snap.length).toBe(500);
    expect(snap[0].args[0]).toBe('n1');
    expect(snap[499].args[0]).toBe('n500');
  });
});

describe('logger.clear', () => {
  it('empties the buffer but leaves the enabled flag untouched', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.enable();

    logger.log('a');
    logger.log('b');
    logger.log('c');
    expect(logger.getEntries().length).toBe(3);

    logger.clear();

    expect(logger.getEntries().length).toBe(0);
    // Flag is orthogonal to buffer state — stays true.
    expect(loggerEnabled.get()).toBe(true);
    expect(localStorage.getItem(ENABLED_KEY)).toBe('true');
  });
});

describe('logger.getEntries snapshot', () => {
  it('returns a shallow copy: mutating the result does not affect internal state', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.enable();

    logger.log('x');
    const snap = logger.getEntries();
    expect(snap.length).toBe(1);

    // Mutate the caller-owned snapshot.
    snap.push(/** @type {any} */ ({ fake: true }));
    expect(snap.length).toBe(2);

    // Internal state is unchanged — a fresh snapshot still has one entry.
    const snap2 = logger.getEntries();
    expect(snap2.length).toBe(1);
  });
});

describe('timestamp freshness', () => {
  it('records a timestamp within ~1s of the call site', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.enable();

    const before = Date.now();
    logger.log('x');
    const after = Date.now();

    const snap = logger.getEntries();
    expect(snap.length).toBe(1);
    const ts = snap[0].timestamp;
    // Must be in the [before, after] window and fresh relative to "now".
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(Date.now() - ts).toBeLessThan(1000);
  });
});
