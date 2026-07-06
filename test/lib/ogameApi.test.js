// @vitest-environment happy-dom

// Unit tests for lib/ogameApi — the thin same-origin fetch layer for the
// OGame public statistics API. `apiUrl` is a pure URL builder we assert
// directly; `fetchApiText` is driven through a stubbed global `fetch` (the
// shared test/setup.js neuters the real one — we replace it per-case with a
// fake Response so no socket opens).
//
// @ts-check

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiUrl, fetchApiText } from '../../src/lib/ogameApi.js';

/**
 * Build a minimal Response-like object good enough for `fetchApiText`
 * (it only reads `.ok`, `.status`, `.text()`).
 * @param {{ ok?: boolean, status?: number, body?: string }} [opts]
 * @returns {any}
 */
const fakeResponse = ({ ok = true, status = 200, body = '' } = {}) => ({
  ok,
  status,
  text: () => Promise.resolve(body),
});

beforeEach(() => {
  // happy-dom gives us a real `location` defaulting to http://localhost.
  // Pin the origin so apiUrl assertions are deterministic.
  // (location.origin is read-only; set href instead.)
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php';
});

describe('apiUrl', () => {
  it('builds the same-origin /api/<file>.xml URL with no params', () => {
    expect(apiUrl('universe')).toBe(
      'https://s163-pl.ogame.gameforge.com/api/universe.xml',
    );
  });

  it('appends query params as a URLSearchParams string', () => {
    expect(apiUrl('highscore', { category: '1', type: '0' })).toBe(
      'https://s163-pl.ogame.gameforge.com/api/highscore.xml?category=1&type=0',
    );
  });

  it('uses the current location.origin (follows the host)', () => {
    window.location.href = 'https://s999-en.ogame.gameforge.com/game/index.php';
    expect(apiUrl('players')).toBe(
      'https://s999-en.ogame.gameforge.com/api/players.xml',
    );
  });

  it('targets an explicit origin when given (the dashboard, off-game-origin)', () => {
    // location is s163-pl, but the explicit origin wins — the extension-origin
    // dashboard refreshing another universe's public API.
    expect(apiUrl('universe', undefined, 'https://s5-en.ogame.gameforge.com')).toBe(
      'https://s5-en.ogame.gameforge.com/api/universe.xml',
    );
    expect(apiUrl('highscore', { category: '1', type: '3' }, 'https://s5-en.ogame.gameforge.com')).toBe(
      'https://s5-en.ogame.gameforge.com/api/highscore.xml?category=1&type=3',
    );
  });
});

describe('fetchApiText', () => {
  it('resolves with the response body text on a 2xx', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(fakeResponse({ body: '<universe/>' })));
    globalThis.fetch = /** @type {any} */ (fetchMock);

    await expect(fetchApiText('universe')).resolves.toBe('<universe/>');
  });

  it('fetches same-origin with credentials omitted (no game cookie)', async () => {
    const fetchMock = vi.fn(
      /** @param {...any} _args */ (..._args) => Promise.resolve(fakeResponse({ body: 'ok' })),
    );
    globalThis.fetch = /** @type {any} */ (fetchMock);

    await fetchApiText('players');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://s163-pl.ogame.gameforge.com/api/players.xml');
    expect(init).toEqual({ credentials: 'omit' });
  });

  it('passes params through to the fetched URL', async () => {
    const fetchMock = vi.fn(
      /** @param {...any} _args */ (..._args) => Promise.resolve(fakeResponse({ body: 'ok' })),
    );
    globalThis.fetch = /** @type {any} */ (fetchMock);

    await fetchApiText('highscore', { category: '1', type: '3' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://s163-pl.ogame.gameforge.com/api/highscore.xml?category=1&type=3',
    );
  });

  it('throws with the file name and HTTP status on a non-2xx', async () => {
    globalThis.fetch = /** @type {any} */ (
      vi.fn(() => Promise.resolve(fakeResponse({ ok: false, status: 503 })))
    );

    await expect(fetchApiText('universe')).rejects.toThrow('ogame api universe: HTTP 503');
  });

  it('fetches from an explicit origin when given (cross-origin, cookie still omitted)', async () => {
    const fetchMock = vi.fn(
      /** @param {...any} _args */ (..._args) => Promise.resolve(fakeResponse({ body: 'ok' })),
    );
    globalThis.fetch = /** @type {any} */ (fetchMock);

    await fetchApiText('universe', undefined, 'https://s5-en.ogame.gameforge.com');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://s5-en.ogame.gameforge.com/api/universe.xml');
    expect(init).toEqual({ credentials: 'omit' });
  });
});
