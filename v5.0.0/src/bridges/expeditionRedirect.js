// MAIN-world bridge that rewrites the `redirectUrl` field on the game's
// sendFleet response for expedition missions, so the page navigates
// directly to the next planet without an active expedition.
//
// Why this module exists:
//   Players who run expeditions on multiple planets click "Send Expedition"
//   on planet A, wait for the page to reload, then have to manually click
//   planet B in the planetList, open fleetdispatch again, pick targets,
//   and click "Send" again. With dozens of planets that's a lot of clicks.
//   This bridge rewrites the `redirectUrl` in the sendFleet response so
//   the browser — which is about to set `location.href = redirectUrl`
//   anyway — lands on the next planet that doesn't yet have an expedition
//   in flight. Nothing else changes: it's still ONE dispatch, ONE reload,
//   ZERO new requests from us.
//
//   The preference (`oge5_autoRedirectExpedition`) is OPT-OUT — the
//   default is `true`, so the feature works out of the box and users who
//   want the old behaviour flip the toggle off. This matches v4's
//   default (see fleet-redirect.js) so we don't surprise returning users.
//
// Why this bridge is SPECIAL (differs from galaxyHook / checkTargetHook):
//   Other bridges are strict observers — they read the response, dispatch
//   a CustomEvent, and never touch what the game sees. This one is a
//   response REWRITER: we override `xhr.responseText` via
//   `Object.defineProperty(xhr, ...)` so the game's own reader gets our
//   modified JSON, not the network's. This is still zero-traffic (we
//   don't originate a request, we only transform the response the game
//   itself triggered), but it's an active transform, not a passive read.
//
// Why Object.defineProperty on the INSTANCE, not the prototype:
//   xhrObserver already patches `XMLHttpRequest.prototype.open/send`.
//   If we also patched the prototype's `responseText` getter we'd have
//   a second layer of global state to tear down in tests, and every XHR
//   in the whole application would route through our getter — wasteful
//   and easy to break. Defining the property on the single XHR instance
//   we care about (the sendFleet for mission=15, via the xhrObserver
//   'send' phase) is scoped to exactly one request, gets garbage-collected
//   with the xhr, and needs no teardown beyond unsubscribing the observer.
//
// What this module does NOT do:
//   - Originate any request. Zero network traffic from us, ever. We only
//     rewrite what the game is already reading. (This is the TOS-critical
//     boundary, see DESIGN.md §3.)
//   - Redirect when no suitable target exists. If all the user's planets
//     already have expeditions in flight, the original `redirectUrl`
//     (game's own choice) stays intact — the user sees exactly what the
//     game intended, no surprise.
//   - Detect expedition state itself. We rely on the `.ogi-exp-dots`
//     badge that the isolated-world UI layer renders next to planets
//     with active expeditions — DOM signal, no network.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';
import { safeLS } from '../lib/storage.js';
import { MISSION_EXPEDITION } from '../domain/rules.js';

/**
 * localStorage key for the user preference. OPT-OUT: default is `true`,
 * users who don't want auto-redirect flip the Settings toggle to `false`.
 *
 * @type {string}
 */
const ENABLED_KEY = 'oge5_autoRedirectExpedition';

/**
 * Read the user preference. Missing key → `true` (opt-out default).
 * See {@link ENABLED_KEY} for the rationale.
 *
 * @returns {boolean}
 */
const isEnabled = () => safeLS.bool(ENABLED_KEY, true);

/**
 * Extract the `mission` field from a form-encoded sendFleet body.
 *
 * Returns `null` when:
 *   - `body` is not a string (e.g. FormData, null, undefined — the game
 *     always sends a string but `XMLHttpRequest#send` accepts other
 *     types so we guard).
 *   - `URLSearchParams` can't parse the body (never happens with real
 *     game traffic, but the try/catch keeps us robust against future
 *     surprises).
 *   - The `mission` key is absent from the body.
 *
 * We `parseInt` the value because the game sends it as a decimal string
 * (`"15"`) but our constants are plain numbers (`MISSION_EXPEDITION === 15`)
 * — comparing the parsed int against the constant keeps both sides in
 * the same numeric domain.
 *
 * @param {unknown} body The body exactly as passed to `xhr.send(body)`.
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
 * Find the cp (planet id) of the next planet in `#planetList` order that
 * doesn't currently have an active expedition in flight.
 *
 * "Next" is defined as: the first planet after the currently highlighted
 * one (the `.hightlightPlanet` — yes, the game's CSS class is spelled
 * that way) that lacks a `.ogi-exp-dots` badge, wrapping around to the
 * start of the list if necessary.
 *
 * The `.ogi-exp-dots` badge is rendered by the isolated-world UI layer
 * (`state/expeditionStatus` or equivalent — see the v4 wiring in the
 * content-script) next to every planet with an expedition in flight.
 * Using the DOM as the source of truth keeps this bridge decoupled from
 * the storage layer: we don't import from state/ in MAIN, and we don't
 * need to.
 *
 * Returns `null` when:
 *   - There are fewer than 2 planets (nowhere to redirect to — all
 *     dispatch loops are single-planet accounts that don't benefit from
 *     this feature anyway).
 *   - The currently active planet can't be found (edge case; the game
 *     always marks exactly one planet highlighted, but a race between
 *     our observer and the DOM rebuild could theoretically hit it).
 *   - Every other planet already has a `.ogi-exp-dots` badge — i.e. the
 *     user has saturated their expedition slots across all planets and
 *     there's genuinely no next target.
 *
 * @returns {string | null} The cp id as a string (what the game's URL
 *   param format expects), or `null` when no suitable target exists.
 */
const findNextPlanetWithoutExpedition = () => {
  const planets = /** @type {HTMLElement[]} */ (
    [...document.querySelectorAll('#planetList .smallplanet')]
  );
  if (planets.length < 2) return null;

  const currentIdx = planets.findIndex((el) => el.classList.contains('hightlightPlanet'));
  if (currentIdx === -1) return null;

  // Wrap-around scan: we skip offset 0 (that's the current planet, which
  // just finished sending an expedition so it definitely has — or is
  // about to have — the dots badge) and walk forward, wrapping to the
  // start when we fall off the end.
  for (let i = 1; i < planets.length; i++) {
    const planet = planets[(currentIdx + i) % planets.length];
    if (!planet.querySelector('.ogi-exp-dots')) {
      const cpId = planet.id.replace('planet-', '');
      if (cpId) return cpId;
    }
  }
  return null;
};

/**
 * Build a fleetdispatch URL targeting the given cp (planet id).
 *
 * Strips any existing query string off the current location and rebuilds
 * from scratch so we don't inherit state (e.g. a stale `position=` that
 * would send the next expedition to the wrong coords). The result is
 * always `<origin+path>?page=ingame&component=fleetdispatch&cp=<cpId>`.
 *
 * Kept as a plain string concat (rather than going through `URL` /
 * `URLSearchParams`) because the game's URL format is stable and we
 * want exactly these three params in exactly this order — the player's
 * browser navigation cache keys on URL strings, so canonical ordering
 * helps reuse.
 *
 * @param {string} cpId The target planet id (output of
 *   {@link findNextPlanetWithoutExpedition}).
 * @returns {string} An absolute URL suitable for `location.href = ...`.
 */
const buildRedirectUrl = (cpId) =>
  location.href.split('?')[0] + '?page=ingame&component=fleetdispatch&cp=' + cpId;

/**
 * Install the `responseText` override on a single XHR instance. Called
 * from the xhrObserver 'send' phase handler once we've confirmed the
 * request is an expedition sendFleet AND the user preference is on.
 *
 * The override uses a closure-cached rewritten string: the game typically
 * reads `responseText` at least twice (once to check `success`, once to
 * extract `redirectUrl`), and each call would otherwise re-parse the raw
 * JSON, re-walk the planetList, and re-stringify. Caching turns that
 * into a one-shot transform.
 *
 * Fallback behaviour:
 *   - If the raw response isn't valid JSON → return raw (game handles
 *     its own error path).
 *   - If `resp.success` is falsy or there's no `redirectUrl` → return
 *     raw (failed dispatch; we have nothing to rewrite and shouldn't
 *     navigate anyway).
 *   - If `findNextPlanetWithoutExpedition` returns null → return raw
 *     (no suitable target; game's own redirect stays in effect).
 *
 * Any of these fallbacks keeps the cache unset, so a subsequent read
 * re-tries the transform — harmless because the underlying descriptor
 * is stable once the response has arrived. Only a successful rewrite
 * locks in the cache.
 *
 * @param {XMLHttpRequest} xhr
 * @param {PropertyDescriptor | undefined} responseTextDescriptor The
 *   prototype's original `responseText` getter, captured once at module
 *   load time. Used via `.get.call(this)` so the override can read what
 *   the game would have seen without our interception.
 * @returns {void}
 */
const overrideResponseText = (xhr, responseTextDescriptor) => {
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
          const nextCp = findNextPlanetWithoutExpedition();
          if (nextCp) {
            resp.redirectUrl = buildRedirectUrl(nextCp);
            cached = JSON.stringify(resp);
            return cached;
          }
        }
      } catch {
        // Malformed JSON — let the game see the raw response and handle
        // its own error path. We never want to hide a real error.
      }
      return raw;
    },
  });
};

/**
 * Idempotency sentinel. Holds the unsubscribe returned by `observeXHR`
 * so a second install call is a no-op that hands back the same teardown.
 * Mirrors the pattern in galaxyHook / checkTargetHook.
 *
 * @type {(() => void) | null}
 */
let unsubscribeFn = null;

/**
 * Install the expedition-redirect observer. Idempotent — a second call
 * returns the same unsubscribe without registering a second observer.
 *
 * The observer:
 *   1. Fires on `send` for any URL containing `action=sendFleet`.
 *   2. Bails silently if the user preference is off.
 *   3. Parses the form body; bails if the mission isn't expedition.
 *   4. Overrides `responseText` on the xhr INSTANCE (not the prototype)
 *      so the game's subsequent read sees a rewritten `redirectUrl`
 *      pointing at the next planet without an active expedition.
 *
 * Unsubscribe semantics: calling the returned function detaches the
 * send-phase observer — future sendFleet calls won't get the override.
 * XHRs that were ALREADY patched (i.e. requests currently in flight at
 * the moment of unsubscribe) keep their overridden `responseText` getter
 * because we put it on the instance, not the prototype. Those in-flight
 * requests will still behave correctly when the response arrives.
 *
 * @returns {() => void} Unsubscribe function. Idempotent.
 */
export const installExpeditionRedirect = () => {
  if (unsubscribeFn) return unsubscribeFn;

  // Capture the prototype's native `responseText` getter ONCE, at install
  // time. We'd rather not re-resolve this every send because nothing in
  // the application should be mutating XMLHttpRequest.prototype beyond
  // what xhrObserver / we do ourselves, and xhrObserver doesn't touch
  // responseText.
  const responseTextDescriptor = Object.getOwnPropertyDescriptor(
    XMLHttpRequest.prototype,
    'responseText',
  );

  const raw = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'send',
    handler: ({ xhr, body }) => {
      if (!isEnabled()) return;
      const mission = getMissionFromBody(body);
      if (mission !== MISSION_EXPEDITION) return;
      overrideResponseText(xhr, responseTextDescriptor);
    },
  });

  // Wrap the underlying unsubscribe so our idempotency sentinel clears
  // cleanly on teardown; without this, a re-install after unsub would
  // hand back the stale no-op fn without registering a new observer.
  unsubscribeFn = () => {
    raw();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: reset the idempotency sentinel WITHOUT unsubscribing the
 * underlying observer. Paired with `_resetObserversForTest` from
 * `xhrObserver.js` so each test case starts fresh.
 *
 * Production code has no reason to call this.
 *
 * @returns {void}
 */
export const _resetExpeditionRedirectForTest = () => {
  unsubscribeFn = null;
};

/**
 * Test-only: expose the private helpers so unit tests can exercise
 * each building block in isolation (purer assertions, smaller failure
 * surface) without needing to stand up a full XHR round-trip for every
 * case. The integration path is still covered by the higher-level
 * smoke tests that drive `installExpeditionRedirect`.
 *
 * Production code has no reason to reach for these.
 */
export const _internalsForTest = {
  isEnabled,
  getMissionFromBody,
  findNextPlanetWithoutExpedition,
  buildRedirectUrl,
  overrideResponseText,
  ENABLED_KEY,
};
