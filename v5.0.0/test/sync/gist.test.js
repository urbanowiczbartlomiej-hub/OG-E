// @vitest-environment happy-dom
//
// Unit tests for the GitHub gist sync client.
//
// Every case stubs the global `fetch` so the module under test never
// touches the real network. happy-dom provides a real `localStorage`
// so the token, gist-id cache, and status keys round-trip through the
// actual API the production code uses — no mocking of `safeLS`.
//
// The `_resetGistStateForTest` backdoor zeros the module-local
// backoff timestamp between cases; otherwise rate-limit arming from
// one test would suppress the fetch call the next test expects.
//
// # Why we swap happy-dom's `Blob` for the Node built-in
//
// The production code calls `new Blob([...]).stream().pipeThrough(
// new CompressionStream('gzip'))` inside `gzipEncode` / `gzipDecode`.
// Node 18+ has all three globals natively, but happy-dom ships a
// stripped-down `Blob` polyfill that deliberately omits `.stream()` —
// fine for DOM simulation but fatal for our streaming gzip pipeline.
//
// The lib-level gzip test avoids the problem by running in Node env
// (no `// @vitest-environment happy-dom`). We can't do that here
// because we need `localStorage` from happy-dom. Instead we reach
// into `node:buffer` for the real `Blob` and re-stub it over the
// happy-dom version at top-level — that keeps localStorage working
// while giving gzipEncode/gzipDecode the streaming Blob they expect.
//
// @ts-check

// Node's `Blob` (with `.stream()`) lives in `node:buffer`. We don't
// add `@types/node` to the project just for this one import — it
// would pull DOM-typing conflicts into every other module. A single
// @ts-ignore on the import line keeps the file otherwise fully
// type-checked.
// @ts-ignore — node:buffer has no types in this project's tsconfig.
import { Blob as NodeBlob } from 'node:buffer';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  getToken,
  getGistId,
  setGistId,
  gh,
  ensureGistV3,
  fetchGistData,
  writeGistData,
  clearGistScans,
  setStatus,
  _resetGistStateForTest,
  TOKEN_KEY,
  GIST_ID_KEY,
  LEGACY_GIST_ID_KEY,
  LAST_UP_KEY,
  LAST_DOWN_KEY,
  LAST_ERR_KEY,
  GIST_FILENAME,
  GIST_DESCRIPTION,
  GIST_FILENAME_V2,
  GIST_DESCRIPTION_V2,
  API_BASE,
} from '../../src/sync/gist.js';
import { gzipEncode } from '../../src/lib/gzip.js';

/**
 * Build a minimal Response-shaped object matching the surface
 * `gh()` actually touches: `ok`, `status`, `statusText`,
 * `headers.get`, `json()`, `text()`. Using a plain object (vs a real
 * `new Response(...)`) sidesteps happy-dom's stricter body handling
 * and keeps the test noise low.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.ok]
 * @param {number} [opts.status]
 * @param {unknown} [opts.body]   Object → JSON.stringify; string → raw text.
 * @param {Record<string, string>} [opts.headers]
 * @returns {any}
 */
const makeResponse = ({ ok = true, status = 200, body = {}, headers = {} } = {}) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Error',
  headers: {
    get: (/** @type {string} */ key) => headers[key] ?? null,
  },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * Stub the global `fetch` with a single-response mock.
 *
 * @param {any} response
 * @returns {import('vitest').Mock}
 */
const mockFetch = (response) => {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fn);
  return fn;
};

// Swap happy-dom's stream-less Blob for Node's stream-capable one
// exactly once — no per-test reset because we never need the happy-dom
// Blob back. See file header for the full rationale.
beforeAll(() => {
  // `stubGlobal` persists across cases until `unstubAllGlobals`, which
  // we only call in `afterEach`; this override would be wiped by that
  // call, so we assign directly to `globalThis` instead. That's the
  // one global we intentionally keep Node-native for this whole file.
  /** @type {any} */ (globalThis).Blob = NodeBlob;
});

beforeEach(() => {
  _resetGistStateForTest();
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'ghp_testtoken123');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token handling', () => {
  it('getToken strips non-printable characters (BOM, NBSP, newline)', () => {
    // Every invisible class we've seen from real user pastes:
    //   \uFEFF — UTF-8 BOM prepended by some editors / clipboards
    //   \u00A0 — non-breaking space from browser copy
    //   \n     — trailing newline from terminals / shells
    //   \x00   — null byte from binary-paste accidents
    // All must be stripped before the token reaches the Authorization
    // header (which is strict ISO-8859-1).
    localStorage.setItem(TOKEN_KEY, '\uFEFFghp_real\u00A0token\n\x00');
    // Non-breaking space (U+00A0) is 0xa0, just above our 0x7e ceiling,
    // so it's stripped too — same for BOM (U+FEFF), newline (0x0a),
    // and NUL (0x00).
    expect(getToken()).toBe('ghp_realtoken');
  });

  it('getToken returns an empty string when no token is stored', () => {
    localStorage.removeItem(TOKEN_KEY);
    expect(getToken()).toBe('');
  });
});

describe('gh() API client', () => {
  it("throws 'No GitHub token' when the token is empty", async () => {
    localStorage.removeItem(TOKEN_KEY);
    mockFetch(makeResponse());
    await expect(gh('/user')).rejects.toThrow('No GitHub token');
  });

  it('sends Bearer + Accept + X-GitHub-Api-Version headers', async () => {
    const fetchMock = mockFetch(makeResponse({ body: { ok: true } }));
    await gh('/user');
    // Exactly one call — we never retry on success.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(API_BASE + '/user');
    const headers = /** @type {Record<string, string>} */ (init.headers);
    expect(headers.Authorization).toBe('Bearer ghp_testtoken123');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    // No body on the GET, so no Content-Type header either — adding
    // one anyway would be harmless but noisy.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('arms backoff from Retry-After so the next call throws "rate limited"', async () => {
    // First call: 403 with a Retry-After of 120 seconds. Our module
    // arms backoffUntil for ~now+120s.
    const first = mockFetch(
      makeResponse({ ok: false, status: 403, headers: { 'Retry-After': '120' }, body: 'quota' }),
    );
    await expect(gh('/gists')).rejects.toThrow(/HTTP 403/);
    // Confirm the first call actually went through before backoff
    // arming — a synchronous throw before fetch would bypass the test.
    expect(first).toHaveBeenCalledTimes(1);

    // Second call: even if fetch would succeed, we should never reach
    // it — backoff is armed.
    const second = vi.fn().mockResolvedValue(makeResponse({ body: { ok: true } }));
    vi.stubGlobal('fetch', second);
    await expect(gh('/gists')).rejects.toThrow(/rate limited/);
    expect(second).not.toHaveBeenCalled();
  });

  it('uses the default 5-minute backoff when no rate-limit headers are present', async () => {
    // Zero-header 403: the fallback path. We can't assert the exact
    // duration without mocking Date.now, but we can assert the
    // second call throws "rate limited" (which proves arming happened)
    // and that the thrown message mentions a minute count in the
    // DEFAULT_BACKOFF_MS range (5 min).
    mockFetch(makeResponse({ ok: false, status: 403, body: 'forbidden' }));
    await expect(gh('/gists')).rejects.toThrow(/HTTP 403/);
    const next = vi.fn();
    vi.stubGlobal('fetch', next);
    // The human-readable message includes "~5 min" when the default
    // backoff of 5 minutes is in effect.
    await expect(gh('/gists')).rejects.toThrow(/~5 min/);
    expect(next).not.toHaveBeenCalled();
  });

  it('throws HTTP <status>: <body snippet> on non-ok responses', async () => {
    // A 500 with a body that's well within the 200-char truncation
    // limit — the thrown message must include both the status and the
    // body snippet so Settings-UI can show the real reason.
    mockFetch(makeResponse({ ok: false, status: 500, body: 'internal server error' }));
    await expect(gh('/gists')).rejects.toThrow('HTTP 500: internal server error');
  });
});

describe('ensureGistV3', () => {
  it('returns the cached gist id without any network call', async () => {
    setGistId('cached-id-abc');
    const fetchMock = mockFetch(makeResponse());
    const id = await ensureGistV3();
    expect(id).toBe('cached-id-abc');
    // Zero fetches: the whole point of the cache is to skip discovery.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches and returns the v5 id when a gist with the v5 description already exists', async () => {
    // No cache; gists listing includes a v5 gist. We should adopt its
    // id without creating anything new.
    localStorage.removeItem(GIST_ID_KEY);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        body: [
          { id: 'v5-existing', description: GIST_DESCRIPTION },
          { id: 'other-gist', description: 'something unrelated' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const id = await ensureGistV3();
    expect(id).toBe('v5-existing');
    expect(getGistId()).toBe('v5-existing');
    // Exactly one call — the listing. No GET on the specific gist,
    // no POST to create, because step 2 of the discovery short-circuits.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('migrates from a v4 (legacy) gist: reads, copies payload, creates v5, cleans LEGACY key', async () => {
    localStorage.removeItem(GIST_ID_KEY);
    // Pretend the user previously had a v4 install: their legacy gist
    // id is cached and we want to see it cleaned up on successful
    // migration.
    localStorage.setItem(LEGACY_GIST_ID_KEY, 'old-v4-cache');

    const legacyPayload = {
      version: 3,
      updatedAt: '2024-01-01T00:00:00.000Z',
      galaxyScans: { '4:30': { scannedAt: 111, positions: {} } },
      colonyHistory: [{ cp: 1, fields: 200, coords: '[1:1:1]', position: 1, timestamp: 1 }],
    };
    const legacyCompressed = await gzipEncode(JSON.stringify(legacyPayload));

    const fetchMock = vi
      .fn()
      // 1) Listing gists.
      .mockResolvedValueOnce(
        makeResponse({
          body: [{ id: 'legacy-v4-id', description: GIST_DESCRIPTION_V2 }],
        }),
      )
      // 2) GET the legacy v4 gist to read the content.
      .mockResolvedValueOnce(
        makeResponse({
          body: {
            id: 'legacy-v4-id',
            files: { [GIST_FILENAME_V2]: { content: legacyCompressed, truncated: false } },
          },
        }),
      )
      // 3) POST the new v5 gist.
      .mockResolvedValueOnce(
        makeResponse({ body: { id: 'new-v5-id' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureGistV3();
    expect(id).toBe('new-v5-id');
    // Legacy cache cleared.
    expect(localStorage.getItem(LEGACY_GIST_ID_KEY)).toBeNull();
    // The POST body (call index 2) must carry the v5 description and
    // filename, with the migrated galaxyScans wrapped into a compressed
    // payload. We don't assert the exact ciphertext — just that the
    // POST went out with the right metadata.
    const [, init] = fetchMock.mock.calls[2];
    expect(init.method).toBe('POST');
    const body = JSON.parse(/** @type {string} */ (init.body));
    expect(body.description).toBe(GIST_DESCRIPTION);
    expect(body.public).toBe(false);
    expect(body.files[GIST_FILENAME]).toBeDefined();
    expect(typeof body.files[GIST_FILENAME].content).toBe('string');
  });

  it('creates an empty v5 gist when no v4 or v5 gist exists', async () => {
    localStorage.removeItem(GIST_ID_KEY);
    const fetchMock = vi
      .fn()
      // 1) Listing: no OG-E gists at all.
      .mockResolvedValueOnce(makeResponse({ body: [] }))
      // 2) POST the new v5 gist.
      .mockResolvedValueOnce(makeResponse({ body: { id: 'brand-new-id' } }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await ensureGistV3();
    expect(id).toBe('brand-new-id');
    // Two calls: listing + POST. No GET on any legacy gist because
    // there was nothing to migrate from.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postCall = fetchMock.mock.calls[1][1];
    const body = JSON.parse(/** @type {string} */ (postCall.body));
    expect(body.description).toBe(GIST_DESCRIPTION);
    expect(body.files[GIST_FILENAME]).toBeDefined();
  });

  it('falls back to an empty v5 when the v4 payload fails to decode', async () => {
    localStorage.removeItem(GIST_ID_KEY);
    const fetchMock = vi
      .fn()
      // 1) Listing: only a v4 gist.
      .mockResolvedValueOnce(
        makeResponse({
          body: [{ id: 'legacy-v4-id', description: GIST_DESCRIPTION_V2 }],
        }),
      )
      // 2) GET legacy: file is present but content is nonsense (not
      //    valid base64/gzip). gzipDecode throws; our catch path logs
      //    a warning and falls through.
      .mockResolvedValueOnce(
        makeResponse({
          body: {
            id: 'legacy-v4-id',
            files: { [GIST_FILENAME_V2]: { content: '!!!not base64!!!', truncated: false } },
          },
        }),
      )
      // 3) POST the new v5 with empty payload.
      .mockResolvedValueOnce(makeResponse({ body: { id: 'fresh-v5' } }));
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureGistV3();
    expect(id).toBe('fresh-v5');
    // POST body: empty galaxyScans, empty colonyHistory (because the
    // migration read bombed and we created a blank payload).
    const postBody = JSON.parse(/** @type {string} */ (fetchMock.mock.calls[2][1].body));
    expect(postBody.description).toBe(GIST_DESCRIPTION);
    expect(postBody.files[GIST_FILENAME]).toBeDefined();
  });
});

describe('fetchGistData', () => {
  it('decompresses and returns a well-formed v3 payload', async () => {
    setGistId('cached-fetch-id');
    const payload = {
      version: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      galaxyScans: { '1:1': { scannedAt: 999, positions: {} } },
      colonyHistory: [
        { cp: 42, fields: 180, coords: '[1:1:1]', position: 1, timestamp: 7 },
      ],
    };
    const compressed = await gzipEncode(JSON.stringify(payload));
    // ensureGistV3 returns the cached id (no network), so the only
    // fetch is the GET on /gists/:id.
    mockFetch(
      makeResponse({
        body: {
          id: 'cached-fetch-id',
          files: { [GIST_FILENAME]: { content: compressed, truncated: false } },
        },
      }),
    );
    const result = await fetchGistData();
    expect(result).toEqual(payload);
  });

  it('returns null on schema version mismatch', async () => {
    setGistId('cached-fetch-id');
    // Encoded payload with version=2 — our reader rejects anything
    // not === SCHEMA_VERSION so callers treat the gist as empty.
    const payload = { version: 2, updatedAt: '2024', galaxyScans: {}, colonyHistory: [] };
    const compressed = await gzipEncode(JSON.stringify(payload));
    mockFetch(
      makeResponse({
        body: {
          id: 'cached-fetch-id',
          files: { [GIST_FILENAME]: { content: compressed, truncated: false } },
        },
      }),
    );
    const result = await fetchGistData();
    expect(result).toBeNull();
  });
});

describe('writeGistData', () => {
  it('PATCHes the gist with a compressed payload under the v5 filename', async () => {
    setGistId('cached-write-id');
    const fetchMock = mockFetch(makeResponse({ body: { id: 'cached-write-id' } }));
    /** @type {import('../../src/sync/gist.js').GistPayload} */
    const data = {
      version: 3,
      updatedAt: '2025-02-02T02:02:02.000Z',
      galaxyScans: { '2:2': { scannedAt: 5, positions: {} } },
      colonyHistory: [{ cp: 7, fields: 100, coords: '[2:2:2]', position: 2, timestamp: 3 }],
    };
    await writeGistData(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(API_BASE + '/gists/cached-write-id');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(/** @type {string} */ (init.body));
    // The file key must exist with a string (compressed) content —
    // we don't recompute the exact ciphertext here; the round-trip
    // test in `fetchGistData` already proves encode/decode parity.
    expect(body.files[GIST_FILENAME]).toBeDefined();
    expect(typeof body.files[GIST_FILENAME].content).toBe('string');
    expect(body.files[GIST_FILENAME].content.length).toBeGreaterThan(0);
  });
});

describe('clearGistScans', () => {
  it('preserves colonyHistory while emptying galaxyScans', async () => {
    setGistId('cached-clear-id');
    const existing = {
      version: 3,
      updatedAt: '2025-03-03T03:03:03.000Z',
      galaxyScans: { '4:30': { scannedAt: 1, positions: {} } },
      colonyHistory: [
        { cp: 99, fields: 200, coords: '[3:3:3]', position: 3, timestamp: 10 },
      ],
    };
    const compressed = await gzipEncode(JSON.stringify(existing));
    const fetchMock = vi
      .fn()
      // 1) GET existing gist.
      .mockResolvedValueOnce(
        makeResponse({
          body: {
            id: 'cached-clear-id',
            files: { [GIST_FILENAME]: { content: compressed, truncated: false } },
          },
        }),
      )
      // 2) PATCH (writeGistData -> ensureGistV3 short-circuits on cached id).
      .mockResolvedValueOnce(makeResponse({ body: { id: 'cached-clear-id' } }));
    vi.stubGlobal('fetch', fetchMock);

    await clearGistScans();

    // The PATCH is the second call. Its body must carry the preserved
    // colonyHistory and an empty galaxyScans map. We decode via
    // gzipDecode to inspect — much more precise than "is the string
    // non-empty".
    const patchCall = fetchMock.mock.calls[1];
    const patchBody = JSON.parse(/** @type {string} */ (patchCall[1].body));
    const compressedOut = patchBody.files[GIST_FILENAME].content;
    const { gzipDecode } = await import('../../src/lib/gzip.js');
    const decoded = JSON.parse(await gzipDecode(compressedOut));
    expect(decoded.version).toBe(3);
    expect(decoded.galaxyScans).toEqual({});
    expect(decoded.colonyHistory).toEqual(existing.colonyHistory);
  });

  it('stamps LAST_UP_KEY with an ISO timestamp on success', async () => {
    setGistId('cached-clear-id');
    const existing = {
      version: 3,
      updatedAt: 'x',
      galaxyScans: {},
      colonyHistory: [],
    };
    const compressed = await gzipEncode(JSON.stringify(existing));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          body: {
            id: 'cached-clear-id',
            files: { [GIST_FILENAME]: { content: compressed, truncated: false } },
          },
        }),
      )
      .mockResolvedValueOnce(makeResponse({ body: { id: 'cached-clear-id' } }));
    vi.stubGlobal('fetch', fetchMock);

    // Sanity: no timestamp before the call.
    expect(localStorage.getItem(LAST_UP_KEY)).toBeNull();
    await clearGistScans();
    // After: the stamped string parses as a valid ISO date.
    const stamped = localStorage.getItem(LAST_UP_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isNaN(Date.parse(/** @type {string} */ (stamped)))).toBe(false);
  });
});

describe('setStatus', () => {
  it("'up' writes to LAST_UP_KEY; 'err' with null removes LAST_ERR_KEY", () => {
    // Write-through: 'up' stamps the upload key.
    setStatus('up', '2025-04-04T04:04:04.000Z');
    expect(localStorage.getItem(LAST_UP_KEY)).toBe('2025-04-04T04:04:04.000Z');
    // Pre-seed an error, then clear it via null — the happy path for
    // a successful retry after a prior failure.
    localStorage.setItem(LAST_ERR_KEY, 'previous failure');
    setStatus('err', null);
    expect(localStorage.getItem(LAST_ERR_KEY)).toBeNull();
    // And 'down' is the mirror of 'up' for download timestamps.
    setStatus('down', '2025-04-04T05:05:05.000Z');
    expect(localStorage.getItem(LAST_DOWN_KEY)).toBe('2025-04-04T05:05:05.000Z');
  });
});
