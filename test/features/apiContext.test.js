// @vitest-environment happy-dom

// Behavioural tests for features/apiContext — the per-device breadth layer.
//
// We drive the feature's real orchestration (TTL-gated cache refresh → pure
// parse → occupancy build → publish to the shared handoff) and assert the
// OBSERVABLE outputs: (a) which feeds were fetched over the wire, (b) the cache
// written back to state/apiCache, (c) the occupancy context published to
// features/shared/apiContextStore (what the picker reads). Internals (the regex
// parsers) are covered in domain/apiOccupancy.test.js — here we only stub their
// I/O leaves so the test is hermetic:
//   - lib/ogameApi.js  → a fake fetchApiText returning XML fixtures (no socket),
//   - state/apiCache.js → an in-memory cache (no chrome.storage),
//   - state/ownProfile.js → a fixed own player id.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- I/O leaves stubbed BEFORE importing the feature (vi.mock is hoisted) ----

/** Per-file in-memory cache the apiCache mock reads/writes. */
let memCache = /** @type {any} */ ({});

vi.mock('../../src/lib/ogameApi.js', () => ({
  fetchApiText: vi.fn(),
}));

vi.mock('../../src/state/apiCache.js', () => ({
  readApiCache: vi.fn(() => Promise.resolve(memCache)),
  writeApiCache: vi.fn((c) => {
    memCache = c;
    return Promise.resolve();
  }),
}));

vi.mock('../../src/state/ownProfile.js', () => ({
  readOwnProfile: vi.fn(() => Promise.resolve({ id: 103 })),
}));

import { fetchApiText } from '../../src/lib/ogameApi.js';
import { readApiCache, writeApiCache } from '../../src/state/apiCache.js';
import {
  refreshCache,
  getContext,
  installApiContext,
  _resetApiContextForTest,
} from '../../src/features/apiContext/index.js';
import { getApiContext, _resetApiContextStoreForTest } from '../../src/features/shared/apiContextStore.js';

/** @type {import('vitest').Mock} */
const fetchMock = /** @type {any} */ (fetchApiText);

// XML fixtures — tiny, just enough to exercise the join.
const UNIVERSE_XML =
  '<universe timestamp="1700000000" serverId="163">' +
  '<planet id="1" name="HW" coords="1:1:2" player="103"/>' +
  '<planet id="2" name="Foe" coords="1:1:8" player="207"/>' +
  '</universe>';
const PLAYERS_XML =
  '<players timestamp="1700000000">' +
  '<player id="103" name="Me" status=""/>' +
  '<player id="207" name="Foe" status="i"/>' +
  '</players>';
const TOTAL_XML = '<highscore timestamp="1700000000" category="1" type="0"><player id="103" position="11" score="123456"/></highscore>';
const MILITARY_XML = '<highscore timestamp="1700000000" category="1" type="3"><player id="103" position="22" score="7890"/></highscore>';
const SERVER_XML = '<serverData timestamp="1700000000"><galaxies>9</galaxies><systems>499</systems></serverData>';

/** Route a fetch by endpoint + (for highscore) the type param to the right fixture. */
const routeFetch = () => {
  fetchMock.mockImplementation((file, params) => {
    switch (file) {
      case 'universe':
        return Promise.resolve(UNIVERSE_XML);
      case 'players':
        return Promise.resolve(PLAYERS_XML);
      case 'highscore':
        return Promise.resolve(params && params.type === '3' ? MILITARY_XML : TOTAL_XML);
      case 'serverData':
        return Promise.resolve(SERVER_XML);
      default:
        return Promise.reject(new Error(`unexpected fetch ${file}`));
    }
  });
};

beforeEach(() => {
  memCache = {};
  fetchMock.mockReset();
  routeFetch();
  /** @type {import('vitest').Mock} */ (/** @type {any} */ (readApiCache)).mockClear();
  /** @type {import('vitest').Mock} */ (/** @type {any} */ (writeApiCache)).mockClear();
  _resetApiContextForTest();
  _resetApiContextStoreForTest();
  // Galaxy page; debug probe OFF by default.
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php?page=ingame&component=galaxy&galaxy=1&system=1';
  localStorage.clear();
});

afterEach(() => {
  _resetApiContextForTest();
  _resetApiContextStoreForTest();
});

describe('refreshCache — cold (empty cache)', () => {
  it('fetches every feed and reports them', async () => {
    const { fetched } = await refreshCache();
    expect(fetched).toEqual(['universe', 'players', 'total', 'military', 'honor', 'server']);
  });

  it('writes the parsed feeds back to the cache once', async () => {
    await refreshCache();
    expect(writeApiCache).toHaveBeenCalledTimes(1);
    const written = /** @type {any} */ (/** @type {any} */ (writeApiCache).mock.calls[0][0]);
    expect(written.universe.planets).toEqual([
      { coords: '1:1:2', player: 103 },
      { coords: '1:1:8', player: 207 },
    ]);
    expect(written.players.players['207'].status).toBe('i');
    expect(written.total.ranks['103'].position).toBe(11);
    expect(written.military.ranks['103'].position).toBe(22);
    expect(written.server.data).toEqual({
      timestamp: 1700000000 * 1000,
      galaxies: 9,
      systems: 499,
      donutGalaxy: false,
      donutSystem: false,
      domain: undefined,
      name: undefined,
    });
    // Each feed stamped with fetchedAt.
    expect(typeof written.universe.fetchedAt).toBe('number');
  });
});

describe('refreshCache — TTL gating', () => {
  it('serves everything from cache when all feeds are within TTL (no fetch, no write)', async () => {
    const now = Date.now();
    memCache = {
      universe: { planets: [], fetchedAt: now },
      players: { players: {}, fetchedAt: now },
      total: { ranks: {}, fetchedAt: now },
      military: { ranks: {}, fetchedAt: now },
      honor: { ranks: {}, fetchedAt: now },
      server: { data: {}, fetchedAt: now },
    };
    const { fetched } = await refreshCache();
    expect(fetched).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeApiCache).not.toHaveBeenCalled();
  });

  it('re-fetches only the feeds past their cadence TTL', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    memCache = {
      universe: { planets: [], fetchedAt: now }, // weekly — fresh
      players: { players: {}, fetchedAt: now }, // daily — fresh
      total: { ranks: {}, fetchedAt: now - 2 * HOUR }, // hourly — STALE
      military: { ranks: {}, fetchedAt: now - 2 * HOUR }, // hourly — STALE
      honor: { ranks: {}, fetchedAt: now - 2 * HOUR }, // hourly — STALE
      server: { data: {}, fetchedAt: now - 2 * DAY }, // daily — STALE
    };
    const { fetched } = await refreshCache();
    expect(fetched).toEqual(['total', 'military', 'honor', 'server']);
  });

  it('force re-fetches every feed regardless of freshness', async () => {
    const now = Date.now();
    memCache = {
      universe: { planets: [], fetchedAt: now },
      players: { players: {}, fetchedAt: now },
      total: { ranks: {}, fetchedAt: now },
      military: { ranks: {}, fetchedAt: now },
      honor: { ranks: {}, fetchedAt: now },
      server: { data: {}, fetchedAt: now },
    };
    const { fetched } = await refreshCache({ force: true });
    expect(fetched).toEqual(['universe', 'players', 'total', 'military', 'honor', 'server']);
  });
});

describe('getContext — builds + publishes the occupancy index', () => {
  it('joins feeds into an occupancy index and flags own colonies', async () => {
    const ctx = await getContext();
    // Points (total + the newly-joined military feed) must reach the INDEX,
    // not just ride along as raw feeds on the context.
    expect(ctx.index.occupied.get('1:1:2')).toMatchObject({
      player: 103, name: 'Me', rank: 11, score: 123456, militaryScore: 7890,
    });
    expect([...ctx.index.ownColonies]).toEqual(['1:1:2']); // ownPlayerId 103
    expect(ctx.server).toEqual(
      expect.objectContaining({ galaxies: 9, systems: 499 }),
    );
    expect(ctx.military.ranks['103'].position).toBe(22);
  });

  it('publishes the built context to the shared handoff (what the picker reads)', async () => {
    expect(getApiContext()).toBeNull();
    const ctx = await getContext();
    const published = getApiContext();
    expect(published).not.toBeNull();
    expect(published?.index).toBe(ctx.index);
    expect(published?.server).toBe(ctx.server);
  });
});

describe('installApiContext — silent build path (no debug flag)', () => {
  it('builds + publishes the occupancy context on install', async () => {
    installApiContext();
    // getContext() runs async inside install; drain its promise chain.
    await vi.waitFor(() => {
      expect(getApiContext()).not.toBeNull();
    });
    expect(getApiContext()?.index.occupied.has('1:1:2')).toBe(true);
  });

  it('is idempotent — a second install does not fetch again', async () => {
    installApiContext();
    await vi.waitFor(() => expect(getApiContext()).not.toBeNull());
    const callsAfterFirst = fetchMock.mock.calls.length;
    installApiContext(); // no-op
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does nothing observable when a fetch fails (picker falls back to live-scan-only)', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('offline'));
    installApiContext();
    // Give the rejected chain a chance to settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(getApiContext()).toBeNull();
  });
});
