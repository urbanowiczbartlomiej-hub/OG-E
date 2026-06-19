// @vitest-environment happy-dom
//
// Behavioural tests for the shared fleetDispatcher snapshot cache
// (`features/shared/fleetDispatcherCache.js`). We drive the bridge
// `oge:fleetDispatcher` CustomEvent and a live `window.fleetDispatcher`
// through happy-dom and assert the observable surface: `get()` value,
// `onUpdate` firing, bootstrap seeding, and attach/detach/reset.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFleetDispatcherCache } from '../../src/features/shared/fleetDispatcherCache.js';
import { FLEET_DISPATCHER_EVENT } from '../../src/lib/ogeEvents.js';

/** @param {any} detail */
const publish = (detail) => {
  document.dispatchEvent(new CustomEvent(FLEET_DISPATCHER_EVENT, { detail }));
};

/** Caches attached during a test, detached in afterEach to avoid listener leak.
 *  @type {Array<{ detach: () => void }>} */
let attached = [];

/** @param {{ onUpdate?: () => void }} [cfg] */
const makeAttached = (cfg) => {
  const c = createFleetDispatcherCache(cfg);
  c.attach();
  attached.push(c);
  return c;
};

beforeEach(() => {
  attached = [];
  delete (/** @type {any} */ (window).fleetDispatcher);
});

afterEach(() => {
  for (const c of attached) c.detach();
  delete (/** @type {any} */ (window).fleetDispatcher);
});

describe('createFleetDispatcherCache', () => {
  it('starts empty', () => {
    const c = createFleetDispatcherCache();
    expect(c.get()).toBe(null);
  });

  it('caches the latest snapshot from the bridge event and fires onUpdate', () => {
    const onUpdate = vi.fn();
    const c = makeAttached({ onUpdate });
    const snap = { fleetCount: 3, maxFleetCount: 11 };
    publish(snap);
    expect(c.get()).toBe(snap);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const snap2 = { fleetCount: 4, maxFleetCount: 11 };
    publish(snap2);
    expect(c.get()).toBe(snap2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('ignores events with a missing or non-object detail', () => {
    const onUpdate = vi.fn();
    const c = makeAttached({ onUpdate });
    publish(null);
    publish('nope');
    publish(42);
    expect(c.get()).toBe(null);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('works without an onUpdate callback', () => {
    const c = makeAttached();
    const snap = { fleetCount: 1 };
    expect(() => publish(snap)).not.toThrow();
    expect(c.get()).toBe(snap);
  });

  it('stops updating after detach', () => {
    const c = createFleetDispatcherCache();
    c.attach();
    publish({ fleetCount: 1 });
    c.detach();
    publish({ fleetCount: 9 });
    expect(c.get()).toEqual({ fleetCount: 1 });
  });

  it('does not receive events before attach', () => {
    const c = createFleetDispatcherCache();
    publish({ fleetCount: 1 });
    expect(c.get()).toBe(null);
  });

  describe('bootstrap', () => {
    it('seeds from a live window.fleetDispatcher object', () => {
      const live = { fleetCount: 7 };
      /** @type {any} */ (window).fleetDispatcher = live;
      const c = createFleetDispatcherCache();
      c.bootstrap();
      expect(c.get()).toBe(live);
    });

    it('is a no-op when window.fleetDispatcher is not an object', () => {
      /** @type {any} */ (window).fleetDispatcher = 'not-an-object';
      const c = createFleetDispatcherCache();
      c.bootstrap();
      expect(c.get()).toBe(null);
    });

    it('is a no-op when nothing is readable', () => {
      const c = createFleetDispatcherCache();
      c.bootstrap();
      expect(c.get()).toBe(null);
    });

    it('does not overwrite a snapshot already cached from an event', () => {
      const c = makeAttached();
      const fromEvent = { fleetCount: 2 };
      publish(fromEvent);
      /** @type {any} */ (window).fleetDispatcher = { fleetCount: 99 };
      c.bootstrap();
      expect(c.get()).toBe(fromEvent);
    });
  });

  it('reset() clears the cached snapshot', () => {
    const c = makeAttached();
    publish({ fleetCount: 5 });
    expect(c.get()).not.toBe(null);
    c.reset();
    expect(c.get()).toBe(null);
  });
});
