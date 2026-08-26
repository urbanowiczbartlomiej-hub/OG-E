// @vitest-environment happy-dom

// Unit tests for state/spyIgnored — the per-universe list of probers muted on
// the "Who's spying on you" surfaces. A plain read*/write* key-owner over
// chrome.storage.local (the sanctioned non-store exception), so we mock
// `../../src/lib/storage.js` and drive the per-universe key resolution through
// the real `currentUniverseKey` by pinning `location.host`.
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
  SPY_IGNORED_KEY_BASE,
  spyIgnoredKeyFor,
  readSpyIgnored,
  readSpyIgnoredFor,
  writeSpyIgnored,
  writeSpyIgnoredFor,
} from '../../src/state/spyIgnored.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
});

describe('spyIgnoredKeyFor', () => {
  it('namespaces per universe — a player id means a different person elsewhere', () => {
    expect(spyIgnoredKeyFor('s163-pl')).toBe(`s163-pl:${SPY_IGNORED_KEY_BASE}`);
    expect(spyIgnoredKeyFor('s1-en')).not.toBe(spyIgnoredKeyFor('s163-pl'));
  });
});

describe('readSpyIgnored', () => {
  it('returns an empty set when nothing is stored', async () => {
    expect(await readSpyIgnored()).toEqual(new Set());
  });

  it('reads the stored ids', async () => {
    mock.get.mockResolvedValue([7, 8, 9]);
    expect(await readSpyIgnored()).toEqual(new Set([7, 8, 9]));
  });

  it('fails towards SHOWING alerts for any unusable payload', async () => {
    // Direction matters: a lost mute is one click to redo, whereas a corrupt
    // value that swallowed an alert is the miss this panel exists to prevent.
    for (const bad of [null, undefined, 0, 'x', {}, true]) {
      mock.get.mockResolvedValue(bad);
      expect(await readSpyIgnored()).toEqual(new Set());
    }
  });

  it('drops non-numeric members rather than trusting the whole array', async () => {
    mock.get.mockResolvedValue([7, 'x', null, Number.NaN, 8, { id: 9 }]);
    expect(await readSpyIgnored()).toEqual(new Set([7, 8]));
  });

  it('reads an explicit universe with the *For variant', async () => {
    mock.get.mockResolvedValue([1]);
    expect(await readSpyIgnoredFor('s163-pl')).toEqual(new Set([1]));
    expect(mock.get).toHaveBeenCalledWith(spyIgnoredKeyFor('s163-pl'));
  });
});

describe('writeSpyIgnored', () => {
  it('persists a sorted, de-duplicated plain array', async () => {
    // Sorted so the raw key stays readable and two devices that muted the same
    // ids produce byte-identical payloads.
    await writeSpyIgnoredFor('s163-pl', [9, 7, 8, 7]);
    expect(mock.set).toHaveBeenCalledWith(spyIgnoredKeyFor('s163-pl'), [7, 8, 9]);
  });

  it('accepts a Set (what the readers hand back) as well as an array', async () => {
    await writeSpyIgnoredFor('s163-pl', new Set([3, 1, 2]));
    expect(mock.set).toHaveBeenCalledWith(spyIgnoredKeyFor('s163-pl'), [1, 2, 3]);
  });

  it('round-trips through the mocked store', async () => {
    /** @type {Map<string, unknown>} */
    const disk = new Map();
    mock.set.mockImplementation(async (/** @type {string} */ k, /** @type {unknown} */ v) => { disk.set(k, v); });
    mock.get.mockImplementation(async (/** @type {string} */ k) => disk.get(k));

    await writeSpyIgnoredFor('s163-pl', new Set([42, 7]));
    expect(await readSpyIgnoredFor('s163-pl')).toEqual(new Set([7, 42]));
  });

  it('writes an empty array when the last mute is lifted', async () => {
    // Unmuting the only muted prober must clear the key, not leave it stale.
    await writeSpyIgnoredFor('s163-pl', new Set());
    expect(mock.set).toHaveBeenCalledWith(spyIgnoredKeyFor('s163-pl'), []);
  });

  it('uses the current tab universe for the bare variant', async () => {
    await writeSpyIgnored([5]);
    expect(mock.set).toHaveBeenCalledTimes(1);
    // happy-dom's host resolves through the real `currentUniverseKey`; we only
    // pin that the key ENDS with the shared base, not the host-derived prefix.
    expect(String(mock.set.mock.calls[0][0])).toContain(SPY_IGNORED_KEY_BASE);
  });
});
