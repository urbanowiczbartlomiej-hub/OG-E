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
import { NEW_ARRIVAL_TTL_MS, NEW_ARRIVAL_MAX_MS } from '../domain/homeWatch.js';
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
 * @property {number} [dismissedAt]  LEGACY: ms of the user's last "clear NEW"
 *   click, from before the flag expired on its own. Still honoured on read so an
 *   install that had cleared its arrivals does not see them light up again; no
 *   code writes it any more.
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
 * Stamp `shownAt` on every arrival that is still NEW and has never been
 * displayed — the dashboard calls this right after painting them, which starts
 * each one's {@link NEW_ARRIVAL_TTL_MS} countdown.
 *
 * This is what replaced the old "clear NEW" button: reading the news IS the
 * acknowledgement, so nothing has to be clicked. Best-effort and idempotent —
 * a no-op (no write at all) once every open arrival carries a stamp.
 *
 * @param {string | undefined} universeId  Omitted ⇒ the current tab's universe.
 * @param {number} nowMs
 * @returns {Promise<boolean>} Whether anything was written.
 */
export const markHomeArrivalsShown = async (universeId, nowMs) => {
  const cur = await readHomeWatch(universeId);
  let touched = false;
  const arrivals = (cur.arrivals || []).map((a) => {
    if (a.shownAt != null) return a;
    if (!isArrivalNew(a, cur, nowMs)) return a;
    touched = true;
    return { ...a, shownAt: nowMs };
  });
  if (!touched) return false;
  await writeHomeWatch({ ...cur, arrivals }, universeId);
  return true;
};

/**
 * In-game shorthand for {@link markHomeArrivalsShown} on the CURRENT universe —
 * "I have seen who moved in". The Spyglass FAB's long-press calls it so a user
 * who already knows the newcomer can retire the pulse without a detour through
 * the dashboard; it writes the very same `shownAt` stamp that opening the
 * dashboard writes, so the two paths cannot disagree about what "seen" means.
 *
 * @param {number} nowMs
 * @returns {Promise<boolean>} Whether anything was written.
 */
export const markHomeArrivalsSeen = (nowMs) =>
  markHomeArrivalsShown(undefined, nowMs);

/**
 * Is this arrival still NEW at `nowMs`? Three gates, all of which must hold:
 *
 *   1. it postdates any legacy "clear NEW" click (`dismissedAt`, kept only so
 *      already-cleared arrivals on an existing install stay cleared),
 *   2. it was either never displayed, or displayed less than
 *      {@link NEW_ARRIVAL_TTL_MS} ago,
 *   3. it is younger than {@link NEW_ARRIVAL_MAX_MS} — the ceiling that stops an
 *      arrival nobody ever looked at from flagging forever.
 *
 * @param {HomeArrival} a
 * @param {HomeWatchState} state
 * @param {number} nowMs
 * @returns {boolean}
 */
const isArrivalNew = (a, state, nowMs) => {
  const at = a.atMs || 0;
  if (at <= (state.dismissedAt ?? 0)) return false;
  if (nowMs - at >= NEW_ARRIVAL_MAX_MS) return false;
  if (a.shownAt != null && nowMs - a.shownAt >= NEW_ARRIVAL_TTL_MS) return false;
  return true;
};

/**
 * Arrivals still flagged NEW (see {@link isArrivalNew}).
 *
 * @param {HomeWatchState} state
 * @param {number} nowMs
 * @returns {HomeArrival[]}
 */
export const openHomeArrivals = (state, nowMs) => (
  (state.arrivals || []).filter((a) => isArrivalNew(a, state, nowMs))
);

/**
 * Arrivals the user has NOT SEEN yet — still NEW *and* never displayed.
 *
 * The stricter twin of {@link openHomeArrivals}, and the difference is
 * deliberate: the two surfaces are answering different questions.
 *
 *   - The dashboard's Home-watch card asks "which rows are recent?", and wants
 *     the {@link NEW_ARRIVAL_TTL_MS} grace period — you read about a newcomer,
 *     come back an hour later, and the row is still marked so you can find it
 *     again. That is {@link openHomeArrivals}.
 *   - The Spyglass FAB nudge asks "is there something you have not read?". A
 *     pulsing button is a demand for attention, and once the demand is met it
 *     has to stop: keeping it lit for another day after the user opened the
 *     report turns the alert into furniture — the exact fate the arrival's own
 *     max-age ceiling was written to prevent.
 *
 * Reading the report IS the acknowledgement (the dashboard stamps `shownAt` as
 * it paints), so the nudge retires itself with no bookkeeping click. The same
 * stamp is what the FAB's long-press writes for a user who has already seen who
 * moved in and just wants the pulse gone.
 *
 * @param {HomeWatchState} state
 * @param {number} nowMs
 * @returns {HomeArrival[]}
 */
export const unreadHomeArrivals = (state, nowMs) => (
  openHomeArrivals(state, nowMs).filter((a) => a.shownAt == null)
);
