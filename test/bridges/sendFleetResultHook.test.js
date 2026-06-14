// @vitest-environment happy-dom
//
// Tests for the sendFleet-result bridge: it observes every action=sendFleet
// response and dispatches oge:sendFleetResult { success, errorCode, mission }.
// Drives a fake XHR through happy-dom (same pattern as checkTargetObserver.test).
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installSendFleetResultHook,
  _resetSendFleetResultHookForTest,
} from '../../src/bridges/sendFleetResultHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { fakeXHR as fakeXhrRoundTrip } from '../helpers/fakeXhr.js';

const SEND_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1';

/**
 * POST a sendFleet body + response object to the fixed send endpoint. Thin
 * wrapper over the shared round-trip helper, keeping the `(body, responseObj)`
 * shape and the `'__INVALID__'` malformed-JSON sentinel.
 *
 * @param {unknown} body @param {unknown} responseObj
 */
const fakeSendXHR = async (body, responseObj) => {
  const responseText =
    responseObj === '__INVALID__' ? 'nope {' : JSON.stringify(responseObj);
  return fakeXhrRoundTrip(SEND_URL, { method: 'POST', body, responseText });
};

/** @type {any} */
let captured = null;
/** @param {Event} e */
const cap = (e) => { captured = /** @type {CustomEvent} */ (e).detail; };

beforeEach(() => {
  captured = null;
  _resetObserversForTest();
  _resetSendFleetResultHookForTest();
  document.addEventListener('oge:sendFleetResult', cap);
  installSendFleetResultHook();
});
afterEach(() => {
  document.removeEventListener('oge:sendFleetResult', cap);
  _resetSendFleetResultHookForTest();
  _resetObserversForTest();
});

describe('sendFleetResultHook', () => {
  it('publishes success on an accepted send', async () => {
    await fakeSendXHR('mission=4&galaxy=4', { success: true, components: [] });
    expect(captured).toEqual({ success: true, errorCode: null, mission: 4 });
  });

  it('publishes the first error code on a rejected send', async () => {
    await fakeSendXHR('mission=4', {
      success: false,
      errors: [{ message: 'Niewystarczająca ilość paliwa!', error: 140026 }],
    });
    expect(captured.success).toBe(false);
    expect(captured.errorCode).toBe(140026);
    expect(captured.mission).toBe(4);
  });

  it('parses the mission from the body (null when absent)', async () => {
    await fakeSendXHR('galaxy=1&system=2', { success: true });
    expect(captured.mission).toBeNull();
  });

  it('does not dispatch on invalid JSON', async () => {
    await fakeSendXHR('mission=4', '__INVALID__');
    expect(captured).toBeNull();
  });
});
