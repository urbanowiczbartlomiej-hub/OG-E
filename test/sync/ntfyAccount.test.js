// @ts-check

// `fetch` is stubbed globally — these assert the request shape and the
// field extraction, not real ntfy responses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchNtfyAccount } from '../../src/sync/ntfyAccount.js';

const VALID = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';

/** @type {ReturnType<typeof vi.fn>} */
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  // @ts-expect-error — overriding the global for the test scope.
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchNtfyAccount', () => {
  it('never hits the network for a malformed token', async () => {
    const r = await fetchNtfyAccount('not-a-token');
    expect(r).toEqual({ ok: false, status: 0, error: 'badtoken' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls /v1/account with the auth query param', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        role: 'user',
        tier: { name: 'Pro' },
        limits: { messages: 250 },
        stats: { messages: 12, messages_remaining: 238 },
      }),
    });
    const r = await fetchNtfyAccount(VALID);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('https://ntfy.sh/v1/account?auth=');
    expect(url).toContain(
      'auth=' + btoa('Bearer ' + VALID).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
    expect(r).toEqual({
      ok: true,
      status: 200,
      used: 12,
      remaining: 238,
      limit: 250,
      tier: 'Pro',
    });
  });

  it('falls back to role when tier name is absent, omits missing usage fields', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'admin', limits: {}, stats: {} }),
    });
    const r = await fetchNtfyAccount(VALID);
    expect(r).toEqual({
      ok: true,
      status: 200,
      used: undefined,
      remaining: undefined,
      limit: undefined,
      tier: 'admin',
    });
  });

  it('maps a non-2xx response to an http error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await fetchNtfyAccount(VALID)).toEqual({ ok: false, status: 401, error: 'http' });
  });

  it('maps a fetch rejection to a network error', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await fetchNtfyAccount(VALID)).toEqual({ ok: false, status: 0, error: 'network' });
  });

  it('maps an unparseable body to a parse error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    expect(await fetchNtfyAccount(VALID)).toEqual({ ok: false, status: 200, error: 'parse' });
  });
});
