// @vitest-environment happy-dom

// Unit tests for state/historyCpIndex — the small per-universe key that lets the
// in-game content script answer "already recorded this colony?" without
// hydrating the whole colony history (~870 KB uncompressed at 10k rows). A plain
// read*/write* key-owner over chrome.storage.local, so `../../src/lib/storage.js`
// is mocked and the per-universe key resolves through the real
// `currentUniverseKey`.
//
// The invariant under test is the same one `domain/cpRanges.js` documents: this
// key may UNDER-report (a slow page-load, then it self-heals) and must never
// OVER-report (a silently dropped observation). So every unusable payload has to
// read as "nothing indexed".
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
  HISTORY_CP_INDEX_KEY_BASE,
  historyCpIndexKeyFor,
  readHistoryCpIndex,
  writeHistoryCpIndex,
} from '../../src/state/historyCpIndex.js';
import { encodeCpRanges, cpRangesHas } from '../../src/domain/cpRanges.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

beforeEach(() => {
  mock.get.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue(undefined);
  mock.set.mockResolvedValue(undefined);
});

describe('historyCpIndexKeyFor', () => {
  it('namespaces per universe — cp-ids are unique per server, not across them', () => {
    expect(historyCpIndexKeyFor('s163-pl')).toBe(`s163-pl:${HISTORY_CP_INDEX_KEY_BASE}`);
    expect(historyCpIndexKeyFor('s1-en')).not.toBe(historyCpIndexKeyFor('s163-pl'));
  });

  it('is a DIFFERENT key from the history itself', () => {
    // The whole point is that the content script can read one without the other.
    expect(HISTORY_CP_INDEX_KEY_BASE).not.toBe('oge_colonyHistory');
  });
});

describe('readHistoryCpIndex', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await readHistoryCpIndex()).toEqual([]);
  });

  it('returns the stored flat pair array unchanged', async () => {
    mock.get.mockResolvedValue([1000, 3, 8, 2]);
    expect(await readHistoryCpIndex()).toEqual([1000, 3, 8, 2]);
  });

  it('under-reports for every unusable payload', async () => {
    for (const bad of [null, undefined, 0, 'x', {}, true]) {
      mock.get.mockResolvedValue(bad);
      expect(await readHistoryCpIndex()).toEqual([]);
    }
  });
});

describe('writeHistoryCpIndex', () => {
  it('persists exactly what it is handed', async () => {
    const flat = encodeCpRanges([10, 11, 12, 20]);
    await writeHistoryCpIndex(flat);
    expect(mock.set).toHaveBeenCalledTimes(1);
    expect(String(mock.set.mock.calls[0][0])).toContain(HISTORY_CP_INDEX_KEY_BASE);
    expect(mock.set.mock.calls[0][1]).toEqual(flat);
  });
});

describe('the whole point — a membership answer without the history rows', () => {
  it('round-trips a cp set through storage and answers correctly', async () => {
    /** @type {Map<string, unknown>} */
    const disk = new Map();
    mock.set.mockImplementation(async (/** @type {string} */ k, /** @type {unknown} */ v) => { disk.set(k, v); });
    mock.get.mockImplementation(async (/** @type {string} */ k) => disk.get(k));

    const recorded = [33783651, 33783652, 33783653, 34900774];
    await writeHistoryCpIndex(encodeCpRanges(recorded));

    const idx = await readHistoryCpIndex();
    for (const cp of recorded) expect(cpRangesHas(idx, cp)).toBe(true);
    // A genuinely new colony must miss, which is what sends the recorder down
    // the slow path that reads the real history.
    expect(cpRangesHas(idx, 34900775)).toBe(false);
  });

  it('a payload from the WRONG key still cannot report a cp as known', async () => {
    // Real failure mode this guards: a storage stub (or a mis-set key) handing
    // back the colony-history ROWS. Objects must never be walked as deltas.
    mock.get.mockResolvedValue([
      { cp: 33783651, fields: 200, coords: '[1:1:1]', position: 1, timestamp: 1 },
    ]);
    const idx = await readHistoryCpIndex();
    expect(cpRangesHas(idx, 33783651)).toBe(false);
  });

  it('costs far fewer bytes than the ids it stands in for', async () => {
    // 300 consecutive colonizations in 3 runs: the index is a handful of numbers
    // where the history rows would be tens of kilobytes.
    const cps = [
      ...Array.from({ length: 100 }, (_, i) => 1000 + i),
      ...Array.from({ length: 100 }, (_, i) => 5000 + i),
      ...Array.from({ length: 100 }, (_, i) => 9000 + i),
    ];
    const flat = encodeCpRanges(cps);
    await writeHistoryCpIndex(flat);
    const written = mock.set.mock.calls[0][1];
    expect(written).toHaveLength(6);
    expect(JSON.stringify(written).length).toBeLessThan(JSON.stringify(cps).length / 10);
  });
});
