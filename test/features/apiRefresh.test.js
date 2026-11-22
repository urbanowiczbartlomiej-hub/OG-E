// @vitest-environment happy-dom

// Behavioural tests for features/shared/apiRefresh — the fetch/parse/cache
// orchestration shared by the in-game apiContext path and the dashboard's
// manual refresh. The TTL/force/degenerate-parse behaviour is already covered
// through the `refreshCache` alias in features/apiContext.test.js; HERE we pin
// only what is NEW to this module: the `origin` + `universeId` params that let
// the extension-origin dashboard drive a cross-origin, explicit-universe refresh.
//
// I/O leaves are stubbed (hoisted vi.mock): fetchApiText returns XML fixtures,
// state/apiCache is in-memory (all four read/write variants), logger is silenced.
//
// @ts-check

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/lib/ogameApi.js', () => ({
  fetchApiText: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Keep the module's real constants (the highscore type numbers) — only the
// storage I/O is faked.
vi.mock('../../src/state/apiCache.js', async (importOriginal) => ({
  ...(/** @type {object} */ (await importOriginal())),
  readApiCache: vi.fn(() => Promise.resolve({})),
  writeApiCache: vi.fn(() => Promise.resolve()),
  readApiCacheFor: vi.fn(() => Promise.resolve({})),
  writeApiCacheFor: vi.fn(() => Promise.resolve()),
}));

import { fetchApiText } from '../../src/lib/ogameApi.js';
import {
  readApiCache,
  writeApiCache,
  readApiCacheFor,
  writeApiCacheFor,
} from '../../src/state/apiCache.js';
import { refreshApiCache } from '../../src/features/shared/apiRefresh.js';

/** @type {import('vitest').Mock} */
const fetchMock = /** @type {any} */ (fetchApiText);

const UNIVERSE_XML =
  '<universe timestamp="1700000000" serverId="5">' +
  '<planet id="1" name="HW" coords="1:1:2" player="103"/>' +
  '</universe>';
const PLAYERS_XML = '<players timestamp="1700000000"><player id="103" name="Me" status=""/></players>';
const HS_XML = '<highscore timestamp="1700000000" category="1" type="0"><player id="103" position="11" score="1"/></highscore>';
const SERVER_XML = '<serverData timestamp="1700000000"><galaxies>9</galaxies><systems>499</systems></serverData>';

const routeFetch = () => {
  fetchMock.mockImplementation((/** @type {string} */ file) => {
    switch (file) {
      case 'universe': return Promise.resolve(UNIVERSE_XML);
      case 'players': return Promise.resolve(PLAYERS_XML);
      case 'highscore': return Promise.resolve(HS_XML);
      case 'serverData': return Promise.resolve(SERVER_XML);
      default: return Promise.reject(new Error(`unexpected fetch ${file}`));
    }
  });
};

const asMock = (/** @type {any} */ fn) => /** @type {import('vitest').Mock} */ (fn);

beforeEach(() => {
  fetchMock.mockReset();
  routeFetch();
  asMock(readApiCache).mockClear();
  asMock(writeApiCache).mockClear();
  asMock(readApiCacheFor).mockClear();
  asMock(writeApiCacheFor).mockClear();
  asMock(readApiCache).mockResolvedValue({});
  asMock(readApiCacheFor).mockResolvedValue({});
});

describe('refreshApiCache — in-game defaults (no origin / no universeId)', () => {
  it('reads + writes the CURRENT-universe cache and fetches same-origin', async () => {
    await refreshApiCache({ force: true });

    expect(readApiCache).toHaveBeenCalledTimes(1);
    expect(readApiCacheFor).not.toHaveBeenCalled();
    expect(writeApiCache).toHaveBeenCalledTimes(1);
    expect(writeApiCacheFor).not.toHaveBeenCalled();

    // Every feed fetched without an explicit origin (arg 3 undefined).
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) expect(call[2]).toBeUndefined();
  });
});

describe('refreshApiCache — lifetime military feeds', () => {
  // Type 5 is military BUILT; the kill history is type 6 and losses are type 4.
  it('reads destroyed from highscore type 6 and lost from type 4, never type 5', async () => {
    await refreshApiCache({ force: true });

    const types = fetchMock.mock.calls
      .filter((c) => c[0] === 'highscore')
      .map((c) => c[1].type);
    expect(types).toContain('6');
    expect(types).toContain('4');
    expect(types).not.toContain('5');
  });

  it('tags each cached part with the type it was fetched from', async () => {
    await refreshApiCache({ force: true });

    const written = asMock(writeApiCache).mock.calls[0][0];
    expect(written.destroyed.hsType).toBe(6);
    expect(written.lost.hsType).toBe(4);
  });
});

describe('refreshApiCache — dashboard path (explicit origin + universeId)', () => {
  const ORIGIN = 'https://s5-en.ogame.gameforge.com';

  it('reads + writes THAT universe\'s cache slice', async () => {
    await refreshApiCache({ force: true, origin: ORIGIN, universeId: 's5-en' });

    expect(readApiCacheFor).toHaveBeenCalledWith('s5-en');
    expect(readApiCache).not.toHaveBeenCalled();
    expect(writeApiCacheFor).toHaveBeenCalledTimes(1);
    expect(asMock(writeApiCacheFor).mock.calls[0][0]).toBe('s5-en');
    expect(writeApiCache).not.toHaveBeenCalled();
  });

  it('threads the origin into every fetch', async () => {
    await refreshApiCache({ force: true, origin: ORIGIN, universeId: 's5-en' });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) expect(call[2]).toBe(ORIGIN);
  });
});
