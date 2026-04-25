// @ts-check

// MAIN-world bridge — publish snapshots of `window.fleetDispatcher` to
// the isolated world via `document.dispatchEvent('oge:fleetDispatcher')`.
//
// # Why this exists
//
// Content scripts in the ISOLATED world (Chrome MV3) cannot read
// JavaScript globals that the page created — `window.fleetDispatcher` is
// `undefined` from `content.js`'s perspective, even though the game
// populated it. Firefox Xray may allow limited reads through
// `window.wrappedJSObject`, but relying on that is fragile and not
// portable to Chrome. The only robust path is a MAIN-world script that
// reads the global, serialises the fields we need, and emits them as an
// event — which bubbles through shared `document` to every isolated
// listener.
//
// # When we publish
//
//   1. On initial load, once DOMContentLoaded has fired (so game JS has
//      had a chance to populate `fleetDispatcher`).
//   2. After every `action=checkTarget` XHR response — the game updates
//      `fleetDispatcher.orders`, `targetPlanet`, `targetInhabited`, etc.
//      right before its own `load` handler returns; we re-publish one
//      microtask later to capture that freshly-updated state.
//
// # What's in the snapshot
//
// A trimmed projection — only the fields the colonize flow reads:
//   - `currentPlanet { galaxy, system, position }` | null
//   - `targetPlanet  { galaxy, system, position }` | null
//   - `orders` — per-mission availability map (e.g. `orders['7']` is
//     `true` when colonize is a valid mission for the current target)
//   - `shipsOnPlanet` — array of `{ id, number }` (filtered to what the
//     user has on the active planet)
//   - `expeditionCount` / `maxExpeditionCount` — read by sendExp's
//     `isGlobalExpeditionCapReached` / `…AfterNextSend` helpers (in
//     `features/sendExp/pure.js`) to bail before any DOM walk when the
//     game reports every expedition slot in use (14/14), and to skip
//     the per-planet hop when the pending send would tip us over the
//     cap (13/14).
//
// Not published: fleet helper config, planet list, cargo settings, loca
// strings, API data blobs, fleet templates. These are accessible via
// the snapshot on MAIN side if ever needed, but the isolated consumers
// (sendCol, sendExp) only need the fields above.
//
// @see ./checkTargetHook.js — emits `oge:checkTargetResult`; this
//   module emits a sibling event with complementary data.
// @see ../features/sendCol/index.js — primary consumer of the snapshot.
// @see ../features/sendExp/index.js — second consumer; reads the
//   expedition cap fields via pure.js helpers.

import { observeXHR } from './xhrObserver.js';

/**
 * @typedef {object} FleetDispatcherSnapshot
 * @property {{ galaxy: number, system: number, position: number } | null} currentPlanet
 * @property {{ galaxy: number, system: number, position: number } | null} targetPlanet
 * @property {Record<string, boolean> | null} orders
 * @property {Array<{ id: number, number: number }>} shipsOnPlanet
 * @property {number} expeditionCount
 * @property {number} maxExpeditionCount
 */

/**
 * Read the current `window.fleetDispatcher` and project it into the
 * canonical snapshot shape. Returns `null` when the global isn't there
 * yet (game JS hasn't run, we're on a non-fleetdispatch page, …).
 *
 * Defensive type coercion on every field so a page-side shape change
 * doesn't blow up the isolated consumer.
 *
 * @returns {FleetDispatcherSnapshot | null}
 */
const readSnapshot = () => {
  const fd = /** @type {any} */ (window).fleetDispatcher;
  if (!fd) return null;

  /** @param {unknown} p */
  const readCoords = (p) => {
    if (!p || typeof p !== 'object') return null;
    const o = /** @type {any} */ (p);
    const g = Number(o.galaxy);
    const s = Number(o.system);
    const pos = Number(o.position);
    if (!Number.isFinite(g) || !Number.isFinite(s) || !Number.isFinite(pos)) {
      return null;
    }
    return { galaxy: g, system: s, position: pos };
  };

  /** @type {Array<{ id: number, number: number }>} */
  const ships = [];
  if (Array.isArray(fd.shipsOnPlanet)) {
    for (const s of fd.shipsOnPlanet) {
      if (!s || typeof s !== 'object') continue;
      const id = Number(s.id);
      const num = Number(s.number);
      if (Number.isFinite(id) && Number.isFinite(num)) {
        ships.push({ id, number: num });
      }
    }
  }

  /** @type {Record<string, boolean> | null} */
  let orders = null;
  if (fd.orders && typeof fd.orders === 'object' && !Array.isArray(fd.orders)) {
    orders = {};
    for (const k of Object.keys(fd.orders)) {
      orders[k] = Boolean(fd.orders[k]);
    }
  }

  return {
    currentPlanet: readCoords(fd.currentPlanet),
    targetPlanet: readCoords(fd.targetPlanet),
    orders,
    shipsOnPlanet: ships,
    expeditionCount: Number(fd.expeditionCount) || 0,
    maxExpeditionCount: Number(fd.maxExpeditionCount) || 0,
  };
};

/**
 * Read + publish the snapshot if `fleetDispatcher` is present. No-op
 * otherwise (non-fleetdispatch pages).
 *
 * @returns {void}
 */
const publish = () => {
  const snap = readSnapshot();
  if (!snap) return;
  document.dispatchEvent(
    new CustomEvent('oge:fleetDispatcher', { detail: snap }),
  );
};

/**
 * Module-scope install handle. Idempotent — a second call returns the
 * same unsubscribe without double-registering.
 *
 * @type {(() => void) | null}
 */
let installed = null;

/**
 * Install the snapshot publisher. Idempotent.
 *
 * Lifecycle:
 *   1. Initial publish — either immediately (if DOM already loaded) on
 *      the next microtask so any still-running game init finishes, or
 *      on DOMContentLoaded.
 *   2. `observeXHR` on `action=checkTarget` load events, one microtask
 *      deferred so the game's own response handler has updated
 *      `fleetDispatcher` before we read it.
 *
 * @returns {() => void} Unsubscribe — removes the XHR observer and
 *   marks us as uninstalled. Pending microtasks are NOT cancelled; any
 *   already-scheduled initial publish will still fire once before
 *   becoming a no-op in `publish()` (which checks for fleetDispatcher).
 */
export const installFleetDispatcherSnapshot = () => {
  if (installed) return installed;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', publish, { once: true });
  } else {
    // Defer to a microtask so any synchronous game init still in
    // flight at module load finishes first.
    Promise.resolve().then(publish);
  }

  const unsub = observeXHR({
    urlPattern: /action=checkTarget/,
    on: 'load',
    handler: () => {
      // Game's own XHR load handler updates fleetDispatcher right
      // before returning; we re-publish one microtask later.
      Promise.resolve().then(publish);
    },
  });

  installed = () => {
    unsub();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset for the module-level install handle.
 *
 * @returns {void}
 */
export const _resetFleetDispatcherSnapshotForTest = () => {
  if (installed) installed();
  installed = null;
};
