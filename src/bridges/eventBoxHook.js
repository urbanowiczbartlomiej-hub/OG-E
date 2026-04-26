// @ts-check

// MAIN-world bridge — observe OGame's eventbox refresh XHR and dispatch
// `oge:eventBoxLoaded` once the response lands with HTTP 200.
//
// # Why this exists
//
// On `component=fleetdispatch`, OGame asynchronously fetches the
// fleet-event list (`?page=componentOnly&component=eventList&...`) a
// short moment after the page itself finishes loading. Until that
// response arrives, several DOM nodes the sendExp click handler reads
// are absent or stale (`#eventContent tr.eventFleet`,
// `#ago_routine_7 .ago_routine_check_3`, ...). A user who taps the
// floating "Send Exp" button before the eventbox lands therefore
// triggers Phase 2 polling that never resolves, locking the button
// for the full 15 s `POLL_TIMEOUT_MS` window before recovery.
//
// This bridge gives the isolated-world consumer a single, reliable
// signal — "eventbox is fresh, you may now click" — without forcing
// it to poll the DOM. The signal is delivered via a CustomEvent
// dispatched on `document`, which is shared across the world boundary
// just like the other `oge:*` events.
//
// # Behaviour
//
//   - Patterns matched on the URL: `component=eventList` and
//     `page=eventList`. OGame has used both forms historically; we
//     accept either so a swap on their side doesn't silently break the
//     gate.
//   - We dispatch ONLY on HTTP 200. A 4xx/5xx response means the
//     eventbox didn't actually update, so the consumer should keep
//     waiting (the next refresh, or the consumer's own safety timeout,
//     will take over).
//   - The event is a bare notification — `detail` is intentionally
//     absent. No data needs to flow; consumers only care about timing.
//
// @see ../features/sendExp/index.js — primary consumer; gates the
//   click handler until this event arrives.

import { observeXHR } from './xhrObserver.js';

/** Idempotency sentinel — a second install returns the same teardown. */
/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the eventbox-loaded observer. Idempotent.
 *
 * @returns {() => void} Unsubscribe — detaches the XHR observer.
 */
export const installEventBoxHook = () => {
  if (installed) return installed;

  // OGame has shipped several URL forms for the eventbox refresh over
  // the years (`page=eventList`, `component=eventList`, `page=fetchEventbox`,
  // `action=fetchEventbox`, `eventList&ajax=1`, ...). A narrow regex
  // misses the in-use form and the gate stays closed until the safety
  // timer fires — bug seen in 1.0.1 release where the button needed
  // many taps before clearing. Match any URL that mentions `eventbox`
  // or `eventList` anywhere, case-insensitive.
  const unsub = observeXHR({
    urlPattern: /event(?:box|list)/i,
    on: 'load',
    handler: ({ xhr }) => {
      if (xhr.status !== 200) return;
      document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    },
  });

  installed = () => {
    unsub();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset for the module-scope install handle.
 *
 * @returns {void}
 */
export const _resetEventBoxHookForTest = () => {
  if (installed) installed();
  installed = null;
};
