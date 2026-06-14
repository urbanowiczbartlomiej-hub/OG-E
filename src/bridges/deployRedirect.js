// MAIN-world bridge that rewrites the `redirectUrl` on the game's
// sendFleet response for DEPLOYMENT missions (mission=4), so the page
// navigates where the fleet-save feature wants next instead of wherever
// the game would have gone.
//
// # Why this bridge is a "dumb rewriter"
//
// Unlike `expeditionRedirect.js` — which computes the next planet itself
// by walking `#planetList` in MAIN — this bridge contains NO routing
// logic. The decision "where to go next" depends on the fleet-save route
// config (`state/dailyRunRoutes.js`, persisted to `chrome.storage.local`) and
// on the in-flight detection read from `#eventContent`. MAIN-world code
// has neither `chrome.*` access nor any business duplicating that logic.
//
// So the ISOLATED-world orchestrator (`features/dailyRun/index.js`) — which
// already has the store + DOM — computes the next URL and writes it to a
// localStorage handoff key SYNCHRONOUSLY, in the same tick it clicks the
// native dispatch button. This bridge just reads that precomputed URL and
// swaps it into the response the game is about to navigate to.
//
// # The handoff contract (`oge_fsRedirect`)
//
//   - The orchestrator writes `oge_fsRedirect` = an absolute URL string
//     immediately before clicking `#dispatchFleet`.
//   - This bridge CONSUMES it on the sendFleet `send` phase (reads then
//     removes it), capturing the URL in a closure. Consuming at send time
//     means a flag can never leak to a later, unrelated deployment: even
//     if this send fails, the flag is gone and the game's own redirect
//     stands.
//   - On the `load` phase, IF the response reports success, the captured
//     URL replaces `redirectUrl`. On failure we leave the response
//     untouched (the game shows its own error / redirect).
//
// Like `expeditionRedirect`, this is zero-traffic: we never originate a
// request, we only transform a response the game itself triggered. The
// override lives on the single XHR INSTANCE (not the prototype) so it is
// scoped to one request and needs no teardown.
//
// @see ./expeditionRedirect.js — the planet-hopping sibling (computes its
//   own next target; this one is told).
// @see ../features/dailyRun/index.js — writes `oge_fsRedirect`.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';
import { safeLS } from '../lib/storage.js';
import { MISSION_DEPLOYMENT } from '../domain/rules.js';
import { DAILY_RUN_REDIRECT_KEY } from '../lib/storageKeys.js';

// Re-export so existing importers (and this bridge's test) can keep
// reading the key from here. The canonical definition lives in
// `lib/storageKeys.js` — a bare string constant the MAIN-world bridge can
// import without dragging in the isolated-world store module (same pattern
// as sendFleetHook importing REGISTRY_KEY from lib/storageKeys.js).
export { DAILY_RUN_REDIRECT_KEY };

/**
 * Extract the `mission` field from a form-encoded sendFleet body. Mirrors
 * the helper in `expeditionRedirect.js` / `sendFleetHook.js`.
 *
 * @param {unknown} body
 * @returns {number | null}
 */
const getMissionFromBody = (body) => {
  if (typeof body !== 'string') return null;
  try {
    const params = new URLSearchParams(body);
    const mission = params.get('mission');
    if (mission === null) return null;
    const parsed = parseInt(mission, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Install the `responseText` override on a single XHR instance. The
 * override returns the original response unless it parses as a successful
 * sendFleet JSON with a `redirectUrl`, in which case it swaps in
 * `nextUrl` (the precomputed handoff URL).
 *
 * @param {XMLHttpRequest} xhr
 * @param {PropertyDescriptor | undefined} responseTextDescriptor
 *   The prototype's original `responseText` getter, captured once.
 * @param {string} nextUrl  Absolute URL to redirect to on success.
 * @returns {void}
 */
const overrideResponseText = (xhr, responseTextDescriptor, nextUrl) => {
  /** @type {string | null} */
  let cached = null;

  Object.defineProperty(xhr, 'responseText', {
    configurable: true,
    get: function () {
      if (cached !== null) return cached;
      const raw =
        responseTextDescriptor && responseTextDescriptor.get
          ? responseTextDescriptor.get.call(this)
          : null;
      if (!raw) return raw;
      try {
        const resp = JSON.parse(raw);
        if (resp && resp.success && resp.redirectUrl) {
          resp.redirectUrl = nextUrl;
          cached = JSON.stringify(resp);
          return cached;
        }
      } catch {
        // Malformed JSON — never hide a real error; show the raw response.
      }
      return raw;
    },
  });
};

/**
 * Idempotency sentinel. Holds the unsubscribe so a second install is a
 * no-op returning the same teardown.
 *
 * @type {(() => void) | null}
 */
let unsubscribeFn = null;

/**
 * Install the deployment-redirect observer. Idempotent.
 *
 * The observer fires on `send` for any `action=sendFleet`. It bails unless
 * the mission is deployment AND a `oge_fsRedirect` handoff URL is present.
 * When both hold it CONSUMES the handoff (reads + removes it) and installs
 * the `responseText` override carrying the captured URL.
 *
 * @returns {() => void} Unsubscribe function. Idempotent.
 */
export const installDeployRedirect = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const responseTextDescriptor = Object.getOwnPropertyDescriptor(
    XMLHttpRequest.prototype,
    'responseText',
  );

  const raw = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'send',
    handler: ({ xhr, body }) => {
      const mission = getMissionFromBody(body);
      if (mission !== MISSION_DEPLOYMENT) return;
      const nextUrl = safeLS.get(DAILY_RUN_REDIRECT_KEY);
      if (!nextUrl) return;
      // Consume the handoff immediately so it can never leak to a later
      // deployment, regardless of whether this send succeeds.
      safeLS.remove(DAILY_RUN_REDIRECT_KEY);
      overrideResponseText(xhr, responseTextDescriptor, nextUrl);
    },
  });

  unsubscribeFn = () => {
    raw();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: reset the idempotency sentinel WITHOUT unsubscribing the
 * underlying observer. Paired with `_resetObserversForTest`.
 *
 * @returns {void}
 */
export const _resetDeployRedirectForTest = () => {
  unsubscribeFn = null;
};

/**
 * Test-only: expose private helpers for focused unit assertions.
 */
export const _internalsForTest = {
  getMissionFromBody,
  overrideResponseText,
  DAILY_RUN_REDIRECT_KEY,
};
