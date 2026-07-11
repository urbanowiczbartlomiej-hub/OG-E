// @ts-check

// Shared in-memory handoff for the built API occupancy context.
//
// `features/apiContext` builds the per-universe occupancy index from the local
// API cache; `features/sendColony` (the colonize picker) needs to read it. A
// direct feature→feature import is forbidden by the architecture (ESLint
// cross-feature zones), and `features/shared` is the sanctioned crossing point
// for exactly this. The context is rebuilt each page load — this module just
// holds the latest build so the picker can read it synchronously between
// async refreshes. It is NOT persisted (the index is a Map; the durable cache
// is `state/apiCache.js`).

/** @typedef {import('../../domain/apiOccupancy.js').OccupancyIndex} OccupancyIndex */
/** @typedef {import('../../domain/apiOccupancy.js').ServerData} ServerData */
/** @typedef {import('../../domain/apiOccupancy.js').ApiPlanet} ApiPlanet */

/**
 * The slice of `features/apiContext`'s built context its consumers read. Typed
 * with domain types only (no feature→feature type coupling): the occupancy
 * index, the server grid bounds (`server.galaxies` / `.systems`) the
 * whole-universe free-slot count needs, the raw planet rows the scan FAB maps
 * watched players over, and the danger profiles the scan planner ranks by
 * (built via `domain/dangerJoin.js`, identical to the dashboard's). The
 * producer may attach more fields (military, builtAt, …) — they're simply not
 * part of this read contract.
 *
 * @typedef {{
 *   index: OccupancyIndex,
 *   server?: ServerData,
 *   universePlanets?: ApiPlanet[],
 *   danger?: Map<number, import('../../domain/dangerScore.js').DangerProfile>,
 *   players?: Record<string, import('../../domain/apiOccupancy.js').ApiPlayerMeta>,
 *   ownId?: string | number | null,
 * }} ApiContextHandoff
 */

/** @type {ApiContextHandoff | null} */
let ctx = null;

/**
 * Listeners fired on every {@link setApiContext} publish. Kept minimal (no
 * value payload — subscribers re-read {@link getApiContext}) because the point
 * is only to let a consumer react the instant the handoff lands, instead of
 * polling. A throwing listener must never wedge the handoff for the others.
 * @type {Set<() => void>}
 */
const listeners = new Set();

/**
 * Publish the latest built context (called by `features/apiContext`) and notify
 * subscribers so they can repaint immediately.
 * @param {ApiContextHandoff | null} next
 * @returns {void}
 */
export const setApiContext = (next) => {
  ctx = next;
  for (const fn of listeners) {
    try { fn(); } catch { /* one bad listener must not block the rest */ }
  }
};

/**
 * Read the latest built context, or `null` if none has been built yet (the
 * picker then falls back to live-scan-only — today's behaviour).
 * @returns {ApiContextHandoff | null}
 */
export const getApiContext = () => ctx;

/**
 * Subscribe to context publishes — fires on EVERY {@link setApiContext} call
 * (including forced rebuilds), never retroactively for an already-set context
 * (read {@link getApiContext} for the current value). Returns an unsubscribe.
 * @param {() => void} fn
 * @returns {() => void}
 */
export const subscribeApiContext = (fn) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/**
 * Test-only: clear the held context and any subscribers.
 * @returns {void}
 */
export const _resetApiContextStoreForTest = () => {
  ctx = null;
  listeners.clear();
};
