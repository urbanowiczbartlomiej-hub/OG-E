// Colony recorder — passive histogram-dataset collection.
//
// # What it does
//
// On every ingame page-load the recorder scans `#planetList` and appends a
// {@link ColonyEntry}-shaped row to {@link historyStore} for every planet
// that has nothing built on it yet (`used === 0`) and is not already in
// history. Deduplication is by `cp` — a planet we have recorded once is
// never recorded again.
//
// # Why the planet LIST and not the overview panel
//
// The recorder used to read `#diameterContentField` on
// `component=overview`, which exposes `(used/max)` for the ACTIVE planet
// only. That made an observation conditional on the user personally
// visiting each fresh colony's overview while it was still empty — and
// silently lost the datum otherwise, because the `used === 0` gate below
// closes the moment the first building is queued. Colonizing two or three
// slots in one go made that likely rather than rare: each colony needed
// its own overview visit, and whichever one got built on first was gone.
//
// OGame renders the sidebar server-side on every ingame page, and each
// planet's `data-tooltip-title` carries the same `(used/max)` pair as the
// overview panel. So one read of any page sees the whole account. The
// window in which an observation can be lost shrinks from "visit this
// colony's overview before building on it" to "load any OGame page before
// building on it".
//
// # Why the `used === 0` gate STAYS
//
// A planet's `max` is NOT fixed for its lifetime: the Terraformer raises
// it, and a sufficiently developed lifeform tree raises it too. Reading
// `max` off a developed planet therefore yields a Terraformer-inflated
// number, not the planet's natural field count — feeding those into the
// histogram would bias the whole distribution toward the large end and
// make the estimate useless. `used === 0` is the proxy for "nothing has
// been built, so nothing can have raised `max` yet", which is exactly the
// pristine value we want.
//
// The gate is not perfect: a player can buy extra fields with antimatter
// (instant, two clicks) or reach an LF field bonus with a very deliberate
// build order that lays down no field-occupying building at all. Both are
// rare and deliberately out of scope — the first is a shop purchase, the
// second costs an hour of intentionally suboptimal play on one planet.
//
// # Why we do NOT prune abandoned colonies
//
// This is documented at length in `src/state/history.js`: the histogram is
// meant to estimate the real shape of OGame's `fields` distribution, which
// means every observation counts, including planets the player later
// abandoned. If we only kept "current" colonies the small-fields bucket
// would look artificially empty — small planets get abandoned fast —
// biasing every downstream statistic toward the large end. The recorder
// therefore only ever appends; removal lives in a separate user-driven
// tombstone path and is not this module's concern.
//
// # Why a single attempt (with retry) per install
//
// The content script runs the install once on boot. OGame reloads the whole
// page on every navigation, so a new process runs for each visit. We do not
// listen for SPA nav or mutations — one install per page-load is both
// simpler and exactly right for the trigger we want. The `waitFor` retry
// exists only because the sidebar can still be hydrating when `content.js`
// fires; once the rows are present (or 5s has elapsed), the recorder is done.
//
// # Why the first attempt is gated on `whenHistoryHydrated`
//
// `historyStore` hydrates asynchronously from `chrome.storage.local`.
// If `tryCollect` ran before that landed, the dedup-by-cp check would
// read an empty store (regardless of what storage actually held),
// pass, and append to `[]`. The write-through would save `[newC]`.
// Then the async hydrate would resolve with `[oldA, oldB, ...]` and
// `store.set(stored)` would wipe `newC` from the store — and the
// write-through fires again, saving `[oldA, oldB, ...]` back to
// storage. Net result: the just-observed colony vanishes.
//
// The race was nearly invisible on Chrome desktop (storage usually
// settles before `DOMContentLoaded`) but reliably reproduced on
// Firefox, especially Android — heavier storage IPC means
// `DOMContentLoaded` wins more often. Awaiting `whenHistoryHydrated()`
// makes the dedup read see the real persisted history and removes the
// race entirely. See `state/history.js` for the lifecycle of the
// hydrated promise.
//
// @see ../state/history.js — the store this feature writes into, and the
//   canonical explanation of the "keep every observation" invariant.
// @see ./shared/planetRows.js — the sidebar projection this feature reads.

/** @ts-check */

import { historyStore, whenHistoryHydrated } from '../state/history.js';
import {
  colonizeDecisionsStore,
  flushColonizeDecisionsStore,
  whenColonizeDecisionsHydrated,
} from '../state/colonizeDecisions.js';
import { withDecision, DEC_MINE } from '../domain/colonizeDecisions.js';
import { readPlanetRows } from './shared/planetRows.js';
import { waitFor } from '../lib/dom.js';
import { GAME } from '../lib/gameDom.js';

/**
 * Single collection attempt. Returns the number of entries appended to
 * {@link historyStore} — `0` when the sidebar is absent or not yet
 * hydrated, when no planet is fresh, or when every fresh planet is already
 * recorded.
 *
 * Every fresh planet found is appended in ONE `historyStore.update` call.
 * That matters for the multi-colony case this function exists to fix: three
 * separate `update`s would mean three write-throughs, and (worse) three
 * chances for a concurrent tab's write to land in between and clobber the
 * partial result.
 *
 * All branches that append nothing return without any side effect, which is
 * what lets `installColonyRecorder` call this twice (sync + post-waitFor)
 * without double-recording.
 *
 * @returns {Promise<number>}
 */
const tryCollect = async () => {
  const rows = readPlanetRows();
  if (rows.length === 0) return 0;

  // Fresh planets only — see the module header on why this gate must stay.
  const fresh = rows.filter((r) => r.used === 0);
  if (fresh.length === 0) return 0;

  // Dedup by cp: OGame's cp-ids are globally unique and monotonically
  // increasing, so a matching cp means we already have this observation.
  const known = new Set(historyStore.get().map((h) => h.cp));
  const novel = fresh.filter((r) => !known.has(r.cp));
  if (novel.length === 0) return 0;

  const timestamp = Date.now();
  historyStore.update((prev) => [
    ...prev,
    ...novel.map((r) => ({
      cp: r.cp,
      fields: r.max,
      coords: r.coords,
      position: r.position,
      timestamp,
    })),
  ]);

  // These fresh colonies are OURS — record a `mine` decision carrying each
  // field count (`f`), the one datum the public API can never provide. It
  // blocks the picker from re-proposing the slot in the lag window before
  // universe.xml lists it, tells a second device "ours", and carries the
  // histogram value into the synced log. flush so it survives any immediate
  // reload.
  //
  // colonizeDecisionsStore hydrates independently of historyStore, with no
  // ordering guarantee between the two — writing here before THIS store's own
  // hydrate resolves would get silently wiped when the hydrate's stored map
  // overwrites it moments later. Same race class documented at the top of this
  // file for historyStore; see state/targets.js for the sibling fix.
  await whenColonizeDecisionsHydrated();
  colonizeDecisionsStore.update((prev) =>
    novel.reduce((acc, r) => {
      const ck = /** @type {`${number}:${number}:${number}`} */ (
        `${r.galaxy}:${r.system}:${r.position}`
      );
      return withDecision(acc, ck, { s: DEC_MINE, ts: timestamp, f: r.max });
    }, prev),
  );
  void flushColonizeDecisionsStore();
  return novel.length;
};

/**
 * The installed-dispose handle, or `null` when the recorder is not
 * currently installed. Kept at module scope so repeat installs collapse
 * to a no-op — returning the same dispose fn — rather than queuing
 * redundant collection attempts for the same page-load.
 *
 * @type {(() => void) | null}
 */
let installed = null;

/**
 * Install the colony recorder for the current page-load.
 *
 * Behaviour:
 *   1. Both collection attempts are gated on
 *      {@link whenHistoryHydrated}. Without that gate the dedup read
 *      against `historyStore` races the async chrome.storage.local
 *      hydrate — see module header for the full failure mode. In tests
 *      that bypass `initHistoryStore` the promise is pre-resolved, so
 *      the deferred work fires on the next microtask.
 *   2. After hydration: first attempt — if the sidebar is already
 *      populated and some planet is fresh, the write happens immediately
 *      and the returned dispose is effectively a no-op.
 *   3. If that attempt recorded nothing, schedule a {@link waitFor} poll
 *      for the first planet row, then retry exactly once; on timeout we
 *      silently give up. Note the retry fires on "no rows yet", NOT on
 *      "rows present, none fresh" — the latter is the steady state on
 *      almost every page-load and polling would not change it.
 *   4. Idempotent per page-load: calling `installColonyRecorder()` a
 *      second time returns the dispose handle from the first call
 *      without scheduling a second attempt. The OGame content script
 *      only runs once per navigation, so this guards against accidental
 *      double-calls from boot code rather than a real multi-install
 *      lifecycle.
 *
 * The returned dispose flips `installed` back to `null`, re-enabling a
 * future install. It does NOT cancel a still-pending hydrate-await or
 * `waitFor` poll — every eventual `tryCollect` is a no-op once the
 * entries exist in history (dedup by cp). No cleanup is necessary for
 * correctness; the dispose is there for API symmetry with other
 * features (antiFlickerBackground, expeditionRedirect, ...).
 *
 * @returns {() => void} Dispose handle — currently just flips the
 *   module-scope `installed` sentinel back to `null`.
 */
export const installColonyRecorder = () => {
  if (installed) return installed;
  installed = () => {
    installed = null;
  };

  // Defer every collection attempt until history hydration has
  // settled — see module header on the race this avoids. The promise
  // is pre-resolved when `initHistoryStore` was never called (the
  // unit-test path), so the .then callback simply fires on the next
  // microtask in that case.
  void whenHistoryHydrated().then(async () => {
    // First try — avoids a pointless waitFor roundtrip when the sidebar
    // is already hydrated (the common case once OGame's own scripts have
    // finished running before us).
    if (await tryCollect()) return;

    // Retry path: poll for a planet row, then attempt once more. The poll
    // resolves immediately when rows already exist, so the cost in the
    // steady state is one extra microtask, not a 5s wait.
    waitFor(() => document.querySelector(GAME.SMALL_PLANET_ONLY) !== null, {
      timeoutMs: 5000,
      intervalMs: 200,
    }).then(() => {
      void tryCollect();
    });
  });

  return installed;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Production
 * code never needs this — the recorder lives for the page-load and is
 * replaced by a fresh module on navigation — but between vitest cases
 * we need a clean slate so idempotency tests do not see leftover state
 * from the previous case.
 *
 * Exported under a `_` prefix to signal "do not import from production
 * code". Kept in the public API surface because vitest files cannot
 * reach module-scope `let` bindings any other way.
 *
 * @returns {void}
 */
export const _resetColonyRecorderForTest = () => {
  installed = null;
};
