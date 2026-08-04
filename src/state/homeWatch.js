// Home-watch key-owner — what our own neighbourhood looked like last time we
// browsed it, plus the arrivals we haven't shown the user yet.
//
// Two parties, two origins: the in-game feature (`features/homeWatch`) writes it
// whenever a fresh galaxy sighting of one of OUR systems lands, and the
// dashboard's Spyglass reads it to paint the "Home watch" card. That is exactly
// the `state/ownProfile.js` situation — nothing SUBSCRIBES to it, so it is a
// plain `read*/write*` key-owner over `chrome.storage` rather than a
// `createStore` + `persist` reactive store (the sanctioned exception documented
// in CLAUDE.md).
//
// Not gist-synced: the baseline is a per-device memory of what THIS device last
// saw. Two devices browsing different systems at different times would each
// hand the other a "newer" baseline for systems it never looked at, and every
// arrival the other device had already recorded would be silently swallowed.
// The alert is cheap to re-derive locally; a lost alert is not.
//
// Per-universe key (`<universeId>:oge_homeWatch`).
//
// @ts-check

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * @typedef {import('../domain/homeWatch.js').HomeBaselineEntry} HomeBaselineEntry
 * @typedef {import('../domain/homeWatch.js').HomeArrival} HomeArrival
 */

/**
 * @typedef {object} HomeWatchState
 * @property {Record<string, HomeBaselineEntry>} baseline  "g:s" → occupants as
 *   of the last sighting.
 * @property {HomeArrival[]} arrivals  Newest-first log of strangers who showed
 *   up in one of our systems (see domain/homeWatch.mergeHomeArrivals).
 * @property {number} [dismissedAt]  ms of the user's last "I've seen these"
 *   click in the dashboard. Arrivals older than it stop counting as NEW; the
 *   rows stay (the neighbour is still there — only the alarm is silenced).
 */

/** Suffix of the per-universe chrome.storage.local key. */
export const HOME_WATCH_KEY_BASE = 'oge_homeWatch';

/**
 * @param {string} universeId
 * @returns {string}
 */
export const homeWatchKeyFor = (universeId) => `${universeId}:${HOME_WATCH_KEY_BASE}`;

/** The empty value every read falls back to. @returns {HomeWatchState} */
export const emptyHomeWatch = () => ({ baseline: {}, arrivals: [] });

/**
 * Read the state for a universe (the dashboard passes the selected one; the
 * in-game caller omits it and gets the current tab's). Never throws — a missing
 * or malformed blob reads as empty.
 *
 * @param {string} [universeId]
 * @returns {Promise<HomeWatchState>}
 */
export const readHomeWatch = async (universeId) => {
  const key = universeId
    ? homeWatchKeyFor(universeId)
    : currentUniverseKey(HOME_WATCH_KEY_BASE, homeWatchKeyFor);
  const raw = await chromeStore.get(key);
  if (!raw || typeof raw !== 'object') return emptyHomeWatch();
  const o = /** @type {any} */ (raw);
  return {
    baseline: o.baseline && typeof o.baseline === 'object' ? o.baseline : {},
    arrivals: Array.isArray(o.arrivals) ? o.arrivals : [],
    ...(typeof o.dismissedAt === 'number' ? { dismissedAt: o.dismissedAt } : {}),
  };
};

/**
 * Write the state for the CURRENT universe (in-game side) or a named one.
 * Best-effort.
 *
 * @param {HomeWatchState} state
 * @param {string} [universeId]
 * @returns {Promise<void>}
 */
export const writeHomeWatch = (state, universeId) => {
  const key = universeId
    ? homeWatchKeyFor(universeId)
    : currentUniverseKey(HOME_WATCH_KEY_BASE, homeWatchKeyFor);
  return chromeStore.set(key, state);
};

/**
 * Silence the current alerts without deleting them (see `dismissedAt`).
 *
 * @param {string} universeId
 * @param {number} nowMs
 * @returns {Promise<void>}
 */
export const dismissHomeArrivals = async (universeId, nowMs) => {
  const cur = await readHomeWatch(universeId);
  await writeHomeWatch({ ...cur, dismissedAt: nowMs }, universeId);
};

/**
 * Arrivals the user hasn't acknowledged yet.
 *
 * @param {HomeWatchState} state
 * @returns {HomeArrival[]}
 */
export const openHomeArrivals = (state) => {
  const since = state.dismissedAt ?? 0;
  return (state.arrivals || []).filter((a) => (a.atMs || 0) > since);
};
