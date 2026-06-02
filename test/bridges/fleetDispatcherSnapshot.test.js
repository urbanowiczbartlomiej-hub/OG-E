// @vitest-environment happy-dom
//
// Tests for the fleetDispatcher snapshot bridge. The module reads the
// page-side `window.fleetDispatcher` global, projects a trimmed snapshot,
// and publishes it on `oge:fleetDispatcher` — both once on install and
// after every `action=checkTarget` XHR. These tests pin the projection's
// defensive coercion (the part the agent flagged as untested) and the
// publish lifecycle.
//
// Timing note: the checkTarget republish and the initial publish are both
// deferred by a microtask (`Promise.resolve().then(publish)`), so every
// assertion is preceded by `flush()` (two microtask turns — one for the
// observer handler, one for the deferred publish).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installFleetDispatcherSnapshot,
  _resetFleetDispatcherSnapshotForTest,
} from '../../src/bridges/fleetDispatcherSnapshot.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

const CHECK_TARGET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=checkTarget';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Drive one checkTarget XHR load to trigger a republish. */
const fireCheckTarget = async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', CHECK_TARGET_URL);
  xhr.send('galaxy=4&system=30&position=8');
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  await flush();
};

/** @param {unknown} fd */
const setFleetDispatcher = (fd) => {
  /** @type {any} */ (window).fleetDispatcher = fd;
};

let fired = 0;
/** @type {any} */
let detail = null;
const listener = (/** @type {Event} */ e) => {
  fired += 1;
  detail = /** @type {CustomEvent} */ (e).detail;
};

beforeEach(() => {
  fired = 0;
  detail = null;
  delete (/** @type {any} */ (window).fleetDispatcher);
  _resetObserversForTest();
  _resetFleetDispatcherSnapshotForTest();
  document.addEventListener('oge:fleetDispatcher', listener);
});

afterEach(() => {
  document.removeEventListener('oge:fleetDispatcher', listener);
  _resetFleetDispatcherSnapshotForTest();
  _resetObserversForTest();
  delete (/** @type {any} */ (window).fleetDispatcher);
});

describe('snapshot projection — happy path', () => {
  it('projects exactly the documented fields on the initial publish', async () => {
    setFleetDispatcher({
      currentPlanet: { galaxy: 4, system: 30, position: 8, name: 'Home' },
      targetPlanet: { galaxy: 1, system: 2, position: 3 },
      orders: { 7: true, 15: false },
      shipsOnPlanet: [{ id: 202, number: 100 }],
      expeditionCount: 3,
      maxExpeditionCount: 14,
      // Fields that must be dropped from the projection:
      loca: 'junk',
      fleetHelper: {},
    });
    installFleetDispatcherSnapshot();
    await flush();

    expect(fired).toBe(1);
    expect(detail.currentPlanet).toEqual({ galaxy: 4, system: 30, position: 8 });
    expect(detail.targetPlanet).toEqual({ galaxy: 1, system: 2, position: 3 });
    expect(detail.orders).toEqual({ 7: true, 15: false });
    expect(detail.shipsOnPlanet).toEqual([{ id: 202, number: 100 }]);
    expect(detail.expeditionCount).toBe(3);
    expect(detail.maxExpeditionCount).toBe(14);
    expect(Object.keys(detail).sort()).toEqual([
      'currentPlanet',
      'expeditionCount',
      'maxExpeditionCount',
      'orders',
      'shipsOnPlanet',
      'targetPlanet',
    ]);
  });
});

describe('snapshot projection — defensive coercion', () => {
  it('string-numeric coords/ships/counts are coerced to numbers', async () => {
    setFleetDispatcher({
      currentPlanet: { galaxy: '4', system: '30', position: '8' },
      shipsOnPlanet: [{ id: '202', number: '100' }],
      expeditionCount: '5',
      maxExpeditionCount: '14',
    });
    installFleetDispatcherSnapshot();
    await flush();

    expect(detail.currentPlanet).toEqual({ galaxy: 4, system: 30, position: 8 });
    expect(detail.shipsOnPlanet).toEqual([{ id: 202, number: 100 }]);
    expect(detail.expeditionCount).toBe(5);
    expect(detail.maxExpeditionCount).toBe(14);
  });

  it('coords with a non-finite component become null', async () => {
    setFleetDispatcher({
      currentPlanet: { galaxy: 4, system: 'NaN-here', position: 8 },
      targetPlanet: null,
    });
    installFleetDispatcherSnapshot();
    await flush();
    expect(detail.currentPlanet).toBeNull();
    expect(detail.targetPlanet).toBeNull();
  });

  it('skips malformed ship entries (non-object, NaN id/number)', async () => {
    setFleetDispatcher({
      shipsOnPlanet: [
        { id: 202, number: 10 }, // valid
        null, // not an object
        { id: 'nope', number: 5 }, // NaN id
        { id: 204 }, // NaN number (missing)
        'junk', // not an object
      ],
    });
    installFleetDispatcherSnapshot();
    await flush();
    expect(detail.shipsOnPlanet).toEqual([{ id: 202, number: 10 }]);
  });

  it('orders as an array yields null; object values are boolean-coerced', async () => {
    setFleetDispatcher({ orders: { 7: 1, 15: 0, 9: 'x' } });
    installFleetDispatcherSnapshot();
    await flush();
    expect(detail.orders).toEqual({ 7: true, 15: false, 9: true });

    _resetFleetDispatcherSnapshotForTest();
    fired = 0;
    setFleetDispatcher({ orders: ['7', '15'] });
    installFleetDispatcherSnapshot();
    await flush();
    expect(detail.orders).toBeNull();
  });

  it('missing/garbage counts fall back to 0', async () => {
    setFleetDispatcher({ expeditionCount: 'abc' });
    installFleetDispatcherSnapshot();
    await flush();
    expect(detail.expeditionCount).toBe(0);
    expect(detail.maxExpeditionCount).toBe(0);
  });
});

describe('publish lifecycle', () => {
  it('does NOT publish when window.fleetDispatcher is absent', async () => {
    // no setFleetDispatcher
    installFleetDispatcherSnapshot();
    await flush();
    await fireCheckTarget();
    expect(fired).toBe(0);
  });

  it('republishes after a checkTarget XHR with the freshly-read state', async () => {
    installFleetDispatcherSnapshot(); // initial publish is a no-op (no global yet)
    await flush();
    expect(fired).toBe(0);

    setFleetDispatcher({ currentPlanet: { galaxy: 7, system: 7, position: 7 } });
    await fireCheckTarget();
    expect(fired).toBe(1);
    expect(detail.currentPlanet).toEqual({ galaxy: 7, system: 7, position: 7 });
  });

  it('is idempotent — repeated install republishes once per checkTarget', async () => {
    setFleetDispatcher({ orders: { 7: true } });
    const a = installFleetDispatcherSnapshot();
    const b = installFleetDispatcherSnapshot();
    expect(a).toBe(b);
    await flush();
    fired = 0; // ignore the initial publish

    await fireCheckTarget();
    expect(fired).toBe(1);
  });

  it('unsubscribe stops checkTarget republishes', async () => {
    setFleetDispatcher({ orders: { 7: true } });
    const unsub = installFleetDispatcherSnapshot();
    await flush();
    fired = 0;

    unsub();
    await fireCheckTarget();
    expect(fired).toBe(0);
  });
});
