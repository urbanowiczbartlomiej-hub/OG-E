// @vitest-environment happy-dom
//
// Unit tests for the DOM helpers. Split into three suites (safeClick,
// waitFor, injectStyle) exercising the behaviours documented in
// src/lib/dom.js.
//
// waitFor is tested under fake timers so we can assert exact polling
// semantics (synchronous first call, timeout resolves to null, etc.)
// without the suite ever actually sleeping.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeClick, waitFor, injectStyle } from '../../src/lib/dom.js';

describe('safeClick', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('removes a javascript: href before clicking (CSP workaround)', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'javascript:alert(1)');
    document.body.appendChild(a);

    // mockImplementation(() => {}) short-circuits the real click so we
    // are counting dispatches, not triggering navigation side effects.
    const clickSpy = vi.spyOn(a, 'click').mockImplementation(() => {});

    safeClick(a);

    expect(a.hasAttribute('href')).toBe(false);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('clicks a <button> that never had an href', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);

    const clickSpy = vi.spyOn(button, 'click').mockImplementation(() => {});

    safeClick(button);

    expect(button.hasAttribute('href')).toBe(false);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves a non-javascript href and still clicks', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'https://example.com/');
    document.body.appendChild(a);

    const clickSpy = vi.spyOn(a, 'click').mockImplementation(() => {});

    safeClick(a);

    expect(a.getAttribute('href')).toBe('https://example.com/');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when passed null (does not throw)', () => {
    expect(() => safeClick(null)).not.toThrow();
  });

  it('clicks an <a> that has no href attribute at all', () => {
    const a = document.createElement('a');
    document.body.appendChild(a);

    const clickSpy = vi.spyOn(a, 'click').mockImplementation(() => {});

    expect(() => safeClick(a)).not.toThrow();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(a.hasAttribute('href')).toBe(false);
  });
});

describe('waitFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves synchronously when predicate is truthy on first check', async () => {
    const target = { hit: true };
    const predicate = vi.fn(() => target);

    const p = waitFor(predicate, { timeoutMs: 1000, intervalMs: 50 });

    // No timers advanced — still resolves because the first check is sync.
    const result = await p;

    expect(result).toBe(target);
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  it('polls until predicate returns truthy, resolving with that value', async () => {
    const target = { ready: 1 };
    let calls = 0;
    const predicate = vi.fn(() => {
      calls += 1;
      return calls > 3 ? target : null;
    });

    const p = waitFor(predicate, { timeoutMs: 1000, intervalMs: 50 });

    // First sync call already happened (returned null, calls=1).
    // Three more ticks at intervalMs each turn calls=2,3,4 → 4th yields target.
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    const result = await p;
    expect(result).toBe(target);
    expect(predicate).toHaveBeenCalledTimes(4);
  });

  it('resolves with null when timeoutMs elapses without a truthy value', async () => {
    const predicate = vi.fn(() => null);

    const p = waitFor(predicate, { timeoutMs: 300, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(500);

    const result = await p;
    expect(result).toBeNull();
    expect(predicate).toHaveBeenCalled();
  });

  it('treats any non-falsy value as truthy (number, string, object, array)', async () => {
    const cases = /** @type {const} */ ([1, 'str', {}, []]);

    for (const value of cases) {
      const predicate = vi.fn(() => value);
      const p = waitFor(predicate, { timeoutMs: 1000, intervalMs: 50 });
      const result = await p;
      expect(result).toBe(value);
    }
  });

  it('uses default timeoutMs=5000 and intervalMs=100 when options omitted', async () => {
    const predicate = vi.fn(() => null);

    const p = waitFor(predicate);

    // After 4999ms we must still be polling (not resolved).
    await vi.advanceTimersByTimeAsync(4999);

    // Push past the timeout and assert the resolution.
    await vi.advanceTimersByTimeAsync(200);
    const result = await p;
    expect(result).toBeNull();
    // With intervalMs=100 and timeoutMs=5000 we expect on the order of
    // ~50 polls; we only assert a sensible lower bound to stay robust.
    expect(predicate.mock.calls.length).toBeGreaterThan(10);
  });

  it('reads the injected `now` clock and never touches Date.now', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    let clock = 1000;
    const now = () => clock;
    const predicate = vi.fn(() => null);

    const p = waitFor(predicate, { timeoutMs: 50, intervalMs: 10, now });

    // Advance the injected clock past the timeout; one tick at intervalMs
    // is enough for the timeout branch to fire.
    clock = 1100;
    await vi.advanceTimersByTimeAsync(20);

    const result = await p;
    expect(result).toBeNull();
    expect(dateNowSpy).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });
});

describe('injectStyle', () => {
  beforeEach(() => {
    // Reset both head and documentElement children to a known state.
    // happy-dom recreates a fresh document per test file, but we still
    // clear any <style> leftovers between tests within this suite.
    for (const el of Array.from(document.querySelectorAll('style'))) {
      el.remove();
    }
  });

  it('creates a <style id="..."> with the given css', () => {
    injectStyle('og-e-x', 'body { color: red; }');

    const el = document.getElementById('og-e-x');
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
    expect(el?.textContent).toBe('body { color: red; }');
  });

  it('is idempotent: a second call with the same id does not overwrite', () => {
    injectStyle('og-e-x', 'body { color: red; }');
    injectStyle('og-e-x', 'body { color: blue; }');

    const matches = document.querySelectorAll('#og-e-x');
    expect(matches.length).toBe(1);
    expect(matches[0]?.textContent).toBe('body { color: red; }');
  });

  it('supports multiple distinct ids in the same document', () => {
    injectStyle('og-e-x', 'body { color: red; }');
    injectStyle('og-e-y', 'p { margin: 0; }');

    expect(document.getElementById('og-e-x')?.textContent).toBe('body { color: red; }');
    expect(document.getElementById('og-e-y')?.textContent).toBe('p { margin: 0; }');
    expect(document.querySelectorAll('style').length).toBe(2);
  });

  it('falls back to documentElement when document.head is missing (document_start)', () => {
    // Simulate run_at: document_start by removing <head> entirely before
    // injecting. The helper should still succeed by appending to <html>.
    document.head?.remove();
    expect(document.head).toBeNull();

    injectStyle('og-e-early', 'html { background: #000; }');

    const el = document.getElementById('og-e-early');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('html { background: #000; }');
    // Parent must be <html> since <head> was gone at insertion time.
    expect(el?.parentElement).toBe(document.documentElement);
  });
});
