// @vitest-environment happy-dom
//
// Tests for the checkTarget XHR bridge. We drive the real module through
// happy-dom's XMLHttpRequest shim — same approach xhrObserver.test.js
// uses, just one layer higher: here we assert on the `oge5:checkTargetResult`
// CustomEvent the hook dispatches after it processes the response.
//
// Each test installs the hook, fires a fake XHR, and (optionally) checks
// the captured event detail. `_resetCheckTargetHookForTest` tears the
// module's single-slot registration down between cases;
// `_resetObserversForTest` clears the underlying xhrObserver registry so
// leftover observers from earlier tests don't match our URLs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installCheckTargetHook,
  _resetCheckTargetHookForTest,
} from '../../src/bridges/checkTargetHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

const CHECK_TARGET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=checkTarget';

/**
 * Drive one checkTarget POST through happy-dom's XHR shim.
 *
 * Mirrors the helper in xhrObserver.test.js: `open` + `send` trigger the
 * xhrObserver patch path, then we force `responseText` / `readyState`
 * and dispatch `load` synthetically so the load-phase observer fires
 * against a response we fully control.
 *
 * @param {unknown} body Body passed verbatim to `xhr.send(body)`. Use a
 *   string to exercise the form-body parser, `null` / object to exercise
 *   the non-string defensive branches.
 * @param {unknown} responseObj Parsed-then-stringified and exposed as
 *   `responseText`. Use `'__INVALID_JSON__'` sentinel to force a JSON
 *   parse failure.
 * @param {string} [url] URL — defaults to the real fleetdispatch URL.
 *   Override to test the URL filter.
 */
const fakeCheckTargetXHR = async (body, responseObj, url = CHECK_TARGET_URL) => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  // @ts-expect-error — happy-dom's XHR accepts anything, and we want to
  // exercise the module's non-string defensive branch.
  xhr.send(body);
  const responseText =
    responseObj === '__INVALID_JSON__'
      ? 'not valid json at all {'
      : JSON.stringify(responseObj);
  Object.defineProperty(xhr, 'responseText', { value: responseText, configurable: true });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  await Promise.resolve();
  return xhr;
};

/** @type {CustomEvent | null} */
let captured = null;

/** @param {Event} e */
const captureListener = (e) => {
  captured = /** @type {CustomEvent} */ (e);
};

beforeEach(() => {
  captured = null;
  _resetObserversForTest();
  _resetCheckTargetHookForTest();
  document.addEventListener('oge5:checkTargetResult', captureListener);
});

afterEach(() => {
  document.removeEventListener('oge5:checkTargetResult', captureListener);
  _resetCheckTargetHookForTest();
  _resetObserversForTest();
});

describe('installCheckTargetHook — happy path', () => {
  it('dispatches oge5:checkTargetResult with coords + null errorCode on success', async () => {
    installCheckTargetHook();

    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: { 7: true, 15: false },
    });

    expect(captured).not.toBeNull();
    const detail = /** @type {any} */ (captured).detail;
    expect(detail.galaxy).toBe(4);
    expect(detail.system).toBe(30);
    expect(detail.position).toBe(8);
    // Simplified shape: errorCode is null on success responses (no errors[])
    // or on success+empty-errors — consumers read the rest of target
    // state from window.fleetDispatcher.
    expect(detail.errorCode).toBeNull();
    // Shape assertion: only the 4 documented fields, nothing else.
    expect(Object.keys(detail).sort()).toEqual(
      ['errorCode', 'galaxy', 'position', 'system'],
    );
  });
});

describe('installCheckTargetHook — response gating', () => {
  it('DOES dispatch on failure response, surfacing first errorCode (4.9.2 parity)', async () => {
    // v4 4.9.2 changed the hook to dispatch on both success AND failure
    // responses so consumers can read the error code for reserved-slot
    // detection (140016) and other edge cases. v5 inherits the
    // contract; simplified shape exposes a single `errorCode` field.
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'error',
      targetOk: false,
      errors: [{ error: 140016, message: 'reserved' }],
    });
    expect(captured).not.toBeNull();
    const detail = /** @type {any} */ (captured).detail;
    expect(detail.errorCode).toBe(140016);
  });

  it('errorCode is first code when errors[] has multiple entries', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'error',
      errors: [
        { error: 140035, message: 'no ship' },
        { error: 140016, message: 'reserved too' },
      ],
    });
    const detail = /** @type {any} */ (captured).detail;
    expect(detail.errorCode).toBe(140035);
  });

  it('errorCode is null when errors[] is empty or missing', async () => {
    installCheckTargetHook();
    // errors[] missing entirely (typical success response)
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
    });
    expect(/** @type {any} */ (captured).detail.errorCode).toBeNull();

    captured = null;
    // errors[] present but empty
    await fakeCheckTargetXHR('galaxy=1&system=2&position=3&type=1', {
      status: 'success',
      errors: [],
    });
    expect(/** @type {any} */ (captured).detail.errorCode).toBeNull();
  });

  it('does NOT dispatch when response is not valid JSON', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', '__INVALID_JSON__');
    expect(captured).toBeNull();
  });

  it('does NOT dispatch when response is null', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', null);
    expect(captured).toBeNull();
  });
});

describe('installCheckTargetHook — body gating', () => {
  it('does NOT dispatch when body is not a string', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR(null, {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: {},
    });
    expect(captured).toBeNull();
  });

  it('does NOT dispatch when body is missing galaxy/system/position', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('type=1&foo=bar', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: {},
    });
    expect(captured).toBeNull();
  });

  it('does NOT dispatch when a coord is zero (parseInt falsy)', async () => {
    installCheckTargetHook();
    // position=0 is not a valid OGame slot; the hook rejects it.
    await fakeCheckTargetXHR('galaxy=4&system=30&position=0&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: {},
    });
    expect(captured).toBeNull();
  });

  it('decodes `+`-encoded spaces and percent-escapes in body values', async () => {
    installCheckTargetHook();
    // We don't rely on any of these fields in the detail — the test is
    // that the parser doesn't choke on `+` and still extracts coords.
    await fakeCheckTargetXHR(
      'galaxy=4&system=30&position=8&some_param=a+b&also=%20space%20',
      {
        status: 'success',
        targetOk: true,
        targetInhabited: false,
        orders: {},
      },
    );

    expect(captured).not.toBeNull();
    const detail = /** @type {any} */ (captured).detail;
    expect(detail.galaxy).toBe(4);
    expect(detail.system).toBe(30);
    expect(detail.position).toBe(8);
  });
});

describe('installCheckTargetHook — errorCode defensive parsing', () => {
  it('skips malformed error entries (non-number .error field)', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'error',
      errors: [
        { error: 'not-a-number' },  // invalid, skip
        { error: 140016 },           // valid, first taken
      ],
    });
    const detail = /** @type {any} */ (captured).detail;
    expect(detail.errorCode).toBe(140016);
  });

  it('errorCode is null when `errors` field is not an array', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'error',
      errors: 'not an array',
    });
    expect(/** @type {any} */ (captured).detail.errorCode).toBeNull();
  });
});

describe('installCheckTargetHook — URL filter', () => {
  it('does NOT fire on unrelated XHRs (no action=checkTarget in URL)', async () => {
    installCheckTargetHook();
    await fakeCheckTargetXHR(
      'galaxy=4&system=30&position=8&type=1',
      {
        status: 'success',
        targetOk: true,
        targetInhabited: false,
        orders: {},
      },
      '/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent',
    );
    expect(captured).toBeNull();
  });
});

describe('installCheckTargetHook — idempotency', () => {
  it('returns the same unsubscribe on repeated install and does not double-dispatch', async () => {
    const unsub1 = installCheckTargetHook();
    const unsub2 = installCheckTargetHook();
    expect(unsub1).toBe(unsub2);

    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: { 7: true },
    });

    // A double-registered observer would cause two dispatches; our
    // listener only records the last one, so we instead count via a
    // dedicated counter.
    let count = 0;
    const counter = () => {
      count += 1;
    };
    document.addEventListener('oge5:checkTargetResult', counter);

    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: { 7: true },
    });

    document.removeEventListener('oge5:checkTargetResult', counter);
    expect(count).toBe(1);
  });

  it('unsubscribe stops further dispatches', async () => {
    const unsub = installCheckTargetHook();

    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: {},
    });
    expect(captured).not.toBeNull();

    captured = null;
    unsub();

    await fakeCheckTargetXHR('galaxy=4&system=30&position=8&type=1', {
      status: 'success',
      targetOk: true,
      targetInhabited: false,
      orders: {},
    });
    expect(captured).toBeNull();
  });
});
