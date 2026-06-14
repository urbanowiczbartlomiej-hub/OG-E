// @vitest-environment happy-dom
//
// Tests for the system-discovery bridge: it observes every
// action=sendSystemDiscoveryFleet response and dispatches
// oge:systemDiscoveryResult { success, message, shipsSent,
// sentToCoordinates, canSendDiscovery, galaxy, system }. Drives a fake XHR
// through happy-dom (same pattern as sendFleetResultHook.test).
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installSystemDiscoveryObserver,
  _resetSystemDiscoveryObserverForTest,
} from '../../src/bridges/systemDiscoveryObserver.js';
import { SYSTEM_DISCOVERY_RESULT_EVENT } from '../../src/lib/ogeEvents.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { fakeXHR as fakeXhrRoundTrip } from '../helpers/fakeXhr.js';

const DISCOVERY_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendSystemDiscoveryFleet&asJson=1';

/**
 * POST a discovery request body and a response object to the fixed discovery
 * endpoint. Thin wrapper over the shared round-trip helper that keeps this
 * file's `(body, responseObj)` shape and the `'__INVALID__'` → malformed-JSON
 * sentinel.
 *
 * @param {unknown} body @param {unknown} responseObj
 */
const fakeXHR = async (body, responseObj) => {
  const responseText =
    responseObj === '__INVALID__' ? 'nope {' : JSON.stringify(responseObj);
  return fakeXhrRoundTrip(DISCOVERY_URL, { method: 'POST', body, responseText });
};

/**
 * Build a sentToCoordinates array for galaxy g / system s, positions 1..n.
 * @param {number} g @param {number} s @param {number} n
 */
const coords = (g, s, n) =>
  Array.from({ length: n }, (_, i) => ({ galaxy: g, system: s, position: i + 1 }));

/** @type {any} */
let captured = null;
/** @param {Event} e */
const cap = (e) => { captured = /** @type {CustomEvent} */ (e).detail; };

beforeEach(() => {
  captured = null;
  _resetObserversForTest();
  _resetSystemDiscoveryObserverForTest();
  document.addEventListener(SYSTEM_DISCOVERY_RESULT_EVENT, cap);
  installSystemDiscoveryObserver();
});
afterEach(() => {
  document.removeEventListener(SYSTEM_DISCOVERY_RESULT_EVENT, cap);
  _resetSystemDiscoveryObserverForTest();
  _resetObserversForTest();
});

describe('systemDiscoveryObserver', () => {
  it('publishes a successful discovery (HAR sample: 15 ships, all positions)', async () => {
    await fakeXHR('galaxy=4&system=472&token=abc', {
      response: {
        success: true,
        message: 'Wysłano statek ekspedycyjny\n',
        shipsSent: 15,
        sentToCoordinates: coords(4, 472, 15),
        discovery: { canSendDiscovery: true, discoveryCount: '(39639 / 48620)' },
      },
      components: [],
      newAjaxToken: 'x',
    });
    expect(captured.success).toBe(true);
    expect(captured.shipsSent).toBe(15);
    expect(captured.sentToCoordinates).toHaveLength(15);
    expect(captured.sentToCoordinates[0]).toEqual({ galaxy: 4, system: 472, position: 1 });
    expect(captured.canSendDiscovery).toBe(true);
    expect(captured.galaxy).toBe(4);
    expect(captured.system).toBe(472);
  });

  it('publishes shipsSent:0 (system already fully discovered)', async () => {
    await fakeXHR('galaxy=4&system=472', {
      response: { success: true, message: '', shipsSent: 0, sentToCoordinates: [] },
    });
    expect(captured.success).toBe(true);
    expect(captured.shipsSent).toBe(0);
    expect(captured.sentToCoordinates).toEqual([]);
  });

  it('publishes the fleet-cap rejection', async () => {
    await fakeXHR('galaxy=4&system=472', {
      response: { message: 'Maksymalna liczba flot osiągnięta', success: false },
      components: [],
      newAjaxToken: 'x',
    });
    expect(captured.success).toBe(false);
    expect(captured.message).toBe('Maksymalna liczba flot osiągnięta');
    expect(captured.shipsSent).toBe(0);
  });

  it('does not dispatch on invalid JSON', async () => {
    await fakeXHR('galaxy=4&system=472', '__INVALID__');
    expect(captured).toBeNull();
  });

  it('does not dispatch when the response envelope lacks a response object', async () => {
    await fakeXHR('galaxy=4&system=472', { components: [] });
    expect(captured).toBeNull();
  });
});
