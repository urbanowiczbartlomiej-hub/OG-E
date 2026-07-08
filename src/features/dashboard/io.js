// @ts-check

// Histogram page I/O — Export / Import of the selected universe's dataset
// (JSON) + CSV dump of the colony history.
//
// This module is the only place the histogram page talks to
// `chrome.storage.local` for the export/import round-trip. It never hits the
// network — all downloads go through Blob + ObjectURL, and neither `fetch()`
// nor `XMLHttpRequest` appear anywhere in this file.
//
// # The IO_SLOTS registry
//
// One table drives both directions (mirroring the sync scheduler's
// SYNC_SLOTS): export = read every slot and include the non-empty ones;
// import = for each payload field with a registered slot, read local → merge
// → write-back-if-changed → count for the summary. Adding a dataset is ONE
// registry entry. Every merge REUSES the canonical reconciler from
// `sync/merge.js` (or `domain/watchListMerge.js` for the watch list), so an
// Export → Import round-trip behaves EXACTLY like a gist download — additive,
// local-first, no wholesale replaces. The one deliberate exception to "purely
// additive": the watch list rides its per-key LWW+tombstone merge, so an
// un-star inside a NEWER file propagates, exactly like sync.
//
// # Scope — what the file can and cannot carry
//
//   - Everything here is `chrome.storage.local`-backed. Game-origin
//     localStorage (per-universe settings values, lifeform artifacts, daily
//     flags) is UNREACHABLE from this extension-origin page — those stay
//     gist-sync-only.
//   - SECRETS NEVER ENTER THE FILE: `oge_sharedSettings` (it holds the GitHub
//     PAT + ntfy token), the token keys, and all sync bookkeeping
//     (`*Ts` ledgers are the exception — the watch-list ledger travels INSIDE
//     its slot's `{v?, ts}` records, and the config slots carry `updatedAt`)
//     are simply not in the registry. An exported file is safe to hand to
//     another person.
//
// # Shape of the exported JSON (version 2)
//
//   {
//     version: 2,
//     exportedAt: <ISO>,
//     extensionVersion: <manifest version, when available>,
//     universeId: <e.g. "s163-pl">,        // informational — see below
//     data: { <slot field>: <value>, ... } // every field optional
//   }
//
// Version-1 files (bare `colonyHistory` / `galaxyScans` at the top level)
// still import — the dispatcher maps them onto the same two slots. Unknown
// `data` fields are skipped and REPORTED (forward compatibility: a file from
// a newer OG-E degrades to a partial import instead of a hard reject). The
// `universeId` field on the import payload is ignored at import time — the
// caller's currently-selected universe owns the merge target, so a file
// exported from s163 can be imported into s164 (deliberate, e.g. server
// merges).

import { chromeStore } from '../../lib/storage.js';
import { historyKeyFor } from '../../state/history.js';
import { scansKeyFor } from '../../state/scans.js';
import { targetReportsKeyFor } from '../../state/targets.js';
import { proximityReportsKeyFor } from '../../state/proximityReports.js';
import { activityObsKeyFor } from '../../state/activityObs.js';
import { playersKeyFor } from '../../state/players.js';
import { allianceClassKeyFor } from '../../state/allianceClass.js';
import { bodiesKeyFor } from '../../state/bodies.js';
import { colonizeDecisionsKeyFor } from '../../state/colonizeDecisions.js';
import { dailyRunRoutesKeyFor, dailyRunRoutesTsKeyFor } from '../../state/dailyRunRoutes.js';
import { galaxyScanConfigKeyFor, galaxyScanConfigTsKeyFor } from '../../state/galaxyScanConfig.js';
import { alarmClockConfigKeyFor, alarmClockConfigTsKeyFor } from '../../state/alarmClockConfig.js';
import {
  watchListKeyFor,
  normalizeWatchList,
  ensureWatchListLedgerSeeded,
  applyWatchListSyncSlot,
} from '../../state/watchList.js';
import {
  WATCH_FAMILIES,
  composeWatchSlot,
  mergeWatchList,
  watchSlotHasData,
} from '../../domain/watchListMerge.js';
import {
  mergeScans,
  mergeHistory,
  mergeColonizeDecisions,
  mergeTargetReports,
  mergeActivityObs,
  mergeProximityReports,
  mergePlayerCache,
  mergeAllianceClassMap,
  mergeBodyInventory,
} from '../../sync/merge.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../state/history.js').ColonyHistory} ColonyHistory
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 */

/** Schema version written by {@link exportAllData}. */
const EXPORT_VERSION = 2;
/** The pre-registry format (bare colonyHistory/galaxyScans) — still imports. */
const LEGACY_VERSION = 1;

/** Legacy/metadata payload fields an import silently ignores (not data). */
const IGNORED_FIELDS = new Set(['version', 'exportedAt', 'extensionVersion', 'universeId', 'deletedColonies']);

/** @param {unknown} v @returns {Record<string, any>} Defensive object narrowing. */
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {any} */ (v) : {});
/** @param {unknown} v @returns {any[]} Defensive array narrowing. */
const asArr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @returns {number} Finite non-negative number, else 0. */
const asTs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** @param {Record<string, any>} a @param {Record<string, any>} b @returns {number} Keys whose value differs (added or updated). */
const changedKeyCount = (a, b) => {
  let n = 0;
  for (const k of Object.keys(b)) {
    if (!(k in a) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) n += 1;
  }
  return n;
};

/** @param {Record<string, Record<string, any>>} a @param {Record<string, Record<string, any>>} b @returns {number} Two-level {@link changedKeyCount} (pid → key → entry). */
const changedLeafCount = (a, b) => {
  let n = 0;
  for (const pid of Object.keys(b)) n += changedKeyCount(asObj(a[pid]), asObj(b[pid]));
  return n;
};

/**
 * The extension's own version for the export header — best-effort (absent in
 * node tests / stripped contexts, where `runtime.getManifest` doesn't exist).
 * @returns {string | undefined}
 */
const extensionVersion = () => {
  try {
    const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
    return (g.browser ?? g.chrome)?.runtime?.getManifest?.()?.version;
  } catch {
    return undefined;
  }
};

/**
 * One export/import dataset. `read` doubles as the import merge-target
 * loader; `exportRead` (optional) overrides the export source — the player
 * cache uses it to ship only the WATCHED players' metadata instead of the
 * unbounded server-wide roster.
 *
 * @typedef {object} IoSlot
 * @property {string} field  Payload field under `data` (and the v1 top level
 *   for the two legacy datasets).
 * @property {string} label  Plural noun for the import summary ("+3 <label>").
 * @property {(uni: string) => Promise<any>} read
 * @property {(uni: string) => Promise<any>} [exportRead]
 * @property {(uni: string, merged: any) => Promise<void>} write
 * @property {(local: any, incoming: any) => { merged: any, changed: boolean }} merge
 * @property {(local: any, merged: any) => number} count  Entries the import
 *   added/updated — the user-facing number, computed AFTER the merge.
 * @property {(v: any) => boolean} nonEmpty  Include in the export?
 */

/**
 * A whole-slot LWW config pair (`<key>` + `<key>Ts`) — Daily Run routes,
 * galaxy-scan config, alarmClock config. The gist syncs these
 * newest-`updatedAt`-wins on the whole slot (sync/merge.js
 * mergeNewestConfigSlot); the import applies the SAME rule to an opaque
 * `{ value, updatedAt }` pair, so no domain shape knowledge is needed here —
 * every reader normalises on hydrate anyway.
 *
 * @param {string} field
 * @param {string} label
 * @param {(uni: string) => string} valueKeyFor
 * @param {(uni: string) => string} tsKeyFor
 * @returns {IoSlot}
 */
const lwwConfigSlot = (field, label, valueKeyFor, tsKeyFor) => ({
  field,
  label,
  read: async (uni) => ({
    value: await chromeStore.get(valueKeyFor(uni)),
    updatedAt: asTs(await chromeStore.get(tsKeyFor(uni))),
  }),
  write: async (uni, merged) => {
    await chromeStore.set(valueKeyFor(uni), merged.value);
    await chromeStore.set(tsKeyFor(uni), merged.updatedAt);
  },
  merge: (local, incoming) => {
    const inc = asObj(incoming);
    const incAt = asTs(inc.updatedAt);
    if (incAt > local.updatedAt && inc.value != null) {
      return { merged: { value: inc.value, updatedAt: incAt }, changed: true };
    }
    return { merged: local, changed: false };
  },
  count: () => 1, // whole-slot adoption — "1 config" either way
  nonEmpty: (v) => v.value != null && v.updatedAt > 0,
});

/** @type {IoSlot[]} */
const IO_SLOTS = [
  {
    field: 'colonyHistory',
    label: 'colonies',
    read: async (uni) => /** @type {ColonyHistory} */ (asArr(await chromeStore.get(historyKeyFor(uni)))),
    write: (uni, merged) => chromeStore.set(historyKeyFor(uni), merged),
    merge: (local, incoming) => mergeHistory(local, asArr(incoming)),
    // Union dedups by cp (local-wins), so the size delta is the # of new cps.
    count: (local, merged) => merged.length - local.length,
    nonEmpty: (v) => v.length > 0,
  },
  {
    field: 'galaxyScans',
    label: 'scans',
    read: async (uni) => /** @type {GalaxyScans} */ (asObj(await chromeStore.get(scansKeyFor(uni)))),
    write: (uni, merged) => chromeStore.set(scansKeyFor(uni), merged),
    merge: (local, incoming) => mergeScans(local, asObj(incoming)),
    // Systems added or refreshed (new key, or an advanced scan / LF timestamp).
    count: (local, merged) => {
      let n = 0;
      for (const key of Object.keys(merged)) {
        const before = local[key];
        const after = merged[key];
        if (
          !before ||
          before.scannedAt !== after.scannedAt ||
          (before.lfScannedAt ?? 0) !== (after.lfScannedAt ?? 0)
        ) {
          n += 1;
        }
      }
      return n;
    },
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  {
    field: 'watchList',
    label: 'watch entries',
    // Seeded read on BOTH paths: unseeded (all-`ts:0`) local records would
    // lose every LWW race against an imported file's stamps — an import must
    // never wipe local decisions (the same first-sync invariant the gist
    // path pins).
    read: async (uni) => {
      const { cfg, ledger } = await ensureWatchListLedgerSeeded(uni);
      return composeWatchSlot(cfg, ledger);
    },
    write: async (uni, merged) => {
      await applyWatchListSyncSlot(uni, merged);
    },
    merge: (local, incoming) => mergeWatchList(local, incoming, Date.now()),
    count: (local, merged) => {
      let n = 0;
      for (const fam of WATCH_FAMILIES) n += changedKeyCount(asObj(local[fam]), asObj(merged[fam]));
      return n;
    },
    nonEmpty: watchSlotHasData,
  },
  {
    field: 'targetReports',
    label: 'spy reports',
    read: async (uni) => asObj(await chromeStore.get(targetReportsKeyFor(uni))),
    write: (uni, merged) => chromeStore.set(targetReportsKeyFor(uni), merged),
    merge: (local, incoming) => mergeTargetReports(local, asObj(incoming)),
    count: (local, merged) => changedLeafCount(local, merged),
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  {
    field: 'proximityReports',
    label: 'proximity alerts',
    read: async (uni) => asArr(await chromeStore.get(proximityReportsKeyFor(uni))),
    write: (uni, merged) => chromeStore.set(proximityReportsKeyFor(uni), merged),
    merge: (local, incoming) => mergeProximityReports(local, asArr(incoming)),
    count: (local, merged) => Math.max(0, merged.length - local.length),
    nonEmpty: (v) => v.length > 0,
  },
  {
    field: 'activityObs',
    label: 'activity looks',
    read: async (uni) => asObj(await chromeStore.get(activityObsKeyFor(uni))),
    write: (uni, merged) => chromeStore.set(activityObsKeyFor(uni), merged),
    merge: (local, incoming) => mergeActivityObs(local, asObj(incoming)),
    count: (local, merged) => {
      /** @param {Record<string, Record<string, any[]>>} m @returns {number} */
      const looks = (m) => {
        let n = 0;
        for (const bodies of Object.values(m)) for (const ring of Object.values(asObj(bodies))) n += asArr(ring).length;
        return n;
      };
      return Math.max(0, looks(merged) - looks(local));
    },
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  {
    field: 'players',
    label: 'player profiles',
    read: async (uni) => asObj(await chromeStore.get(playersKeyFor(uni))),
    // Export ONLY the watched players' metadata ("playersLite") — the full
    // roster cache grows with every player ever seen server-wide and would
    // bloat the file with rebuild-able data; the watched subset is what makes
    // dossiers readable on a fresh machine.
    exportRead: async (uni) => {
      const cfg = normalizeWatchList(await chromeStore.get(watchListKeyFor(uni)));
      const watched = new Set(cfg.players.map(String));
      const all = asObj(await chromeStore.get(playersKeyFor(uni)));
      /** @type {Record<string, any>} */
      const lite = {};
      for (const [id, meta] of Object.entries(all)) {
        if (watched.has(String(id))) lite[id] = meta;
      }
      return lite;
    },
    write: (uni, merged) => chromeStore.set(playersKeyFor(uni), merged),
    merge: (local, incoming) => mergePlayerCache(local, asObj(incoming)),
    count: (local, merged) => changedKeyCount(local, merged),
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  {
    field: 'allianceClass',
    label: 'alliance classes',
    read: async (uni) => asObj(await chromeStore.get(allianceClassKeyFor(uni))),
    write: (uni, merged) => chromeStore.set(allianceClassKeyFor(uni), merged),
    merge: (local, incoming) => mergeAllianceClassMap(local, asObj(incoming)),
    count: (local, merged) => changedKeyCount(local, merged),
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  {
    field: 'bodies',
    label: 'own bodies',
    read: async (uni) => {
      const raw = asObj(await chromeStore.get(bodiesKeyFor(uni)));
      return { bodies: asArr(raw.bodies), capturedAt: asTs(raw.capturedAt) };
    },
    write: (uni, merged) => chromeStore.set(bodiesKeyFor(uni), merged),
    merge: (local, incoming) => mergeBodyInventory(local, asObj(incoming)),
    count: (local, merged) => merged.bodies.length,
    nonEmpty: (v) => v.capturedAt > 0,
  },
  {
    field: 'colonizeDecisions',
    label: 'colonize decisions',
    read: async (uni) => asObj(await chromeStore.get(colonizeDecisionsKeyFor(uni))),
    write: (uni, merged) => chromeStore.set(colonizeDecisionsKeyFor(uni), merged),
    merge: (local, incoming) => mergeColonizeDecisions(local, asObj(incoming)),
    count: (local, merged) => changedKeyCount(local, merged),
    nonEmpty: (v) => Object.keys(v).length > 0,
  },
  lwwConfigSlot('dailyRunRoutes', 'Daily Run config', dailyRunRoutesKeyFor, dailyRunRoutesTsKeyFor),
  lwwConfigSlot('galaxyScanConfig', 'scan config', galaxyScanConfigKeyFor, galaxyScanConfigTsKeyFor),
  lwwConfigSlot('alarmClockConfig', 'alarm config', alarmClockConfigKeyFor, alarmClockConfigTsKeyFor),
];

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
 * Download the selected universe's dataset as a JSON file (compact — spy
 * reports + activity rings can push a heavy account into the megabytes, and
 * pretty-printing would double it). Every registered slot with data is
 * included; empty ones are omitted so the file stays honest about what it
 * carries. When the WebExtension API is absent and `document` is missing
 * (node tests), this resolves without writing.
 *
 * Filename embeds the universe id so a user managing several servers can
 * tell exports apart at a glance: `oge-s163-pl-2026-07-08.json`.
 *
 * @param {string} universeId  Selected universe (e.g. `'s163-pl'`).
 * @returns {Promise<{ datasets: number, bytes: number }>} What was written
 *   (dataset count + serialized size) for the status line.
 */
export const exportAllData = async (universeId) => {
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const slot of IO_SLOTS) {
    const value = await (slot.exportRead ?? slot.read)(universeId);
    if (slot.nonEmpty(value)) data[slot.field] = value;
  }

  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: extensionVersion(),
    universeId,
    data,
  };

  const json = JSON.stringify(payload);
  const result = { datasets: Object.keys(data).length, bytes: json.length };

  // No DOM = no download target. Stay silent instead of throwing so
  // callers running under node/test environments can await us safely.
  if (typeof document === 'undefined') return result;

  downloadBlob(new Blob([json], { type: 'application/json' }), `oge-${universeId}-${todayIso()}.json`);
  return result;
};

/**
 * One import summary line: the dataset label + how many entries the merge
 * added or updated.
 * @typedef {{ label: string, count: number }} ImportPart
 */

/**
 * Parse a user-uploaded JSON file and merge it into the selected universe's
 * keys in `chrome.storage.local`, one registered slot at a time. Every slot
 * is independently optional — a file carrying only `colonyHistory` leaves
 * everything else untouched. Version 1 files (top-level fields) and version
 * 2 files (`data: {...}`) both import; unknown `data` fields are skipped and
 * returned in `skipped` so the caller can say so (a file from a NEWER OG-E
 * degrades to a partial import instead of a hard reject).
 *
 * On parse failure or an unknown version, returns an empty result with a
 * `warning` describing the reason. This is the one place we wrap awaits in
 * try/catch because the failure mode IS user-visible.
 *
 * @param {File} file
 * @param {string} universeId  Selected universe (destination of the merge).
 * @returns {Promise<{ parts: ImportPart[], skipped: string[], warning?: string }>}
 */
export const importAllData = async (file, universeId) => {
  /** @type {unknown} */
  let parsed;
  try {
    const text = await readFileAsText(file);
    parsed = JSON.parse(text);
  } catch {
    return { parts: [], skipped: [], warning: 'Invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { parts: [], skipped: [], warning: 'Invalid JSON' };
  }

  const imported = /** @type {Record<string, unknown>} */ (parsed);

  /** @type {Record<string, unknown>} */
  let data;
  /** @type {string[]} */
  const skipped = [];
  if (imported.version === LEGACY_VERSION) {
    // v1: the two datasets sat at the top level.
    data = {};
    if (imported.colonyHistory != null) data.colonyHistory = imported.colonyHistory;
    if (imported.galaxyScans != null) data.galaxyScans = imported.galaxyScans;
  } else if (imported.version === EXPORT_VERSION) {
    data = asObj(imported.data);
  } else {
    return { parts: [], skipped: [], warning: 'Unsupported version' };
  }

  const known = new Set(IO_SLOTS.map((s) => s.field));
  for (const field of Object.keys(data)) {
    if (!known.has(field) && !IGNORED_FIELDS.has(field)) skipped.push(field);
  }

  /** @type {ImportPart[]} */
  const parts = [];
  for (const slot of IO_SLOTS) {
    if (!(slot.field in data) || data[slot.field] == null) continue;
    const local = await slot.read(universeId);
    const { merged, changed } = slot.merge(local, data[slot.field]);
    if (!changed) continue;
    await slot.write(universeId, merged);
    const count = slot.count(local, merged);
    if (count > 0) parts.push({ label: slot.label, count });
  }

  return { parts, skipped };
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
