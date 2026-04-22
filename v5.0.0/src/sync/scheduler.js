// Sync scheduler — orchestrates local stores ↔ remote gist under one lock.
//
// # Role
//
// This is the glue that turns three independently-useful primitives —
// {@link scansStore}/{@link historyStore} (local state),
// {@link mergeScans}/{@link mergeHistory} (pure reconcilers), and the
// {@link fetchGistData}/{@link writeGistData} gist client — into a
// working cross-device sync round-trip. Every other sync module is
// stateless; this one owns the timers, the in-flight lock, and the
// store/event subscriptions that drive it.
//
// # Why a 15-second debounce
//
// OGame's galaxy page emits a burst of scans whenever the user scrolls
// — one XHR per system, potentially a dozen in a few seconds. Each
// scan flips {@link scansStore}, which on its own would queue an
// upload. Without debouncing we'd burn ~12 GitHub API requests to sync
// a single scrolling session; at OGame's tick cadence that exhausts
// the 5000 req/h quota in minutes. A 15 s quiet window lets the whole
// burst coalesce into one trailing upload. The price is staleness on
// the *other* device: fresh data takes up to 15 s + network RTT to
// reach it. That trade is conservative on purpose — a later device
// pulling on its next boot always gets the merged current state; we
// only lose a few seconds of real-time-ish freshness for a huge
// reduction in API pressure.
//
// # The anti-loop rule
//
// Every sync round-trip merges local and remote, and in the general
// case writes the merged result back to the local store. But the local
// store is watched by `storage.onChanged`-equivalent subscribers (any
// v5 feature that reacts to scans / history updates), and — crucially
// — by US: any write to {@link scansStore} or {@link historyStore}
// fires {@link onStoreChange}, which schedules another upload. If the
// write was a no-op (merge produced exactly what was already there),
// that next upload will re-merge, re-write, re-schedule, forever.
//
// {@link mergeScans} and {@link mergeHistory} return a `changed` flag
// that is `true` iff remote contributed at least one entry local did
// not already have. We only call `store.set(merged)` when `changed ===
// true`. When `changed === false` the merged reference IS the local
// reference (same object), so the write would have been a no-op
// semantically anyway — but skipping it breaks the subscription loop
// at its source.
//
// # The in-flight lock
//
// {@link downloadAndMerge} and {@link upload} share one boolean
// `inFlight`. Either operation, while running, blocks the other. This
// avoids two classes of race:
//
//   1. Concurrent PATCHes clobbering each other (the second one wins
//      on GitHub's side, but the first one's work is lost).
//   2. A download + upload interleaving such that upload reads
//      `local.get()` before download has stored its merged result —
//      leading to upload writing a stale view of local over the gist.
//
// The lock is coarse but correct. Finer-grained locking would require
// per-field versioning, which the current schema doesn't carry.
//
// # Force-sync event
//
// The Settings UI's "Sync now" button and the histogram's "Clear"
// action need to trigger a full round-trip immediately, bypassing the
// debounce. They dispatch a `CustomEvent('oge5:syncForce')` on
// `document` and this module's listener runs
// {@link downloadAndMerge} + {@link upload} back-to-back. Using a DOM
// event (rather than a direct function import) keeps the cross-
// feature coupling loose — the Settings UI doesn't need to know the
// scheduler module exists, and tests can simulate user clicks with a
// plain `document.dispatchEvent`.
//
// # Initial boot
//
// On install, we fire exactly one {@link downloadAndMerge} (fire-
// and-forget, we don't await). That catches up this device with
// whatever another device uploaded while we were offline. Local
// writes that happen DURING the initial download are still safe
// because the lock serialises them: any store change during the boot
// download queues a debounced upload, and that upload pre-merges with
// remote at its own call site.
//
// @ts-check

/* global document, CustomEvent */

import { scansStore } from '../state/scans.js';
import { historyStore } from '../state/history.js';
import { settingsStore } from '../state/settings.js';
import { mergeScans, mergeHistory } from './merge.js';
import {
  fetchGistData,
  writeGistData,
  setStatus,
  getToken,
  clearGistScans,
  clearGistScansForGalaxy,
} from './gist.js';
import { debounce } from '../lib/debounce.js';
import { chromeStore } from '../lib/storage.js';

/**
 * Tombstone keys the histogram page (extension origin) writes into
 * `chrome.storage.local` to cross-origin-signal the game-origin sync
 * scheduler. A direct `document.dispatchEvent` wouldn't work — the two
 * pages live in separate JS realms and separate origins — so the
 * shared storage area is the only reliable channel.
 *
 * Kept local (not exported) because the only writers are
 * `features/histogram/io.js` (see `SYNC_REQUEST_KEY` / `CLEAR_REMOTE_KEY`
 * there) and the only reader is this file. If a third participant ever
 * needs these strings, promote them to a small shared constants module.
 */
const SYNC_REQUEST_TOMBSTONE = 'oge5_syncRequestAt';
const CLEAR_REMOTE_TOMBSTONE = 'oge5_clearRemoteAt';
/**
 * Per-galaxy reset tombstone. Value is `"<galaxy>:<timestamp>"` so two
 * resets of the same galaxy back-to-back register as distinct changes
 * (chrome.storage.onChanged only fires when the value actually changes).
 */
const RESET_GALAXY_TOMBSTONE = 'oge5_resetGalaxyAt';

/**
 * Quiet-period length (ms) for {@link scheduleUpload}. See file header
 * for the 15-second rationale (burst-coalesce vs cross-device freshness
 * trade-off).
 */
const DEBOUNCE_MS = 15_000;

/**
 * DOM event name the Settings UI and histogram dispatch on `document`
 * to request an immediate sync round-trip. Exported so those callers
 * import the exact string rather than hard-coding it (drift between
 * dispatcher and listener would silently break force-sync).
 */
export const FORCE_SYNC_EVENT = 'oge5:syncForce';

/**
 * Active install handle, or `null` when the scheduler is not installed.
 * Kept at module scope so a second {@link installSync} call can detect
 * the already-installed state and return the existing dispose fn
 * without duplicating subscriptions.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Single lock shared by {@link downloadAndMerge} and {@link upload}.
 * `true` while either operation is running; both short-circuit when
 * they find it set. See file header "The in-flight lock" for why this
 * is coarse-but-correct.
 */
let inFlight = false;

/**
 * Compare two values by JSON structural equality. Cheap and good
 * enough for the "is the gist already current?" check at the end of
 * {@link upload} — both sides are plain JSON (nested records / arrays
 * of primitives), no Dates, no cycles, no functions.
 *
 * Normalises `undefined` / `null` / missing to the literal `null`
 * string so `sameJSON(undefined, null)` is `true`. That matters
 * because `fetchGistData` may yield `undefined` for a missing field
 * while our merge always produces a concrete empty container — we
 * want those shapes to register as "already current" and skip the
 * PATCH.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Pull the remote payload, merge it with local, and conditionally
 * write the merged result back to the local stores.
 *
 * Sequence:
 *   1. Early return when cloud sync is disabled or no token is set —
 *      this is how users opt out.
 *   2. Early return when {@link inFlight} is already set (a concurrent
 *      upload / download is in progress). The lock prevents a read
 *      from racing a write.
 *   3. {@link fetchGistData} — returns `null` when the gist exists but
 *      is empty / corrupt / schema-mismatched. Treat `null` the same as
 *      "nothing to merge", clear the error status, and finish.
 *   4. Merge each pair (scans, history). The merged result is the new
 *      source of truth for both local and remote — but see step 5.
 *   5. Anti-loop write: only `store.set(merged)` when `changed ===
 *      true`. That flag is `true` iff remote contributed something
 *      local didn't have; when it's `false` the merged reference IS the
 *      local reference, and writing it would fire our own
 *      subscription → schedule another upload → infinite loop.
 *   6. Stamp `down` with the ISO timestamp and clear any stale `err`.
 *      On exception, stamp `err` with a human-readable message so the
 *      Settings UI can surface what went wrong.
 *
 * @returns {Promise<void>}
 */
const downloadAndMerge = async () => {
  if (!settingsStore.get().cloudSync || !getToken()) return;
  if (inFlight) return;
  inFlight = true;
  try {
    const remote = await fetchGistData();
    if (!remote) {
      // Gist exists but is empty / corrupt / wrong schema: nothing to
      // merge in, but also not a failure — clear any stale error and
      // skip the timestamp (we didn't actually download data).
      setStatus('err', null);
      return;
    }

    const localScans = scansStore.get();
    const localHistory = historyStore.get();

    const scansResult = mergeScans(localScans, remote.galaxyScans);
    const histResult = mergeHistory(localHistory, remote.colonyHistory);

    // Anti-loop: see file header. `changed === false` means merge is a
    // structural no-op; skipping the write breaks the subscription
    // feedback loop at its source.
    if (scansResult.changed) scansStore.set(scansResult.merged);
    if (histResult.changed) historyStore.set(histResult.merged);

    setStatus('down', new Date().toISOString());
    setStatus('err', null);
  } catch (err) {
    setStatus('err', `download: ${/** @type {Error} */ (err).message}`);
  } finally {
    inFlight = false;
  }
};

/**
 * Pre-merge with remote, PATCH the gist with the merged state, and
 * conditionally write the merged result back to the local stores.
 *
 * Sequence:
 *   1. Early return when cloud sync is disabled or no token is set.
 *   2. Early return when {@link inFlight} is already set.
 *   3. Read local from the two stores.
 *   4. Pre-merge: {@link fetchGistData} gives us what the gist
 *      currently contains. Merging local with remote BEFORE we write
 *      ensures we don't clobber another device's recent writes. A
 *      thrown fetch (network blip, rate limit) is swallowed — we fall
 *      through with `remote = null`, which the merge functions treat
 *      as "nothing to merge in, keep local as-is".
 *   5. Same anti-loop write as {@link downloadAndMerge}: only call
 *      `store.set(merged)` when `changed === true`.
 *   6. Skip the PATCH when `sameJSON(remote, merged)` on both sides —
 *      a common case right after a download from another device where
 *      local and remote are already in agreement. Saves one API call
 *      and avoids a no-op gist revision on GitHub's end.
 *   7. When we do PATCH: build the full {@link GistPayload} (version
 *      3, fresh `updatedAt`, merged scans+history), call
 *      {@link writeGistData}, stamp `up` on success.
 *   8. Stamp `err` with a human-readable message on exception.
 *
 * @returns {Promise<void>}
 */
const upload = async () => {
  if (!settingsStore.get().cloudSync || !getToken()) return;
  if (inFlight) return;
  inFlight = true;
  try {
    const localScans = scansStore.get();
    const localHistory = historyStore.get();

    // Pre-merge: read remote and combine with local BEFORE writing, so
    // a concurrent write from another device isn't clobbered. A thrown
    // fetch is NOT fatal — we proceed with remote = null and merge
    // treats that as "nothing to merge", yielding merged === local.
    /** @type {import('./gist.js').GistPayload | null} */
    let remote = null;
    try {
      remote = await fetchGistData();
    } catch {
      // Swallow: see above. We still want to attempt an upload with
      // just the local snapshot when the gist read fails.
    }

    const scansResult = mergeScans(localScans, remote?.galaxyScans);
    const histResult = mergeHistory(localHistory, remote?.colonyHistory);

    // Same anti-loop guard as downloadAndMerge. Without this, a store
    // subscription would fire on every upload-round and re-schedule
    // indefinitely.
    if (scansResult.changed) scansStore.set(scansResult.merged);
    if (histResult.changed) historyStore.set(histResult.merged);

    // Skip the PATCH when the gist already matches the merged state.
    // This is the common case when upload fires right after a download
    // from another device and both sides already agree — PATCHing
    // anyway would burn a request and produce a no-op revision.
    const gistIsCurrent =
      sameJSON(remote?.galaxyScans, scansResult.merged) &&
      sameJSON(remote?.colonyHistory, histResult.merged);

    if (!gistIsCurrent) {
      await writeGistData({
        version: 3,
        updatedAt: new Date().toISOString(),
        galaxyScans: scansResult.merged,
        colonyHistory: histResult.merged,
      });
      setStatus('up', new Date().toISOString());
    }
    setStatus('err', null);
  } catch (err) {
    setStatus('err', `upload: ${/** @type {Error} */ (err).message}`);
  } finally {
    inFlight = false;
  }
};

/**
 * Debounced wrapper over {@link upload}: collapses a burst of store
 * changes into one trailing upload. See file header "Why a 15-second
 * debounce" for the rate-limit rationale.
 *
 * Note: `debounce` from `lib/debounce` ignores the wrapped fn's return
 * value (the signature is `(...args) => void`). That's fine here —
 * `upload` is fire-and-forget from the scheduler's perspective; any
 * error is captured by its internal try/catch and surfaced via
 * {@link setStatus}.
 */
const scheduleUpload = debounce(() => {
  // `void` the promise so tsc doesn't complain about an unhandled
  // PromiseLike. The function's own try/catch owns error reporting.
  void upload();
}, DEBOUNCE_MS);

/**
 * Install the scheduler: subscribe local stores, listen for the force-
 * sync event, and kick off the initial download.
 *
 * Idempotent. A second call while already installed returns the same
 * dispose fn without duplicating subscriptions — matching the
 * convention used by `state/scans.js` and friends.
 *
 * When `cloudSync` is `false` at install time, this returns a no-op
 * dispose and registers nothing. The user can flip `cloudSync` on
 * later; the content-script bootstrap is expected to re-install the
 * scheduler in response to that settings change (the scheduler itself
 * doesn't subscribe to settings because the install/dispose lifecycle
 * is owned by the caller).
 *
 * @returns {() => void} Dispose fn: unsubscribes stores, removes the
 *   event listener, and clears the install handle. Idempotent.
 */
export const installSync = () => {
  if (installed) return installed.dispose;

  // Honour the opt-out. Returning a no-op (not throwing) means the
  // content-script bootstrap doesn't need to branch on cloudSync —
  // it can always call `installSync()` and pay at most one cheap
  // settings read for the decision.
  if (!settingsStore.get().cloudSync) {
    const noop = () => {};
    installed = { dispose: noop };
    return noop;
  }

  const onStoreChange = () => {
    // Re-check settings on every event: the user might have flipped
    // cloudSync off mid-session. We leave the subscription in place
    // (avoiding tear-down churn) and just skip scheduling.
    if (!settingsStore.get().cloudSync) return;
    scheduleUpload();
  };

  const unsubScans = scansStore.subscribe(onStoreChange);
  const unsubHistory = historyStore.subscribe(onStoreChange);

  const onForceSync = async () => {
    // Force-sync is an explicit user action (settings "Sync now" or
    // histogram "Refresh"). Run a full round-trip back-to-back,
    // bypassing the debounce entirely. Each operation has its own
    // in-flight guard; they serialise naturally via the shared lock.
    await downloadAndMerge();
    await upload();
  };
  document.addEventListener(FORCE_SYNC_EVENT, onForceSync);

  /**
   * Bridge from the extension-origin histogram page to this scheduler.
   * The histogram writes `oge5_syncRequestAt = Date.now()` on "Refresh"
   * and `oge5_clearRemoteAt = Date.now()` on "Clear observation data";
   * chrome.storage.onChanged fires in THIS origin (game), so we can
   * observe and act. Value changes — we don't care about the timestamp
   * itself, only that the key was touched.
   *
   * @param {Record<string, unknown>} changes
   */
  const onStorageChange = (changes) => {
    if (SYNC_REQUEST_TOMBSTONE in changes) {
      void onForceSync();
    }
    if (CLEAR_REMOTE_TOMBSTONE in changes) {
      // The histogram wiped `chrome.storage.local` before writing this
      // tombstone — but scansStore IN MEMORY on the game tab still
      // holds every scan. Without a symmetric in-memory wipe, the next
      // scheduled upload would merge local-in-memory with the now-empty
      // remote (union) and push everything back up. Do the in-memory
      // wipe first, THEN clear the gist.
      scansStore.set(/** @type {import('./merge.js').GalaxyScans} */ ({}));
      (async () => {
        try {
          await clearGistScans();
        } catch (err) {
          setStatus('err', `clear-remote: ${/** @type {Error} */ (err).message}`);
        }
      })();
    }
    if (RESET_GALAXY_TOMBSTONE in changes) {
      // Value shape is `"<galaxy>:<timestamp>"`; we only care about the
      // galaxy id. Bad parses fall through silently — a corrupt
      // tombstone shouldn't take down the listener for the next one.
      const raw = /** @type {{ newValue?: unknown }} */ (
        changes[RESET_GALAXY_TOMBSTONE]
      ).newValue;
      const str = typeof raw === 'string' ? raw : '';
      const galaxy = parseInt(str.split(':')[0], 10);
      if (Number.isFinite(galaxy) && galaxy > 0) {
        // Drop the galaxy from scansStore IN MEMORY for the same
        // merge-round-trip reason as CLEAR_REMOTE above — the
        // histogram cleared chrome.storage but our in-memory copy
        // would otherwise re-introduce the keys via union merge.
        const current = scansStore.get();
        const prefix = galaxy + ':';
        /** @type {typeof current} */
        const filtered = {};
        for (const key of /** @type {(keyof typeof current)[]} */ (
          Object.keys(current)
        )) {
          if (!key.startsWith(prefix)) filtered[key] = current[key];
        }
        if (Object.keys(filtered).length !== Object.keys(current).length) {
          scansStore.set(filtered);
        }
        (async () => {
          try {
            await clearGistScansForGalaxy(galaxy);
          } catch (err) {
            setStatus(
              'err',
              `reset-galaxy: ${/** @type {Error} */ (err).message}`,
            );
          }
        })();
      }
    }
  };
  const unsubStorage = chromeStore.onChanged(onStorageChange);

  // Kick off the initial download fire-and-forget. We do not await —
  // the content-script bootstrap shouldn't block waiting for network.
  // Local writes that land during this download still upload correctly
  // because onStoreChange schedules the debounced upload, and the
  // in-flight lock serialises the two operations.
  void downloadAndMerge();

  installed = {
    dispose: () => {
      unsubScans();
      unsubHistory();
      document.removeEventListener(FORCE_SYNC_EVENT, onForceSync);
      unsubStorage();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Reset module-local state so tests can exercise a clean install/
 * dispose cycle without bleeding across cases.
 *
 * NOT part of the public API. The leading underscore is a hard signal
 * — feature code must never call this. Resets both the install handle
 * (disposing first if currently installed) and the in-flight lock.
 *
 * @returns {void}
 */
export const _resetSchedulerForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  inFlight = false;
};
