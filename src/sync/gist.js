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
// # Legacy-gist migration
//
// The current gist and a legacy gist share the gzip+base64 payload
// shape (schema version 3) but intentionally live in **separate
// gists**: different description ({@link GIST_DESCRIPTION} vs
// {@link GIST_DESCRIPTION_V2}) and different filename
// ({@link GIST_FILENAME} vs {@link GIST_FILENAME_V2}). The reason is
// rollback safety: if a user switches between an OG-E build that
// writes the current gist and one that writes the legacy gist, each
// build must remain able to read its own data. Sharing one gist would
// mean a write from the current build (which may carry newer fields)
// would confuse the legacy reader, and a legacy write would strip
// anything the legacy build doesn't know about.
//
// The one-time migration path (see {@link ensureGistV3}) therefore:
//
//   1. Looks for the current gist (description matches {@link GIST_DESCRIPTION}).
//      If found, cache its id and we're done.
//   2. If absent, looks for the legacy gist (description matches
//      {@link GIST_DESCRIPTION_V2}). If found, READ its content, COPY
//      `galaxyScans` + `colonyHistory` into a fresh payload, CREATE a
//      new current-gist. The legacy gist is **never** modified or
//      deleted — the user can roll back and find their legacy data
//      exactly where they left it.
//   3. If neither exists, create an empty current-gist.
//
// The migration is idempotent: a subsequent boot skips steps 2/3
// because step 1 now succeeds. If step 2 fails mid-flight (parse
// error, network, gzip-decode exception), we log a warning and fall
// through to creating an empty current-gist — the user's legacy data
// is still safe on GitHub, and a later merge round can still reconcile
// from either side once the user fixes whatever broke the read.
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
import { safeLS } from '../lib/storage.js';
import { logger } from '../lib/logger.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../state/history.js').ColonyHistory} ColonyHistory
 */

/**
 * Shape of the JSON we compress and store in the gist's single data file.
 * The whole payload is serialised, gzipped, base64-encoded, then shoved
 * into the file's `content` field.
 *
 * @typedef {object} GistPayload
 * @property {3} version
 *   Schema version. Pinned to 3 — readers reject anything else via
 *   {@link fetchGistData}'s schema guard, which keeps us from
 *   accidentally interpreting an older-schema blob as the current
 *   shape if the user ever edits the gist by hand.
 * @property {string} updatedAt
 *   ISO timestamp stamped by the writer at the moment it chose to
 *   upload. Informational — consumers use per-record timestamps
 *   (`scannedAt`, history `timestamp`) to decide merges, not this.
 * @property {GalaxyScans} galaxyScans
 *   Full galaxy-scan map. See {@link GalaxyScans}.
 * @property {ColonyHistory} colonyHistory
 *   Full colony-history list. See {@link ColonyHistory}.
 */

// ── Storage keys ────────────────────────────────────────────────────

/**
 * localStorage key for the user's GitHub Personal Access Token.
 * Namespaced with the `oge_` prefix every OG-E key shares so any
 * legacy state never collides.
 */
export const TOKEN_KEY = 'oge_gistToken';

/**
 * localStorage key caching our gist id once discovered/created. Named
 * `oge_gist` (not `oge_gistId`) specifically so it does NOT collide
 * with {@link LEGACY_GIST_ID_KEY} — the pre-v1 legacy install used
 * `oge_gistId` for the same purpose, and we want the legacy-migration
 * path to be able to tell its cached value apart from ours.
 */
export const GIST_ID_KEY = 'oge_gist';

/**
 * localStorage key the pre-v1 legacy install wrote its gist id to. We
 * clean this up after a successful migration — not because it hurts
 * to leave it (the key lives alongside its matching token, unread by
 * us) but because stripping it gives support a cleaner storage dump.
 */
export const LEGACY_GIST_ID_KEY = 'oge_gistId';

/** localStorage key holding the ISO timestamp of the last successful upload. */
export const LAST_UP_KEY = 'oge_lastSyncAt';

/** localStorage key holding the ISO timestamp of the last successful download. */
export const LAST_DOWN_KEY = 'oge_lastDownAt';

/** localStorage key holding the last error message, or absent on success. */
export const LAST_ERR_KEY = 'oge_lastSyncErr';

// ── Gist identity ───────────────────────────────────────────────────

/** Filename under which the current gist stores its single compressed data file. */
export const GIST_FILENAME = 'oge-data.json.gz.b64';

/** Description GitHub shows for the current gist; also used as the discovery predicate. */
export const GIST_DESCRIPTION = 'OG-E sync data (compressed) — do not edit manually';

/** Legacy-gist filename — read-only during legacy-migration, never written. */
export const GIST_FILENAME_V2 = 'oge-data.json.gz.b64';

/** Legacy-gist description — matched during legacy-migration discovery. */
export const GIST_DESCRIPTION_V2 = 'OG-E sync data v3 (compressed) — do not edit manually';

// ── Protocol constants ──────────────────────────────────────────────

/** Schema version baked into every written payload. See file header. */
export const SCHEMA_VERSION = 3;

/** GitHub REST API base URL. All {@link gh} calls are built on top. */
export const API_BASE = 'https://api.github.com';

/**
 * Backoff duration used when a 403/429 comes back with no rate-limit
 * headers at all. 5 minutes matches the "secondary rate limit" window
 * GitHub documents and is conservative enough that we stop hammering
 * the API while still recovering automatically.
 */
export const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;

// ── Module-local state ──────────────────────────────────────────────

/**
 * Epoch-ms timestamp before which every {@link gh} call short-circuits
 * to a thrown "rate limited" error without touching the network. Zero
 * means "no active backoff". Armed by {@link gh} on 403/429. Cleared
 * implicitly when the clock moves past it. See file header for the
 * full strategy.
 */
let backoffUntil = 0;

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
 * discovered. {@link ensureGistV3} promotes this to a full id on first
 * successful discovery or creation.
 *
 * @returns {string}
 */
export const getGistId = () => safeLS.get(GIST_ID_KEY) || '';

/**
 * Cache the gist id in localStorage. Normally called by
 * {@link ensureGistV3}; exposed for tests and settings flows that want
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
};

// ── GitHub API client ───────────────────────────────────────────────

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
    }
    // Truncate the body to keep the thrown message Settings-UI-sized.
    // `.catch` makes the read defensive: some error bodies aren't text
    // decodable (e.g. upstream connection reset), in which case we fall
    // back to the status line.
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
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
 *   Exact filename to read (either {@link GIST_FILENAME} or, during
 *   migration, {@link GIST_FILENAME_V2}).
 * @returns {Promise<string | null>}
 */
const readGistFile = async (gist, filename) => {
  const file = gist?.files?.[filename];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    return res.text();
  }
  return file.content;
};

// ── Gist discovery + creation (with legacy-gist migration) ────────────

/**
 * Return the id of the current gist, discovering or creating one as needed.
 *
 * Four-step resolution:
 *
 *   1. **Cached id** — if {@link GIST_ID_KEY} is populated, return it
 *      without a network call.
 *   2. **Existing current gist** — list the user's gists (one page of 100;
 *      enough for any real account), match `description ===
 *      {@link GIST_DESCRIPTION}`. If found, cache and return its id.
 *   3. **Legacy migration** — if no current gist but a legacy gist
 *      (`description === {@link GIST_DESCRIPTION_V2}`) exists, read and
 *      decode its content. Copy `galaxyScans` + `colonyHistory` into
 *      the initial payload. The legacy gist is **never** modified.
 *   4. **Fresh create** — POST a new gist with the initial payload
 *      (migrated from legacy if step 3 succeeded, empty otherwise). On
 *      success, cache the new id and clean up {@link LEGACY_GIST_ID_KEY}.
 *
 * Migration failures (bad base64, corrupt gzip, JSON parse error) are
 * logged via {@link logger.warn} and swallowed — we fall through to
 * creating an empty gist so the user isn't blocked forever on a
 * corrupted legacy payload.
 *
 * @returns {Promise<string>} The gist id.
 * @throws When the underlying {@link gh} calls fail (no token, rate
 *   limited, network error on gist creation).
 */
export const ensureGistV3 = async () => {
  const cached = getGistId();
  if (cached) return cached;

  // One page is enough: GitHub's default sort is updated-desc, and
  // nobody has more than 100 gists that would rank higher than their
  // OG-E gist.
  const gists = await gh('/gists?per_page=100');

  /** @type {Array<{ id: string, description: string }>} */
  const list = gists || [];

  const v3 = list.find((g) => g.description === GIST_DESCRIPTION);
  if (v3) {
    setGistId(v3.id);
    return v3.id;
  }

  /** @type {GistPayload} */
  let initialPayload = {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    galaxyScans: /** @type {GalaxyScans} */ ({}),
    colonyHistory: /** @type {ColonyHistory} */ ([]),
  };

  const v2 = list.find((g) => g.description === GIST_DESCRIPTION_V2);
  if (v2) {
    try {
      const v2Gist = await gh(`/gists/${v2.id}`);
      const content = await readGistFile(v2Gist, GIST_FILENAME_V2);
      if (content) {
        const json = await gzipDecode(content);
        const parsed = JSON.parse(json);
        // Only adopt the legacy payload when it carries the same
        // schema version we understand. An older-schema blob with a
        // different `version` is skipped; we'd rather create an empty
        // gist and let the merge engine rehydrate from local state.
        if (parsed && parsed.version === SCHEMA_VERSION) {
          initialPayload = {
            version: SCHEMA_VERSION,
            updatedAt: new Date().toISOString(),
            galaxyScans: parsed.galaxyScans || {},
            colonyHistory: parsed.colonyHistory || [],
          };
        }
      }
    } catch (err) {
      // Best-effort migration. The legacy gist is still on GitHub for
      // rollback; the user can try again next boot. We don't rethrow
      // because a migration failure mustn't block boot.
      logger.warn('[gist] v2→v3 migration read failed:', /** @type {Error} */ (err).message);
    }
  }

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
  // Clean up the legacy cache pointer. The legacy gist itself stays on
  // GitHub; we only drop the localStorage reference because we never
  // read it again.
  safeLS.remove(LEGACY_GIST_ID_KEY);
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
  const id = await ensureGistV3();
  const gist = await gh(`/gists/${id}`);
  const content = await readGistFile(gist, GIST_FILENAME);
  if (!content) return null;
  try {
    const json = await gzipDecode(content);
    const parsed = JSON.parse(json);
    // `parsed.version || 1` treats payloads that pre-date explicit
    // versioning as schema version 1, which is rejected — same as
    // anything labelled with a version we don't understand.
    if (!parsed || (parsed.version || 1) !== SCHEMA_VERSION) return null;
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
  const id = await ensureGistV3();
  const compressed = await gzipEncode(JSON.stringify(data));
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: compressed } },
    }),
  });
};

/**
 * Empty the remote `galaxyScans` map while preserving `colonyHistory`.
 * The "Clear scan data" UI action needs a matching remote wipe —
 * merge logic alone can't distinguish "user cleared" from "device
 * hasn't seen this".
 *
 * Stamps {@link LAST_UP_KEY} with the current ISO time on success.
 *
 * @returns {Promise<void>}
 */
export const clearGistScans = async () => {
  const id = await ensureGistV3();
  const gist = await gh(`/gists/${id}`);
  const content = await readGistFile(gist, GIST_FILENAME);
  /** @type {ColonyHistory} */
  let colonyHistory = [];
  if (content) {
    try {
      const parsed = JSON.parse(await gzipDecode(content));
      if (parsed && Array.isArray(parsed.colonyHistory)) {
        colonyHistory = parsed.colonyHistory;
      }
    } catch {
      // Corrupt payload: fall back to wiping the whole thing. That's
      // still the correct "clear scans" semantics — history will
      // re-populate from local on the next upload.
    }
  }
  await writeGistData({
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    galaxyScans: /** @type {GalaxyScans} */ ({}),
    colonyHistory,
  });
  setStatus('up', new Date().toISOString());
};

/**
 * Drop every `${galaxy}:*` entry from the remote `galaxyScans` map
 * while preserving `colonyHistory`, the other galaxies' scans, and any
 * tombstones. Counterpart to the histogram's per-galaxy "Reset" button:
 * without this, a local-only delete would be undone by the next sync
 * round-trip (`mergeScans` is a UNION).
 *
 * Stamps {@link LAST_UP_KEY} on success.
 *
 * @param {number} galaxy
 * @returns {Promise<void>}
 */
export const clearGistScansForGalaxy = async (galaxy) => {
  const id = await ensureGistV3();
  const gist = await gh(`/gists/${id}`);
  const content = await readGistFile(gist, GIST_FILENAME);
  /** @type {ColonyHistory} */
  let colonyHistory = [];
  /** @type {GalaxyScans} */
  let galaxyScans = {};
  if (content) {
    try {
      const parsed = JSON.parse(await gzipDecode(content));
      if (parsed && Array.isArray(parsed.colonyHistory)) {
        colonyHistory = parsed.colonyHistory;
      }
      if (parsed && parsed.galaxyScans && typeof parsed.galaxyScans === 'object') {
        galaxyScans = parsed.galaxyScans;
      }
    } catch {
      // Corrupt payload: fall through with empty defaults — the next
      // legit upload will rebuild everything from local.
    }
  }
  // Drop the requested galaxy's keys; everything else (other galaxies
  // and the colony history) survives.
  const prefix = galaxy + ':';
  /** @type {GalaxyScans} */
  const filtered = {};
  for (const key of /** @type {(keyof GalaxyScans)[]} */ (Object.keys(galaxyScans))) {
    if (!key.startsWith(prefix)) filtered[key] = galaxyScans[key];
  }
  await writeGistData({
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    galaxyScans: filtered,
    colonyHistory,
  });
  setStatus('up', new Date().toISOString());
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
