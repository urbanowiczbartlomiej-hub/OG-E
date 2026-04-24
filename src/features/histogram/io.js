// @ts-check

// Histogram page I/O — Export / Import of the full dataset (JSON),
// CSV dump of the colony history, and sync/clear-remote tombstones.
//
// This module is the only place the histogram page talks to
// `chrome.storage.local` for the export/import round-trip and for the
// two tombstone keys the sync scheduler observes. It never hits the
// network — all downloads go through Blob + ObjectURL, and neither
// `fetch()` nor `XMLHttpRequest` appear anywhere in this file.
//
// Shape of the exported JSON:
//   {
//     version: 1,
//     exportedAt: <ISO>,
//     colonyHistory: ColonyEntry[],
//     galaxyScans:   GalaxyScans
//   }
//
// Merge semantics (kept consistent with `sync/merge.js` for the same
// data so Export → Import round-trip is idempotent and matches Gist
// sync):
//   - colonyHistory: union by `cp`, local entry WINS on duplicate.
//   - galaxyScans:   per key, newer `scannedAt` wins.
//
// Old export files may include a `deletedColonies` field; it is
// silently ignored on import (only `version` is validated).

import { chromeStore } from '../../lib/storage.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/history.js').ColonyHistory} ColonyHistory
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

/**
 * chrome.storage.local key for the colony-history array. Mirrors the
 * constant re-exported from `state/history.js`; we re-declare it here
 * so the histogram page can read/write without depending on the state
 * module (which would drag the persist/store wiring along on import).
 */
export const HISTORY_KEY = 'oge_colonyHistory';

/** chrome.storage.local key for the full galaxy-scan map. */
export const SCANS_KEY = 'oge_galaxyScans';

/**
 * Tombstone written when the user clicks "Sync now". The sync
 * scheduler (running in the game-origin content script) observes the
 * change via `chrome.storage.onChanged` and forces an upload cycle.
 * Its value is a Date.now() timestamp — the scheduler only cares that
 * it changed, not about the exact number.
 */
export const SYNC_REQUEST_KEY = 'oge_syncRequestAt';

/**
 * Tombstone written when the user clicks "Clear remote". Tells the
 * sync scheduler to wipe the remote gist contents so local state
 * does not re-upload the scans we just deleted.
 */
export const CLEAR_REMOTE_KEY = 'oge_clearRemoteAt';

/**
 * Tombstone for per-galaxy reset. Value shape `"<galaxy>:<timestamp>"`
 * — including the timestamp ensures resetting the same galaxy twice
 * still fires `chrome.storage.onChanged` (it only triggers when value
 * actually changes). The scheduler parses out the galaxy id and runs
 * the matching `clearGistScansForGalaxy(g)` so the union merge doesn't
 * undo the local delete on the next sync round-trip.
 */
export const RESET_GALAXY_KEY = 'oge_resetGalaxyAt';

/** Schema version embedded in the exported JSON payload. */
const EXPORT_VERSION = 1;

/**
 * Today's date as YYYY-MM-DD, used in download filenames so users can
 * tell export files apart at a glance.
 *
 * @returns {string}
 */
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Trigger a browser download of `blob` with the given filename. Uses the
 * classic ObjectURL + invisible `<a>` trick — no network I/O, no third
 * party, works in both MV3 extension pages and plain pages.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Read a `File` as text via FileReader. Rejects when the underlying
 * reader errors (permission denial, disk read failure). The caller wraps
 * this in a try/catch so a failure surfaces as a user-visible warning
 * rather than a silent no-op.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
const readFileAsText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const { result } = reader;
      resolve(typeof result === 'string' ? result : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsText(file);
  });

/**
 * Download the full dataset as a pretty-printed JSON file. Missing
 * keys (nothing recorded yet, or the WebExtension API is absent) are
 * exported as the appropriate empty collection so the file always
 * round-trips cleanly. When the API is absent and `document` is missing
 * (node tests), this resolves without writing — the Blob step itself
 * requires `document.createElement('a')`, so the guard below makes the
 * "stripped context" case a no-op rather than a throw.
 *
 * @returns {Promise<void>}
 */
export const exportAllData = async () => {
  const [history, scans] = await Promise.all([
    chromeStore.get(HISTORY_KEY),
    chromeStore.get(SCANS_KEY),
  ]);

  // Defensive narrowing — corrupt or absent values fall back to empty.
  const colonyHistory = /** @type {ColonyHistory} */ (
    Array.isArray(history) ? history : []
  );
  const galaxyScans = /** @type {GalaxyScans} */ (
    scans && typeof scans === 'object' ? scans : {}
  );

  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    colonyHistory,
    galaxyScans,
  };

  // No DOM = no download target. Stay silent instead of throwing so
  // callers running under node/test environments can await us safely.
  if (typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, `oge-data-${todayIso()}.json`);
};

/**
 * Merge local and imported colony histories. Local entries WIN on cp
 * collisions so a bad/older import cannot overwrite freshly recorded
 * local observations. Returns the merged list plus the count of newly
 * added entries (not the final size).
 *
 * @param {ColonyHistory} local
 * @param {ColonyHistory} imported
 * @returns {{ merged: ColonyHistory, added: number }}
 */
const mergeHistory = (local, imported) => {
  const byCp = new Map(local.map((e) => [e.cp, e]));
  let added = 0;
  for (const entry of imported) {
    if (!byCp.has(entry.cp)) {
      byCp.set(entry.cp, entry);
      added += 1;
    }
  }
  return { merged: [...byCp.values()], added };
};

/**
 * Merge local and imported galaxy-scan maps, keyed by `"galaxy:system"`.
 * An imported entry wins iff local has nothing for that key OR the
 * imported `scannedAt` is strictly newer. Returns the merged map plus
 * the number of systems added or updated.
 *
 * @param {GalaxyScans} local
 * @param {GalaxyScans} imported
 * @returns {{ merged: GalaxyScans, changed: number }}
 */
const mergeScans = (local, imported) => {
  /** @type {GalaxyScans} */
  const merged = { ...local };
  let changed = 0;
  for (const key of /** @type {(keyof GalaxyScans)[]} */ (Object.keys(imported))) {
    const next = imported[key];
    const existing = merged[key];
    if (!existing || existing.scannedAt < next.scannedAt) {
      merged[key] = next;
      changed += 1;
    }
  }
  return { merged, changed };
};

/**
 * Parse a user-uploaded JSON file and merge it into
 * `chrome.storage.local`. Each field is independently optional — a file
 * may contain only `colonyHistory`, only `galaxyScans`, and the
 * other field is left untouched. Unknown fields (e.g. legacy exports'
 * `deletedColonies`) are silently ignored — only `version` is validated.
 *
 * On parse failure or unsupported version, returns a zero-count result
 * with a `warning` describing the reason. This is the one place we
 * wrap awaits in try/catch because the failure mode IS user-visible.
 *
 * @param {File} file
 * @returns {Promise<{ colonies: number, scans: number, warning?: string }>}
 */
export const importAllData = async (file) => {
  /** @type {unknown} */
  let parsed;
  try {
    const text = await readFileAsText(file);
    parsed = JSON.parse(text);
  } catch {
    return { colonies: 0, scans: 0, warning: 'Invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { colonies: 0, scans: 0, warning: 'Invalid JSON' };
  }

  const imported = /** @type {Record<string, unknown>} */ (parsed);
  if (imported.version !== EXPORT_VERSION) {
    return { colonies: 0, scans: 0, warning: 'Unsupported version' };
  }

  let colonies = 0;
  let scans = 0;

  if (Array.isArray(imported.colonyHistory)) {
    const localRaw = await chromeStore.get(HISTORY_KEY);
    const local = /** @type {ColonyHistory} */ (
      Array.isArray(localRaw) ? localRaw : []
    );
    const { merged, added } = mergeHistory(
      local,
      /** @type {ColonyHistory} */ (imported.colonyHistory),
    );
    if (added > 0) await chromeStore.set(HISTORY_KEY, merged);
    colonies = added;
  }

  if (imported.galaxyScans && typeof imported.galaxyScans === 'object') {
    const localRaw = await chromeStore.get(SCANS_KEY);
    const local = /** @type {GalaxyScans} */ (
      localRaw && typeof localRaw === 'object' ? localRaw : {}
    );
    const { merged, changed } = mergeScans(
      local,
      /** @type {GalaxyScans} */ (imported.galaxyScans),
    );
    if (changed > 0) await chromeStore.set(SCANS_KEY, merged);
    scans = changed;
  }

  return { colonies, scans };
};

/**
 * Escape a CSV field: wrap in quotes and double any embedded quote. We
 * always quote, even when unnecessary, because the cost is negligible
 * and it sidesteps the "coords contains a colon" kind of surprise that
 * Excel/LibreOffice disagree on.
 *
 * @param {string | number} value
 * @returns {string}
 */
const csvField = (value) => {
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * Download the colony history as a CSV file. The caller passes the
 * already-loaded entries (typically from `historyStore.get()` in
 * `colony.js`) so this module stays free of store wiring.
 *
 * Columns: CP, Coords, Position, Fields, Date (ISO).
 * Rows sorted by timestamp descending — most recent first, matching
 * the on-page list order.
 *
 * @param {ColonyEntry[]} entries
 * @returns {void}
 */
export const exportColonyCsv = (entries) => {
  if (typeof document === 'undefined') return;

  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  const header = 'CP,Coords,Position,Fields,Date';
  const rows = sorted.map((e) =>
    [
      csvField(e.cp),
      csvField(e.coords),
      csvField(e.position),
      csvField(e.fields),
      csvField(new Date(e.timestamp).toISOString()),
    ].join(','),
  );
  // Trailing newline so POSIX tools don't complain about "no newline at EOF".
  const body = [header, ...rows].join('\n') + '\n';

  const blob = new Blob([body], { type: 'text/csv' });
  downloadBlob(blob, 'oge-colony-history.csv');
};

/**
 * Request a forced sync cycle. Writes a timestamp to
 * {@link SYNC_REQUEST_KEY}; the sync scheduler observes the change
 * via `chrome.storage.onChanged` and uploads immediately.
 *
 * @returns {Promise<void>}
 */
export const triggerSync = () => chromeStore.set(SYNC_REQUEST_KEY, Date.now());

/**
 * Request a remote-clear operation. Writes a timestamp to
 * {@link CLEAR_REMOTE_KEY}; the sync scheduler uses this to wipe
 * the Gist payload without letting local state re-upload the
 * now-deleted scans.
 *
 * @returns {Promise<void>}
 */
export const triggerClearRemote = () =>
  chromeStore.set(CLEAR_REMOTE_KEY, Date.now());

/**
 * Request a remote-side reset for a single galaxy. Writes
 * `"<galaxy>:<Date.now()>"` to {@link RESET_GALAXY_KEY} so back-to-back
 * resets of the same galaxy each fire a fresh `onChanged` event. The
 * scheduler reads the galaxy id and runs `clearGistScansForGalaxy`.
 * Pair with the local `chromeStore.set(SCANS_KEY, ...)` that already
 * dropped the galaxy's keys on this device.
 *
 * @param {number} galaxy
 * @returns {Promise<void>}
 */
export const triggerResetGalaxy = (galaxy) =>
  chromeStore.set(RESET_GALAXY_KEY, `${galaxy}:${Date.now()}`);
