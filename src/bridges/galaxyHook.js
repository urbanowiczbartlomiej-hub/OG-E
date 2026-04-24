// Galaxy-scan bridge: passive observer over the game's `fetchGalaxyContent`
// XHR. Every time the user navigates the galaxy view the game fires this
// request and renders the 15-slot table from the response; we latch onto
// the same response, classify each slot through `domain/scans.js`, and
// broadcast a single `oge:galaxyScanned` CustomEvent carrying the whole
// system snapshot.
//
// Why a bridge (MAIN world) and not a feature (ISOLATED world):
//   The XHR prototype only exists in the page's world. Patching it from
//   an isolated content script is impossible — our patched `open`/`send`
//   would never run for requests originated by game code. So this module
//   lives in the page bundle (src/page.js), alongside the shared
//   `xhrObserver` plumbing, and the event we dispatch is the handoff
//   boundary back to the isolated world's state layer.
//
// Strict observer, zero initiation:
//   We never call `.open` / `.send` ourselves. We never mutate the
//   response. We never inject UI. The module's ONLY side-effects are
//   (a) registering one `observeXHR` subscription and (b) dispatching a
//   CustomEvent on `document`. If the observer throws, `xhrObserver`
//   swallows it — we can't derail the game's own pipeline.
//
// Why NOT depend on state/scans or chrome.storage from here:
//   MAIN-world code has no chrome.* access, and the bridge is a pure
//   producer. The isolated world's `state/scans` subscribes to our
//   `oge:galaxyScanned` event and handles persistence from there.

/** @ts-check */

import { observeXHR } from './xhrObserver.js';
import { classifyPosition } from '../domain/scans.js';

/**
 * Mission-id the game uses for colonize sends. Duplicated from
 * `domain/rules.js` by value so this file stays self-contained on the
 * one constant it reads; we avoid a tree of `rules.js` imports in every
 * bridge. If the number ever changes, both places must be updated —
 * caught immediately by the tests that exercise `derivesCanColonize`.
 */
const MISSION_COLONIZE = 7;

/**
 * @typedef {object} GalaxyScannedDetail
 * @property {number} galaxy
 *   Galaxy id echoed back from `data.system.galaxy`. Never range-checked
 *   here — the game is the authority on what's valid.
 * @property {number} system
 *   System id echoed back from `data.system.system`.
 * @property {number} scannedAt
 *   Wall-clock ms (`Date.now()`) captured at dispatch time. Stamped on
 *   the bridge side because consumers in the isolated world want the
 *   time the OBSERVATION happened, not the time their handler ran.
 * @property {Record<number, import('../domain/scans.js').Position>} positions
 *   Keys are position numbers 1..15. Values produced by
 *   {@link classifyPosition}. Positions outside 1..15 (shouldn't exist
 *   in a well-formed response, but we guard anyway) are silently dropped.
 * @property {boolean} canColonize
 *   Does the currently-active planet hold at least one colonizer right
 *   now? Consumed by the Send-Col UI label. See
 *   {@link derivesCanColonize} for the fallback when the response's
 *   top-level flag is absent.
 */

/**
 * Reads our own player id from `window.playerId`, the field OGame sets
 * on every game page. Used by {@link classifyPosition} to promote slots
 * we own to the `mine` status rather than classifying them as generic
 * `occupied`. Returns `null` when the field is unavailable — on those
 * pages every slot falls through the usual status ladder.
 *
 * We wrap in try/catch defensively: some sandboxed contexts forbid
 * touching arbitrary globals, and a plain `ReferenceError` here would
 * be swallowed by `xhrObserver`'s catch but leak into the log at
 * ERROR severity. Returning null keeps the log quiet.
 *
 * @returns {number | null}
 */
const getOwnPlayerId = () => {
  try {
    if (typeof /** @type {any} */ (window).playerId !== 'undefined') {
      return /** @type {number} */ (/** @type {any} */ (window).playerId);
    }
  } catch {
    /* fall through */
  }
  return null;
};

/**
 * Fallback for `canColonize` when the game's top-level flag is absent.
 *
 * The game includes `availableMissions` on every slot in `galaxyContent`.
 * For empty / placeholder slots (player id 99999 is the "unoccupied"
 * sentinel), the colonize-mission entry carries a real link only when
 * the current planet has a colonizer on-hand; when no ship is available
 * the link is set to `"#"` (or the entry is omitted). We sample the
 * first candidate slot and read that link state.
 *
 * Occupied slots are skipped because the game never attaches a
 * colonize-mission entry to them (no sense colonizing an inhabited
 * slot). Iterating until we find a candidate rather than looking at
 * `content[0]` is a nicety — the game's ordering is position 1..15 and
 * position 1 may well be inhabited.
 *
 * @param {Array<{
 *   player?: { playerId?: number },
 *   planets?: unknown[],
 *   availableMissions?: Array<{ missionType?: number, link?: string }>,
 * }>} galaxyContent The raw `data.system.galaxyContent` array.
 * @returns {boolean} true iff the active planet has a colonizer available.
 */
const derivesCanColonize = (galaxyContent) => {
  for (const pos of galaxyContent) {
    // "Placeholder player" entries: the game sometimes returns a full
    // player block with id 99999 for empty slots. Treat those as empty
    // for sampling purposes.
    const isPlayerEmpty = !!(pos.player && pos.player.playerId === 99999);
    const hasPlanets = !!(pos.planets && pos.planets.length > 0);
    if (!isPlayerEmpty && hasPlanets) continue;
    const colMission = (pos.availableMissions || []).find(
      (m) => m.missionType === MISSION_COLONIZE,
    );
    if (colMission) return Boolean(colMission.link && colMission.link !== '#');
  }
  return false;
};

/**
 * Drive the whole classification pass over one parsed `fetchGalaxyContent`
 * response and return the `detail`-shaped subset (minus `scannedAt`,
 * which the caller stamps). Returns `null` when the payload doesn't
 * look like a galaxy-content response — safer than throwing out of a
 * JSON-parsed branch where the caller's expectation is "fire if valid".
 *
 * @param {any} data Parsed JSON from the game's XHR response.
 * @returns {Omit<GalaxyScannedDetail, 'scannedAt'> | null}
 */
const analyzeResponse = (data) => {
  if (!data || !data.system || !data.system.galaxyContent) return null;

  const galaxy = /** @type {number} */ (data.system.galaxy);
  const system = /** @type {number} */ (data.system.system);
  const content = /** @type {any[]} */ (data.system.galaxyContent);
  const ownPlayerId = getOwnPlayerId();

  /** @type {Record<number, import('../domain/scans.js').Position>} */
  const positions = {};
  for (const entry of content) {
    const pos = entry.position;
    // Drop malformed entries silently. The game is the source of truth
    // for what's in the array, but a defensive guard here prevents a
    // single bad record from blowing up `classifyPosition`.
    if (typeof pos !== 'number' || pos < 1 || pos > 15) continue;
    positions[pos] = classifyPosition(entry, ownPlayerId);
  }

  // `canColonize` on the response is the authoritative field when the
  // game includes it; newer universes sometimes omit it, and the
  // availableMissions fallback covers those. `undefined` (not `false`)
  // is the signal to fall back — the game explicitly writes `false`
  // when the planet is ship-less but the field is still included.
  const canColonize =
    data.system.canColonize !== undefined
      ? Boolean(data.system.canColonize)
      : derivesCanColonize(content);

  return { galaxy, system, positions, canColonize };
};

/**
 * Idempotency sentinel for {@link installGalaxyHook}. Holds the
 * unsubscribe returned by `observeXHR` on the first install so the
 * second install can hand back the same one instead of stacking a
 * second observer on the prototype.
 *
 * @type {(() => void) | null}
 */
let unsubscribeFn = null;

/**
 * Register the galaxy-scan observer on the shared `xhrObserver`. Call
 * this once, from the MAIN-world entry point (`src/page.js`). Returns
 * an unsubscribe for test teardown / hypothetical hot-reload paths;
 * production code keeps the subscription alive for the tab's lifetime.
 *
 * Idempotent: calling this twice doesn't register a second observer.
 * The second call hands back the SAME unsubscribe the first call
 * returned, so either caller's teardown removes the (one) subscription.
 *
 * @returns {() => void} Unsubscribe — removes the observer from
 *   `xhrObserver`'s registry. After calling, a fresh `installGalaxyHook`
 *   will register a brand new observer.
 */
export const installGalaxyHook = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const raw = observeXHR({
    urlPattern: /action=fetchGalaxyContent/,
    on: 'load',
    handler: ({ response }) => {
      if (!response) return;
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch {
        // Malformed JSON — either the game changed the response shape or
        // some proxy mangled the payload. Either way this is not our
        // problem to surface: stay silent and let the next scan retry.
        return;
      }
      const analysis = analyzeResponse(parsed);
      if (!analysis) return;
      document.dispatchEvent(
        new CustomEvent('oge:galaxyScanned', {
          detail: {
            ...analysis,
            scannedAt: Date.now(),
          },
        }),
      );
    },
  });

  // Wrap the real unsubscribe so our idempotency sentinel clears when
  // the caller tears down. Without this wrap, a subsequent
  // `installGalaxyHook()` after an unsubscribe would early-return the
  // stale (now-no-op) function and never re-register.
  unsubscribeFn = () => {
    raw();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: clear the idempotency sentinel WITHOUT unsubscribing the
 * underlying observer. Paired with `_resetObserversForTest` from
 * `xhrObserver.js` so each test case starts fresh.
 *
 * Production code has no reason to call this.
 *
 * @returns {void}
 */
export const _resetGalaxyHookForTest = () => {
  unsubscribeFn = null;
};
