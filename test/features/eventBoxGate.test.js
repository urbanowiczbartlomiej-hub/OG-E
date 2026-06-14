// @vitest-environment happy-dom
//
// Behavioural tests for the shared eventbox-readiness gate
// (features/shared/eventBoxGate.js): off fleetdispatch it fires
// immediately; on fleetdispatch it waits for the bridge signal /
// window 'load' / a safety timeout, fires onReady exactly once, and the
// teardown detaches everything.
//
// @ts-check

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  whenEventBoxReady,
  isFleetdispatchPage,
  EVENTBOX_SAFETY_TIMEOUT_MS,
} from '../../src/features/shared/eventBoxGate.js';

afterEach(() => {
  location.search = '';
  vi.useRealTimers();
});

describe('isFleetdispatchPage', () => {
  it('is true only when the component is fleetdispatch', () => {
    location.search = '?page=ingame&component=fleetdispatch&cp=1';
    expect(isFleetdispatchPage()).toBe(true);
    location.search = '?page=ingame&component=overview';
    expect(isFleetdispatchPage()).toBe(false);
  });
});

describe('whenEventBoxReady', () => {
  it('off fleetdispatch fires synchronously and returns a no-op teardown', () => {
    location.search = '?component=overview';
    let ready = 0;
    const stop = whenEventBoxReady(() => (ready += 1));
    expect(ready).toBe(1);
    expect(() => stop()).not.toThrow();
  });

  it('on fleetdispatch waits, then fires once on oge:eventBoxLoaded', () => {
    location.search = '?component=fleetdispatch';
    let ready = 0;
    whenEventBoxReady(() => (ready += 1));
    expect(ready).toBe(0); // still waiting

    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    expect(ready).toBe(1);
    // A second signal must NOT fire onReady again.
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    expect(ready).toBe(1);
  });

  it('on fleetdispatch opens via the safety timeout if no signal arrives', () => {
    vi.useFakeTimers();
    location.search = '?component=fleetdispatch';
    let ready = 0;
    whenEventBoxReady(() => (ready += 1));
    expect(ready).toBe(0);
    vi.advanceTimersByTime(EVENTBOX_SAFETY_TIMEOUT_MS);
    expect(ready).toBe(1);
  });

  it('teardown detaches the listener so a later signal does nothing', () => {
    location.search = '?component=fleetdispatch';
    let ready = 0;
    const stop = whenEventBoxReady(() => (ready += 1));
    stop();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    expect(ready).toBe(0);
  });
});
