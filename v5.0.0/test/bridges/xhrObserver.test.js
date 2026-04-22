// @vitest-environment happy-dom
//
// Tests for the generic XHR observer. We rely on happy-dom's
// XMLHttpRequest shim to exercise the prototype patch; no real network
// calls happen because happy-dom's XHR resolves synthetically when
// `respond()` is called on the instance.
//
// The module installs a one-time prototype patch the FIRST time
// `observeXHR` is called. That patch survives for the lifetime of the
// test process, so we use `_resetObserversForTest` between cases to
// avoid leaks; we never un-patch the prototype (neither does production).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { observeXHR, _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

/**
 * Helper: exercise the patched open/send pair and resolve via happy-dom's
 * `respond` / `responseText` plumbing. happy-dom's XHR doesn't actually
 * reach the network — setting `responseText` and dispatching `load` is
 * enough to drive the observers we're testing.
 *
 * Returns the xhr after `load` has fired so tests can assert on side
 * effects registered via `'load'`-phase observers.
 *
 * @param {string} url
 * @param {{ method?: string, body?: string | null, responseText?: string }} [options]
 */
const fakeXHR = async (url, { method = 'GET', body = null, responseText = '' } = {}) => {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);
  xhr.send(body);
  // happy-dom lets us set the readyState + response and fire load manually.
  // We simulate a normal response arrival here.
  Object.defineProperty(xhr, 'responseText', { value: responseText, configurable: true });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  // Yield a microtask so any `{ once: true }` listeners registered by the
  // observer have a chance to fire before the caller asserts.
  await Promise.resolve();
  return xhr;
};

beforeEach(() => {
  _resetObserversForTest();
});

afterEach(() => {
  _resetObserversForTest();
});

describe('observeXHR — registration', () => {
  it('returns an unsubscribe function', () => {
    const unsubscribe = observeXHR({
      urlPattern: /nothing-matches/,
      on: 'send',
      handler: () => {},
    });
    expect(typeof unsubscribe).toBe('function');
  });

  it('unsubscribe is idempotent (safe to call repeatedly)', () => {
    const unsubscribe = observeXHR({
      urlPattern: /nothing-matches/,
      on: 'send',
      handler: () => {},
    });
    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});

describe('observeXHR — send phase', () => {
  it('fires handler synchronously before native send (URL matches)', async () => {
    const handler = vi.fn();
    observeXHR({
      urlPattern: /\/api\/foo/,
      on: 'send',
      handler,
    });

    await fakeXHR('/api/foo?x=1', { method: 'POST', body: 'payload' });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.url).toBe('/api/foo?x=1');
    expect(event.method).toBe('POST');
    expect(event.body).toBe('payload');
    expect(event.xhr).toBeInstanceOf(XMLHttpRequest);
    // The send-phase event never carries a `response` — response hasn't
    // arrived yet when the send handler fires.
    expect(event.response).toBeUndefined();
  });

  it('does NOT fire handler when URL does not match', async () => {
    const handler = vi.fn();
    observeXHR({
      urlPattern: /\/never\/matches/,
      on: 'send',
      handler,
    });

    await fakeXHR('/api/foo');
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler throws are caught and do not interrupt send', async () => {
    const handler = vi.fn(() => {
      throw new Error('observer bug');
    });
    observeXHR({
      urlPattern: /\/api\/foo/,
      on: 'send',
      handler,
    });

    // fakeXHR must complete without propagating the throw; if the
    // observer's error reaches here the `await` below would reject.
    await expect(fakeXHR('/api/foo')).resolves.toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('observeXHR — load phase', () => {
  it('fires handler after the response arrives, with responseText', async () => {
    const handler = vi.fn();
    observeXHR({
      urlPattern: /\/api\/bar/,
      on: 'load',
      handler,
    });

    await fakeXHR('/api/bar', { responseText: '{"ok":true}' });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.url).toBe('/api/bar');
    expect(event.response).toBe('{"ok":true}');
    expect(event.xhr).toBeInstanceOf(XMLHttpRequest);
  });

  it('load handler fires once even on multiple load events (once: true)', async () => {
    const handler = vi.fn();
    observeXHR({
      urlPattern: /\/api\/once/,
      on: 'load',
      handler,
    });

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/once');
    xhr.send();
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true });
    xhr.dispatchEvent(new Event('load'));
    Object.defineProperty(xhr, 'responseText', { value: 'second', configurable: true });
    xhr.dispatchEvent(new Event('load'));
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].response).toBe('first');
  });

  it('load handler throws are caught (observer bug does not propagate)', async () => {
    const handler = vi.fn(() => {
      throw new Error('load observer bug');
    });
    observeXHR({
      urlPattern: /\/api\/throws/,
      on: 'load',
      handler,
    });

    await expect(fakeXHR('/api/throws', { responseText: 'x' })).resolves.toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('observeXHR — multiple observers', () => {
  it('independent patterns fire independently', async () => {
    const hitFoo = vi.fn();
    const hitBar = vi.fn();

    observeXHR({ urlPattern: /\/api\/foo/, on: 'send', handler: hitFoo });
    observeXHR({ urlPattern: /\/api\/bar/, on: 'send', handler: hitBar });

    await fakeXHR('/api/foo');
    await fakeXHR('/api/bar');

    expect(hitFoo).toHaveBeenCalledTimes(1);
    expect(hitBar).toHaveBeenCalledTimes(1);
    expect(hitFoo.mock.calls[0][0].url).toBe('/api/foo');
    expect(hitBar.mock.calls[0][0].url).toBe('/api/bar');
  });

  it('overlapping patterns both fire for the same URL', async () => {
    const sendObs = vi.fn();
    const loadObs = vi.fn();

    observeXHR({ urlPattern: /\/api\/x/, on: 'send', handler: sendObs });
    observeXHR({ urlPattern: /\/api/, on: 'load', handler: loadObs });

    await fakeXHR('/api/x', { responseText: 'payload' });

    expect(sendObs).toHaveBeenCalledTimes(1);
    expect(loadObs).toHaveBeenCalledTimes(1);
  });

  it('unsubscribed observer stops receiving events', async () => {
    const handler = vi.fn();
    const unsubscribe = observeXHR({
      urlPattern: /\/api\/x/,
      on: 'send',
      handler,
    });

    await fakeXHR('/api/x');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    await fakeXHR('/api/x');
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });
});
