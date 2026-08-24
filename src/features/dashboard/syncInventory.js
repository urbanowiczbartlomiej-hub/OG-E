// @ts-check
//
// Pure core for the dashboard "Sync" view: turn a flat chrome.storage.local
// snapshot into a per-universe inventory (what data is stored + how big) plus
// the mirrored sync-status freshness. No DOM, no chrome.*, no timers — every
// function here is deterministic (the freshness classifier takes `now` as an
// argument) so it is unit-testable in isolation.
//
// chrome.storage.local holds one namespaced key per (universe, data category):
// `<universeId>:oge_<name>` (see state/universeKey.js). The game side also
// mirrors each universe's sync status under `<universeId>:oge_syncStatus`
// (see sync/gist.js → mirrorSyncStatusToChrome) so this extension-origin page
// can show per-universe ↑/↓ times without reading game-origin localStorage.

/** Base suffix of the per-universe sync-status mirror key (sync/gist.js). */
export const SYNC_STATUS_BASE = 'oge_syncStatus';

/** A sync whose newest ↑/↓ is older than this reads as "stale" on the chip. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Friendly labels for the known per-universe data bases. An unknown base
 * falls back to its raw string, so a category added later still renders
 * (just without a polished name) instead of silently vanishing.
 *
 * @type {Record<string, string>}
 */
const CATEGORY_LABELS = {
  oge_galaxyScans: 'Galaxy scans',
  oge_colonyHistory: 'Colony history',
  oge_players: 'Player cache',
  oge_ownProfile: 'Own profile',
  oge_galaxyScanConfig: 'Scan config',
  oge_bodies: 'Planet/moon sizes',
  oge_dailyRunRoutes: 'Daily Run routes',
  oge_alarmClockConfig: 'Alarm clock config',
  oge_apiCache: 'API cache',
  oge_colonizeDecisions: 'Colonization decisions',
  oge_watchedPlayers: 'Watch list',
  oge_targetReports: 'Spy reports',
  oge_activityObs: 'Activity observations',
  oge_presenceLedger: 'Presence ledger',
  oge_proximityReports: 'Proximity alerts',
  oge_allianceClass: 'Alliance classes',
  oge_allianceIntel: 'Alliance intel',
};

/**
 * Bases whose data actually LEAVES the device — the slots the sync engine
 * PATCHes into the personal gist (`sync/gist.js` GistPayload; the SYNC_SLOTS
 * registry in `sync/scheduler.js` is the writer), plus the alliance-share doc.
 * Everything NOT listed here (most prominently the multi-MB `oge_apiCache`,
 * which is fully re-fetchable from the OGame public API, and the §4b-retired
 * `oge_ownProfile`) is a device-local cache that never enters any gist. This
 * view previously offered no such distinction, so the
 * per-universe Total read as "this much is synced" — the source of the
 * "sync is 2.3 MB, mostly API cache" misread.
 *
 * @type {Set<string>}
 */
const GIST_SYNCED_BASES = new Set([
  'oge_colonyHistory',
  'oge_galaxyScanConfig',
  'oge_dailyRunRoutes',
  'oge_alarmClockConfig',
  'oge_colonizeDecisions',
  'oge_watchedPlayers',
  'oge_targetReports',
  'oge_activityObs',
  'oge_presenceLedger',
  'oge_proximityReports',
  'oge_allianceIntel',
]);

/**
 * Bases only PARTIALLY synced:
 *   - `oge_players` ships as the filtered watched ∪ observed "playersLite"
 *     subset — the full server roster stays local.
 *   - `oge_galaxyScans` ships ONLY its lifeform-discovery markers
 *     (`lfDiscoveryPerUniverse`). The fat per-slot occupancy §4b removed is
 *     still device-local and re-derived from the public API.
 *
 * @type {Set<string>}
 */
const PARTIAL_SYNCED_BASES = new Set(['oge_players', 'oge_galaxyScans']);

/**
 * Classify how a base relates to cross-device sync.
 *
 * @param {string} base
 * @returns {'synced' | 'partial' | 'local'}
 */
export const classifyBaseSync = (base) => {
  if (GIST_SYNCED_BASES.has(base)) return 'synced';
  if (PARTIAL_SYNCED_BASES.has(base)) return 'partial';
  return 'local';
};

/**
 * @typedef {object} SyncStatusSnapshot
 * @property {string | null} [up]    ISO of last successful upload, null/absent if none.
 * @property {string | null} [down]  ISO of last successful download.
 * @property {string | null} [err]   Last error message, or null on success.
 * @property {number} [backoffUntil] Epoch-ms until rate-limit backoff lifts, 0 if none.
 */

/**
 * @typedef {object} CategoryEntry
 * @property {string} base    The `oge_*` base suffix.
 * @property {string} label   Friendly label (or the raw base for unknowns).
 * @property {number} bytes   Approx serialized size of the stored value.
 * @property {number | null} count Item count (array length / object key count), null for scalars.
 * @property {'synced' | 'partial' | 'local'} sync
 *   Whether this data rides the gist (see {@link classifyBaseSync}).
 */

/**
 * @typedef {object} UniverseInventory
 * @property {string} universeId
 * @property {SyncStatusSnapshot | null} status
 * @property {CategoryEntry[]} categories  Sorted by label; the status key is excluded.
 * @property {number} totalBytes
 * @property {number} syncedBytes  Sum over synced + partial categories — what
 *   can actually travel cross-device (upper bound: partial slots ship a subset).
 * @property {number} localBytes   Sum over device-local categories (never synced).
 */

/**
 * Approx serialized size of a value, in chars (≈ bytes for ASCII-ish JSON).
 *
 * @param {unknown} v
 * @returns {number}
 */
const sizeOf = (v) => {
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s.length : 0;
  } catch {
    return 0;
  }
};

/**
 * Item count for a container value; null for scalars / null.
 *
 * @param {unknown} v
 * @returns {number | null}
 */
const countOf = (v) => {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return null;
};

/**
 * Split a chrome.storage key into `{ universeId, base }` when it is a
 * per-universe `<universeId>:oge_*` key; null for global / unrelated keys
 * (no colon, or a part after the colon that isn't an `oge_` base).
 *
 * Splits on the FIRST colon: universe ids are `s\d+-<lang>` (no colon) and
 * bases are `oge_*` (no colon), so the first colon is always the separator.
 *
 * @param {string} key
 * @returns {{ universeId: string, base: string } | null}
 */
export const parsePerUniverseKey = (key) => {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const base = key.slice(i + 1);
  if (!base.startsWith('oge_')) return null;
  return { universeId: key.slice(0, i), base };
};

/**
 * Every chrome.storage.local key belonging to one universe — the exact set the
 * abandon flow deletes.
 *
 * DELIBERATELY WIDER than the inventory above: this includes the plumbing the
 * inventory hides (`…Ts` ledgers, the `oge_syncStatus` mirror, the
 * `oge_syncRequestAt` command key) and any base this build has never heard of.
 * Abandoning must leave NOTHING behind — a surviving `…Ts` stamp would make the
 * next re-import lose every LWW race against a ghost, and a surviving
 * `oge_ownProfile` would keep the universe alive in the dashboard's selector
 * (`discoverUniverses` counts it as evidence of play). Structural rule, not a
 * whitelist, so a base added after this code was written is still purged.
 *
 * Global (non-namespaced) keys are never touched: they belong to the other
 * universes too.
 *
 * @param {Record<string, unknown>} all  chromeStore.getAll() result.
 * @param {string} universeId
 * @returns {string[]}  Full keys, sorted for a stable log/undo order.
 */
export const universeStorageKeys = (all, universeId) => {
  if (!universeId) return [];
  return Object.keys(all)
    .filter((key) => parsePerUniverseKey(key)?.universeId === universeId)
    .sort();
};

/**
 * Whether a base is sync PLUMBING rather than stored data: the `…Ts`
 * conflict-resolution timestamps that sit beside each synced slot, and the
 * command-channel keys the dashboard/scheduler use to signal one another
 * (`oge_syncRequestAt`; `oge_resetGalaxyAt` is a LEGACY residue — its writer
 * and consumer are gone with the Scanned-data accordion, but old installs may
 * still hold the key). These are internal bookkeeping — a few bytes each — so
 * they're kept out of the "what's stored" inventory.
 *
 * @param {string} base
 * @returns {boolean}
 */
const isPlumbingBase = (base) =>
  base.endsWith('Ts') || base === 'oge_syncRequestAt' || base === 'oge_resetGalaxyAt';

/**
 * Build the per-universe inventory + status list from a flat
 * chrome.storage.local snapshot. Universes are discovered from ANY
 * `<id>:oge_*` key (including a lone status mirror), so a universe that
 * attempted a sync but stored no data still surfaces.
 *
 * @param {Record<string, unknown>} all  chromeStore.getAll() result.
 * @returns {UniverseInventory[]}  Sorted by universeId.
 */
export const buildSyncInventory = (all) => {
  /** @type {Map<string, UniverseInventory>} */
  const byUniverse = new Map();
  /** @param {string} id @returns {UniverseInventory} */
  const slot = (id) => {
    let u = byUniverse.get(id);
    if (!u) {
      u = {
        universeId: id,
        status: null,
        categories: [],
        totalBytes: 0,
        syncedBytes: 0,
        localBytes: 0,
      };
      byUniverse.set(id, u);
    }
    return u;
  };

  for (const [key, value] of Object.entries(all)) {
    const parsed = parsePerUniverseKey(key);
    if (!parsed) continue;
    const u = slot(parsed.universeId);
    if (parsed.base === SYNC_STATUS_BASE) {
      u.status =
        value && typeof value === 'object' && !Array.isArray(value)
          ? /** @type {SyncStatusSnapshot} */ (value)
          : null;
      continue;
    }
    if (isPlumbingBase(parsed.base)) continue;
    const bytes = sizeOf(value);
    const sync = classifyBaseSync(parsed.base);
    u.categories.push({
      base: parsed.base,
      label: CATEGORY_LABELS[parsed.base] ?? parsed.base,
      bytes,
      count: countOf(value),
      sync,
    });
    u.totalBytes += bytes;
    if (sync === 'local') u.localBytes += bytes;
    else u.syncedBytes += bytes;
  }

  const list = [...byUniverse.values()];
  for (const u of list) u.categories.sort((a, b) => a.label.localeCompare(b.label));
  list.sort((a, b) => a.universeId.localeCompare(b.universeId));
  return list;
};

/**
 * Epoch-ms of the newer of the given ISO timestamps; null if none parse.
 *
 * @param {...(string | null | undefined)} isos
 * @returns {number | null}
 */
const mostRecent = (...isos) => {
  /** @type {number | null} */
  let best = null;
  for (const iso of isos) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best;
};

/**
 * Compact "just now" / "5m ago" / "3h ago" / "2d ago" from a positive age.
 *
 * @param {number} ageMs
 * @returns {string}
 */
const relativeAge = (ageMs) => {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/**
 * Classify a universe's sync freshness for the status chip. Priority:
 * an active rate-limit backoff first, then a recorded error, then recency of
 * the newest ↑/↓ (≤24h ⇒ ok, older ⇒ stale), finally "never synced".
 *
 * @param {SyncStatusSnapshot | null} status
 * @param {number} now  Epoch-ms (caller passes Date.now()).
 * @returns {{ tone: 'ok'|'stale'|'error'|'backoff'|'never', label: string }}
 */
export const classifySyncFreshness = (status, now) => {
  if (!status) return { tone: 'never', label: 'never synced' };
  if (typeof status.backoffUntil === 'number' && status.backoffUntil > now) {
    const mins = Math.ceil((status.backoffUntil - now) / 60000);
    return { tone: 'backoff', label: `rate-limited (~${mins} min)` };
  }
  if (status.err) return { tone: 'error', label: 'last sync failed' };
  const last = mostRecent(status.up ?? null, status.down ?? null);
  if (last === null) return { tone: 'never', label: 'never synced' };
  const ageMs = now - last;
  return ageMs <= STALE_AFTER_MS
    ? { tone: 'ok', label: relativeAge(ageMs) }
    : { tone: 'stale', label: relativeAge(ageMs) };
};

/**
 * Human size: B / KB / MB from a char/byte count.
 *
 * @param {number} n
 * @returns {string}
 */
export const formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
