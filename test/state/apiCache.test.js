// @vitest-environment happy-dom

// Unit tests for state/apiCache — a plain read*/write* key-owner over
// chrome.storage.local (the sanctioned non-store exception). We mock
// `../../src/lib/storage.js` so every chromeStore.get/set is a vi.fn we assert
// on, and drive the per-universe key resolution through the real
// `currentUniverseKey` by pinning `location.host` via happy-dom.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    onChanged: vi.fn(),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  apiCacheKeyFor,
  readApiCache,
  readApiCacheFor,
  writeApiCache,
} from '../../src/state/apiCache.js';

/**
 * @type {{ get: import('vitest').Mock, set: import('vitest').Mock }}
 */
const mock = /** @type {any} */ (chromeStore);

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php';
});

describe('apiCacheKeyFor', () => {
  it('namespaces the base key with the universe id', () => {
    expect(apiCacheKeyFor('s163-pl')).toBe('s163-pl:oge_apiCache');
  });
});

describe('readApiCache (current universe)', () => {
  it('reads the per-universe key derived from location.host', async () => {
    await readApiCache();
    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(mock.get).toHaveBeenCalledWith('s163-pl:oge_apiCache');
  });

  it('returns the stored object when present', async () => {
    const stored = { universe: { planets: [{ coords: '1:1:1' }], fetchedAt: 5 } };
    mock.get.mockResolvedValueOnce(stored);
    await expect(readApiCache()).resolves.toBe(stored);
  });

  it('returns {} when nothing is stored', async () => {
    await expect(readApiCache()).resolves.toEqual({});
  });

  it('returns {} when the stored value is not an object', async () => {
    mock.get.mockResolvedValueOnce('garbage');
    await expect(readApiCache()).resolves.toEqual({});
  });
});

describe('readApiCacheFor (explicit universe)', () => {
  it('reads the given universe key, ignoring location', async () => {
    await readApiCacheFor('s999-en');
    expect(mock.get).toHaveBeenCalledWith('s999-en:oge_apiCache');
  });

  it('returns {} when nothing is stored for that universe', async () => {
    await expect(readApiCacheFor('s999-en')).resolves.toEqual({});
  });
});

describe('writeApiCache', () => {
  it('persists wholesale under the current-universe key', async () => {
    /** @type {import('../../src/state/apiCache.js').ApiCache} */
    const cache = { server: { data: { galaxies: 9, systems: 499 }, fetchedAt: 1 } };
    await writeApiCache(cache);
    expect(mock.set).toHaveBeenCalledTimes(1);
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_apiCache', cache);
  });
});
