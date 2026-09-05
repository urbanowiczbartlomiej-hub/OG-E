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
// # Why a ONE-PLANET account records nothing
//
// The home planet the game hands out at registration is not a sample of the
// colony-size distribution, and it is fresh precisely when a new player first
// loads OG-E. See the gate in `tryCollect` for the full reasoning and why
// "the list has exactly one planet" identifies it exactly.
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
// # Why the dedup check reads an INDEX first, and the history only on a hit
//
// The history array grows forever by design and is stored uncompressed:
// ~89 bytes per observation, so ~870 KB at 10k rows. Hydrating it existed
// for one purpose here — building a `Set` of its cps to answer "already
// recorded?" — and it used to happen on every OGame page-load in every
// frame, because `content.js` called `initHistoryStore()` unconditionally
// at boot. That is a full `chrome.storage.local` round-trip plus a JSON
// parse of the whole dataset, paid on every navigation, to answer a
// question about ~20 integers.
//
// So the check is now staged, cheapest-first:
//
//   1. No planet with `used === 0`?  Return before touching storage at
//      all. This is the steady state on almost every page-load.
//   2. Otherwise read `state/historyCpIndex.js` — the same cp set
//      run-length encoded, measured at 1 413 B against 131 000 B of rows
//      on a real 1474-observation universe (see `domain/cpRanges.js`).
//      No candidate survives it? Return; the big key is never read.
//   3. Only for a cp the index does not know do we hydrate the real
//      history and re-check against it — appending if the cp is genuinely
//      new, and otherwise rewriting the index from that array so the next
//      page-load stops at step 2.
//
// The index is a derived cache, never the authority. It is allowed to
// MISS cps (the dashboard's import and the gist download both union into
// the history without touching it) but never to claim extra ones — a miss
// costs one slow page-load and then heals, whereas a false claim would
// silently drop a real observation. `domain/cpRanges.js` documents that
// invariant and encodes to that direction; `tryCollect` explains why the
// index is written only from a history array read back out of storage,
// and never from the append it just made.
//
// # Why step 3 gates on `whenHistoryHydrated`
//
// `historyStore` hydrates asynchronously from `chrome.storage.local`.
// If the dedup read ran before that landed it would see an empty store
// (regardless of what storage actually held), pass, and append to `[]`.
// The write-through would save `[newC]`. Then the async hydrate would
// resolve with `[oldA, oldB, ...]` and `store.set(stored)` would wipe
// `newC` from the store — and the write-through fires again, saving
// `[oldA, oldB, ...]` back to storage. Net result: the just-observed
// colony vanishes.
//
// The race was nearly invisible on Chrome desktop (storage usually
// settles before `DOMContentLoaded`) but reliably reproduced on
// Firefox, especially Android — heavier storage IPC means
// `DOMContentLoaded` wins more often. Awaiting `whenHistoryHydrated()`
// makes the dedup read see the real persisted history and removes the
// race entirely. See `state/history.js` for the lifecycle of the
// hydrated promise.
//
// Since the boot-time `initHistoryStore()` is gone, step 3 calls it
// itself — it is idempotent, so this both wires persistence in a frame
// that never needed it (an iframe, or a device with cloudSync off, where
// nothing else inits the store) and no-ops when the sync scheduler
// already did.
//
// @see ../state/history.js — the store this feature writes into, and the
//   canonical explanation of the "keep every observation" invariant.
// @see ../state/historyCpIndex.js — the small key step 2 reads.
// @see ./shared/planetRows.js — the sidebar projection this feature reads.

/** @ts-check */

import { historyStore, initHistoryStore, whenHistoryHydrated } from '../state/history.js';
import { readHistoryCpIndex, writeHistoryCpIndex } from '../state/historyCpIndex.js';
import { encodeCpRanges, cpRangesHas } from '../domain/cpRanges.js';
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
 * No branch that appends nothing touches the history, which is what lets
 * `installColonyRecorder` call this twice (sync + post-waitFor) without
 * double-recording. One of them does refresh the cp index, which is a cache
 * and idempotent to rewrite.
 *
 * @returns {Promise<number>}
 */
const tryCollect = async () => {
  const rows = readPlanetRows();
  if (rows.length === 0) return 0;

  // The STARTING planet is never an observation — skip a one-planet account.
  //
  // Every OGame account is handed a home planet at registration, and that
  // planet is NOT drawn from the same distribution the histogram is trying to
  // estimate: the game hands out a small, fixed-ish starter, and nobody ever
  // "finds" a planet that way. Worse, it is fresh (`used === 0`) at exactly the
  // moment a new player installs OG-E, so it is the one planet that sails
  // through the freshness gate below and lands in the dataset — and on a young
  // account, where the dataset is a handful of rows, that single small value
  // drags the whole distribution down. A colonised slot, by contrast, is a
  // genuine sample of what the universe offers (and players deliberately keep
  // the big ones, which is a separate bias the "never prune" rule handles).
  //
  // "One planet in the list" identifies it exactly, with no name/i18n guessing:
  // an account can only ever be down to a single planet while that planet is
  // the home planet — OGame does not let you abandon your last one, and the
  // home planet cannot be abandoned at all. The second planet you ever own is
  // a colony, so no real colonisation is lost here.
  //
  // Counted off the DOM rows, NOT `rows.length`: the projection drops a row it
  // cannot parse, so a two-planet account with one unreadable tooltip would
  // otherwise read as "one planet" and lose a real observation. The question
  // here is how many planets the account HAS, which is a row count.
  if (document.querySelectorAll(GAME.SMALL_PLANET_ONLY).length === 1) return 0;

  // Fresh planets only — see the module header on why this gate must stay.
  // Also the first of the three staged gates: on a page-load where nothing
  // is fresh (almost all of them) we return here, having touched no storage.
  const fresh = rows.filter((r) => r.used === 0);
  if (fresh.length === 0) return 0;

  // Gate 2 — the cp index (~1.4 KB) instead of the history rows (~130 KB and
  // climbing). Dedup is by cp because OGame's cp-ids come from one global
  // monotonic counter, so a matching cp means we already have this exact
  // observation. Note the same slot gets re-colonized repeatedly and each
  // re-colonization is a NEW planet with its own field count, so coords could
  // never serve as the key here.
  const idx = await readHistoryCpIndex();
  const candidates = fresh.filter((r) => !cpRangesHas(idx, r.cp));
  if (candidates.length === 0) return 0;

  // Gate 3 — a cp the index has not seen. Now, and only now, pay for the full
  // history: the index is allowed to miss cps, so it cannot be trusted to
  // authorise a write. `initHistoryStore` is idempotent (no-op when the sync
  // scheduler already wired it); the await closes the hydrate race documented
  // in the module header.
  initHistoryStore();
  await whenHistoryHydrated();
  const known = new Set(historyStore.get().map((h) => h.cp));
  const novel = candidates.filter((r) => !known.has(r.cp));

  if (novel.length === 0) {
    // The index under-reported. Usually because WE recorded this colony on an
    // earlier page-load and deliberately left the index alone (see the note
    // after the append below); also whenever an import or a gist download
    // unioned cps into the history behind the index's back. Either way the
    // fix is the same: rewrite it from the authority, which we have just read
    // out of storage, so the next page-load stops at gate 2. A failed write
    // only means we come back here later, so swallow it rather than surfacing
    // an unhandled rejection from a cache refresh.
    await writeHistoryCpIndex(encodeCpRanges(known)).catch(() => {});
    return 0;
  }

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

  // Deliberately NOT updating the index here, even though we know exactly
  // which cps we just added.
  //
  // The append above and an index write would be two independent
  // `chrome.storage.local` writes with no ordering guarantee between them. If
  // the index landed and the history did not — a failed write, or the tab
  // dying in between — the index would from then on claim a cp that is not in
  // the history, and this observation would be skipped forever. That is the
  // false positive the whole design forbids.
  //
  // So the index is only ever written from a history array we have READ back
  // out of storage, which is provably persisted: the `novel.length === 0`
  // branch above. The cost is that a just-recorded colony takes the slow path
  // once more on the next page-load, which then rebuilds the index and settles
  // it. One extra read, once per colony, in exchange for making the dangerous
  // direction structurally impossible rather than merely unlikely.

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
 * Monotonic install generation. Bumped by every install and by every
 * dispose/reset, and captured by the deferred work so a collect scheduled by
 * install N can tell that it is no longer the current install.
 *
 * # Why this is needed
 *
 * `installColonyRecorder` may leave a {@link waitFor} poll in flight for up to
 * five seconds after it returns. Nothing can cancel a `waitFor`, and the
 * dispose used to simply not try — documented as harmless on the grounds that a
 * late `tryCollect` is a no-op once the entry exists.
 *
 * That reasoning held while a collect was one synchronous dedup read. It does
 * not hold now: a collect clears three staged gates with real awaits between
 * them, so a poll from a PREVIOUS install can wake up inside a completely
 * different page state — in the suite, one test's leaked poll firing against
 * the next test's sidebar and store, which is exactly the kind of cross-case
 * bleed the hermetic-tests rule forbids. In production the same leak is a
 * narrower version of the same thing (two overlapping installs on one
 * page-load), and appending against a stale read is precisely the failure this
 * feature has already been bitten by once.
 *
 * A generation check is cheaper than making `waitFor` cancellable and covers
 * both call sites.
 */
let installGen = 0;

/**
 * Install the colony recorder for the current page-load.
 *
 * Behaviour:
 *   1. First attempt fires immediately — no longer deferred behind
 *      history hydration, because the cheap gates in {@link tryCollect}
 *      run before any storage read and the hydrate await now sits inside
 *      the one branch that actually needs the rows. On a page-load with
 *      nothing fresh (the overwhelming majority) this costs a DOM scan of
 *      ~20 sidebar rows and nothing else.
 *   2. If the sidebar is already populated and some planet is fresh, the
 *      write happens on that first attempt and the returned dispose is
 *      effectively a no-op.
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
  const gen = ++installGen;
  installed = () => {
    // Retiring this install invalidates any collect it still has in flight.
    if (installGen === gen) installGen++;
    installed = null;
  };

  void (async () => {
    // First try — avoids a pointless waitFor roundtrip when the sidebar
    // is already hydrated (the common case once OGame's own scripts have
    // finished running before us).
    if (await tryCollect()) return;
    // Disposed while that collect was awaiting storage — do not go on to
    // schedule a poll on behalf of an install that no longer exists.
    if (gen !== installGen) return;

    // Retry path: poll for a planet row, then attempt once more. The poll
    // resolves immediately when rows already exist, so the cost in the
    // steady state is one extra microtask, not a 5s wait.
    waitFor(() => document.querySelector(GAME.SMALL_PLANET_ONLY) !== null, {
      timeoutMs: 5000,
      intervalMs: 200,
    }).then(() => {
      if (gen !== installGen) return;
      void tryCollect();
    });
  })();

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
  // Bump the generation too, not just the sentinel: a `waitFor` poll left over
  // from the previous case would otherwise wake up against the next case's
  // sidebar. See {@link installGen}.
  installGen++;
  installed = null;
};
