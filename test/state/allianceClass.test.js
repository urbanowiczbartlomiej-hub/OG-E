// @vitest-environment happy-dom

// Unit tests for state/allianceClass — a plain read*/merge* key-owner over
// chrome.storage.local. We mock `../../src/lib/storage.js` so every
// chromeStore.get/set is a vi.fn we assert on, and drive the per-universe key
// resolution through the real `currentUniverseKey` by pinning `location.host`.
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
  allianceClassKeyFor,
  readAllianceClasses,
  readAllianceClassesFor,
  mergeAllianceClasses,
} from '../../src/state/allianceClass.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php';
});

describe('allianceClassKeyFor', () => {
  it('namespaces the base key with the universe id', () => {
    expect(allianceClassKeyFor('s163-pl')).toBe('s163-pl:oge_allianceClass');
  });
});

describe('readAllianceClasses (current universe)', () => {
  it('reads the per-universe key derived from location.host', async () => {
    await readAllianceClasses();
    expect(mock.get).toHaveBeenCalledWith('s163-pl:oge_allianceClass');
  });

  it('returns the stored map when present', async () => {
    const stored = { '500921': 'warrior', '500485': 'trader' };
    mock.get.mockResolvedValueOnce(stored);
    await expect(readAllianceClasses()).resolves.toBe(stored);
  });

  it('returns {} when nothing is stored / value is not an object', async () => {
    await expect(readAllianceClasses()).resolves.toEqual({});
    mock.get.mockResolvedValueOnce('garbage');
    await expect(readAllianceClasses()).resolves.toEqual({});
  });
});

describe('readAllianceClassesFor (explicit universe)', () => {
  it('reads the given universe key, ignoring location', async () => {
    await readAllianceClassesFor('s999-en');
    expect(mock.get).toHaveBeenCalledWith('s999-en:oge_allianceClass');
  });
});

describe('mergeAllianceClasses', () => {
  it('writes the merged map under the current-universe key', async () => {
    mock.get.mockResolvedValueOnce({ '1': 'trader' });
    await mergeAllianceClasses({ '500921': 'warrior' });
    expect(mock.set).toHaveBeenCalledTimes(1);
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_allianceClass', {
      '1': 'trader',
      '500921': 'warrior',
    });
  });

  it('accumulates over prior data (union, newest value wins)', async () => {
    mock.get.mockResolvedValueOnce({ '1': 'trader', '2': 'none' });
    await mergeAllianceClasses({ '2': 'warrior', '3': 'explorer' });
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_allianceClass', {
      '1': 'trader',
      '2': 'warrior',
      '3': 'explorer',
    });
  });

  it('is a no-op (no write) when nothing changed — an unchanged re-sweep', async () => {
    mock.get.mockResolvedValueOnce({ '500921': 'warrior' });
    await mergeAllianceClasses({ '500921': 'warrior' });
    expect(mock.set).not.toHaveBeenCalled();
  });

  it('is a no-op (no read/write) for an empty update', async () => {
    await mergeAllianceClasses({});
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.set).not.toHaveBeenCalled();
  });

  it('stores "none" verbatim (KNOWN no-class, distinct from never-seen)', async () => {
    mock.get.mockResolvedValueOnce({});
    await mergeAllianceClasses({ '7': 'none' });
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_allianceClass', { '7': 'none' });
  });
});
