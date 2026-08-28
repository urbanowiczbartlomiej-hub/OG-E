// @vitest-environment happy-dom
//
// Unit tests for state/homeWatch — the plain read*/write* key-owner storing the
// per-system baseline + arrival log, and the shownAt/expiry math that replaced
// the old "clear NEW" button. We mock `../../src/lib/storage.js` so every
// chromeStore.get/set is a vi.fn we assert on (matching apiCache.test.js).
//
// @ts-check

import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

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
  HOME_WATCH_KEY_BASE,
  homeWatchKeyFor,
  emptyHomeWatch,
  readHomeWatch,
  writeHomeWatch,
  markHomeArrivalsShown,
  markHomeArrivalsSeen,
  openHomeArrivals,
  unreadHomeArrivals,
} from '../../src/state/homeWatch.js';
import { NEW_ARRIVAL_TTL_MS, NEW_ARRIVAL_MAX_MS } from '../../src/domain/homeWatch.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

const NOW = 10_000_000;

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php';
});

describe('homeWatchKeyFor', () => {
  it('namespaces the base key with the universe id', () => {
    expect(homeWatchKeyFor('s163-pl')).toBe('s163-pl:oge_homeWatch');
    expect(HOME_WATCH_KEY_BASE).toBe('oge_homeWatch');
  });
});

describe('readHomeWatch', () => {
  it('returns the empty default when nothing is stored', async () => {
    await expect(readHomeWatch('s163-pl')).resolves.toEqual(emptyHomeWatch());
  });

  it('returns the empty default for a malformed blob', async () => {
    mock.get.mockResolvedValueOnce('garbage');
    await expect(readHomeWatch('s163-pl')).resolves.toEqual(emptyHomeWatch());
  });

  it('reads baseline + arrivals from the stored blob, defaulting missing fields', async () => {
    mock.get.mockResolvedValueOnce({ baseline: { '4:151': { ids: [1], seenAt: 5 } } });
    await expect(readHomeWatch('s163-pl')).resolves.toEqual({
      baseline: { '4:151': { ids: [1], seenAt: 5 } },
      arrivals: [],
    });
  });

  it('carries dismissedAt forward only when it is a number', async () => {
    mock.get.mockResolvedValueOnce({ baseline: {}, arrivals: [], dismissedAt: 42 });
    await expect(readHomeWatch('s163-pl')).resolves.toEqual({
      baseline: {}, arrivals: [], dismissedAt: 42,
    });
  });

  it('reads the current-universe key derived from location.host when omitted', async () => {
    await readHomeWatch();
    expect(mock.get).toHaveBeenCalledWith('s163-pl:oge_homeWatch');
  });
});

describe('writeHomeWatch', () => {
  it('persists wholesale under the given universe key', async () => {
    const state = { baseline: {}, arrivals: [] };
    await writeHomeWatch(state, 's163-pl');
    expect(mock.set).toHaveBeenCalledWith('s163-pl:oge_homeWatch', state);
  });
});

describe('openHomeArrivals — the isArrivalNew gates', () => {
  it('is NEW when never shown and well within the max age', () => {
    const state = { baseline: {}, arrivals: [{
      system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000,
    }] };
    expect(openHomeArrivals(state, NOW)).toHaveLength(1);
  });

  it('stays NEW while shown less than the TTL ago', () => {
    const state = { baseline: {}, arrivals: [{
      system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000, shownAt: NOW - (NEW_ARRIVAL_TTL_MS - 1),
    }] };
    expect(openHomeArrivals(state, NOW)).toHaveLength(1);
  });

  it('expires once shown at least the TTL ago', () => {
    const state = { baseline: {}, arrivals: [{
      system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000, shownAt: NOW - NEW_ARRIVAL_TTL_MS,
    }] };
    expect(openHomeArrivals(state, NOW)).toEqual([]);
  });

  it('expires at the hard ceiling even if never shown', () => {
    const state = { baseline: {}, arrivals: [{
      system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - NEW_ARRIVAL_MAX_MS,
    }] };
    expect(openHomeArrivals(state, NOW)).toEqual([]);
  });

  it('honours a legacy dismissedAt: arrivals at or before it are not NEW', () => {
    const state = {
      baseline: {},
      dismissedAt: NOW - 500,
      arrivals: [
        { system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000 },
        { system: '4:151', coord: '4:151:9', playerId: 200, atMs: NOW - 100 },
      ],
    };
    expect(openHomeArrivals(state, NOW).map((a) => a.playerId)).toEqual([200]);
  });
});

describe('markHomeArrivalsShown', () => {
  it('stamps shownAt on every open, unshown arrival and writes once', async () => {
    mock.get.mockResolvedValueOnce({
      baseline: {},
      arrivals: [{
        system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000,
      }],
    });
    const wrote = await markHomeArrivalsShown('s163-pl', NOW);
    expect(wrote).toBe(true);
    expect(mock.set).toHaveBeenCalledTimes(1);
    const [, written] = mock.set.mock.calls[0];
    expect(written.arrivals[0].shownAt).toBe(NOW);
  });

  it('leaves an already-shown arrival untouched', async () => {
    mock.get.mockResolvedValueOnce({
      baseline: {},
      arrivals: [{
        system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000, shownAt: NOW - 500,
      }],
    });
    const wrote = await markHomeArrivalsShown('s163-pl', NOW);
    expect(wrote).toBe(false);
    expect(mock.set).not.toHaveBeenCalled();
  });

  it('is a no-op (no write) when there is nothing open to stamp', async () => {
    mock.get.mockResolvedValueOnce({
      baseline: {},
      arrivals: [{
        system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - NEW_ARRIVAL_MAX_MS,
      }],
    });
    const wrote = await markHomeArrivalsShown('s163-pl', NOW);
    expect(wrote).toBe(false);
    expect(mock.set).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call after stamping writes nothing further', async () => {
    const arrival = {
      system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000,
    };
    mock.get.mockResolvedValueOnce({ baseline: {}, arrivals: [arrival] });
    await markHomeArrivalsShown('s163-pl', NOW);
    const [, written] = mock.set.mock.calls[0];

    mock.get.mockResolvedValueOnce(written);
    const wrote = await markHomeArrivalsShown('s163-pl', NOW + 1);
    expect(wrote).toBe(false);
    expect(mock.set).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// unreadHomeArrivals — the FAB nudge's stricter predicate
// ──────────────────────────────────────────────────────────────────

describe('unreadHomeArrivals', () => {
  /** @param {Partial<{ shownAt: number, atMs: number }>} over */
  const arrival = (over = {}) => ({
    system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000, ...over,
  });

  it('lists an arrival nobody has looked at yet', () => {
    const state = { baseline: {}, arrivals: [arrival()] };
    expect(unreadHomeArrivals(state, NOW)).toHaveLength(1);
  });

  // The whole point of the split: the dashboard keeps its NEW mark for a day
  // after you read the row, but the pulsing FAB has to stop the moment the news
  // is read — an alert that outlives its own answer becomes furniture.
  it('drops an arrival the moment it has been shown, while openHomeArrivals keeps it', () => {
    const state = { baseline: {}, arrivals: [arrival({ shownAt: NOW - 1 })] };
    expect(openHomeArrivals(state, NOW)).toHaveLength(1);
    expect(unreadHomeArrivals(state, NOW)).toHaveLength(0);
  });

  it('still honours the expiry gates it inherits (too old to be NEW at all)', () => {
    const state = { baseline: {}, arrivals: [arrival({ atMs: NOW - NEW_ARRIVAL_MAX_MS })] };
    expect(unreadHomeArrivals(state, NOW)).toHaveLength(0);
  });

  it('is empty for a state with no arrivals', () => {
    expect(unreadHomeArrivals(emptyHomeWatch(), NOW)).toEqual([]);
  });
});

describe('markHomeArrivalsSeen', () => {
  // The FAB long-press: same stamp the dashboard writes when it paints the row,
  // so "seen by holding the button" and "seen by reading the card" cannot mean
  // two different things.
  it('stamps the current universe\'s open arrivals as shown', async () => {
    mock.get.mockResolvedValueOnce({
      baseline: {},
      arrivals: [{ system: '4:151', coord: '4:151:8', playerId: 100, atMs: NOW - 1_000 }],
    });
    const wrote = await markHomeArrivalsSeen(NOW);
    expect(wrote).toBe(true);
    const [key, written] = mock.set.mock.calls[0];
    expect(key).toBe('s163-pl:oge_homeWatch');
    expect(written.arrivals[0].shownAt).toBe(NOW);
    expect(unreadHomeArrivals(written, NOW)).toHaveLength(0);
  });

  it('writes nothing when there is no unread news to retire', async () => {
    mock.get.mockResolvedValueOnce(emptyHomeWatch());
    await expect(markHomeArrivalsSeen(NOW)).resolves.toBe(false);
    expect(mock.set).not.toHaveBeenCalled();
  });
});
