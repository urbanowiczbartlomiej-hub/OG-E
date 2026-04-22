// MAIN-world bridge that observes the game's `action=checkTarget` XHR and
// republishes the result as a DOM CustomEvent.
//
// Why this module exists:
//   The game issues a `checkTarget` XHR every time the user edits the
//   coord input on the fleetdispatch page. The response tells the game
//   which mission buttons to light up (colonize, spy, attack, ...) and
//   whether the target slot is inhabited. Several v5 features — notably
//   "stale target detection" in colonize scheduling and expedition-slot
//   redirects — need that same information in the ISOLATED world.
//
//   We can't re-issue the request ourselves (TOS-critical: v5 never
//   originates game traffic, see DESIGN.md §3). Instead we piggy-back on
//   the game's own XHR: xhrObserver gives us the body and response text,
//   we parse them into a structured detail, and we dispatch
//   `oge5:checkTargetResult` on `document`. Isolated-world listeners pick
//   up the detail via `event.detail` and act on it.
//
// What this module does NOT do:
//   - Fire the request. The game fires it; we observe it. Never call
//     `fetch` / `XMLHttpRequest` from here.
//   - Persist anything. This is a pure observer → event pipe. Consumers
//     in ISOLATED world own any state derived from the event.
//   - Trust the response beyond shape checks. The game's response can
//     theoretically change; we parse defensively (type-check each field,
//     fall back to a safe default) so a malformed response doesn't blow
//     up the event dispatch.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';

/**
 * @typedef {object} CheckTargetResultDetail
 * @property {number} galaxy Target galaxy coordinate, parsed from the
 *   request body (the game's own form field).
 * @property {number} system Target system coordinate, parsed from body.
 * @property {number} position Target position coordinate, parsed from body.
 * @property {boolean} success From `response.status === 'success'`. Failure
 *   responses (`status !== 'success'`) also fire this event — v4 4.9.2
 *   onward — so consumers can differentiate "ok but not colonizable" from
 *   "the server rejected the target outright".
 * @property {boolean} targetOk From `response.targetOk`. When `false`, the
 *   slot cannot be targeted for the chosen mission (e.g. empty slot +
 *   attack mission).
 * @property {boolean} targetInhabited From `response.targetInhabited`. When
 *   `true`, the slot has an owner; when `false`, it's an empty slot and a
 *   candidate for colonization.
 * @property {number} targetPlayerId From `response.targetPlayerId`. `0`
 *   when the slot is empty, or when the field is missing / non-numeric
 *   (defensive default).
 * @property {string} targetPlayerName From `response.targetPlayerName`.
 *   Empty string when the slot is empty, or when the field is missing /
 *   non-string (defensive default).
 * @property {Record<string, boolean>} orders Per-mission availability map
 *   from `response.orders`. Keys are mission IDs as strings:
 *   `orders['7']` is the colonization flag, `orders['15']` is expedition,
 *   etc. Empty object `{}` when the response omits the field.
 * @property {number[]} errorCodes Flat list of `error` fields from
 *   `response.errors`. Used by colonize logic to distinguish a
 *   "reserved for planet-move" slot (error `140016`) from a generic
 *   stale target.
 * @property {boolean} colonizable Composite: `success && targetOk &&
 *   !targetInhabited && orders['7'] === true`. The one flag the
 *   colonize flow cares about.
 * @property {boolean} reserved True iff `errorCodes.includes(140016)` —
 *   the slot is reserved for a planet-move by another DM-paying player.
 *   Surfaces as a separate badge colour in the histogram and a distinct
 *   label on the Send button.
 * @property {boolean} noShip True iff `errorCodes.includes(140035)` —
 *   the game refused the send because the active planet has no
 *   colonization ship. Surfaced as a "No ship!" label rather than
 *   "Stale" — the target is fine, the user just needs to build a
 *   colonizer. Do NOT arm stale-retry for this case.
 */

/**
 * Parse a URL-encoded form body into a plain key → string map.
 *
 * The game's checkTarget request is `application/x-www-form-urlencoded`,
 * something like `galaxy=4&system=30&position=8&type=1`. `URLSearchParams`
 * would work too, but rolling it by hand keeps zero dependencies on
 * browser globals (and makes the `+` → space behaviour explicit).
 *
 * Non-string input returns an empty map — defensive for cases where the
 * caller passes `null`, `undefined`, or some other body type (the game
 * never does, but `XMLHttpRequest#send` accepts many types).
 *
 * @param {unknown} body
 * @returns {Record<string, string>}
 */
const parseFormBody = (body) => {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof body !== 'string') return out;
  for (const pair of body.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const rawKey = pair.slice(0, eqIdx);
    const rawVal = pair.slice(eqIdx + 1).replace(/\+/g, ' ');
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal);
    } catch {
      // Malformed percent-encoding — skip this pair rather than letting
      // decodeURIComponent throw and kill the whole dispatch.
    }
  }
  return out;
};

/**
 * Track the installed unsubscribe so repeated `installCheckTargetHook`
 * calls are no-ops that return the same tear-down function. Under normal
 * content-script lifecycle this is installed exactly once, but module
 * hot-reload paths (Firefox temporary add-ons reload the whole page) can
 * re-execute this file — the idempotency guard keeps observer counts
 * from doubling.
 *
 * @type {(() => void) | null}
 */
let unsubscribeFn = null;

/**
 * Install the checkTarget observer. Idempotent — a second call returns
 * the same unsubscribe without registering a second observer.
 *
 * The observer:
 *   1. Fires on `load` for any URL containing `action=checkTarget`.
 *   2. Parses the JSON response; bails silently on invalid JSON or on
 *      `status !== 'success'`.
 *   3. Parses the form body to pull out `galaxy` / `system` / `position`;
 *      bails if any coordinate is missing or non-numeric.
 *   4. Dispatches `oge5:checkTargetResult` on `document` with a
 *      {@link CheckTargetResultDetail} payload.
 *
 * Bailing silently (rather than logging) is deliberate: this XHR fires
 * on every keystroke the user makes in the coord input, so a cold miss
 * (user typed `4.3` mid-edit) is normal and must not spam the logger.
 *
 * @returns {() => void} Unsubscribe function. Calling it detaches the
 *   observer; subsequent checkTarget responses no longer dispatch.
 */
export const installCheckTargetHook = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const unsub = observeXHR({
    urlPattern: /action=checkTarget/,
    on: 'load',
    handler: ({ body, response }) => {
      if (typeof body !== 'string' || !response) return;

      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      // NOTE: we deliberately do NOT filter on `status === 'success'`
      // here. v4 4.9.2 changed this to dispatch on BOTH success and
      // failure responses — failure responses carry `errors[]` with
      // the error code consumers need (e.g. 140016 for a slot
      // reserved for planet-move). Filtering would hide those.
      const success = parsed.status === 'success';

      const params = parseFormBody(body);
      const galaxy = parseInt(params.galaxy, 10);
      const system = parseInt(params.system, 10);
      const position = parseInt(params.position, 10);
      // `parseInt('', 10)` → NaN, falsy; `parseInt('0', 10)` → 0, also
      // falsy. All three coordinates are 1-indexed in OGame (galaxy 1+,
      // system 1+, position 1-16), so treating 0 as invalid here is the
      // same constraint the game enforces client-side.
      if (!galaxy || !system || !position) return;

      const orders =
        parsed.orders && typeof parsed.orders === 'object' && !Array.isArray(parsed.orders)
          ? /** @type {Record<string, boolean>} */ (parsed.orders)
          : {};
      const targetOk = Boolean(parsed.targetOk);
      const targetInhabited = Boolean(parsed.targetInhabited);

      // Extract error codes from `response.errors[]`. The server ships
      // entries as `{ error: <number>, message: <string> }`; we keep
      // just the numeric code so consumers can do fast set-membership.
      /** @type {number[]} */
      const errorCodes = [];
      if (Array.isArray(parsed.errors)) {
        for (const err of parsed.errors) {
          if (err && typeof err.error === 'number') errorCodes.push(err.error);
        }
      }

      // Composite flags. The colonize flow asks "can I send a
      // colonizer here right now?"; the reserved flag distinguishes
      // planet-move reservations from every other kind of stale.
      const colonizable =
        success && targetOk && !targetInhabited && orders['7'] === true;
      const reserved = errorCodes.includes(140016);
      const noShip = errorCodes.includes(140035);

      /** @type {CheckTargetResultDetail} */
      const detail = {
        galaxy,
        system,
        position,
        success,
        targetOk,
        targetInhabited,
        targetPlayerId: typeof parsed.targetPlayerId === 'number' ? parsed.targetPlayerId : 0,
        targetPlayerName:
          typeof parsed.targetPlayerName === 'string' ? parsed.targetPlayerName : '',
        orders,
        errorCodes,
        colonizable,
        reserved,
        noShip,
      };

      document.dispatchEvent(new CustomEvent('oge5:checkTargetResult', { detail }));
    },
  });

  unsubscribeFn = () => {
    unsub();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: reset the module-level `unsubscribeFn` so each test starts
 * with a clean slate. Production code never needs this.
 *
 * @returns {void}
 */
export const _resetCheckTargetHookForTest = () => {
  if (unsubscribeFn) unsubscribeFn();
  unsubscribeFn = null;
};
