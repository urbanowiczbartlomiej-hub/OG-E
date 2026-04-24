// @ts-check

// Settings → chrome.storage cross-origin mirror.
//
// Problem it solves: `state/settings.js` persists every preference to
// `localStorage` (for AGR compatibility and per-key debuggability). The
// histogram extension page, however, runs in the EXTENSION origin and
// cannot read the game page's localStorage. For every setting the
// histogram needs to observe (today: `colPositions`, which drives the
// "target positions" filter), we mirror a copy into
// `chrome.storage.local` — an API area that IS visible across origins
// within the same extension.
//
// Direction: one-way, settings → chrome.storage. The histogram page
// never writes back; it reads and renders. Mirroring in reverse would
// create a feedback loop that `state/settings.js` isn't built for.
//
// Scope: only the keys the histogram (or any other extension-origin
// surface) actually reads. Mirroring the full Settings object would
// leak sensitive fields (`gistToken`, `colPassword`) into a second
// storage area for no benefit. Today that's just `colPositions`.
//
// @see ../features/histogram/index.js — COL_POSITIONS_KEY reader
// @see ./settings.js                  — source of truth

import { chromeStore } from '../lib/storage.js';
import { settingsStore } from './settings.js';

/**
 * chrome.storage.local key the histogram reads. Matches
 * `features/histogram/index.js:COL_POSITIONS_KEY`. Keep the two in
 * sync if either side changes — they don't import a shared constant
 * because they live in different module trees (state vs. features)
 * and a shared constants module would be overkill for one string.
 */
const COL_POSITIONS_KEY = 'oge_colPositions';

/**
 * Active install handle, or `null` when the mirror is not installed.
 * Kept at module scope so a second {@link installSettingsMirror} call
 * can collapse to the existing dispose fn — matches the convention in
 * `state/scans.js`, `state/history.js`, etc.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Subscribe to {@link settingsStore} and mirror `colPositions` into
 * `chrome.storage.local` whenever it changes. Fires once on install to
 * carry the current value into chromeStore — otherwise a fresh extension
 * load on a freshly-loaded game page would leave the histogram reading
 * `undefined` (and falling back to the hard-coded default) until the
 * user touched a setting.
 *
 * Idempotent: repeat calls return the existing dispose handle.
 *
 * @returns {() => void} Dispose fn that unsubscribes the listener.
 *   In-memory `settingsStore` state and the already-written chromeStore
 *   value are left intact; only future writes are suppressed.
 */
export const installSettingsMirror = () => {
  if (disposeFn) return disposeFn;

  // Initial mirror. Without this, devices that load the game page AFTER
  // the histogram page has already started — and haven't yet changed a
  // setting — would see the histogram stuck on its default filter.
  let last = settingsStore.get().colPositions;
  void chromeStore.set(COL_POSITIONS_KEY, last);

  const unsubscribe = settingsStore.subscribe((settings) => {
    // Diff-guarded write: the store notifies on ANY field change, but
    // we only care about `colPositions`. Most subscriber firings touch
    // nothing we mirror — skipping the chromeStore.set on those avoids
    // unnecessary storage writes (and the onChanged event they produce
    // in every consuming origin).
    if (settings.colPositions !== last) {
      last = settings.colPositions;
      void chromeStore.set(COL_POSITIONS_KEY, last);
    }
  });

  disposeFn = unsubscribe;
  return disposeFn;
};

/**
 * Tear down the mirror subscription. Safe to call when never installed
 * (no-op) and when already disposed. In-memory state and the previously
 * mirrored chromeStore value both survive dispose.
 *
 * @returns {void}
 */
export const disposeSettingsMirror = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};
