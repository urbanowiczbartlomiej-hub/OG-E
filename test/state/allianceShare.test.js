// @ts-check

// Unit tests for state/allianceShare — the plain key-owner holding the
// alliance-share config (global dict) and the per-universe pulled-intel
// cache. Mirrors the allianceClass test harness: `lib/storage.js` is mocked
// so every chromeStore.get/set is a vi.fn we assert on.

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
  ALLIANCE_SHARE_CONFIG_KEY,
  allianceIntelKeyFor,
  readAllianceShareConfig,
  writeAllianceShareConfig,
  readAllianceIntel,
  writeAllianceIntel,
} from '../../src/state/allianceShare.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
});

describe('allianceIntelKeyFor', () => {
  it('namespaces the base key with the universe id', () => {
    expect(allianceIntelKeyFor('s163-pl')).toBe('s163-pl:oge_allianceIntel');
  });
});

describe('readAllianceShareConfig', () => {
  it('normalises an absent / malformed dict to the disabled empty defaults', async () => {
    await expect(readAllianceShareConfig()).resolves.toEqual({
      enabled: false, token: '', gistId: '', shareName: '',
    });
    mock.get.mockResolvedValueOnce(['not', 'a', 'dict']);
    await expect(readAllianceShareConfig()).resolves.toEqual({
      enabled: false, token: '', gistId: '', shareName: '',
    });
    expect(mock.get).toHaveBeenCalledWith(ALLIANCE_SHARE_CONFIG_KEY);
  });

  it('passes through stored string fields and drops non-strings', async () => {
    mock.get.mockResolvedValueOnce({ token: 'ghp_x', gistId: 42, shareName: 'Me' });
    await expect(readAllianceShareConfig()).resolves.toEqual({
      // Pre-toggle config with a token reads as ENABLED (the working-share
      // migration) …
      enabled: true, token: 'ghp_x', gistId: '', shareName: 'Me',
    });
  });

  it('an explicit enabled flag always wins over the token heuristic', async () => {
    mock.get.mockResolvedValueOnce({ enabled: false, token: 'ghp_x' });
    await expect(readAllianceShareConfig()).resolves.toMatchObject({ enabled: false });
    mock.get.mockResolvedValueOnce({ enabled: true });
    await expect(readAllianceShareConfig()).resolves.toMatchObject({ enabled: true });
  });
});

describe('writeAllianceShareConfig', () => {
  it('read-modify-writes the patch over the current dict', async () => {
    mock.get.mockResolvedValueOnce({ token: 'old', gistId: 'g1', shareName: 'Me' });
    await writeAllianceShareConfig({ token: 'new' });
    expect(mock.set).toHaveBeenCalledWith(ALLIANCE_SHARE_CONFIG_KEY, {
      enabled: true, token: 'new', gistId: 'g1', shareName: 'Me',
    });
  });
});

describe('alliance intel cache', () => {
  it('returns null when nothing was pulled yet or the slot is malformed', async () => {
    await expect(readAllianceIntel('s163-pl')).resolves.toBeNull();
    mock.get.mockResolvedValueOnce({ pulledAt: 5 }); // no doc
    await expect(readAllianceIntel('s163-pl')).resolves.toBeNull();
    expect(mock.get).toHaveBeenCalledWith('s163-pl:oge_allianceIntel');
  });

  it('round-trips doc + pulledAt (non-finite pulledAt coerces to 0)', async () => {
    const doc = { version: 1, members: {} };
    await writeAllianceIntel('s163-pl', doc, 1234);
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_allianceIntel', { doc, pulledAt: 1234 });
    mock.get.mockResolvedValueOnce({ doc, pulledAt: 'garbage' });
    await expect(readAllianceIntel('s163-pl')).resolves.toEqual({ doc, pulledAt: 0 });
  });
});
