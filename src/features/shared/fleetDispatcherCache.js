// features/shared/fleetDispatcherCache.js
//
// A per-feature cache of the MAIN-world `window.fleetDispatcher` snapshot,
// shared by the send* features that gate on global fleet/expedition caps
// (sendExpedition, sendColony). The snapshot can't be read directly from a
// Chrome MV3 isolated content script, so the MAIN-world bridge
// (`bridges/fleetDispatcherSnapshot.js`) republishes it via the
// `oge:fleetDispatcher` CustomEvent; this caches the latest payload and
// seeds synchronously from a live `fleetDispatcher` when one IS readable
// (Firefox Xray, or tests assigning `window.fleetDispatcher` directly).
//
// Each feature owns its own instance: call `bootstrap()` before the first
// mount, `attach()` alongside the feature's other listeners, and `detach()`
// + `reset()` from its dispose / test reset.

import { FLEET_DISPATCHER_EVENT } from '../../lib/ogeEvents.js';

/**
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 */

/** @param {unknown} p @returns {{ galaxy: number, system: number, position: number } | null} */
const readCoords = (p) => {
  if (!p || typeof p !== 'object') return null;
  const o = /** @type {any} */ (p);
  const g = Number(o.galaxy);
  const s = Number(o.system);
  const pos = Number(o.position);
  if (!Number.isFinite(g) || !Number.isFinite(s) || !Number.isFinite(pos)) return null;
  return { galaxy: g, system: s, position: pos };
};

/**
 * Normalize a live `window.fleetDispatcher`-shaped object into the canonical
 * {@link FleetDispatcherSnapshot}, or `null` when `fd` is absent / not an
 * object. Mirrors `bridges/fleetDispatcherSnapshot.readSnapshot`'s coercion so
 * a directly-read seed (this cache's `bootstrap`, the fleet courier) and the
 * event-delivered snapshot agree by construction rather than by parallel
 * hand-rolled copies — and returns a fresh COPY, decoupling cached reads from
 * later mutation of the live object. Pure: reads only the passed object.
 *
 * @param {unknown} fd
 * @returns {FleetDispatcherSnapshot | null}
 */
export const seedFromLiveFd = (fd) => {
  if (!fd || typeof fd !== 'object') return null;
  const o = /** @type {any} */ (fd);
  /** @type {Array<{ id: number, number: number }>} */
  const ships = [];
  if (Array.isArray(o.shipsOnPlanet)) {
    for (const s of o.shipsOnPlanet) {
      if (!s || typeof s !== 'object') continue;
      const id = Number(s.id);
      const num = Number(s.number);
      if (Number.isFinite(id) && Number.isFinite(num)) ships.push({ id, number: num });
    }
  }
  /** @type {Record<string, boolean> | null} */
  let orders = null;
  if (o.orders && typeof o.orders === 'object' && !Array.isArray(o.orders)) {
    orders = {};
    for (const k of Object.keys(o.orders)) orders[k] = Boolean(o.orders[k]);
  }
  return {
    currentPlanet: readCoords(o.currentPlanet),
    targetPlanet: readCoords(o.targetPlanet),
    orders,
    shipsOnPlanet: ships,
    expeditionCount: Number(o.expeditionCount) || 0,
    maxExpeditionCount: Number(o.maxExpeditionCount) || 0,
    fleetCount: Number(o.fleetCount) || 0,
    maxFleetCount: Number(o.maxFleetCount) || 0,
  };
};

/**
 * Build a fleetDispatcher-snapshot cache.
 *
 * @param {{ onUpdate?: () => void }} [cfg]  `onUpdate` fires after each
 *   fresh snapshot lands — sendColony repaints here; sendExpedition omits
 *   it (it reads the snapshot lazily on click).
 * @returns {{
 *   get: () => FleetDispatcherSnapshot | null,
 *   bootstrap: () => void,
 *   attach: () => void,
 *   detach: () => void,
 *   reset: () => void,
 * }}
 */
export const createFleetDispatcherCache = ({ onUpdate } = {}) => {
  /** @type {FleetDispatcherSnapshot | null} */
  let snapshot = null;

  const onEvent = (/** @type {Event} */ e) => {
    const detail = /** @type {CustomEvent} */ (e).detail;
    if (!detail || typeof detail !== 'object') return;
    snapshot = /** @type {FleetDispatcherSnapshot} */ (detail);
    onUpdate?.();
  };

  return {
    get: () => snapshot,
    /**
     * Seed from a live `window.fleetDispatcher` if one is readable right
     * now. No-op once a snapshot has already been cached. Call BEFORE the
     * first mount so the initial paint sees the right phase.
     */
    bootstrap: () => {
      if (!snapshot) {
        const seed = seedFromLiveFd(/** @type {any} */ (window).fleetDispatcher);
        if (seed) snapshot = seed;
      }
    },
    attach: () => document.addEventListener(FLEET_DISPATCHER_EVENT, onEvent),
    detach: () =>
      document.removeEventListener(FLEET_DISPATCHER_EVENT, onEvent),
    reset: () => {
      snapshot = null;
    },
  };
};
