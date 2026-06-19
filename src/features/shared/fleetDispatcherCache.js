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
        const liveFd = /** @type {any} */ (window).fleetDispatcher;
        if (liveFd && typeof liveFd === 'object') {
          snapshot = /** @type {FleetDispatcherSnapshot} */ (liveFd);
        }
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
