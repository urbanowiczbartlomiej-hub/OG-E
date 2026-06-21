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

/**
 * The slice of `features/apiContext`'s built context the picker reads. Typed
 * with domain types only (no feature→feature type coupling): the occupancy
 * index plus the server grid bounds (`server.galaxies` / `.systems`) the
 * whole-universe free-slot count needs. The producer may attach more fields
 * (military, builtAt, …) — they're simply not part of this read contract.
 *
 * @typedef {{ index: OccupancyIndex, server?: ServerData }} ApiContextHandoff
 */

/** @type {ApiContextHandoff | null} */
let ctx = null;

/**
 * Publish the latest built context (called by `features/apiContext`).
 * @param {ApiContextHandoff | null} next
 * @returns {void}
 */
export const setApiContext = (next) => {
  ctx = next;
};

/**
 * Read the latest built context, or `null` if none has been built yet (the
 * picker then falls back to live-scan-only — today's behaviour).
 * @returns {ApiContextHandoff | null}
 */
export const getApiContext = () => ctx;

/**
 * Test-only: clear the held context.
 * @returns {void}
 */
export const _resetApiContextStoreForTest = () => {
  ctx = null;
};
