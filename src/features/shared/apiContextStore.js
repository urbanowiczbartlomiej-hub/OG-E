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
 * True once the first build attempt of this page load has finished — flipped
 * by ANY {@link setApiContext} publish, including the `null` the producer
 * sends when the build fails (offline / API hiccup). Readiness gates (the
 * colonize button) key off THIS rather than `ctx !== null` so a failed build
 * un-gates them into the scan-only fallback instead of stranding them
 * disabled. Never un-set in production (the context is rebuilt per page load).
 */
let settled = false;

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
 * subscribers so they can repaint immediately. Publishing `null` means "the
 * build finished with no data" (offline / API failure) — it clears the context
 * AND settles the hydration phase (see {@link hasApiContextSettled}), so
 * consumers fall back to live-scan-only instead of waiting forever.
 * @param {ApiContextHandoff | null} next
 * @returns {void}
 */
export const setApiContext = (next) => {
  ctx = next;
  settled = true;
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
 * Has the first build attempt of this page load finished — with data OR a
 * declared failure? `false` only in the window between page load and the
 * first {@link setApiContext} call: exactly the window where a colonize
 * candidate computed now would be spuriously empty (the breadth layer isn't
 * in yet). The colonize button's readiness gate holds until this flips.
 * @returns {boolean}
 */
export const hasApiContextSettled = () => settled;

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
 * Test-only: clear the held context, the settled flag and any subscribers.
 * @returns {void}
 */
export const _resetApiContextStoreForTest = () => {
  ctx = null;
  settled = false;
  listeners.clear();
};
