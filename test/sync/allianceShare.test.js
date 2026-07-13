// @vitest-environment happy-dom
//
// Behavioral tests for sync/allianceShare — the click-driven alliance-gist
// IO. Every case stubs the global `fetch` (hermetic — see test/setup.js);
// we drive a fake GitHub response through fetchAllianceFile /
// writeAllianceFile and assert the observable request + parsed output.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  allianceFilenameFor,
  fetchAllianceFile,
  writeAllianceFile,
  ensureAllianceGist,
  ALLIANCE_GIST_DESCRIPTION,
} from '../../src/sync/allianceShare.js';

/** Build a minimal ok-Response stub around a JSON body. @param {unknown} body */
const okJson = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** @type {import('vitest').Mock} */
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = /** @type {any} */ (fetchMock);
});

describe('allianceFilenameFor', () => {
  it('scopes the file per universe', () => {
    expect(allianceFilenameFor('s163-pl')).toBe('oge-spyglass-alliance-s163-pl.json');
  });
});

describe('fetchAllianceFile', () => {
  it('GETs the gist with the EXPLICIT token and returns null when the file is absent', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ files: {} }));
    await expect(fetchAllianceFile('tok', 'gid', 's163-pl')).resolves.toBeNull();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/gists/gid');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('parses the per-universe file content', async () => {
    const doc = { version: 1, members: { Me: { updatedAtSec: 1, players: {} } } };
    fetchMock.mockResolvedValueOnce(okJson({
      files: {
        'oge-spyglass-alliance-s163-pl.json': { content: JSON.stringify(doc) },
        'oge-data.json.gz.b64': { content: 'unrelated' },
      },
    }));
    await expect(fetchAllianceFile('tok', 'gid', 's163-pl')).resolves.toEqual(doc);
  });

  it('THROWS on malformed JSON — treating it as empty would clobber every member on the next write', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      files: { 'oge-spyglass-alliance-s163-pl.json': { content: '{oops' } },
    }));
    await expect(fetchAllianceFile('tok', 'gid', 's163-pl'))
      .rejects.toThrow(/not valid JSON/);
  });

  it('throws a concise HTTP error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 404, statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'Not Found' }),
      json: async () => ({}),
    });
    await expect(fetchAllianceFile('tok', 'gid', 's163-pl'))
      .rejects.toThrow('HTTP 404: Not Found');
  });

  it('resolves a truncated file through raw_url before parsing', async () => {
    const doc = { version: 1, members: {} };
    fetchMock
      .mockResolvedValueOnce(okJson({
        files: {
          'oge-spyglass-alliance-s163-pl.json': {
            content: '{"trunca', truncated: true, raw_url: 'https://gist.example/raw',
          },
        },
      }))
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(doc) });
    await expect(fetchAllianceFile('tok', 'gid', 's163-pl')).resolves.toEqual(doc);
    expect(fetchMock.mock.calls[1][0]).toBe('https://gist.example/raw');
  });
});

describe('writeAllianceFile', () => {
  it('PATCHes ONLY the per-universe file, pretty-printed', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const doc = { version: 1, universeId: 's163-pl', members: {} };
    await writeAllianceFile('tok', 'gid', 's163-pl', doc);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/gists/gid');
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body);
    expect(Object.keys(body.files)).toEqual(['oge-spyglass-alliance-s163-pl.json']);
    expect(body.files['oge-spyglass-alliance-s163-pl.json'].content)
      .toBe(JSON.stringify(doc, null, 2));
  });
});

describe('ensureAllianceGist — discover-or-create', () => {
  it('picks the OLDEST description match from the token account\'s gists', async () => {
    fetchMock.mockResolvedValueOnce(okJson([
      { id: 'newer', description: ALLIANCE_GIST_DESCRIPTION, created_at: '2026-07-02T00:00:00Z' },
      { id: 'other', description: 'something else', created_at: '2020-01-01T00:00:00Z' },
      { id: 'older', description: ALLIANCE_GIST_DESCRIPTION, created_at: '2026-07-01T00:00:00Z' },
    ]));
    await expect(ensureAllianceGist('tok', 's163-pl'))
      .resolves.toEqual({ id: 'older', created: false });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/gists?per_page=100');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no POST when one exists
  });

  it('POSTs a fresh SECRET gist seeded with the universe file when none matches', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson([{ id: 'x', description: 'unrelated' }]))
      .mockResolvedValueOnce(okJson({ id: 'fresh123' }));
    await expect(ensureAllianceGist('tok', 's163-pl'))
      .resolves.toEqual({ id: 'fresh123', created: true });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.github.com/gists');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.description).toBe(ALLIANCE_GIST_DESCRIPTION);
    expect(body.public).toBe(false);
    const seeded = JSON.parse(body.files['oge-spyglass-alliance-s163-pl.json'].content);
    expect(seeded).toEqual({ version: 1, universeId: 's163-pl', members: {} });
  });
});
