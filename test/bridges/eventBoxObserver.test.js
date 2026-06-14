// @vitest-environment happy-dom
//
// Tests for the eventbox XHR bridge. Same approach as checkTargetObserver.test.js:
// drive a fake XHR through happy-dom's shim and assert on the
// `oge:eventBoxLoaded` CustomEvent the hook dispatches. The hook's whole
// contract is a gate — fire ONLY on HTTP 200 for an eventbox/eventList URL —
// so the tests pin the status gate, the URL matcher, the bare (detail-less)
// event shape, and idempotency/teardown.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installEventBoxObserver,
  _resetEventBoxObserverForTest,
} from '../../src/bridges/eventBoxObserver.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { fakeXHR as fakeXhrRoundTrip } from '../helpers/fakeXhr.js';

const EVENTLIST_URL =
  '/game/index.php?page=componentOnly&component=eventList&ajax=1';

/**
 * Drive one eventList GET round-trip with a chosen HTTP status. Thin wrapper
 * over the shared round-trip helper, keeping this file's `{ url, status }`
 * options shape (the hook only cares about the status, not a body).
 *
 * @param {{ url?: string, status?: number }} [opts]
 */
const fireXHR = async ({ url = EVENTLIST_URL, status = 200 } = {}) =>
  fakeXhrRoundTrip(url, { method: 'GET', status });

let fired = 0;
/** @type {CustomEvent | null} */
let captured = null;
const listener = (/** @type {Event} */ e) => {
  fired += 1;
  captured = /** @type {CustomEvent} */ (e);
};

beforeEach(() => {
  fired = 0;
  captured = null;
  _resetObserversForTest();
  _resetEventBoxObserverForTest();
  document.addEventListener('oge:eventBoxLoaded', listener);
});

afterEach(() => {
  document.removeEventListener('oge:eventBoxLoaded', listener);
  _resetEventBoxObserverForTest();
  _resetObserversForTest();
});

describe('installEventBoxObserver — status gate', () => {
  it('dispatches oge:eventBoxLoaded on a 200 eventList response', async () => {
    installEventBoxObserver();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });

  it('does NOT dispatch on a non-200 status (4xx/5xx mean stale eventbox)', async () => {
    installEventBoxObserver();
    await fireXHR({ status: 500 });
    await fireXHR({ status: 404 });
    expect(fired).toBe(0);
  });

  it('the event is a bare notification — no detail payload', async () => {
    installEventBoxObserver();
    await fireXHR({ status: 200 });
    expect(captured).not.toBeNull();
    // CustomEvent with no init → detail is null. Consumers only care about
    // timing, never data.
    expect(/** @type {any} */ (captured).detail).toBeNull();
  });
});

describe('installEventBoxObserver — URL matcher', () => {
  it('matches the `eventbox` URL form too (case-insensitive)', async () => {
    installEventBoxObserver();
    await fireXHR({ url: '/game/index.php?page=fetchEventbox', status: 200 });
    expect(fired).toBe(1);
  });

  it('does NOT fire on an unrelated XHR (no eventbox/eventList in URL)', async () => {
    installEventBoxObserver();
    await fireXHR({
      url: '/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent',
      status: 200,
    });
    expect(fired).toBe(0);
  });
});

describe('installEventBoxObserver — idempotency & teardown', () => {
  it('returns the same unsubscribe on repeated install and fires once', async () => {
    const a = installEventBoxObserver();
    const b = installEventBoxObserver();
    expect(a).toBe(b);
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });

  it('unsubscribe stops further dispatches', async () => {
    const unsub = installEventBoxObserver();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
    unsub();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });
});
