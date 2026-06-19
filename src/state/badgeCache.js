// Planet-marker optimistic cache — the last successfully-rendered status
// markers, persisted so the badges can paint INSTANTLY on the next page load,
// before the event-list XHR (the source we compute everything from) has landed.
// The live render then replaces this stale paint as soon as the real data
// arrives.
//
// This is the badges feature's OWN render output, not shared state — but it
// still lives here (not written from the feature via raw `safeLS`) so all
// persistence stays in `state/`, matching `state/dailyActions.js`. Plain
// key-owner, per-origin localStorage = per-universe.
//
// We store only the ordered category ids per body — the optimistic paint needs
// nothing else (no counts, no per-fleet detail); the popover detail is
// re-derived live.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON cache envelope. */
export const BADGE_CACHE_KEY = 'oge-badge-cache';

/** Bumped when the cached shape changes, so a stale envelope is dropped. */
const CACHE_VERSION = 2;

/**
 * Read the cached per-body markers. Keyed by
 * {@link import('../features/badges/pure.js').bodyKey} → ordered category ids
 * (already priority-sorted and capped at render time).
 *
 * @returns {Record<string, string[]> | null} The map, or null when absent /
 *   unreadable / a stale schema version.
 */
export const readBadgeCache = () => {
  const env = safeLS.json(BADGE_CACHE_KEY, null);
  if (!env || typeof env !== 'object') return null;
  const e = /** @type {{ version?: number, bodies?: unknown }} */ (env);
  if (e.version !== CACHE_VERSION || !e.bodies || typeof e.bodies !== 'object') return null;
  return /** @type {Record<string, string[]>} */ (e.bodies);
};

/**
 * Persist the per-body category ids for the next reload's optimistic paint.
 *
 * @param {Record<string, string[]>} bodies
 * @returns {void}
 */
export const writeBadgeCache = (bodies) => {
  safeLS.setJSON(BADGE_CACHE_KEY, { version: CACHE_VERSION, bodies });
};

/** Drop the cache (the event list is loaded and genuinely has no activity). */
export const clearBadgeCache = () => {
  safeLS.remove(BADGE_CACHE_KEY);
};
