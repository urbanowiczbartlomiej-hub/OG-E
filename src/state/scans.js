// Galaxy-scan database — reactive store keyed by `"galaxy:system"`.
//
// Every scanned system lands here as a {scannedAt, positions} record, with
// `positions` keyed by slot number 1..15 using the canonical {@link Position}
// shape from `domain/scans.js`. The store is persisted to
// `chrome.storage.local` under a per-universe key (`<universeId>:oge_galaxyScans`,
// see {@link scansKeyFor}). Hydration is async — the initial in-memory
// state is an empty map `{}` and real data flows in once the chromeStore
// promise settles (see `persist` — it handles both sync and async loads).
//
// # Why per-universe namespacing
//
// `chrome.storage.local` is shared across every origin the extension runs
// on — without a per-universe prefix the data from every server bleeds
// together. We prefix the key with the universe id parsed from
// `location.host` (`s163-pl.ogame.gameforge.com` → `s163-pl`) so each
// OGame server keeps its own scan dataset. Legacy un-namespaced data is
// rehomed once at first launch post-upgrade by `state/migrate.js`.
//
// Persistence is wired lazily via {@link initScansStore}, NOT on import.
// Two reasons:
//   1. Tests can mock `chromeStore` and decide when (if ever) to bind
//      persist — otherwise a singleton wire-up on module load would fire
//      real I/O before vi.mock could intercept it.
//   2. The content-script entry is the one place that should wire
//      persistence, exactly once, at bootstrap. Calling `initScansStore`
//      from anywhere else is a no-op thanks to idempotency.
//
// Why debounce 200ms: scrolling through the galaxy produces a rapid burst
// of per-system scans (our XHR hook fires once per navigation step). A
// naive write-through would hit chrome.storage.local once per step,
// which is both wasteful and measurably slow. 200ms is long enough to
// collapse a continuous scroll into one trailing save yet short enough
// that a pause-and-check pattern still persists promptly.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { persist } from '../lib/persist.js';
import { chromeStore } from '../lib/storage.js';
import { GALAXY_SCANNED_EVENT } from '../lib/ogeEvents.js';
import { currentUniverseKey } from './universeKey.js';
import { mergeScanResult } from '../domain/scans.js';
import { registryStore } from './registry.js';

/**
 * @typedef {import('../domain/scans.js').Position} Position
 */

/**
 * One system's worth of scan data. `scannedAt` is an epoch-ms timestamp of
 * the moment we classified this system; `positions` is a dense-ish record
 * keyed by slot number 1..15 whose values are the canonical Position
 * projections. Missing keys mean "we haven't observed that slot yet in
 * this scan" and should be treated as absent (NOT as `empty`).
 *
 * Invariants:
 *   - `scannedAt` is always a finite number of milliseconds since epoch.
 *   - `positions` keys are integer strings 1..15 at runtime (TypeScript
 *     widens this to `number` because JSON objects cannot distinguish
 *     integer-string keys from other keys; callers that care enforce
 *     the range at write time).
 *
 * @typedef {object} SystemScan
 * @property {number} scannedAt
 *   ms timestamp of the most recent scan of this system.
 * @property {Record<number, Position>} positions
 *   Per-slot classification. Keys are numeric slots 1..15.
 * @property {number} [lfScannedAt]
 *   ms timestamp of the last successful lifeform system-discovery for this
 *   system (the `features/sendLifeform` button). Drives a 7-day retention
 *   gate that is INDEPENDENT of the colonization `scannedAt` above. Absent
 *   means "never discovered". Set by the Lifeforms feature, never by the
 *   galaxy (colonization) scan — and preserved across colonization rescans
 *   by {@link installScansListener}.
 * @property {Record<number, number>} [lfPositions]
 *   Per-position ms timestamps from the discovery response's
 *   `sentToCoordinates`. Record/fidelity only — the 7-day gate keys off
 *   {@link SystemScan.lfScannedAt}. Keys are slot numbers 1..15.
 */

/**
 * Full galaxy-scan map. Keys are `"galaxy:system"` template strings (e.g.
 * `"4:30"`), values are the per-system scan record. This is the shape
 * persisted under `<universeId>:oge_galaxyScans` in chrome.storage.local.
 *
 * @typedef {Record<`${number}:${number}`, SystemScan>} GalaxyScans
 */

/**
 * Suffix portion of the chrome.storage.local key under which the
 * {@link GalaxyScans} map is persisted. The actual key written is
 * `<universeId>:<SCANS_KEY_BASE>` — see {@link scansKeyFor}. Kept
 * exported so the histogram (extension origin) can compose a key for
 * an arbitrary selected universe and so the migration code can read
 * the legacy un-namespaced location.
 */
export const SCANS_KEY_BASE = 'oge_galaxyScans';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 * Called by the histogram page (which knows the selected universe
 * from its dropdown) and by the migration code in `state/migrate.js`.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from
 *   {@link parseUniverseId}.
 * @returns {string} The namespaced key, e.g. `'s163-pl:oge_galaxyScans'`.
 */
export const scansKeyFor = (universeId) => `${universeId}:${SCANS_KEY_BASE}`;

/**
 * Resolve the chrome.storage.local key for the current tab's universe.
 * Reads `location.host` defensively — in non-DOM test environments where
 * `location` is undefined the call falls back to the legacy un-namespaced
 * key so tests don't have to stub the global. Production never hits the
 * fallback because manifest content_scripts restricts this module to
 * `*.ogame.gameforge.com/game/index.php*`.
 *
 * @returns {string}
 */
const currentScansKey = () => currentUniverseKey(SCANS_KEY_BASE, scansKeyFor);

/**
 * Write-through debounce window. See file header for the "collapse a
 * galaxy-navigation burst" rationale.
 */
const DEBOUNCE_MS = 200;

/**
 * The galaxy-scan store.
 *
 * Initial value is an empty map: on module load we have no data yet, and
 * hydration is async (chromeStore returns a Promise). Once
 * {@link initScansStore} is called the `persist` helper will resolve the
 * load promise and `store.set` the hydrated value on a microtask — until
 * that tick, consumers see `{}`.
 *
 * @type {import('../lib/createStore.js').Store<GalaxyScans>}
 */
export const scansStore = createStore(/** @type {GalaxyScans} */ ({}));

/**
 * The `persist` unsubscribe handle, or `null` before `initScansStore`
 * has been called (or after it has been torn down via
 * {@link disposeScansStore}). Kept at module scope so repeat calls to
 * `initScansStore` can be detected cheaply and collapsed to a no-op.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire the scans store to chrome.storage.local: hydrate from
 * `<universeId>:oge_galaxyScans`, and write every change back (debounced by
 * {@link DEBOUNCE_MS}). Safe to call multiple times — subsequent calls
 * return the same dispose handle without double-registering the
 * write-through subscription.
 *
 * Intended to be called exactly once from the content-script entry
 * during bootstrap. Tests call it explicitly after stubbing
 * `chromeStore` so they can observe the load/save wire.
 *
 * @returns {() => void} Dispose function that unsubscribes the
 *   write-through listener. The pending debounced save (if any) is NOT
 *   cancelled — callers that need a clean teardown should advance
 *   timers past {@link DEBOUNCE_MS} first.
 */
export const initScansStore = () => {
  if (disposeFn) return disposeFn;
  // `chromeStore.get` returns `Promise<unknown>` (the API cannot know the
  // persisted shape). The cast inside the async wrapper tells tsc that
  // whatever we read under the per-universe scans key is a GalaxyScans —
  // which holds by construction because we are the only writer there. A
  // corrupted or shape-mismatched value would misbehave downstream; we
  // accept the trade-off rather than validating every persisted blob on
  // every load.
  disposeFn = persist({
    store: scansStore,
    load: async () => {
      const raw = await chromeStore.get(currentScansKey());
      return /** @type {GalaxyScans | null | undefined} */ (raw);
    },
    save: (value) => chromeStore.set(currentScansKey(), value),
    debounceMs: DEBOUNCE_MS,
  });

  // Auto-wire the MAIN-world bridge listener so callers only need one
  // entry point for "boot the scans store". Without this bundling,
  // `content.js` has to remember to call `installScansListener` as a
  // separate step — that bug-class manifests as every galaxy scan
  // firing into a void when the listener is forgotten. The listener
  // itself is idempotent and defensive (no-op when the runtime has no
  // `document`, i.e. node tests), so auto-installing it here never
  // produces surprises.
  installScansListener();

  return disposeFn;
};

/**
 * Bypass the debounce and write the current store value to
 * chrome.storage.local immediately. Call this before navigating away
 * so that in-memory deletions (e.g. stale-click rescan marking) are
 * not lost when the page unloads before the debounced save fires.
 *
 * @returns {Promise<void>}
 */
export const flushScansStore = () => chromeStore.set(currentScansKey(), scansStore.get());

/**
 * Tear down the persist wiring installed by {@link initScansStore}.
 * Idempotent — does nothing when persistence is not currently wired.
 * Primarily useful between tests so state and subscriptions don't
 * leak across cases; production code generally leaves the store
 * wired for the lifetime of the page.
 *
 * @returns {void}
 */
export const disposeScansStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
  // Tear the auto-installed listener down in lock-step so a test that
  // disposes the store doesn't leave a dangling `document` listener
  // feeding into `scansStore` from leftover event dispatches.
  disposeScansListener();
};

// GALAXY_SCANNED_EVENT (lib/ogeEvents.js) is dispatched by the MAIN-world
// galaxy bridge after classifying each `fetchGalaxyContent` response; this
// store subscribes to it. Centralized so bridge and listener can't drift.

/**
 * Unsubscribe handle for the `oge:galaxyScanned` listener, `null`
 * when not installed. Kept at module scope for idempotency — the
 * same convention as `disposeFn` above.
 *
 * @type {(() => void) | null}
 */
let disposeScansListenerFn = null;

/**
 * Install the bridge from `oge:galaxyScanned` (fired by
 * `bridges/galaxyHook.js` in the MAIN world) into `scansStore`. Every
 * event received merges its fresh `{positions, canColonize}` payload
 * with the existing per-system scan via {@link mergeScanResult},
 * preserving our locally-stamped `empty_sent` markers when a pending
 * colonize fleet from `registryStore` is still in flight.
 *
 * Without this wiring the galaxy XHR hook fires into a void and
 * scansStore never grows past whatever the store hydrated from
 * chrome.storage at boot — the classic "scan doesn't persist" bug.
 *
 * Idempotent: a second call returns the existing dispose fn without
 * double-registering. Safe to call from any context that has
 * `document` (the isolated-world content script).
 *
 * @returns {() => void} Dispose fn that removes the listener.
 */
export const installScansListener = () => {
  if (disposeScansListenerFn) return disposeScansListenerFn;

  // Defensive: in node-env tests (e.g. `test/state/scans.test.js` which
  // runs `initScansStore` to exercise the persist wiring) there is no
  // `document`. Return a no-op dispose so callers get the same shape
  // they expect; the listener in production is wired from the content-
  // script bootstrap path, which always has a document.
  if (typeof document === 'undefined') {
    disposeScansListenerFn = () => {
      disposeScansListenerFn = null;
    };
    return disposeScansListenerFn;
  }

  /** @param {Event} e */
  const handler = (e) => {
    const detail = /** @type {CustomEvent<{
      galaxy?: number,
      system?: number,
      positions?: Record<number, Position>,
      canColonize?: boolean,
    }>} */ (e).detail;
    if (!detail || !detail.positions) return;
    if (typeof detail.galaxy !== 'number' || typeof detail.system !== 'number') {
      return;
    }

    const systemKey = /** @type {`${number}:${number}`} */ (
      `${detail.galaxy}:${detail.system}`
    );
    const now = Date.now();

    // Build the pending-fleet set from the colonization registry so
    // `mergeScanResult` can preserve `empty_sent` markers on slots
    // where our fleet hasn't landed yet.
    const registry = registryStore.get();
    const pendingCoordKeys = new Set(
      registry
        .filter((r) => (r.arrivalAt || 0) > now)
        .map((r) => r.coords),
    );

    const current = scansStore.get();
    const existingScan = current[systemKey];
    const mergedPositions = mergeScanResult(
      existingScan?.positions,
      detail.positions,
      pendingCoordKeys,
      systemKey,
    );

    scansStore.set({
      ...current,
      [systemKey]: {
        // Spread the existing record FIRST so lifeform discovery markers
        // (`lfScannedAt` / `lfPositions`, owned by `features/sendLifeform`)
        // survive a colonization rescan — the galaxy XHR observes neither,
        // so without this carry-forward every scan would silently reset the
        // 7-day discovery retention. `scannedAt` + `positions` below
        // overwrite the colonization-owned fields with the fresh values.
        ...existingScan,
        scannedAt: now,
        positions: mergedPositions,
      },
    });
  };

  document.addEventListener(GALAXY_SCANNED_EVENT, handler);
  disposeScansListenerFn = () => {
    document.removeEventListener(GALAXY_SCANNED_EVENT, handler);
    disposeScansListenerFn = null;
  };
  return disposeScansListenerFn;
};

/**
 * Tear down the listener installed by {@link installScansListener}.
 * Idempotent.
 *
 * @returns {void}
 */
export const disposeScansListener = () => {
  if (disposeScansListenerFn) disposeScansListenerFn();
};
