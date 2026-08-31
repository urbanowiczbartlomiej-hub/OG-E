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
//   The preference (`oge_autoRedirectExpedition`) is OPT-OUT — the
//   default is `true`, so the feature works out of the box and users
//   who want the old behaviour flip the toggle off.
//
// Why this bridge is SPECIAL (differs from galaxyHook / checkTargetObserver):
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
//     boundary.)
//   - Redirect when no suitable target exists. If every planet has already
//     reached the per-planet expedition cap (`maxExpeditionsPerPlanet`), the
//     original `redirectUrl` (game's own choice) stays intact — the user sees
//     exactly what the game intended, no surprise.
//   - Ask the server for expedition state. We read the event ticker
//     (`#eventContent`) that is already on the page — DOM signal, no network.
//     One row per in-flight expedition, so the rows matching a planet's coords
//     ARE that planet's current tally, which we compare against the cap.
//
// # Round-robin, not fill-to-max
//
// The cap (`maxExpeditionsPerPlanet`, default 1) is honoured by COUNTING the
// in-flight expeditions, not by mere presence. So with the cap at 2 the hop
// lands on the next planet still UNDER its cap — visiting 1×A, 1×B, 1×C, then 2×A, 2×B …
// (the current planet is always skipped by position, so the wrap naturally
// spreads sends evenly) rather than draining one planet to its cap before
// moving on, or — the pre-cap bug — stopping after a single pass because every
// planet already had one expedition. At the default cap of 1 this reduces to
// the original "skip any planet that already has an expedition".
//
// # The standing skip list overrides the cap
//
// A body on `oge_expSkipCoords` is never a hop target, however empty it is.
// Without it the round-robin has no way to tell "free slot" from "planet the
// player keeps for something else": a mining colony with no fleet stays under
// the cap forever, so the hop lands there, the send is refused, and the wave
// stalls one planet short of its second pass. See `domain/expeditionSkip.js`.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';
import { safeLS } from '../lib/storage.js';
import { MISSION_EXPEDITION } from '../domain/rules.js';
import { ingameComponentUrl } from '../domain/ogameUrl.js';
import { denseCoords } from '../domain/bodies.js';
import { parseSkipCoords } from '../domain/expeditionSkip.js';
import { GAME, ACTIVE_PLANET_CLASS, ACTIVE_MOON_CLASS } from '../lib/gameDom.js';

/**
 * localStorage key for the user preference. OPT-OUT: default is `true`,
 * users who don't want auto-redirect flip the Settings toggle to `false`.
 *
 * @type {string}
 */
const ENABLED_KEY = 'oge_autoRedirectExpedition';

/**
 * Read the user preference. Missing key → `true` (opt-out default).
 * See {@link ENABLED_KEY} for the rationale.
 *
 * @returns {boolean}
 */
const isEnabled = () => safeLS.bool(ENABLED_KEY, true);

/**
 * localStorage key for the per-planet expedition cap. Owned by the settings
 * store (`state/settings.js`, field `maxExpeditionsPerPlanet`); mirrored here
 * as a bare string for the SAME reason as {@link ENABLED_KEY} — this is a
 * MAIN-world bridge and must not drag in the isolated-world `state/` store.
 * localStorage is per-origin, so this reads the value for the current server.
 *
 * @type {string}
 */
const MAX_PER_PLANET_KEY = 'oge_maxExpeditionsPerPlanet';

/**
 * Read the per-planet expedition cap. Missing / non-positive → 1 (the
 * settings default), so the redirect never treats a planet as having
 * unlimited room.
 *
 * @returns {number}
 */
const readMaxExpeditionsPerPlanet = () => {
  const raw = safeLS.int(MAX_PER_PLANET_KEY, 1);
  return raw > 0 ? raw : 1;
};

/**
 * localStorage key for the standing expedition skip list — bodies the wave
 * must never visit. Owned by the settings store (`state/settings.js`, field
 * `expSkipCoords`) and mirrored here as a bare string for the same reason as
 * {@link MAX_PER_PLANET_KEY}: a MAIN-world bridge cannot import `state/`.
 *
 * @type {string}
 */
const SKIP_COORDS_KEY = 'oge_expSkipCoords';

/**
 * The player's skip list as a set of dense `g:s:p` coords. Missing key → empty
 * set (nothing excluded — the behaviour before the setting existed).
 *
 * @returns {Set<string>}
 */
const readSkipCoords = () => parseSkipCoords(safeLS.get(SKIP_COORDS_KEY));

/**
 * Count a body's in-flight expeditions off the event ticker — the same tally
 * `features/sendExpedition/domHelpers.js` computes for the button's own gate,
 * so the hop and the button can never disagree about which planet has room.
 *
 * Counted as ONE RETURN ROW PER EXPEDITION: the game writes both legs of a
 * two-way mission at dispatch, the outbound row vanishes on arrival at the
 * expedition point, and the return row survives the whole round trip — so it is
 * the one row present exactly once per in-flight expedition. Origin is
 * direction-stable (always the launcher). See
 * `features/sendExpedition/domHelpers.js` (`countActiveExpeditions`) for the
 * full account and the two wrong models it replaced; the rule is duplicated
 * rather than imported because a MAIN-world bridge may not import `features/`.
 *
 * Reading the ticker (rather than a planet-row badge) is what makes the cap
 * work at all: the previous source was `.ogi-exp-dots`, a badge OG-E does not
 * render — that is OGame Infinity's. Without that extension installed the count
 * was always 0, every planet looked empty, and the hop walked to whatever body
 * came next in list order no matter how many expeditions it already held.
 *
 * DOM-only, no network, no `state/` import — the bridge stays MAIN-world clean.
 *
 * @param {string | null} coords  Body coords in `g:s:p` form; `null` → 0.
 * @returns {number}
 */
const countBodyExpeditions = (coords) => {
  if (!coords) return 0;
  const rows = document.querySelectorAll(
    `${GAME.EVENT_CONTENT} tr.eventFleet[data-mission-type="${MISSION_EXPEDITION}"]`
      + '[data-return-flight="true"]',
  );
  let count = 0;
  for (const row of rows) {
    const from = denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    if (from === coords) count += 1;
  }
  return count;
};

/**
 * A planet row's own coordinates, read from its `.planet-koords` cell (the
 * game's own misspelling — see `lib/gameDom.js`), normalised to `g:s:p`.
 *
 * @param {Element} planet  A `#planetList .smallplanet` element.
 * @returns {string | null}
 */
const planetRowCoords = (planet) =>
  denseCoords(planet.querySelector(GAME.PLANET_KOORDS)?.textContent) || null;

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
 * Find the cp of the next body in `#planetList` order that is still UNDER
 * the per-planet expedition cap (`maxExpeditionsPerPlanet`).
 *
 * "Next" is defined as: the first row after the currently highlighted one
 * whose in-flight expedition count (its rows in the event ticker) is
 * below the cap, wrapping around to the start of the list if necessary.
 * On planet pages the active row carries `.hightlightPlanet`; on MOON
 * pages the game swaps it for `.hightlightMoon` (both are the game's own
 * misspellings) — we recognise both, so a moon-launched expedition hops
 * too. Always walking forward from the active row and skipping it is what
 * makes the loop ROUND-ROBIN: each pass tops every body up by one before
 * any body receives its next expedition. At the default cap of 1 this is
 * exactly "the first body that has no expedition yet".
 *
 * The hop stays on the KIND of body the expedition left from (read off the
 * `ogame-planet-type` meta of the page that sent it): a planet-launched
 * expedition lands on the next planet (the row's `planet-<n>` id), a
 * moon-launched one on the next MOON (the row's moonlink `cp`; rows
 * without a moon are skipped).
 *
 * The event ticker the count comes from is the game's own, already rendered on
 * the page. Using the DOM as the source of truth keeps this bridge decoupled
 * from the storage layer: we don't import from state/ in MAIN, and we don't
 * need to.
 *
 * Returns `null` when:
 *   - There are fewer than 2 planets (nowhere to redirect to — all
 *     dispatch loops are single-planet accounts that don't benefit from
 *     this feature anyway).
 *   - The currently active row can't be found (edge case; the game
 *     always marks exactly one row highlighted, but a race between
 *     our observer and the DOM rebuild could theoretically hit it).
 *   - Every other candidate has already reached the cap — i.e. the user
 *     has saturated their expedition budget and there's genuinely no next
 *     target (in moon mode also: no other row has a moon).
 *
 * @returns {string | null} The cp id as a string (what the game's URL
 *   param format expects), or `null` when no suitable target exists.
 */
const findNextPlanetWithFreeSlot = () => {
  const max = readMaxExpeditionsPerPlanet();
  const skipped = readSkipCoords();
  const planets = /** @type {HTMLElement[]} */ (
    [...document.querySelectorAll(GAME.SMALL_PLANET)]
  );
  if (planets.length < 2) return null;

  // This runs while the sendFleet response is being read — the page is
  // still the ORIGIN's fleetdispatch, so its meta names the body the
  // expedition just left from.
  const fromMoon =
    document.querySelector(GAME.META_PLANET_TYPE)?.getAttribute('content') ===
    'moon';
  const currentIdx = planets.findIndex(
    (el) =>
      el.classList.contains(ACTIVE_PLANET_CLASS) ||
      el.classList.contains(ACTIVE_MOON_CLASS),
  );
  if (currentIdx === -1) return null;

  // Wrap-around scan: we skip offset 0 (that's the current body, which
  // just finished sending an expedition — the ticker hasn't caught up yet,
  // and we don't want to immediately bounce back to it) and walk forward,
  // wrapping to the start when we fall off the end. The first candidate
  // still under the cap wins.
  for (let i = 1; i < planets.length; i++) {
    const planet = planets[(currentIdx + i) % planets.length];
    const coords = planetRowCoords(planet);
    // Standing exclusion beats the cap: a body on the skip list is never a
    // hop target no matter how empty it is. Same filter the button's own walk
    // applies (`features/sendExpedition/domHelpers.js`), so the post-send hop
    // and the button can never disagree about where the wave goes next.
    if (coords !== null && skipped.has(coords)) continue;
    if (countBodyExpeditions(coords) >= max) continue;
    if (fromMoon) {
      const href = planet.querySelector(GAME.MOON_LINK)?.getAttribute('href');
      if (!href) continue; // no moon at this slot → not a candidate
      try {
        const cpId = new URL(href, location.href).searchParams.get('cp');
        if (cpId) return cpId;
      } catch {
        // Malformed href — skip the row rather than abort the walk.
      }
    } else {
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
 *   {@link findNextPlanetWithFreeSlot}).
 * @returns {string} An absolute URL suitable for `location.href = ...`.
 */
const buildRedirectUrl = (cpId) =>
  ingameComponentUrl(location.href, 'fleetdispatch', { cp: cpId });

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
 *   - If `findNextPlanetWithFreeSlot` returns null → return raw
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
          const nextCp = findNextPlanetWithFreeSlot();
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
 * Mirrors the pattern in galaxyHook / checkTargetObserver.
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
 * tests that drive `installExpeditionRedirect`.
 *
 * Production code has no reason to reach for these.
 */
export const _internalsForTest = {
  isEnabled,
  getMissionFromBody,
  findNextPlanetWithFreeSlot,
  buildRedirectUrl,
  overrideResponseText,
  ENABLED_KEY,
  MAX_PER_PLANET_KEY,
  SKIP_COORDS_KEY,
};
