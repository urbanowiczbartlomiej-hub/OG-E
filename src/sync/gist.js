// GitHub Gist sync client — the only place OG-E speaks to a remote network.
//
// # Role
//
// Cross-device sync of the user's own locally-collected OGame state
// (galaxy-scan classifications, colony-history observations) via
// *their own* private GitHub gist. Every byte this module sends or
// receives flows through `api.github.com` using a Personal Access
// Token the user has personally pasted into Settings. Crucially, this
// module **never** addresses the game server — OG-E's position in the
// TOS line is that we only read/parse game pages rendered to the user's
// own browser, and user data syncs out-of-band through a service the
// user controls. Keeping that rule machine-checkable is exactly why
// the network side lives here in isolation and nowhere else.
//
// # Authentication
//
// The user supplies a classic PAT with `gist` scope (the single
// smallest permission that lets us create/patch a private gist). The
// token string lives in `localStorage` under {@link TOKEN_KEY}. On
// every read we run it through {@link sanitizeToken} which strips any
// byte outside printable ASCII (0x21..0x7E). Pastes from browsers and
// password managers routinely inject a stray BOM, non-breaking space,
// or trailing newline; those bytes slip past visual inspection but
// break `fetch`'s Authorization header (which is strict ISO-8859-1).
// The sanitizer defangs that class of bug without us having to ask
// the user to retype.
//
// # Rate-limit strategy
//
// GitHub's REST quota is 5000 authenticated requests per hour. Abuse
// detection and secondary rate limits (403 from burst writes) can fire
// earlier. Whenever the API returns 403 or 429 we parse the rate-limit
// signals — in priority order: `Retry-After` (seconds), then
// `X-RateLimit-Reset` (epoch seconds), then a default 5-minute backoff
// — and arm the module-local `backoffUntil` timestamp. Every
// subsequent {@link gh} call before that moment *throws immediately
// without a network round-trip*. This is essential: without it, the
// retry loop in the calling sync engine would just keep rebooting the
// failure and burn the remaining quota for the hour.
//
// The backoff is in-process state, not persisted: a full reload
// effectively resets it, but the first call after reload that does
// hit 403/429 re-arms it within milliseconds, so the only real cost
// of not persisting is one wasted round-trip per reload.
//
// # Why gzip + base64 for the payload
//
// A fully-scanned account's JSON is roughly 2 MB, dominated by
// repeated keys (`"status"`, `"positions"`, `"empty"`, ...). Gzip's
// LZ77 dedupes these almost perfectly — payloads land around 250 KB.
// That is the difference between a smooth sync and a visibly throttled
// one on slow mobile links, and it also keeps us well under GitHub's
// per-gist size limits. Gist files are stored as UTF-8 text, so the
// compressed bytes are base64-encoded on the way in (and decoded on
// the way out). The +33% base64 overhead still leaves the payload
// ~6× smaller than the raw JSON.
//
// # Status tracking
//
// Three localStorage keys record the module's last outcomes, read by
// the Settings UI to render "Last upload: ...", "Last download: ...",
// "Last error: ...":
//
//   - {@link LAST_UP_KEY}   — ISO timestamp of the last successful upload.
//   - {@link LAST_DOWN_KEY} — ISO timestamp of the last successful download.
//   - {@link LAST_ERR_KEY}  — Human-readable error message string, or
//                             absent when the last sync round succeeded.
//
// Writes go through {@link setStatus} which accepts `null` as
// "clear the key".
//
// # Testing affordances
//
// - {@link _resetGistStateForTest} zeros the in-process `backoffUntil`
//   so tests can exercise rate-limit arming without bleeding across
//   cases. Not part of the public API; the leading underscore is a
//   hard signal "do not call from feature code."
//
// @ts-check

/* global fetch */

import { gzipEncode, gzipDecode } from '../lib/gzip.js';
import { safeLS, chromeStore } from '../lib/storage.js';
import { parseUniverseId } from '../lib/universeId.js';
import { SYNC_STATUS_EVENT } from '../lib/ogeEvents.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../state/history.js').ColonyHistory} ColonyHistory
 */

/**
 * Shape of the JSON we compress and store in the gist's single data file.
 * The whole payload is serialised, gzipped, base64-encoded, then shoved
 * into the file's `content` field.
 *
 * @typedef {object} SyncedSettings
 * @property {Record<string, unknown>} values
 *   Synced preference values (every Settings key except the few that are
 *   per-device — see `EXCLUDED_SETTINGS` in `sync/settingsSync.js`).
 * @property {Record<string, number>} ts
 *   Per-key last-change epoch-ms timestamps, the merge granularity for
 *   {@link import('./merge.js').mergeSettings} (newer wins).
 */

/**
 * Shape of the JSON we compress and store in the gist's single data file.
 * The whole payload is serialised, gzipped, base64-encoded, then shoved
 * into the file's `content` field.
 *
 * @typedef {object} GistPayload
 * @property {1} version
 *   Schema version. Pinned to 1 — readers reject anything else via
 *   {@link fetchGistData}'s schema guard, which keeps us from
 *   accidentally interpreting an off-schema blob as the current
 *   shape if the user ever edits the gist by hand.
 * @property {string} updatedAt
 *   ISO timestamp stamped by the writer at the moment it chose to
 *   upload. Informational — consumers use per-record timestamps
 *   (`scannedAt`, history `timestamp`) to decide merges, not this.
 * @property {Record<string, GalaxyScans>} [galaxyScansPerUniverse]
 *   OPTIONAL, additive: galaxy-scan maps keyed by universe id. Each slot is a
 *   {@link GalaxyScans} merged per-system, newer-`scannedAt`-wins (see
 *   {@link import('./merge.js').mergeScans}). Per-universe because a scan is
 *   server-specific — `3:265` on one universe is a different planet than on
 *   another — so the old single global `galaxyScans` field let one server's
 *   scans bleed into another's colonize candidates on a second device. New
 *   readers do NOT fall back to that legacy field: it is contaminated by
 *   construction (a union of every universe), so adopting it would re-pollute.
 *   Absent on gists written before this migration → treated as "no remote
 *   scans for this universe yet", keeping local.
 * @property {Record<string, ColonyHistory>} [colonyHistoryPerUniverse]
 *   OPTIONAL, additive: per-universe colony-history observations keyed by
 *   universe id. Each slot is a {@link ColonyHistory} list merged by union
 *   (dedup by `cp`, local-wins — see {@link import('./merge.js').mergeHistory}).
 *   Per-universe because the histogram is per-server: a single global list let
 *   one server's observations land under another server's key on a second
 *   device, leaving the histogram empty there.
 * @property {SyncedSettings} [settings]
 *   OPTIONAL, additive (no version bump): synced user preferences. Absent
 *   on gists written before this feature; new readers treat absence as
 *   "nothing to merge", old readers ignore the unknown field. That two-way
 *   tolerance is why this could be added without a schema-version change.
 * @property {Record<string, DailyRunRoutesSlot>} [dailyRunRoutes]
 *   OPTIONAL, additive (same two-way tolerance as `settings`): fleet-save
 *   routes keyed by universe id. Each slot is whole-universe newest-wins
 *   (see {@link import('./merge.js').mergeDailyRunRoutes}). Per-universe because,
 *   unlike scans/history, routes target a specific server's own bodies and
 *   must never leak across universes.
 * @property {Record<string, SyncedSettings>} [settingsPerUniverse]
 *   OPTIONAL, additive: game-logic settings keyed by universe id. Each slot
 *   uses the same `{ values, ts }` shape as `settings` but carries only the
 *   keys listed in `UNIVERSE_SCOPED_SETTINGS` (see `sync/settingsSync.js`).
 *   Per-universe because these parameters (maxExpeditionsPerPlanet,
 *   alarmClockNtfyToken) depend on which OGame server the user is playing and
 *   must not leak across universes. The top-level `settings` field retains
 *   only global preferences.
 * @property {Record<string, import('../state/dailyActions.js').DailyState>} [dailyStatePerUniverse]
 *   OPTIONAL, additive: daily-action completion state keyed by universe id.
 *   Each slot is a {@link import('../state/dailyActions.js').DailyState} object.
 *   Merge strategy: per-field max-wins (a later day string / higher timestamp
 *   always beats an earlier one). Per-universe because tasks are server-specific
 *   and must not leak across universes.
 * @property {Record<string, import('../state/manualLandedFs.js').ManualLandedFsSlot>} [manualLandedFsPerUniverse]
 *   OPTIONAL, additive: the user's manual fleet-save marks per universe. Merge
 *   strategy: last-writer-wins on the whole set (keyed by `updatedAt`) so an
 *   unmark / re-save propagates instead of being resurrected by another device.
 * @property {Record<string, import('./merge.js').GalaxyScanConfigSlot>} [galaxyScanConfig]
 *   OPTIONAL, additive: Galaxy-Scan config (positions + rescan policy) keyed
 *   by universe id. Each slot is whole-universe newest-wins (see
 *   {@link import('./merge.js').mergeGalaxyScanConfig}). Per-universe because
 *   the scan strategy depends on which OGame server is being played.
 *   `colonyPassword` NEVER rides in this slot — device-local by policy
 *   (domain/galaxyScanConfig `sanitizeGalaxyScanConfigForWire`); the
 *   scheduler blanks it on compose/merge and preserves the local one on apply.
 * @property {Record<string, import('./merge.js').AlarmClockConfigSlot>} [alarmClockConfigPerUniverse]
 *   OPTIONAL, additive: per-universe alarmClock config (wave enable + schedule,
 *   ad-hoc lead time, message templates) keyed by universe id. Each slot is
 *   whole-universe newest-wins (see
 *   {@link import('./merge.js').mergeAlarmClockConfig}). Per-universe because the
 *   alarmClock cadence is configured per server.
 * @property {Record<string, import('../state/players.js').PlayerCache>} [playersPerUniverse]
 *   LEGACY, no longer written: per-universe player-metadata cache (rank,
 *   alliance, honour, flags) keyed by universe id. §4b stopped syncing this —
 *   the writer leaves it `undefined` and its merge helper was removed. The key
 *   is retained here only so {@link import('./scheduler/pure.js').gistIsCurrent}
 *   still compares it: a gist written before §4b that still carries this slot
 *   reads "not current" against our `undefined` and gets slimmed by one PATCH.
 * @property {Record<string, import('../state/ownProfile.js').OwnProfile>} [ownProfilePerUniverse]
 *   LEGACY, no longer written: our own standing (rank, name, honour class)
 *   keyed by universe id. Dropped alongside `playersPerUniverse` in §4b (writer
 *   omits it, merge helper removed). Retained in this typedef for the same
 *   reason: {@link import('./scheduler/pure.js').gistIsCurrent} compares it so a
 *   pre-§4b gist still carrying it is detected and slimmed on the next PATCH.
 * @property {Record<string, import('../domain/colonizeDecisions.js').DecisionMap>} [colonizeDecisionsPerUniverse]
 *   OPTIONAL, additive: the colonization decision log keyed by universe id —
 *   the small "looks-free-but-isn't" correction set (sent/mine/abandoned/
 *   taken/reserved) the public API can't reproduce. Each slot is merged per
 *   coord, monotonic + newest-`ts`-wins (terminal outcomes never regress; see
 *   {@link import('../domain/colonizeDecisions.js').mergeColonizeDecisions}).
 *   Per-universe because a coord is server-specific. This is the colonization
 *   state that powers cross-device "continue only the remaining free positions".
 * @property {Record<string, import('../domain/watchListMerge.js').WatchListSyncSlot>} [watchListPerUniverse]
 *   OPTIONAL, additive (same two-way tolerance as `settings`): the Spyglass
 *   watch-list DECISIONS keyed by universe id — starred players, map
 *   colours, scan/galaxy-watch modes, map mutes, body filter and cadence, each a
 *   per-key `{ v?, ts }` family merged newest-`ts`-wins with removal
 *   tombstones (see {@link import('../domain/watchListMerge.js').mergeWatchList}).
 *   `probes` / `rescan` are deliberately absent (per-device). Per-universe
 *   because player ids are server-specific. NOTE while devices run mixed
 *   versions: a pre-1.40 writer omits this field, so its PATCH drops it until
 *   a 1.40 device's next round restores it from local — transient, converges
 *   once all devices update (same exposure every additive field had).
 */

/**
 * @typedef {import('./merge.js').DailyRunRoutesSlot} DailyRunRoutesSlot
 */

// ── Storage keys ────────────────────────────────────────────────────

/**
 * localStorage key for the user's GitHub Personal Access Token.
 * Namespaced with the `oge_` prefix every OG-E key shares so any
 * legacy state never collides.
 */
export const TOKEN_KEY = 'oge_gistToken';

/** localStorage key caching our gist id once discovered/created. */
export const GIST_ID_KEY = 'oge_gist';

/** localStorage key holding the ISO timestamp of the last successful upload. */
export const LAST_UP_KEY = 'oge_lastSyncAt';

/** localStorage key holding the ISO timestamp of the last successful download. */
export const LAST_DOWN_KEY = 'oge_lastDownAt';

/** localStorage key holding the last error message, or absent on success. */
export const LAST_ERR_KEY = 'oge_lastSyncErr';

/**
 * localStorage key holding the epoch-ms until which API calls are backing off
 * after a 403/429 (see {@link gh}). Written when backoff arms so the Settings
 * "Sync status" row can show a "rate-limited — retry after HH:MM" line instead
 * of a bare error. A past value is simply ignored by the reader, so no explicit
 * clear is needed when the window lifts.
 */
export const BACKOFF_KEY = 'oge_syncBackoffUntil';

// SYNC_STATUS_EVENT (lib/ogeEvents.js) fires after any sync-status write (see
// {@link setStatus}), so a live status display can re-read immediately. The
// Settings "Sync status" row listens for it (via the asyncStatus control's
// `refreshEvent`).

// ── Gist identity ───────────────────────────────────────────────────

/** Filename under which the current gist stores its single compressed data file. */
export const GIST_FILENAME = 'oge-data.json.gz.b64';

/** Description GitHub shows for the current gist; also used as the discovery predicate. */
export const GIST_DESCRIPTION = 'OG-E sync data (compressed) — do not edit manually';

// ── Protocol constants ──────────────────────────────────────────────

/** Schema version baked into every written payload. See file header. */
const SCHEMA_VERSION = 1;

/** GitHub REST API base URL. All {@link gh} calls are built on top. */
export const API_BASE = 'https://api.github.com';

/**
 * Backoff duration used when a 403/429 comes back with no rate-limit
 * headers at all. 5 minutes matches the "secondary rate limit" window
 * GitHub documents and is conservative enough that we stop hammering
 * the API while still recovering automatically.
 */
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;

// ── Module-local state ──────────────────────────────────────────────

/**
 * Epoch-ms timestamp before which every {@link gh} call short-circuits
 * to a thrown "rate limited" error without touching the network. Zero
 * means "no active backoff". Armed by {@link gh} on 403/429. Cleared
 * implicitly when the clock moves past it. See file header for the
 * full strategy.
 *
 * SEEDED from the persisted {@link BACKOFF_KEY} at module load so the backoff
 * SURVIVES A PAGE RELOAD (and is shared across same-origin tabs). OGame reloads
 * the page constantly (every fleet send), and a fresh JS context would otherwise
 * reset this to 0 and immediately re-hammer GitHub after one 403 — exhausting the
 * 5000 req/h quota tab-by-tab. A stale past value is harmless: the `> now` check
 * just lets the next call through. The `typeof` guard keeps this a no-op (0) when
 * a test partially mocks `safeLS` without `int` — a module-load read must not
 * throw during import for a suite that never touches the gist client.
 */
let backoffUntil = typeof safeLS.int === 'function' ? safeLS.int(BACKOFF_KEY, 0) : 0;

// ── Small helpers (token + LS + status) ─────────────────────────────

/**
 * Strip anything outside printable ASCII (0x21..0x7E) from a pasted
 * token. Browsers and password managers routinely inject BOMs, NBSPs,
 * trailing newlines, and other invisibles that fetch's Authorization
 * header (strict ISO-8859-1) rejects.
 *
 * @param {string} raw
 * @returns {string}
 */
const sanitizeToken = (raw) => (raw || '').replace(/[^\x21-\x7e]/g, '');

/**
 * Read the sanitised GitHub PAT from localStorage. Returns `''` when no
 * token is stored — callers treat empty as "sync disabled" and skip.
 *
 * @returns {string}
 */
export const getToken = () => sanitizeToken(safeLS.get(TOKEN_KEY) || '');

/**
 * Read the cached gist id from localStorage, or `''` when not yet
 * discovered. {@link ensureGist} promotes this to a full id on first
 * successful discovery or creation.
 *
 * @returns {string}
 */
export const getGistId = () => safeLS.get(GIST_ID_KEY) || '';

/**
 * Cache the gist id in localStorage. Normally called by
 * {@link ensureGist}; exposed for tests and settings flows that want
 * to override the cached value (e.g. user paste of a pre-existing
 * gist id).
 *
 * @param {string} id
 * @returns {void}
 */
export const setGistId = (id) => safeLS.set(GIST_ID_KEY, id);

/**
 * Update one of the status keys (`'up'` / `'down'` / `'err'`). Passing
 * `null` as the value removes the key; any other value is written as
 * a raw string (timestamps are ISO-8601, errors are free-text).
 *
 * @param {'up' | 'down' | 'err'} kind
 * @param {string | null} value
 * @returns {void}
 */
export const setStatus = (kind, value) => {
  const key =
    kind === 'up'
      ? LAST_UP_KEY
      : kind === 'down'
        ? LAST_DOWN_KEY
        : LAST_ERR_KEY;
  if (value === null) safeLS.remove(key);
  else safeLS.set(key, value);
  // Nudge any live status display (the Settings "Sync status" row) to
  // re-read immediately. Without this the row only refreshed on the next
  // unrelated settings-store tick, so a manual "Sync now" that failed
  // showed nothing until you touched another setting. Covers every status
  // write (manual force-sync, background upload, clears, errors). Guarded
  // for non-DOM contexts (defensive — both origins that run this have one).
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
  }
  // Mirror the snapshot for the extension-origin Dashboard's Sync view (it
  // can't read this game origin's localStorage). Covers the backoff case too:
  // the rate-limit path arms BACKOFF_KEY then throws, which routes through a
  // caller's setStatus('err', …) — this read picks the fresh BACKOFF_KEY up.
  mirrorSyncStatusToChrome();
};

/**
 * chrome.storage.local key base for the per-universe sync-status mirror, read
 * by the OG-E Dashboard's Sync view. Full key: `<universeId>:oge_syncStatus`
 * (same namespace convention as the data slices — see state/universeKey.js).
 */
export const SYNC_STATUS_MIRROR_BASE = 'oge_syncStatus';

/**
 * Mirror this origin's current sync-status snapshot into chrome.storage.local
 * under `<universeId>:oge_syncStatus`, so the extension-origin Dashboard can
 * render each universe's ↑/↓ times + error/backoff in one cross-universe view.
 *
 * Best-effort and fire-and-forget — a mirror failure must never disturb a
 * sync. Reads localStorage (the source of truth) at call time, so it always
 * reflects whatever {@link setStatus} / the backoff path just wrote. A
 * dedicated per-universe key (not a shared dict) means no cross-origin
 * read-modify-write race. game-origin only — setStatus is never called at the
 * extension origin, where `location.host` wouldn't parse to a universe.
 *
 * @returns {void}
 */
const mirrorSyncStatusToChrome = () => {
  if (typeof location === 'undefined') return;
  const key = `${parseUniverseId(location.host)}:${SYNC_STATUS_MIRROR_BASE}`;
  const snapshot = {
    up: safeLS.get(LAST_UP_KEY),
    down: safeLS.get(LAST_DOWN_KEY),
    err: safeLS.get(LAST_ERR_KEY),
    backoffUntil: safeLS.int(BACKOFF_KEY, 0),
  };
  void chromeStore.set(key, snapshot).catch(() => {});
};

// ── GitHub API client ───────────────────────────────────────────────

/**
 * Reduce a GitHub error body to ONE short line for the thrown message
 * (which surfaces verbatim in the Settings "Sync status" row). GitHub
 * returns JSON like `{"message":"Bad credentials", ...}` — we take just
 * `message`; otherwise we collapse whitespace so a multi-line body can't
 * blow the status line up to several rows. Truncated for UI sizing.
 *
 * @param {string} text  Raw response body.
 * @returns {string}
 */
export const conciseErrorBody = (text) => {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === 'string' && j.message) return j.message;
  } catch {
    // Not JSON — fall through to the collapsed-text path.
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
};

/**
 * One-call GitHub API client with token, headers, and 403/429 backoff
 * baked in. Adds the `Accept`, `Authorization`, `X-GitHub-Api-Version`,
 * and (when a body is present) `Content-Type` headers to every request,
 * and parses the JSON response body on success.
 *
 * Pre-flight: when {@link backoffUntil} is in the future, throws
 * "rate limited — backing off until ... (~N min)" without issuing the
 * fetch. This is how we preserve the remaining quota once GitHub has
 * told us to slow down.
 *
 * On non-ok responses:
 *   - 403 / 429: parse rate-limit hints and arm backoff. Signals in
 *     priority order are `Retry-After` (seconds relative to now),
 *     then `X-RateLimit-Reset` (epoch seconds), then
 *     {@link DEFAULT_BACKOFF_MS}. This happens **before** we throw,
 *     so the caller's subsequent retries are suppressed.
 *   - Any non-ok: throws `HTTP <status>: <body-snippet-or-statusText>`.
 *     The body is truncated to 200 chars to keep error messages
 *     Settings-UI-sized.
 *
 * @param {string} path
 *   API path starting with `/` (e.g. `/gists`, `/gists/:id`). Combined
 *   with {@link API_BASE} to form the full URL.
 * @param {RequestInit} [options]
 *   Standard `fetch` options. Any headers provided win over our defaults.
 * @returns {Promise<any>}
 *   Parsed JSON response body on success.
 * @throws {Error}
 *   "No GitHub token" when no token is configured; "rate limited ..."
 *   when backoff is active; "HTTP ..." on any non-ok response.
 */
export const gh = async (path, options = {}) => {
  const now = Date.now();
  if (backoffUntil > now) {
    const minutes = Math.ceil((backoffUntil - now) / 60000);
    throw new Error(
      `rate limited — backing off until ${new Date(backoffUntil).toLocaleTimeString()} (~${minutes} min)`,
    );
  }

  const token = getToken();
  if (!token) throw new Error('No GitHub token');

  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      .../** @type {Record<string, string>} */ (options.headers || {}),
    },
  });

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      // Three possible rate-limit signals, in priority order. The
      // priority matches GitHub's own docs: `Retry-After` is the
      // concrete "wait N seconds" used by secondary limits;
      // `X-RateLimit-Reset` is the epoch second when the primary
      // 5000/hour quota resets; the default falls back when neither
      // header is present (some abuse-detector paths omit both).
      const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
      const reset = parseInt(res.headers.get('X-RateLimit-Reset') || '', 10);
      let waitMs = 0;
      if (retryAfter > 0) waitMs = retryAfter * 1000;
      else if (reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now());
      else waitMs = DEFAULT_BACKOFF_MS;
      backoffUntil = Date.now() + waitMs;
      // Mirror to localStorage so the Settings status row can show the
      // retry-after countdown. The throw below routes through the caller's
      // setStatus('err', …), which fires SYNC_STATUS_EVENT and repaints it.
      safeLS.set(BACKOFF_KEY, String(backoffUntil));
    }
    // Truncate the body to keep the thrown message Settings-UI-sized.
    // `.catch` makes the read defensive: some error bodies aren't text
    // decodable (e.g. upstream connection reset), in which case we fall
    // back to the status line.
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${conciseErrorBody(text) || res.statusText}`);
  }
  return res.json();
};

// ── Gist file reader (truncation-aware) ─────────────────────────────

/**
 * Pull the raw text content of one file out of a gist JSON blob,
 * resolving the GitHub "truncated" case when the file is >1 MB.
 *
 * GitHub's `/gists/:id` endpoint inlines file content up to 1 MB. If
 * the file is larger, `content` is a truncated prefix and the full
 * bytes must be fetched from `raw_url` via a separate request. Our
 * compressed payloads are much smaller than 1 MB in practice, but the
 * truncation guard is still correct handling — a user with a huge
 * account could conceivably cross the line.
 *
 * Returns `null` when the file is absent from the gist (e.g. a freshly
 * created gist that raced a read before the write settled).
 *
 * @param {any} gist
 *   Gist JSON as returned by `GET /gists/:id`. `any` because the full
 *   GitHub schema isn't worth typing for our one-field access.
 * @param {string} filename
 *   Exact filename to read (normally {@link GIST_FILENAME}).
 * @returns {Promise<string | null>}
 */
const readGistFile = async (gist, filename) => {
  const file = gist?.files?.[filename];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    // Must THROW on a non-ok response (mirroring gh()): returning the error
    // body would fail the JSON parse upstream and read as "empty gist" — and
    // the upload path treats null as license to rebuild the payload from
    // local, wiping every other universe's slots. An availability failure
    // has to abort the round via the caller's try/catch instead.
    if (!res.ok) throw new Error(`gist raw_url fetch failed: HTTP ${res.status}`);
    return res.text();
  }
  return file.content;
};

// ── Gist discovery + creation ─────────────────────────────────────────

/**
 * Return the id of the current gist, discovering or creating one as needed.
 *
 * Three-step resolution:
 *
 *   1. **Cached id** — if {@link GIST_ID_KEY} is populated, return it
 *      without a network call.
 *   2. **Existing gist** — list the user's gists (one page of 100;
 *      enough for any real account), match `description ===
 *      {@link GIST_DESCRIPTION}`. If found, cache and return its id.
 *   3. **Fresh create** — POST a new gist with an empty payload. On
 *      success, cache the new id and return it.
 *
 * @returns {Promise<string>} The gist id.
 * @throws When the underlying {@link gh} calls fail (no token, rate
 *   limited, network error on gist creation).
 */
/**
 * In-flight de-dupe for {@link ensureGist}. The scheduler (boot download) and
 * the alarmClock producer run under INDEPENDENT locks and both reach ensureGist
 * transitively; on a fresh device with no cached id, two concurrent callers
 * could each list (find none) and POST a new gist — orphaning a duplicate and
 * stranding whichever payload landed in the loser. Memoizing the in-progress
 * resolution makes concurrent callers await the SAME discovery+create.
 * @type {Promise<string> | null}
 */
let gistResolution = null;

export const ensureGist = async () => {
  const cached = getGistId();
  if (cached) return cached;
  if (gistResolution) return gistResolution;
  gistResolution = resolveGist().finally(() => {
    gistResolution = null;
  });
  return gistResolution;
};

/**
 * The actual discover-or-create, run single-flight via {@link ensureGist}.
 * @returns {Promise<string>}
 */
const resolveGist = async () => {
  // One page is enough: GitHub's default sort is updated-desc, and
  // nobody has more than 100 gists that would rank higher than their
  // OG-E gist.
  const gists = await gh('/gists?per_page=100');

  /** @type {Array<{ id: string, description: string, created_at?: string }>} */
  const list = gists || [];

  // Pick the OLDEST matching gist deterministically (smallest created_at) so
  // that if a cross-device first-boot race ever did create two, every device
  // converges on the same one instead of flapping between them.
  const existing = list
    .filter((g) => g.description === GIST_DESCRIPTION)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0];
  if (existing) {
    setGistId(existing.id);
    return existing.id;
  }

  /** @type {GistPayload} */
  const initialPayload = {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  const compressed = await gzipEncode(JSON.stringify(initialPayload));
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: compressed } },
    }),
  });
  setGistId(created.id);
  return created.id;
};

// ── Payload read / write / clear ────────────────────────────────────

/**
 * Pull and decode the current payload from the gist. Returns `null`
 * when the gist exists but the file is empty, when the encoded content
 * can't be decoded (bad base64, bad gzip, bad JSON), or when the
 * decoded payload's schema version doesn't match {@link SCHEMA_VERSION}.
 *
 * Any of those "null" cases is a signal to the sync engine to treat
 * the gist as empty and upload local state on the next round — the
 * merge result is the same either way because merge is commutative.
 *
 * @returns {Promise<GistPayload | null>}
 */
export const fetchGistData = async () => {
  const id = await ensureGist();
  const gist = await gh(`/gists/${id}`);
  const content = await readGistFile(gist, GIST_FILENAME);
  if (!content) return null;
  try {
    const json = await gzipDecode(content);
    const parsed = JSON.parse(json);
    // Reject anything whose version isn't exactly the schema we write —
    // a missing/unknown version means a hand-edited or off-schema blob,
    // which we treat as empty and overwrite on the next upload.
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null;
    return /** @type {GistPayload} */ (parsed);
  } catch {
    return null;
  }
};

/**
 * Gzip-compress, base64-encode, and PATCH the given payload into the
 * gist's data file. Creates / discovers the gist if needed.
 *
 * The caller is responsible for supplying a consistent payload —
 * specifically, the merge engine has already reconciled local and
 * remote before handing us what to write.
 *
 * @param {GistPayload} data
 * @returns {Promise<void>}
 */
export const writeGistData = async (data) => {
  const id = await ensureGist();
  const compressed = await gzipEncode(JSON.stringify(data));
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: compressed } },
    }),
  });
};

// ── Test affordances ────────────────────────────────────────────────

/**
 * Reset module-local state so tests can exercise rate-limit arming
 * without bleeding across cases. Zeroes {@link backoffUntil}.
 *
 * NOT part of the public API. The leading underscore is a hard signal
 * — feature code must never call this.
 *
 * @returns {void}
 */
export const _resetGistStateForTest = () => {
  backoffUntil = 0;
};
