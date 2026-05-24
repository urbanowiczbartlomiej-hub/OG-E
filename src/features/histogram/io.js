// @ts-check

// Histogram page I/O — Export / Import of the full dataset (JSON),
// CSV dump of the colony history, and sync/clear-remote tombstones.
//
// This module is the only place the histogram page talks to
// `chrome.storage.local` for the export/import round-trip and for the
// tombstone keys the sync scheduler observes. It never hits the
// network — all downloads go through Blob + ObjectURL, and neither
// `fetch()` nor `XMLHttpRequest` appear anywhere in this file.
//
// # Per-universe scope
//
// Every storage operation here is scoped to a `universeId` passed in
// by the caller (the histogram's server-selector dropdown). The base
// suffixes (`oge_colonyHistory`, `oge_galaxyScans`, ...) and the
// `*KeyFor` composers are imported from the state / sync modules that
// own them, so this file does not re-declare any key string — keeping
// the wire contract single-sourced.
//
// Shape of the exported JSON:
//   {
//     version: 1,
//     exportedAt: <ISO>,
//     universeId: <e.g. "s163-pl">,
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
// silently ignored on import (only `version` is validated). The
// `universeId` field on the import payload is also ignored at
// import time — the caller's currently-selected universe owns the
// merge target, so a file exported from s163 can be imported into s164.

import { chromeStore } from '../../lib/storage.js';
import { historyKeyFor } from '../../state/history.js';
import { scansKeyFor } from '../../state/scans.js';
import {
  syncRequestKeyFor,
  clearRemoteKeyFor,
  resetGalaxyKeyFor,
} from '../../sync/scheduler.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/history.js').ColonyHistory} ColonyHistory
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

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
 * Download the selected universe's dataset as a pretty-printed JSON
 * file. Missing keys (nothing recorded yet, or the WebExtension API is
 * absent) are exported as the appropriate empty collection so the file
 * always round-trips cleanly. When the API is absent and `document` is
 * missing (node tests), this resolves without writing — the Blob step
 * itself requires `document.createElement('a')`, so the guard below
 * makes the "stripped context" case a no-op rather than a throw.
 *
 * Filename embeds the universe id so a user managing several servers
 * can tell exports apart at a glance: `oge-s163-pl-2026-05-23.json`.
 *
 * @param {string} universeId  Selected universe (e.g. `'s163-pl'`).
 * @returns {Promise<void>}
 */
export const exportAllData = async (universeId) => {
  const [history, scans] = await Promise.all([
    chromeStore.get(historyKeyFor(universeId)),
    chromeStore.get(scansKeyFor(universeId)),
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
    universeId,
    colonyHistory,
    galaxyScans,
  };

  // No DOM = no download target. Stay silent instead of throwing so
  // callers running under node/test environments can await us safely.
  if (typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, `oge-${universeId}-${todayIso()}.json`);
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
 * Parse a user-uploaded JSON file and merge it into the selected
 * universe's slot in `chrome.storage.local`. Each field is
 * independently optional — a file may contain only `colonyHistory`,
 * only `galaxyScans`, and the other field is left untouched. Unknown
 * fields (legacy exports' `deletedColonies`, or the new `universeId`
 * tag) are silently ignored — only `version` is validated.
 *
 * On parse failure or unsupported version, returns a zero-count result
 * with a `warning` describing the reason. This is the one place we
 * wrap awaits in try/catch because the failure mode IS user-visible.
 *
 * @param {File} file
 * @param {string} universeId  Selected universe (destination of the merge).
 * @returns {Promise<{ colonies: number, scans: number, warning?: string }>}
 */
export const importAllData = async (file, universeId) => {
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

  const historyKey = historyKeyFor(universeId);
  const scansKey = scansKeyFor(universeId);

  let colonies = 0;
  let scans = 0;

  if (Array.isArray(imported.colonyHistory)) {
    const localRaw = await chromeStore.get(historyKey);
    const local = /** @type {ColonyHistory} */ (
      Array.isArray(localRaw) ? localRaw : []
    );
    const { merged, added } = mergeHistory(
      local,
      /** @type {ColonyHistory} */ (imported.colonyHistory),
    );
    if (added > 0) await chromeStore.set(historyKey, merged);
    colonies = added;
  }

  if (imported.galaxyScans && typeof imported.galaxyScans === 'object') {
    const localRaw = await chromeStore.get(scansKey);
    const local = /** @type {GalaxyScans} */ (
      localRaw && typeof localRaw === 'object' ? localRaw : {}
    );
    const { merged, changed } = mergeScans(
      local,
      /** @type {GalaxyScans} */ (imported.galaxyScans),
    );
    if (changed > 0) await chromeStore.set(scansKey, merged);
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
 * already-loaded entries (typically from the histogram page's
 * module-scope cache populated by `chromeStore.get(historyKeyFor(...))`)
 * so this module stays free of store wiring.
 *
 * Columns: CP, Coords, Position, Fields, Date (ISO).
 * Rows sorted by timestamp descending — most recent first, matching
 * the on-page list order.
 *
 * Filename embeds the universe id for the same disambiguation reason
 * as {@link exportAllData}.
 *
 * @param {ColonyEntry[]} entries
 * @param {string} universeId
 * @returns {void}
 */
export const exportColonyCsv = (entries, universeId) => {
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
  downloadBlob(blob, `oge-${universeId}-colony-history.csv`);
};

/**
 * Request a forced sync cycle for the given universe. Writes a
 * timestamp to that universe's namespaced sync tombstone; the sync
 * scheduler running on a game tab for the SAME universe observes the
 * change via `chrome.storage.onChanged` and uploads immediately. If no
 * tab for that universe is currently open, the tombstone sits until
 * one is — natural behaviour since sync requires a game tab anyway.
 *
 * @param {string} universeId
 * @returns {Promise<void>}
 */
export const triggerSync = (universeId) =>
  chromeStore.set(syncRequestKeyFor(universeId), Date.now());

/**
 * Request a remote-clear operation for the given universe. Writes a
 * timestamp to that universe's namespaced clear-remote tombstone; the
 * sync scheduler uses this to wipe the Gist payload without letting
 * local state re-upload the now-deleted scans.
 *
 * @param {string} universeId
 * @returns {Promise<void>}
 */
export const triggerClearRemote = (universeId) =>
  chromeStore.set(clearRemoteKeyFor(universeId), Date.now());

/**
 * Request a remote-side reset for a single galaxy within the given
 * universe. Writes `"<galaxy>:<Date.now()>"` to that universe's
 * namespaced reset tombstone so back-to-back resets of the same galaxy
 * each fire a fresh `onChanged` event. The scheduler reads the galaxy
 * id and runs `clearGistScansForGalaxy`. Pair with the local
 * `chromeStore.set(scansKeyFor(universeId), ...)` that already dropped
 * the galaxy's keys on this device.
 *
 * @param {number} galaxy
 * @param {string} universeId
 * @returns {Promise<void>}
 */
export const triggerResetGalaxy = (galaxy, universeId) =>
  chromeStore.set(resetGalaxyKeyFor(universeId), `${galaxy}:${Date.now()}`);
