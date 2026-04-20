// OG-E: cross-device sync of YOUR locally collected data via YOUR private gist.
//
// This is the only script that talks to a network service — but it talks to
// GitHub (not the game) and only with a token that the user provides. None
// of this traffic touches the game server in any way.
//
// Purpose: the user's own device-local observations (planet field sizes,
// galaxy position records) are their own data. This script lets them sync
// that data between their own devices (e.g. desktop ↔ mobile) by putting
// it in a private gist under their GitHub account. The user pastes a
// Personal Access Token (gist scope only) into OG-E settings to enable it.
// Without the token, this script does nothing.
//
// Configuration (localStorage):
//   oge_cloudSync   : 'true' | 'false'  — enables sync
//   oge_gistToken   : PAT (gist scope)
//   oge_gistId      : ID of the OG-E gist (auto-discovered or auto-created)
//   oge_lastSyncAt  : ISO timestamp of last successful upload
//   oge_lastDownAt  : ISO timestamp of last successful download
//   oge_lastSyncErr : last error message (for the settings UI to display)
//
// Strategy:
//   - On boot: download from gist, merge with local (newer-wins), save merged
//   - On local change (debounced 5s): upload merged dataset
//   - On manual "Force sync now" event: download + upload immediately
//
// IMPORTANT: this script must run in TOP FRAME ONLY. Multiple instances per tab
// (one per iframe) would each schedule their own uploads on the same storage
// change event, multiplying API calls and exhausting GitHub's 5000 req/h quota.
(() => {
  // Belt-and-suspenders guard: if manifest ever sets all_frames:true again,
  // bail out immediately in iframes so only the top frame runs sync.
  if (window.top !== window.self) return;

  const SYNC_KEY = 'oge_cloudSync';
  const TOKEN_KEY = 'oge_gistToken';
  // v2 constants kept for one-shot migration path only (see ensureGistV3).
  // All live reads/writes target v3.
  const LEGACY_GIST_ID_KEY = 'oge_gistId';   // old localStorage key; cleaned on successful v3 migration
  const GIST_FILENAME_V2 = 'oge-data.json';
  const GIST_DESCRIPTION_V2 = 'OG-E sync data — do not edit manually';
  // v3 (current): gzipped + base64-encoded payload.
  const GIST_ID_KEY = 'oge_gistId_v3';
  const GIST_FILENAME = 'oge-data.json.gz.b64';
  const GIST_DESCRIPTION = 'OG-E sync data v3 (compressed) — do not edit manually';
  const SCHEMA_VERSION = 3;
  const LAST_UP_KEY = 'oge_lastSyncAt';
  const LAST_DOWN_KEY = 'oge_lastDownAt';
  const LAST_ERR_KEY = 'oge_lastSyncErr';
  // Debounce upload timer. 15s (up from 5s in ≤4.8.5) so burst writes during
  // active galaxy scanning coalesce into fewer uploads — crucial on slow
  // mobile connections where each upload saturates bandwidth and competes
  // with game traffic. Trade-off: fresh data on another device is at most
  // 15s "stale" in normal operation.
  const DEBOUNCE_MS = 15000;
  const API_BASE = 'https://api.github.com';

  // ── Storage helper (Firefox desktop & mobile, Chrome) ──
  const getStorage = () => {
    const ns = (typeof browser !== 'undefined' && browser.storage) ? browser
             : (typeof chrome !== 'undefined' && chrome.storage) ? chrome
             : null;
    if (!ns) return null;
    return {
      local: ns.storage.local,
      onChanged: ns.storage.onChanged,
    };
  };

  // ── safeLS for config persistence ──
  const safeLS = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} },
    remove: (k) => { try { localStorage.removeItem(k); } catch {} },
    bool: (k) => { try { return localStorage.getItem(k) === 'true'; } catch { return false; } },
  };

  // ── Compression helpers (v3 payload format) ──
  //
  // Gist file content is base64(gzip(JSON.stringify(payload))).
  //
  // Why gzip: the raw JSON for a fully-scanned account is ~2 MB, dominated by
  // repeated keys ("status", "positions", "empty", etc.). Gzip's LZ77 dedupes
  // these almost perfectly → ~250 KB payloads. On slow mobile links this is
  // the difference between a smooth sync and a visibly throttled one.
  //
  // Why base64: gist files are UTF-8 text. Gzipped bytes contain non-ASCII
  // values that GitHub would corrupt on read-back. base64 is overhead (+33%)
  // but required; the compressed text is still ~6× smaller than raw JSON.
  //
  // Why CompressionStream (not a JS library): native browser API, zero
  // dependencies, Firefox 113+ / Chrome 80+ / FF Android 113+. Our manifest
  // min version is FF 140, so it's universally available.

  // Collect all chunks from a ReadableStream into a single Uint8Array.
  // Avoids `new Response(stream)` which under Firefox can trigger an Xray
  // wrapper permission error ("Permission denied to access property
  // 'constructor'") when the stream was produced by CompressionStream
  // inside a content script scope. Manual reader is 100% portable.
  const readStreamToBytes = async (stream) => {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  const gzipEncode = async (str) => {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = await readStreamToBytes(stream);
    // Build binary string in chunks (avoids stack overflow on large inputs)
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };

  const gzipDecode = async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const out = await readStreamToBytes(stream);
    return new TextDecoder().decode(out);
  };

  const isSyncEnabled = () => safeLS.bool(SYNC_KEY);
  // Strip anything outside printable ASCII — paste often introduces BOM, NBSP,
  // trailing newline, or whitespace that breaks the Authorization header
  // (HTTP headers must be ISO-8859-1, and fetch is strict).
  const sanitizeToken = (raw) => (raw || '').replace(/[^\x21-\x7e]/g, '');
  const getToken = () => sanitizeToken(safeLS.get(TOKEN_KEY));
  const getGistId = () => safeLS.get(GIST_ID_KEY) || '';

  const setStatus = (key, value) => {
    if (value == null) safeLS.remove(key);
    else safeLS.set(key, value);
  };

  const setError = (msg) => {
    if (msg) {
      console.warn('[OG-E sync]', msg);
      setStatus(LAST_ERR_KEY, msg);
    } else {
      setStatus(LAST_ERR_KEY, null);
    }
  };

  // ── GitHub API ──

  // Backoff state: when GitHub returns 403 with rate-limit info, we record the
  // earliest time at which we should try again. All gh() calls before that time
  // throw immediately without hitting the network.
  let backoffUntil = 0;

  /**
   * GitHub API client with two protections:
   *   1. Token sourcing + sanitisation (strips non-printable bytes added by paste)
   *   2. 403/429 backoff: when rate-limited, arms `backoffUntil` from
   *      Retry-After header → X-RateLimit-Reset header → default 5 min.
   *      All subsequent calls before that time throw immediately without
   *      hitting the network (preserves what's left of the 5000 req/h quota).
   *
   * @param {string} path     API path starting with /
   * @param {object} options  passed to fetch (method, body, etc.)
   * @returns {Promise<any>}  parsed JSON response body
   * @throws  on non-2xx, no token, or active backoff
   */
  const gh = async (path, options = {}) => {
    const now = Date.now();
    if (backoffUntil > now) {
      const minutes = Math.ceil((backoffUntil - now) / 60000);
      throw new Error('rate limited — backing off until ' + new Date(backoffUntil).toLocaleTimeString() + ' (~' + minutes + ' min)');
    }

    const token = getToken();
    if (!token) throw new Error('No GitHub token');
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      // Parse rate-limit hints and arm backoff so we stop hammering GitHub.
      // Three possible signals (in priority order):
      //   1. Retry-After header (seconds) — set on secondary rate limits
      //   2. X-RateLimit-Reset header (epoch sec) — primary limit reset time
      //   3. Default 5 minutes if 403 with no hints
      if (res.status === 403 || res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
        const reset = parseInt(res.headers.get('X-RateLimit-Reset') || '', 10);
        let waitMs = 0;
        if (retryAfter > 0) waitMs = retryAfter * 1000;
        else if (reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now());
        else waitMs = 5 * 60 * 1000;
        backoffUntil = Date.now() + waitMs;
      }

      const text = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ': ' + (text.slice(0, 200) || res.statusText));
    }
    return res.json();
  };

  // Read raw file content from a gist — resolving truncation (gists >1MB get
  // truncated via the API and the full bytes must be fetched from raw_url).
  const readGistFile = async (gist, filename) => {
    const file = gist?.files?.[filename];
    if (!file) return null;
    if (file.truncated && file.raw_url) {
      const res = await fetch(file.raw_url);
      return res.text();
    }
    return file.content;
  };

  // ── v3 gist: discovery + one-shot migration from v2 ──
  //
  // 4.9.0 introduced a new gist format (gzip+base64) for a ~6× payload size
  // reduction. Rather than mutate the legacy v2 gist in place we create a
  // fresh one so the old uncompressed data stays intact as a backup (the
  // user can delete it manually at any time via GitHub's UI).
  //
  // Discovery order:
  //   1. Cached v3 id in localStorage (`oge_gistId_v3`) → use directly.
  //   2. Search gists for v3 description. If found: cache + use.
  //   3. Search gists for v2 description. If found: migrate content →
  //      create v3 → cache. v2 is NOT deleted.
  //   4. Nothing found (fresh user) → create empty v3.
  //
  // Migration is idempotent — rerunning yields the same cached v3 id. If the
  // migration call fails mid-flight (network, rate limit), the next boot
  // simply retries from step 1 (v3 not yet created) or step 2 (v3 created
  // but possibly with partial data — which is fine, mergeScans/mergeHistory
  // fill it in on first upload).
  const ensureGistV3 = async () => {
    const cached = safeLS.get(GIST_ID_KEY);
    if (cached) return cached;

    const gists = await gh('/gists?per_page=100');

    // Step 2 — existing v3
    const v3 = (gists || []).find(g => g.description === GIST_DESCRIPTION);
    if (v3) {
      setStatus(GIST_ID_KEY, v3.id);
      return v3.id;
    }

    // Step 3 — migrate from v2 if present
    let initialPayload = { version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), galaxyScans: {}, colonyHistory: [] };
    const v2 = (gists || []).find(g => g.description === GIST_DESCRIPTION_V2);
    if (v2) {
      try {
        const v2Gist = await gh('/gists/' + v2.id);
        const content = await readGistFile(v2Gist, GIST_FILENAME_V2);
        if (content) {
          const parsed = JSON.parse(content);
          if (parsed && parsed.version === 2) {
            initialPayload = {
              version: SCHEMA_VERSION,
              updatedAt: new Date().toISOString(),
              galaxyScans: parsed.galaxyScans || {},
              colonyHistory: parsed.colonyHistory || [],
            };
          }
        }
      } catch (err) {
        // Migration failed — fall through to creating an empty v3. User keeps
        // the v2 gist untouched; a later boot can retry (migration triggers
        // whenever v3 cache is empty and v2 exists).
        console.warn('[OG-E sync] v2→v3 migration read failed:', err.message);
      }
    }

    // Step 4 — create v3 (possibly pre-populated from v2)
    const compressed = await gzipEncode(JSON.stringify(initialPayload));
    const created = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILENAME]: { content: compressed } },
      }),
    });
    setStatus(GIST_ID_KEY, created.id);
    // Migration succeeded — purge the stale v2 id cache so future boots don't
    // try to resolve it. The v2 gist itself is left on GitHub as a backup.
    safeLS.remove(LEGACY_GIST_ID_KEY);
    return created.id;
  };

  const fetchGistData = async () => {
    const id = await ensureGistV3();
    const gist = await gh('/gists/' + id);
    const content = await readGistFile(gist, GIST_FILENAME);
    if (!content) return null;
    let parsed;
    try {
      const json = await gzipDecode(content);
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    // Schema guard — v3 is current. v1/v2 are handled during ensureGistV3
    // migration, never reach this point as live reads.
    if (!parsed || (parsed.version || 1) !== SCHEMA_VERSION) return null;
    return parsed;
  };

  const writeGistData = async (data) => {
    const id = await ensureGistV3();
    const compressed = await gzipEncode(JSON.stringify(data));
    await gh('/gists/' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: compressed } },
      }),
    });
  };

  // ── Merge: combine local + remote (newer wins per record) ──

  /**
   * Merge two `oge_galaxyScans` maps by max `scannedAt` per system. We do NOT
   * merge positions across devices — fresh scan would replace stale data
   * anyway, so per-system grain is sufficient and much simpler.
   *
   * Returns `{ merged, changed }` where `changed === true` iff remote
   * contributed something new. Callers MUST skip the local write when
   * `changed === false`, otherwise: storage.onChanged → scheduleUpload →
   * another sync → INFINITE LOOP that exhausts GitHub's 5000 req/h quota.
   *
   * @param {object} localScans   local oge_galaxyScans
   * @param {object} remoteScans  decoded `galaxyScans` from gist
   * @returns {{merged: object, changed: boolean}}
   * @see SCHEMAS.md#oge_galaxyscans
   */
  const mergeScans = (localScans, remoteScans) => {
    const local = localScans || {};
    const remote = remoteScans || {};
    const merged = {};
    const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
    let changed = false;
    for (const key of allKeys) {
      const l = local[key];
      const r = remote[key];
      if (!l) { merged[key] = r; changed = true; continue; }
      if (!r) { merged[key] = l; continue; }
      if ((l.scannedAt || 0) >= (r.scannedAt || 0)) {
        merged[key] = l;
      } else {
        merged[key] = r;
        changed = true;
      }
    }
    return { merged, changed };
  };

  /**
   * Merge two `oge_colonyHistory` arrays, deduping by `cp` (planet ID).
   * Local entries win on collision. Entries whose `cp` is in `deletedSet`
   * are filtered out from BOTH sides — this is how soft-deleted history
   * entries stay dead across devices (without this, one device deleting
   * an entry would race against another device re-uploading it via union).
   *
   * Returns `{ merged, changed }` like `mergeScans` to support the same
   * anti-loop pattern. `changed` is true when the remote contributed new
   * cps (i.e. remote entries whose cp was neither in local nor in deleted).
   *
   * @param {ColonyEntry[]} localHist
   * @param {ColonyEntry[]} remoteHist
   * @param {Set<number>} [deletedSet=new Set()]  cps soft-deleted anywhere
   * @returns {{merged: ColonyEntry[], changed: boolean}}
   * @see SCHEMAS.md#oge_colonyhistory
   */
  const mergeHistory = (localHist, remoteHist, deletedSet) => {
    const del = deletedSet instanceof Set ? deletedSet : new Set(deletedSet || []);
    const byCP = new Map();
    for (const h of (localHist || [])) {
      if (del.has(h.cp)) continue;
      byCP.set(h.cp, h);
    }
    let changed = false;
    for (const h of (remoteHist || [])) {
      if (del.has(h.cp)) continue;
      if (!byCP.has(h.cp)) {
        byCP.set(h.cp, h);
        changed = true;
      }
    }
    return { merged: [...byCP.values()], changed };
  };

  /**
   * Union-merge two `oge_deletedColonies` arrays. Soft-delete tombstones
   * are append-only — a cp added on any device propagates to all.
   * `changed` = true iff remote added new cps we didn't already have.
   *
   * @param {number[]} localDel
   * @param {number[]} remoteDel
   * @returns {{merged: number[], changed: boolean}}
   */
  const mergeDeleted = (localDel, remoteDel) => {
    const local = new Set(localDel || []);
    const remote = remoteDel || [];
    let changed = false;
    for (const cp of remote) {
      if (!local.has(cp)) { local.add(cp); changed = true; }
    }
    return { merged: [...local], changed };
  };

  // ── Local data access ──

  const store = getStorage();

  const getLocalData = () => new Promise((resolve) => {
    if (!store) return resolve({ scans: {}, history: [], deleted: [] });
    store.local.get(['oge_galaxyScans', 'oge_colonyHistory', 'oge_deletedColonies'], (data) => {
      resolve({
        scans: (data && data.oge_galaxyScans) || {},
        history: (data && data.oge_colonyHistory) || [],
        deleted: (data && data.oge_deletedColonies) || [],
      });
    });
  });

  const setLocalData = (scans, history, deleted) => new Promise((resolve) => {
    if (!store) return resolve();
    const toSave = {};
    if (scans) toSave.oge_galaxyScans = scans;
    if (history) toSave.oge_colonyHistory = history;
    if (deleted) toSave.oge_deletedColonies = deleted;
    if (Object.keys(toSave).length === 0) return resolve();
    store.local.set(toSave, resolve);
  });

  // ── Public sync operations ──

  let inFlight = false;

  /**
   * Pull gist → merge with local → write merged back to local (only if remote
   * contributed). One-shot; uses the `inFlight` lock to serialise with `upload`
   * and `clearGistScans`.
   *
   * @returns {Promise<void>}
   */
  const downloadAndMerge = async () => {
    if (!isSyncEnabled() || !getToken()) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const remote = await fetchGistData();
      if (!remote) { setError(null); return; }

      const local = await getLocalData();
      const delResult = mergeDeleted(local.deleted, remote.deletedColonies);
      const deletedSet = new Set(delResult.merged);
      const scansResult = mergeScans(local.scans, remote.galaxyScans);
      const histResult = mergeHistory(local.history, remote.colonyHistory, deletedSet);

      // Local history also needs a write if remote's deletedColonies introduced
      // a cp that's currently in local.history (we need to remove it locally).
      const localHasDeletedCp = (local.history || []).some(h => deletedSet.has(h.cp));
      const histLocalNeedsUpdate = histResult.changed || localHasDeletedCp;

      // Only write local if something actually changed — otherwise we'd
      // trigger storage.onChanged → another scheduleUpload → infinite loop.
      if (scansResult.changed || histLocalNeedsUpdate || delResult.changed) {
        await setLocalData(
          scansResult.changed ? scansResult.merged : null,
          histLocalNeedsUpdate ? histResult.merged : null,
          delResult.changed ? delResult.merged : null
        );
      }
      setStatus(LAST_DOWN_KEY, new Date().toISOString());
      setError(null);
    } catch (err) {
      setError('download: ' + err.message);
    } finally {
      inFlight = false;
    }
  };

  /**
   * Pre-merge with remote (so we don't blow away another device's writes),
   * write merged state back to gist, optionally update local. Skips the gist
   * PATCH when local + remote are already identical (saves an API call when
   * sync was triggered but nothing actually needs sending — typical right
   * after a download from another device).
   *
   * @returns {Promise<void>}
   */
  const upload = async () => {
    if (!isSyncEnabled() || !getToken()) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const local = await getLocalData();
      // Pre-merge with remote so we don't blow away another device's writes
      const remote = await fetchGistData().catch(() => null);
      const delResult = mergeDeleted(local.deleted, remote?.deletedColonies);
      const deletedSet = new Set(delResult.merged);
      const scansResult = mergeScans(local.scans, remote?.galaxyScans);
      const histResult = mergeHistory(local.history, remote?.colonyHistory, deletedSet);

      // Local history also needs a rewrite if the merged deletedSet now covers
      // a cp still present in local.history — this is how another device's
      // soft-delete propagates into this device's local chrome.storage.
      const localHasDeletedCp = (local.history || []).some(h => deletedSet.has(h.cp));
      const histLocalNeedsUpdate = histResult.changed || localHasDeletedCp;

      // Only update local if something actually changed — same anti-loop logic
      // as downloadAndMerge.
      if (scansResult.changed || histLocalNeedsUpdate || delResult.changed) {
        await setLocalData(
          scansResult.changed ? scansResult.merged : null,
          histLocalNeedsUpdate ? histResult.merged : null,
          delResult.changed ? delResult.merged : null
        );
      }

      // Skip the PATCH if the gist already matches the merged state — saves
      // an API call when sync was triggered but nothing actually needs sending
      // (typical after a download from another device).
      const sameJSON = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      const gistIsCurrent = sameJSON(remote?.galaxyScans, scansResult.merged)
                         && sameJSON(remote?.colonyHistory, histResult.merged)
                         && sameJSON(remote?.deletedColonies || [], delResult.merged);
      if (!gistIsCurrent) {
        await writeGistData({
          version: SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          galaxyScans: scansResult.merged,
          colonyHistory: histResult.merged,
          deletedColonies: delResult.merged,
        });
        setStatus(LAST_UP_KEY, new Date().toISOString());
      }
      setError(null);
    } catch (err) {
      setError('upload: ' + err.message);
    } finally {
      inFlight = false;
    }
  };

  // Wipe gist scans (used by Clear scan data UI). Uses the same inFlight lock
  // as upload/download so a debounced upload can't race-restore the cleared data.
  const clearGistScans = async () => {
    if (!getToken()) return;
    // Wait briefly for any in-flight op to finish before claiming the lock
    for (let i = 0; i < 30 && inFlight; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    inFlight = true;
    try {
      const local = await getLocalData(); // local scans already cleared by histogram.js
      await writeGistData({
        version: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        galaxyScans: {},
        colonyHistory: local.history || [],
        deletedColonies: local.deleted || [],
      });
      setStatus(LAST_UP_KEY, new Date().toISOString());
      setError(null);
    } catch (err) {
      setError('clear: ' + err.message);
    } finally {
      inFlight = false;
    }
    // Cancel any pending debounced upload so it doesn't clobber the wipe
    clearTimeout(syncTimer);
    syncTimer = null;
  };

  // ── Auto-sync trigger (debounced) ──

  let syncTimer = null;
  const scheduleUpload = () => {
    if (!isSyncEnabled()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(upload, DEBOUNCE_MS);
  };

  // ── Wire up ──

  // Tombstone written by histogram.js Clear button so we wipe the gist's scans
  // (merge logic alone cannot tell "user cleared" from "device hasn't seen this").
  const handleClearTombstone = async () => {
    try {
      await clearGistScans();
    } finally {
      if (store) store.local.remove('oge_clearRemoteAt');
    }
  };

  // Tombstone written by histogram.js Refresh buttons — runs a full sync
  // (download + upload) so the open histogram view sees fresh data from the gist.
  const handleSyncTombstone = async () => {
    try {
      await downloadAndMerge();
      await upload();
    } finally {
      if (store) store.local.remove('oge_syncRequestAt');
    }
  };

  if (store) {
    try {
      store.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes.oge_clearRemoteAt && changes.oge_clearRemoteAt.newValue) {
          handleClearTombstone();
          return;
        }
        if (changes.oge_syncRequestAt && changes.oge_syncRequestAt.newValue) {
          handleSyncTombstone();
          return;
        }
        if (changes.oge_galaxyScans || changes.oge_colonyHistory || changes.oge_deletedColonies) scheduleUpload();
      });
    } catch {}

    // Initial download on page load (gives us latest before user starts touching data)
    if (isSyncEnabled() && getToken()) {
      setTimeout(downloadAndMerge, 2000);
    }

    // Process any pending tombstones left over from a previous session
    // (e.g. user clicked Clear or Refresh in histogram with no OGame tab open).
    setTimeout(() => {
      store.local.get(['oge_clearRemoteAt', 'oge_syncRequestAt'], (data) => {
        if (data && data.oge_clearRemoteAt) handleClearTombstone();
        if (data && data.oge_syncRequestAt) handleSyncTombstone();
      });
    }, 3000);
  }

  // Manual sync trigger from settings panel ("Force sync now")
  document.addEventListener('oge:syncForce', async () => {
    await downloadAndMerge();
    await upload();
  });
})();
