// MAIN-world bridge that observes EVERY `action=sendFleet` response and
// republishes a small result on the ISOLATED-world boundary as
// `oge:sendFleetResult`. The shared fleet courier's dispatch() awaits it so
// a button can tell a real send from a rejected one — the game answers a
// rejected send with HTTP 200 but `{"success":false,"errors":[...]}` (e.g.
// error 140026 "insufficient fuel"), which would otherwise look like a
// successful "Sent".
//
// This is a strict observer: we never originate the request and never
// mutate the response — we read it and dispatch an event. It is separate
// from sendFleetHook.js (which is colonize-specific, mission=7) because the
// result is needed for ALL missions (deployment, expedition, colonize).
//
// @ts-check

import { observeXHR } from './xhrObserver.js';
import { FD_SEND_RESULT_EVENT } from '../lib/fleetProtocol.js';

/** @param {unknown} body @returns {number | null} */
const missionFromBody = (body) => {
  if (typeof body !== 'string') return null;
  try {
    const raw = new URLSearchParams(body).get('mission');
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/** @type {(() => void) | null} */
let unsubscribeFn = null;

/**
 * Install the sendFleet-result observer. Idempotent.
 *
 * @returns {() => void} unsubscribe
 */
export const installSendFleetResultHook = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const unsub = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'load',
    handler: ({ body, response }) => {
      if (!response) return;
      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      const success = parsed.success === true;
      /** @type {number | null} */
      let errorCode = null;
      if (Array.isArray(parsed.errors)) {
        for (const e of parsed.errors) {
          if (e && typeof e.error === 'number') {
            errorCode = e.error;
            break;
          }
        }
      }

      document.dispatchEvent(
        new CustomEvent(FD_SEND_RESULT_EVENT, {
          detail: { success, errorCode, mission: missionFromBody(body) },
        }),
      );
    },
  });

  unsubscribeFn = () => {
    unsub();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/** Test-only reset. @returns {void} */
export const _resetSendFleetResultHookForTest = () => {
  if (unsubscribeFn) unsubscribeFn();
  unsubscribeFn = null;
};
