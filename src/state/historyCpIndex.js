// @ts-check

// Colony-history cp INDEX — the small key the in-game content script reads
// instead of the whole histogram dataset.
//
// Plain `read*/write*` key-owner over `chrome.storage.local` — the sanctioned
// exception documented in CLAUDE.md (cf. `state/apiCache.js`,
// `state/ownProfile.js`): the one reader is `features/colonyRecorder.js`,
// which pulls it on demand once per page-load, and nothing subscribes to it.
// A reactive store would be pure overhead.
//
// # What it holds, and why it is not the source of truth
//
// The run-length encoding of every cp-id present in `state/history.js`, in
// the flat (delta, length) form defined by `domain/cpRanges.js`. Measured on
// a real 1474-observation universe: 1 413 B here versus 131 000 B for the
// history rows — and the gap widens as the history grows, because the cps are
// near-consecutive (see `domain/cpRanges.js` for the numbers).
//
// The recorder used to answer "already recorded?" by hydrating the full
// history array on every page-load, in every frame, purely to build a Set of
// its cps. This key exists so the steady-state page-load never touches the
// big key at all.
//
// It is a DERIVED CACHE, always rebuildable from the history array, and it is
// allowed to lag behind it. Two writers add cps without going through here —
// the dashboard's import/merge (`features/dashboard/io.js`) and the gist
// download (`sync/scheduler.js`) — and both are union merges, so the index
// can only ever end up missing cps, never claiming extra ones. That is the
// safe direction (`domain/cpRanges.js` documents why), and the recorder's
// slow path rewrites this key from the real array whenever it lands there,
// so the lag self-heals on the next fresh colony.
//
// LOCAL ONLY — never enters the gist. It is derivable from data that already
// syncs, so shipping it would be redundant bytes and a second thing to merge.

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * Suffix portion of the chrome.storage.local key holding the index. The key
 * actually written is `<universeId>:<HISTORY_CP_INDEX_KEY_BASE>` — see
 * {@link historyCpIndexKeyFor}. Namespaced per universe for the same reason
 * the history itself is: cp-ids are unique per server, not across servers.
 */
export const HISTORY_CP_INDEX_KEY_BASE = 'oge_colonyHistoryCpIdx';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 * Exported for the same reason `historyKeyFor` is: callers on the extension
 * origin (the dashboard) have no `location.host` to derive it from.
 *
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string} e.g. `'s163-pl:oge_colonyHistoryCpIdx'`.
 */
export const historyCpIndexKeyFor = (universeId) =>
  `${universeId}:${HISTORY_CP_INDEX_KEY_BASE}`;

/**
 * Read the index for the current tab's universe.
 *
 * Returns `[]` for a missing, non-array or otherwise unusable payload —
 * "nothing is indexed yet", which makes every membership test answer `false`
 * and sends the caller down the slow path that rebuilds the key. That is the
 * under-report direction, i.e. the one that cannot lose an observation.
 *
 * @returns {Promise<number[]>} Flat (delta, length) pairs; `[]` when absent.
 */
export const readHistoryCpIndex = async () => {
  const key = currentUniverseKey(HISTORY_CP_INDEX_KEY_BASE, historyCpIndexKeyFor);
  const raw = await chromeStore.get(key);
  return Array.isArray(raw) ? /** @type {number[]} */ (raw) : [];
};

/**
 * Overwrite the index for the current tab's universe.
 *
 * Always a full replace, never a merge: the caller has the complete cp set in
 * hand (it just read the history array to get there), so re-deriving is both
 * simpler and self-healing — it silently absorbs cps that an import or a gist
 * download added behind the index's back.
 *
 * @param {number[]} flat  Output of `encodeCpRanges`.
 * @returns {Promise<void>}
 */
export const writeHistoryCpIndex = (flat) => {
  const key = currentUniverseKey(HISTORY_CP_INDEX_KEY_BASE, historyCpIndexKeyFor);
  return chromeStore.set(key, flat);
};
