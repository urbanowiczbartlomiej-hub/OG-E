// MAIN-world bridge that observes the game's `action=sendFleet` XHR to
// catch colonization dispatches (mission=7) and republish them on the
// ISOLATED-world boundary as `oge5:colonizeSent` CustomEvents.
//
// Why two phases (send + load):
//   `send` fires synchronously, before the game's native XHR send. That
//   is where we pre-register the colonization in localStorage — the
//   4.8.5 mobile-race fix hinges on this write completing in the same
//   JS tick as the navigation that follows the response. A post-response
//   chrome.storage.set would lose the entry on mobile Firefox when the
//   game's redirect beats our async callback. `safeLS.setJSON` is fully
//   synchronous, so the registry update is visible before any navigation
//   can start — see state/registry.js for the full rationale.
//
//   `load` fires after the response lands. That is where we decide
//   whether the send actually succeeded (response.success === true) and
//   whether to fire the ISOLATED-world event. We cannot collapse this
//   into the `send` phase because the response is what tells us the
//   game accepted the fleet — firing on `send` would report phantom
//   sends when the server rejects.
//
// Why a WeakMap of per-XHR context:
//   Between `send` and `load` we need to remember the coords / sentAt /
//   arrivalAt that were valid AT SEND TIME. Reading them again in the
//   load handler is unsafe: the game may have rewritten the form DOM
//   and the URL query string by then (the response typically navigates).
//   Stashing context on a WeakMap keyed by the XHR instance survives
//   until the XHR is GC'd — no cleanup bookkeeping needed on our side.
//
// Strict observer, zero initiation:
//   We never call `.open` / `.send` ourselves. We never mutate the
//   response. The ONLY side-effects are (a) a SYNC localStorage write
//   (gated on colonize + parseable arrivalAt), and (b) a CustomEvent
//   dispatch on `document` when the response confirms success.
//
// Why NOT import state/registry (the reactive store):
//   MAIN-world code has no chrome.* access and must not pull in the
//   store layer's persist machinery. We write localStorage by hand via
//   `safeLS.setJSON`, using the pure `pruneRegistry` / `dedupeEntry`
//   helpers from `domain/registry`. The store in the ISOLATED world
//   will pick up the change on the next hydrate. Only the key string
//   (REGISTRY_KEY) is imported from state/registry — a bare string
//   constant with no side effects.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';
import { safeLS } from '../lib/storage.js';
import { pruneRegistry, dedupeEntry } from '../domain/registry.js';
import { MISSION_COLONIZE } from '../domain/rules.js';
import { REGISTRY_KEY } from '../state/registry.js';

/**
 * @typedef {import('../domain/registry.js').RegistryEntry} RegistryEntry
 */

/**
 * @typedef {object} ColonizeSentDetail
 * @property {number} galaxy Target galaxy from the fleetdispatch URL.
 * @property {number} system Target system from the fleetdispatch URL.
 * @property {number} position Target position from the URL, or `0`
 *   defensively when the URL did not carry a position query param.
 * @property {number} sentAt Wall-clock ms (`Date.now()`) captured
 *   synchronously in the `send` phase, before the native XHR fires.
 * @property {number} arrivalAt `sentAt + duration*1000` if the
 *   `#durationOneWay` DOM element was parseable at send time, else `0`.
 *   Consumers that need the landing timestamp must guard against `0`
 *   explicitly.
 */

/**
 * Per-XHR carry-over from the `send` phase to the `load` phase. Keyed
 * on the XHR instance itself so garbage collection of the XHR drops
 * the context entry automatically — no explicit cleanup required.
 *
 * @type {WeakMap<XMLHttpRequest, {
 *   galaxy: number,
 *   system: number,
 *   position: number,
 *   sentAt: number,
 *   arrivalAt: number,
 * }>}
 */
const contextByXhr = new WeakMap();

/**
 * Parse `#durationOneWay`'s textContent into seconds.
 *
 * The game renders this element as `H:MM:SS` (3 parts) for sub-day
 * flights or `D:H:MM:SS` (4 parts) for longer ones — e.g. `01:50:48`
 * = 6648s. Any other shape, empty text, or NaN in any chunk returns
 * `0`. Caller treats `0` as "duration unknown" and skips the registry
 * write. Must be called AT TIME OF SEND — the game may overwrite the
 * DOM after receiving the sendFleet response.
 *
 * @param {Element | null} el The `#durationOneWay` element, or null.
 * @returns {number} Duration in seconds, or `0` if unparseable.
 */
const parseDurationSeconds = (el) => {
  if (!el) return 0;
  const text = el.textContent ? el.textContent.trim() : '';
  if (!text) return 0;
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  return 0;
};

/**
 * Pull the `mission` field out of a URL-encoded request body.
 *
 * `URLSearchParams` does the percent-decoding + `+` → space handling
 * for free, and fails gracefully on malformed input (the constructor
 * does not throw on anything the game realistically sends). A
 * non-string body (null, undefined, Blob, ...) returns `null`:
 * the game always sends colonize XHRs as urlencoded strings, but
 * defensive typing keeps us safe if the call shape ever changes.
 *
 * @param {Document | XMLHttpRequestBodyInit | null | undefined} body
 * @returns {number | null} Parsed integer mission id, or `null` when
 *   the body isn't a string or the field is missing / non-numeric.
 */
const getMissionFromBody = (body) => {
  if (typeof body !== 'string') return null;
  try {
    const params = new URLSearchParams(body);
    const raw = params.get('mission');
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/**
 * Read galaxy / system / position from the current `location.search`.
 *
 * The fleetdispatch URL always carries the target coords in the query
 * string because the user navigated there via our Send-Col link (or
 * via the game's own galaxy-row actions, which use the same shape).
 * Values default to `NaN` when missing; callers range-check `galaxy`
 * and `system` before trusting the result. `position` is allowed to
 * be missing → consumer falls back to `0`.
 *
 * @returns {{ galaxy: number, system: number, position: number }}
 */
const getTargetCoords = () => {
  const params = new URLSearchParams(location.search);
  const galaxy = parseInt(params.get('galaxy') || '', 10);
  const system = parseInt(params.get('system') || '', 10);
  const position = parseInt(params.get('position') || '', 10);
  return { galaxy, system, position };
};

/**
 * Idempotency sentinel. Holds the composite unsubscribe returned by
 * the first `installSendFleetHook` call; second and later calls
 * return this same reference without stacking a second pair of
 * observers on the prototype.
 *
 * @type {(() => void) | null}
 */
let unsubscribeFn = null;

/**
 * Register the colonize-send observer on the shared `xhrObserver`.
 * Call this once, from the MAIN-world entry point (`src/page.js`).
 *
 * Two observers are registered in one go:
 *   - `send` phase — synchronously pre-registers the colonization in
 *     localStorage (mobile-race guard) and stashes context on a
 *     WeakMap for the load phase to pick up.
 *   - `load` phase — on success, dispatches `oge5:colonizeSent` on
 *     `document` with the coords + sentAt + arrivalAt captured at
 *     send time.
 *
 * Idempotent: a second call returns the same composite unsubscribe
 * without registering a second pair. The unsubscribe tears both
 * observers down together and clears the sentinel so a subsequent
 * `installSendFleetHook` wires up fresh.
 *
 * @returns {() => void} Composite unsubscribe — removes BOTH observers
 *   from `xhrObserver`'s registry.
 */
export const installSendFleetHook = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const unsubSend = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'send',
    handler: ({ xhr, body }) => {
      const mission = getMissionFromBody(body);
      if (mission !== MISSION_COLONIZE) return;

      // Capture timing + form state AT TIME OF SEND. The game can
      // mutate `#durationOneWay` and the URL after the response
      // arrives, so we freeze everything here and carry it to load.
      const sentAt = Date.now();
      const durSec = parseDurationSeconds(document.getElementById('durationOneWay'));
      const arrivalAt = durSec > 0 ? sentAt + durSec * 1000 : 0;

      const { galaxy, system, position } = getTargetCoords();
      // Without valid galaxy + system we cannot identify the target.
      // Registry write is meaningless; load-phase dispatch is skipped
      // too (the WeakMap stays empty, so the load handler bails).
      if (!galaxy || !system) return;

      const safePosition = position || 0;
      contextByXhr.set(xhr, { galaxy, system, position: safePosition, sentAt, arrivalAt });

      // SYNC write — mobile race mitigation, see module header and
      // state/registry.js for the 4.8.5 rationale. Gated on
      // `arrivalAt > 0` because an entry without a landing time
      // cannot participate in min-gap checks and would just be
      // pruned on the next read.
      if (arrivalAt > 0) {
        const current = safeLS.json(REGISTRY_KEY, []);
        /** @type {RegistryEntry[]} */
        const reg = Array.isArray(current) ? /** @type {RegistryEntry[]} */ (current) : [];
        const pruned = pruneRegistry(reg, Date.now());
        const coords = /** @type {`${number}:${number}:${number}`} */ (
          `${galaxy}:${system}:${safePosition}`
        );
        const next = dedupeEntry(pruned, { coords, sentAt, arrivalAt });
        safeLS.setJSON(REGISTRY_KEY, next);
      }
    },
  });

  const unsubLoad = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'load',
    handler: ({ xhr, response }) => {
      // No context means either (a) this wasn't a colonize send, or
      // (b) it was but getTargetCoords returned no galaxy/system.
      // Either way there's nothing to dispatch.
      const ctx = contextByXhr.get(xhr);
      if (!ctx) return;
      if (!response) return;

      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch {
        // Malformed JSON — the server rejected the send or some
        // proxy mangled it. No event; localStorage entry is already
        // written and will expire naturally on pruneRegistry.
        return;
      }
      if (!parsed || !parsed.success) return;

      /** @type {ColonizeSentDetail} */
      const detail = {
        galaxy: ctx.galaxy,
        system: ctx.system,
        position: ctx.position,
        sentAt: ctx.sentAt,
        arrivalAt: ctx.arrivalAt,
      };
      document.dispatchEvent(new CustomEvent('oge5:colonizeSent', { detail }));
    },
  });

  // Wrap the underlying unsubscribes so our sentinel clears on teardown.
  // Without this, a subsequent install would early-return the stale
  // (now-no-op) function and never re-register.
  unsubscribeFn = () => {
    unsubSend();
    unsubLoad();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: clear the idempotency sentinel WITHOUT running the
 * underlying unsubscribes. Paired with `_resetObserversForTest` from
 * `xhrObserver.js` so each case starts from a clean module state.
 *
 * Production code has no reason to call this.
 *
 * @returns {void}
 */
export const _resetSendFleetHookForTest = () => {
  unsubscribeFn = null;
};
