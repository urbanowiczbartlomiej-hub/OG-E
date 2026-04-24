// Generic XMLHttpRequest observer — the single point where OG-E's MAIN-world
// bridges hook into the game's network traffic.
//
// Why this module exists:
//   The game issues every navigation-driven request (galaxy fetch,
//   checkTarget, sendFleet, ...) via XMLHttpRequest. We never originate
//   game traffic ourselves (TOS-critical), so hooking XHR is how OG-E
//   "sees" what the game is doing in passive observer mode.
//
//   Each individual bridge (galaxyHook, checkTargetHook, sendFleetHook,
//   expeditionRedirect) wants to attach some logic to a URL pattern at
//   either "just before send" or "when the response lands". Patching
//   XMLHttpRequest.prototype directly from each bridge would double-wrap
//   on reload / HMR and is miserable to unwind in tests. This module
//   patches the prototype ONCE and fans out to any number of observers
//   registered via `observeXHR`.
//
// Behaviour contract:
//   - `on: 'send'`  handler runs SYNCHRONOUSLY inside the send() hook,
//                   BEFORE the native send fires. Bridges use this for
//                   pre-register work that must beat the navigation race
//                   (notably sendFleetHook's sync localStorage write —
//                   the mobile colonize-then-navigate race it guards).
//                   The handler receives the xhr, the request body, and
//                   the URL. It must NOT block long; a throw is caught
//                   and forwarded to the logger so one observer's bug
//                   never derails the game's own request.
//   - `on: 'load'`  handler runs AFTER the response arrives. Registered
//                   via `addEventListener('load', ..., { once: true })`,
//                   so the same XHR never fires the same handler twice
//                   even if game code listens to the load event itself.
//
// What this module does NOT do:
//   - Throws on ANY network traffic initiated by us. We are a strict
//     observer — the `observeXHR` callback can read the request, read
//     the response, mutate the responseText via defineProperty elsewhere,
//     but we never call `.open`/`.send` of our own.
//   - Mocks / fakes for tests. Tests under test/ use the happy-dom
//     XMLHttpRequest shim directly; this file is production code.

/** @ts-check */

import { logger } from '../lib/logger.js';

/**
 * @typedef {'send' | 'load'} ObservePhase
 * When to invoke the observer's handler relative to the game's XHR:
 *   - `'send'` — synchronously inside the patched `send()`, before native.
 *   - `'load'` — when the response has arrived (via `load` event).
 */

/**
 * @typedef {object} XHRObserverEvent
 * @property {XMLHttpRequest} xhr The live request object. Handlers may read
 *   `xhr.responseText` (on `'load'`) or stash data for later.
 * @property {string} url The URL as captured in `open()`. Never undefined —
 *   requests that reach `send()` have always been through `open()` first.
 * @property {string | null | undefined} method HTTP method from `open()`.
 *   `null`/`undefined` are theoretically possible if some exotic caller
 *   passes weird values; the observer never checks these.
 * @property {Document | XMLHttpRequestBodyInit | null | undefined} body
 *   Request body as passed to `send(body)`. `undefined` on a bodyless
 *   send, `null` when caller explicitly passes null.
 * @property {string} [response] Response text, only populated on `'load'`.
 *   Absent on `'send'`. Guaranteed to be the same string game code would
 *   see via `xhr.responseText`.
 */

/**
 * @typedef {object} XHRObserver
 * @property {RegExp} urlPattern Tested against the URL captured in `open()`.
 *   Matching is positional (`.test(url)`), not `full-match`, so a partial
 *   pattern like `/action=sendFleet/` suffices.
 * @property {ObservePhase} on When to invoke `handler`.
 * @property {(ev: XHRObserverEvent) => void} handler The observer body.
 *   Throws are caught and logged — never re-thrown — so a broken
 *   observer can never sabotage the game's own XHR pipeline.
 */

/** @type {XHRObserver[]} */
const observers = [];

/**
 * Has the prototype been patched yet? Guards against double-patching
 * under hot-reload (Firefox temporary add-ons reload the page, which
 * re-executes this module in the MAIN world; the prototype survives).
 */
let patched = false;

/**
 * Install the one-time patch on XMLHttpRequest.prototype. Idempotent —
 * guarded by the `patched` flag so a second import is a no-op.
 *
 * We capture `open`'s `method` and `url` onto the XHR instance via
 * non-enumerable symbol-like property names prefixed with `_oge_` so
 * game code is unlikely to observe them or trip over them.
 */
const installPatch = () => {
  if (patched) return;
  patched = true;

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  // open() and send() are typed with overloads in lib.dom.d.ts that make a
  // plain `(this, args) => ...` assignment fail strict-mode tsc. We cast
  // the whole replacement through `any` once — the runtime shape is
  // correct by construction and we forward the native args untouched via
  // `arguments` so every overload variant keeps working.
  /** @type {any} */ (XMLHttpRequest.prototype).open = function patchedOpen(
    /** @type {string} */ method,
    /** @type {string | URL} */ url,
  ) {
    // Attach ad-hoc metadata onto the host XHR object. Defining a
    // declaration-merge interface for two bookkeeping strings is overkill;
    // a local `any` cast keeps the typecheck happy.
    /** @type {any} */ (this)._oge_url = String(url);
    /** @type {any} */ (this)._oge_method = method;
    // Forward the full argument list (including optional async/username/
    // password) so both open() overloads pass through unchanged.
    return nativeOpen.apply(this, /** @type {any} */ (arguments));
  };

  /** @type {any} */ (XMLHttpRequest.prototype).send = function patchedSend(
    /** @type {Document | XMLHttpRequestBodyInit | null | undefined} */ body,
  ) {
    const self = /** @type {any} */ (this);
    const url = typeof self._oge_url === 'string' ? self._oge_url : '';
    const method = self._oge_method;

    // Iterate over a snapshot so an observer that registers / unregisters
    // another observer during its own handler can't mutate this loop.
    const snapshot = observers.slice();
    for (const observer of snapshot) {
      if (!observer.urlPattern.test(url)) continue;

      if (observer.on === 'send') {
        try {
          observer.handler({ xhr: this, url, method, body });
        } catch (err) {
          // Swallow-and-log: a broken observer must never derail game traffic.
          logger.error('[xhrObserver] send-phase handler threw', err, { url });
        }
      } else if (observer.on === 'load') {
        // `once: true` prevents the same observer from firing twice on
        // the same XHR if game code triggers additional load events.
        this.addEventListener(
          'load',
          () => {
            try {
              observer.handler({
                xhr: this,
                url,
                method,
                body,
                response: this.responseText,
              });
            } catch (err) {
              logger.error('[xhrObserver] load-phase handler threw', err, { url });
            }
          },
          { once: true },
        );
      }
    }

    return nativeSend.call(this, /** @type {XMLHttpRequestBodyInit | null | undefined} */ (body));
  };
};

/**
 * Register an observer. Installs the prototype patch on first call,
 * is a no-op patch-wise on subsequent calls.
 *
 * Returns an unsubscribe function. Calling it removes this observer
 * from the registry; the prototype patch stays installed (no realistic
 * benefit to tearing it down, and doing so would race with any in-flight
 * requests that haven't dispatched their load handler yet).
 *
 * @param {XHRObserver} observer
 * @returns {() => void} Unsubscribe — removes this observer from the
 *   registry. Idempotent: a second call is a no-op.
 *
 * @example
 *   // Passively observe galaxy fetches and dispatch an event.
 *   observeXHR({
 *     urlPattern: /action=fetchGalaxyContent/,
 *     on: 'load',
 *     handler: ({ response }) => {
 *       const data = JSON.parse(response ?? 'null');
 *       if (!data) return;
 *       document.dispatchEvent(new CustomEvent('oge:galaxyScanned', {
 *         detail: { ... },
 *       }));
 *     },
 *   });
 *
 *   // Pre-register a colonization in localStorage BEFORE the native send
 *   // fires — the entire point of the 'send' phase.
 *   observeXHR({
 *     urlPattern: /action=sendFleet/,
 *     on: 'send',
 *     handler: ({ body }) => {
 *       // Parse body, maybe sync-write to localStorage, maybe dispatch.
 *     },
 *   });
 */
export const observeXHR = (observer) => {
  installPatch();
  observers.push(observer);
  return () => {
    const idx = observers.indexOf(observer);
    if (idx >= 0) observers.splice(idx, 1);
  };
};

/**
 * Test-only: uninstall all observers WITHOUT reverting the prototype patch.
 * Exported primarily so unit tests don't leak observers across cases.
 * Production code has no reason to call this.
 *
 * @returns {void}
 */
export const _resetObserversForTest = () => {
  observers.length = 0;
};
