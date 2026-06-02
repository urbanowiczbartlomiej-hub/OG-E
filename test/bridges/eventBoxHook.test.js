// @vitest-environment happy-dom
//
// Tests for the eventbox XHR bridge. Same approach as checkTargetHook.test.js:
// drive a fake XHR through happy-dom's shim and assert on the
// `oge:eventBoxLoaded` CustomEvent the hook dispatches. The hook's whole
// contract is a gate — fire ONLY on HTTP 200 for an eventbox/eventList URL —
// so the tests pin the status gate, the URL matcher, the bare (detail-less)
// event shape, and idempotency/teardown.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installEventBoxHook,
  _resetEventBoxHookForTest,
} from '../../src/bridges/eventBoxHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

const EVENTLIST_URL =
  '/game/index.php?page=componentOnly&component=eventList&ajax=1';

/**
 * Drive one GET through happy-dom's XHR shim and force the load phase with
 * a chosen HTTP status. `open` + `send` trip the xhrObserver patch; we then
 * pin `status`/`readyState` and dispatch a synthetic `load` so the hook
 * evaluates a response we fully control.
 *
 * @param {{ url?: string, status?: number }} [opts]
 */
const fireXHR = async ({ url = EVENTLIST_URL, status = 200 } = {}) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.send();
  Object.defineProperty(xhr, 'status', { value: status, configurable: true });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  await Promise.resolve();
  return xhr;
};

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
  _resetEventBoxHookForTest();
  document.addEventListener('oge:eventBoxLoaded', listener);
});

afterEach(() => {
  document.removeEventListener('oge:eventBoxLoaded', listener);
  _resetEventBoxHookForTest();
  _resetObserversForTest();
});

describe('installEventBoxHook — status gate', () => {
  it('dispatches oge:eventBoxLoaded on a 200 eventList response', async () => {
    installEventBoxHook();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });

  it('does NOT dispatch on a non-200 status (4xx/5xx mean stale eventbox)', async () => {
    installEventBoxHook();
    await fireXHR({ status: 500 });
    await fireXHR({ status: 404 });
    expect(fired).toBe(0);
  });

  it('the event is a bare notification — no detail payload', async () => {
    installEventBoxHook();
    await fireXHR({ status: 200 });
    expect(captured).not.toBeNull();
    // CustomEvent with no init → detail is null. Consumers only care about
    // timing, never data.
    expect(/** @type {any} */ (captured).detail).toBeNull();
  });
});

describe('installEventBoxHook — URL matcher', () => {
  it('matches the `eventbox` URL form too (case-insensitive)', async () => {
    installEventBoxHook();
    await fireXHR({ url: '/game/index.php?page=fetchEventbox', status: 200 });
    expect(fired).toBe(1);
  });

  it('does NOT fire on an unrelated XHR (no eventbox/eventList in URL)', async () => {
    installEventBoxHook();
    await fireXHR({
      url: '/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent',
      status: 200,
    });
    expect(fired).toBe(0);
  });
});

describe('installEventBoxHook — idempotency & teardown', () => {
  it('returns the same unsubscribe on repeated install and fires once', async () => {
    const a = installEventBoxHook();
    const b = installEventBoxHook();
    expect(a).toBe(b);
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });

  it('unsubscribe stops further dispatches', async () => {
    const unsub = installEventBoxHook();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
    unsub();
    await fireXHR({ status: 200 });
    expect(fired).toBe(1);
  });
});
