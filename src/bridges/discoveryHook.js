// MAIN-world bridge that observes every `action=sendSystemDiscoveryFleet`
// response (the lifeform "discover system" send) and republishes a small
// result on the ISOLATED-world boundary as `oge:systemDiscoveryResult`.
//
// The Lifeforms button (features/sendLifeform) clicks the game's own
// `#discoverSystemBtn`; the game issues this request. This module never
// originates it — it is a strict observer (same contract as
// sendFleetResultHook.js). We read the response (`shipsSent`,
// `sentToCoordinates`, the discovery cap, and the failure message) and
// the request body (galaxy/system) and dispatch one CustomEvent. The
// isolated-world feature uses it to mark the discovered system in
// `scansStore` with a 7-day retention.
//
// A representative success body is `galaxy=4&system=472&token=…` and the
// response carries `response.success`, `response.message`,
// `response.shipsSent`, `response.sentToCoordinates: [{galaxy,system,position}]`,
// and `response.discovery.canSendDiscovery`. A rejected send (e.g. fleet
// cap reached) answers HTTP 200 with `success:false` and the message
// "Maksymalna liczba flot osiągnięta".
//
// @ts-check

import { observeXHR } from './xhrObserver.js';

/**
 * Event dispatched on `document` after each observed discovery response.
 * Kept in sync with the listener in `features/sendLifeform/index.js`.
 */
export const SYSTEM_DISCOVERY_RESULT_EVENT = 'oge:systemDiscoveryResult';

/**
 * Pull an integer field out of an `x-www-form-urlencoded` request body.
 *
 * @param {unknown} body
 * @param {string} name
 * @returns {number | null}
 */
const intFromBody = (body, name) => {
  if (typeof body !== 'string') return null;
  try {
    const raw = new URLSearchParams(body).get(name);
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/** @type {(() => void) | null} */
let unsubscribeFn = null;

/**
 * @typedef {object} SystemDiscoveryResultDetail
 * @property {boolean} success           `response.success` verbatim.
 * @property {string | null} message     `response.message` (trimmed) or null.
 * @property {number} shipsSent          discovery fleets sent (0 when nothing left).
 * @property {Array<{ galaxy: number, system: number, position: number }>} sentToCoordinates
 *   Coordinates that received a discovery fleet (empty when shipsSent is 0).
 * @property {boolean | null} canSendDiscovery
 *   `response.discovery.canSendDiscovery`, or null when absent.
 * @property {number | null} galaxy      galaxy parsed from the request body.
 * @property {number | null} system      system parsed from the request body.
 */

/**
 * Install the discovery-result observer. Idempotent.
 *
 * @returns {() => void} unsubscribe
 */
export const installDiscoveryHook = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const unsub = observeXHR({
    urlPattern: /action=sendSystemDiscoveryFleet/,
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
      // The interesting payload sits under `response` (a sibling of the
      // top-level `components` / `newAjaxToken` envelope fields).
      const r = parsed && typeof parsed === 'object' ? parsed.response : null;
      if (!r || typeof r !== 'object') return;

      const success = r.success === true;
      const message =
        typeof r.message === 'string' ? r.message.trim() : null;
      const shipsSent = Number.isFinite(r.shipsSent) ? Number(r.shipsSent) : 0;

      /** @type {SystemDiscoveryResultDetail['sentToCoordinates']} */
      const sentToCoordinates = [];
      if (Array.isArray(r.sentToCoordinates)) {
        for (const c of r.sentToCoordinates) {
          if (
            c &&
            typeof c.galaxy === 'number' &&
            typeof c.system === 'number' &&
            typeof c.position === 'number'
          ) {
            sentToCoordinates.push({
              galaxy: c.galaxy,
              system: c.system,
              position: c.position,
            });
          }
        }
      }

      const canSendDiscovery =
        r.discovery && typeof r.discovery.canSendDiscovery === 'boolean'
          ? r.discovery.canSendDiscovery
          : null;

      /** @type {SystemDiscoveryResultDetail} */
      const detail = {
        success,
        message,
        shipsSent,
        sentToCoordinates,
        canSendDiscovery,
        galaxy: intFromBody(body, 'galaxy'),
        system: intFromBody(body, 'system'),
      };

      document.dispatchEvent(
        new CustomEvent(SYSTEM_DISCOVERY_RESULT_EVENT, { detail }),
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
export const _resetDiscoveryHookForTest = () => {
  if (unsubscribeFn) unsubscribeFn();
  unsubscribeFn = null;
};
