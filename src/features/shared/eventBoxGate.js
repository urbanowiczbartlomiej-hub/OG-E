// @ts-check

// Shared "eventbox readiness" gate for the floating command buttons.
//
// # Why this exists
//
// On `component=fleetdispatch`, OGame fetches the fleet-event list
// (`?page=componentOnly&component=eventList&...`) a short moment AFTER the
// page itself finishes loading. Until that response lands, the DOM the
// command buttons read — `#eventContent` rows, AGR's `#ago_routine_7`
// check class, the fleet/expedition cap counters — is absent or stale.
// A tap in that window acts on a half-hydrated page (sendExpedition used
// to poll a dead DOM for the full 15 s Phase-2 timeout before recovering).
//
// So every fleet-send button (Expeditions, Colonization, Daily Run,
// Lifeforms) is held VISIBLY disabled from page load until the eventbox is
// fresh, then enabled. The signal is `bridges/eventBoxObserver.js`'s
// `oge:eventBoxLoaded` CustomEvent; we add two fallbacks so a missed XHR
// (a `run_at` race, a future OGame URL shape, a cached response) can never
// strand the button disabled forever:
//
//   1. `window 'load'` — a hard guarantee the page itself stopped hydrating.
//   2. A safety timeout — opens the gate even if neither of the above fires.
//
// OFF fleetdispatch the page doesn't trigger that XHR, so there is nothing
// to wait for and the gate opens immediately.
//
// Layering: features/shared (touches `document` / `window`); imports only
// `lib`. The button component (`./button.js`) wires this in via the
// `gateUntilEventBox` config flag; features never touch it directly.
//
// @see ./button.js                  — the consumer (gateUntilEventBox).
// @see ../../bridges/eventBoxObserver.js — dispatches oge:eventBoxLoaded.

import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';

/**
 * Safety fallback: open the gate this long after install even if neither the
 * eventbox XHR nor `window 'load'` is observed. Well past a typical eventbox
 * load yet a fraction of sendExpedition's 15 s Phase-2 timeout, so a missed
 * signal costs a brief over-disable, never a stuck button.
 */
export const EVENTBOX_SAFETY_TIMEOUT_MS = 1200;

/**
 * Is the current page OGame's fleet-dispatch component? The only page whose
 * post-load eventbox XHR the command buttons depend on.
 *
 * @returns {boolean}
 */
export const isFleetdispatchPage = () =>
  location.search.includes('component=fleetdispatch');

/**
 * Invoke `onReady` exactly once, when the eventbox is fresh enough to act on.
 * On fleetdispatch that's the first of: `oge:eventBoxLoaded`, `window 'load'`,
 * or the safety timeout. Off fleetdispatch it fires synchronously (nothing to
 * wait for). Returns an idempotent teardown that detaches every listener and
 * the timer — call it on dispose, and it's a no-op once `onReady` has fired.
 *
 * @param {() => void} onReady
 * @returns {() => void} teardown.
 */
export const whenEventBoxReady = (onReady) => {
  if (!isFleetdispatchPage()) {
    onReady();
    return () => {};
  }

  let done = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const cleanup = () => {
    document.removeEventListener(EVENT_BOX_LOADED_EVENT, fire);
    window.removeEventListener('load', fire);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  function fire() {
    if (done) return;
    done = true;
    cleanup();
    onReady();
  }

  document.addEventListener(EVENT_BOX_LOADED_EVENT, fire);
  window.addEventListener('load', fire, { once: true });
  timer = setTimeout(fire, EVENTBOX_SAFETY_TIMEOUT_MS);

  return cleanup;
};
