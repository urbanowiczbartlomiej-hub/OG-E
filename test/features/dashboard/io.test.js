// @vitest-environment happy-dom
//
// Tests for the dashboard's import/export + sync-tombstone I/O. The merge
// semantics (local-wins for colonies, newer-scannedAt-wins for scans) are
// the part with real branching, so they get the most coverage. We back the
// mocked `chromeStore` with an in-memory Map so import → re-read → write is
// exercised end to end, and assert the trigger* helpers write the exact
// namespaced tombstone keys the sync scheduler observes.
//
// The real key composers (historyKeyFor / scansKeyFor / *KeyFor) are used
// both by the module under test and by these tests, so get/set line up on
// the same keys regardless of how namespacing resolves under the test env.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map();

// Keep the real module (safeLS etc. are pulled in transitively by the
// state/sync modules io.js imports) and override only chromeStore with an
// in-memory map so the import → re-read → write round-trip is exercised.
vi.mock('../../../src/lib/storage.js', async (importActual) => {
  const actual = /** @type {any} */ (await importActual());
  return {
    ...actual,
    chromeStore: {
      get: vi.fn((k) => Promise.resolve(store.has(k) ? store.get(k) : undefined)),
      set: vi.fn((k, v) => {
        store.set(k, v);
        return Promise.resolve();
      }),
    },
  };
});

import {
  exportAllData,
  importAllData,
  exportColonyCsv,
} from '../../../src/features/dashboard/io.js';
import { chromeStore } from '../../../src/lib/storage.js';
import { historyKeyFor } from '../../../src/state/history.js';
import { scansKeyFor } from '../../../src/state/scans.js';
import { watchListKeyFor, watchListTsKeyFor } from '../../../src/state/watchList.js';

const UNI = 's163-pl';
const HKEY = historyKeyFor(UNI);
const SKEY = scansKeyFor(UNI);

/**
 * A colony entry with all CSV columns populated.
 * @param {number} cp
 * @param {Record<string, unknown>} [over]
 */
const colony = (cp, over = {}) => ({
  cp,
  coords: `1:2:${cp}`,
  position: cp,
  fields: 100 + cp,
  timestamp: 1_000 + cp,
  ...over,
});

/**
 * Build a JSON File the way the dashboard's <input type=file> hands it over.
 * @param {unknown} obj  Object (stringified) or a raw string (passed verbatim).
 */
const jsonFile = (obj) =>
  new File([typeof obj === 'string' ? obj : JSON.stringify(obj)], 'import.json', {
    type: 'application/json',
  });

beforeEach(() => {
  store.clear();
  /** @type {import('vitest').Mock} */ (chromeStore.get).mockClear();
  /** @type {import('vitest').Mock} */ (chromeStore.set).mockClear();
});

describe('importAllData — guards', () => {
  it('returns an Invalid JSON warning on unparseable input', async () => {
    const res = await importAllData(jsonFile('not json {{{'), UNI);
    expect(res).toEqual({ parts: [], skipped: [], warning: 'Invalid JSON' });
    expect(chromeStore.set).not.toHaveBeenCalled();
  });

  it('returns Invalid JSON when the payload is not an object', async () => {
    const res = await importAllData(jsonFile('123'), UNI);
    expect(res.warning).toBe('Invalid JSON');
  });

  it('rejects an unsupported schema version without writing', async () => {
    const res = await importAllData(jsonFile({ version: 99, colonyHistory: [colony(1)] }), UNI);
    expect(res).toEqual({ parts: [], skipped: [], warning: 'Unsupported version' });
    expect(chromeStore.set).not.toHaveBeenCalled();
  });
});

/**
 * Count for one dataset label out of the v2 import summary (`parts`), 0 when
 * the label is absent (nothing new for that dataset).
 * @param {{ parts: { label: string, count: number }[] }} res
 * @param {string} label
 * @returns {number}
 */
const importCount = (res, label) => res.parts.find((p) => p.label === label)?.count ?? 0;

describe('importAllData — colony merge (local wins on cp collision)', () => {
  it('adds only new cps and keeps the local entry on collision', async () => {
    store.set(HKEY, [colony(1, { fields: 999 })]); // local cp=1, distinctive fields
    const res = await importAllData(
      jsonFile({
        version: 1,
        colonyHistory: [colony(1, { fields: 1 }), colony(2)],
      }),
      UNI,
    );

    expect(importCount(res, 'colonies')).toBe(1); // only cp=2 is new
    const stored = store.get(HKEY);
    const byCp = new Map(stored.map((/** @type {any} */ e) => [e.cp, e]));
    expect(byCp.get(1).fields).toBe(999); // local won the collision
    expect(byCp.get(2)).toBeTruthy();
  });

  it('does not write when nothing new is added', async () => {
    store.set(HKEY, [colony(1)]);
    const res = await importAllData(
      jsonFile({ version: 1, colonyHistory: [colony(1)] }),
      UNI,
    );
    expect(importCount(res, 'colonies')).toBe(0);
    // get for the re-read, but never a set (added === 0).
    expect(chromeStore.set).not.toHaveBeenCalledWith(HKEY, expect.anything());
  });

  it('treats absent local history as empty', async () => {
    const res = await importAllData(
      jsonFile({ version: 1, colonyHistory: [colony(5)] }),
      UNI,
    );
    expect(importCount(res, 'colonies')).toBe(1);
    expect(store.get(HKEY)).toHaveLength(1);
  });
});

describe('importAllData — scan merge (newer scannedAt wins)', () => {
  it('keeps local when the imported scan is older, updates when newer', async () => {
    store.set(SKEY, {
      '1:2': { scannedAt: 100 },
      '1:9': { scannedAt: 100 },
    });
    const res = await importAllData(
      jsonFile({
        version: 1,
        galaxyScans: {
          '1:2': { scannedAt: 50 }, // older → ignored
          '1:9': { scannedAt: 200 }, // newer → wins
          '1:3': { scannedAt: 10 }, // new key → added
        },
      }),
      UNI,
    );

    expect(importCount(res, 'scans')).toBe(2); // 1:9 updated + 1:3 added
    const merged = store.get(SKEY);
    expect(merged['1:2'].scannedAt).toBe(100); // unchanged
    expect(merged['1:9'].scannedAt).toBe(200); // updated
    expect(merged['1:3'].scannedAt).toBe(10); // added
  });
});

describe('importAllData — scan merge preserves lifeform markers (canonical merge)', () => {
  it('keeps a local lifeform discovery when a newer plain rescan is imported', async () => {
    // Local has a lifeform discovery; the imported file is a newer PLAIN rescan
    // (no LF fields). The old per-file merge would replace the whole entry and
    // erase the discovery; the canonical mergeScans reconciles LF independently.
    store.set(SKEY, { '1:2': { scannedAt: 100, lfScannedAt: 999, lfPositions: { 3: 999 } } });
    const res = await importAllData(
      jsonFile({ version: 1, galaxyScans: { '1:2': { scannedAt: 200 } } }),
      UNI,
    );
    expect(importCount(res, 'scans')).toBe(1);
    const merged = store.get(SKEY);
    expect(merged['1:2'].scannedAt).toBe(200); // newer base scan wins
    expect(merged['1:2'].lfScannedAt).toBe(999); // discovery NOT erased
    expect(merged['1:2'].lfPositions).toEqual({ 3: 999 });
  });
});

describe('importAllData — partial & unknown fields', () => {
  it('imports colonyHistory only, leaving scans untouched', async () => {
    const res = await importAllData(
      jsonFile({ version: 1, colonyHistory: [colony(1)] }),
      UNI,
    );
    expect(res).toEqual({ parts: [{ label: 'colonies', count: 1 }], skipped: [] });
    expect(chromeStore.set).not.toHaveBeenCalledWith(SKEY, expect.anything());
  });

  it('silently ignores legacy/extra fields (deletedColonies, universeId)', async () => {
    const res = await importAllData(
      jsonFile({
        version: 1,
        universeId: 's999-xx',
        deletedColonies: [{ cp: 7 }],
        colonyHistory: [colony(3)],
      }),
      UNI,
    );
    expect(importCount(res, 'colonies')).toBe(1);
    expect(store.get(HKEY).map((/** @type {any} */ e) => e.cp)).toEqual([3]);
  });
});

describe('importAllData — v2 payloads', () => {
  it('merges a v2 watchList slot: union + a NEWER file tombstone un-stars locally', async () => {
    const fileTs = Date.now() + 60_000; // beats the import-time seed stamp
    store.set(watchListKeyFor(UNI), { players: ['1'], probes: 7, rescan: { 1: 123 } });
    const res = await importAllData(
      jsonFile({
        version: 2,
        data: {
          watchList: {
            watched: { 1: { ts: fileTs }, 2: { v: true, ts: fileTs } },
            rel: { 2: { v: 'enemy', ts: fileTs } }, // legacy tag in an OLD file
          },
        },
      }),
      UNI,
    );
    expect(importCount(res, 'watch entries')).toBeGreaterThan(0);
    const cfg = store.get(watchListKeyFor(UNI));
    expect(cfg.players).toEqual(['2']); // 1 un-starred by the newer tombstone, 2 added
    // The old file's 'enemy' tag lands as the hue it used to paint.
    expect(cfg.colors).toEqual({ 2: '#e2726a' });
    expect(cfg.probes).toBe(7); // local-only fields preserved
    expect(cfg.rescan).toEqual({ 1: 123 });
    // The imported stamps land in the ledger verbatim (LWW continuity).
    expect(store.get(watchListTsKeyFor(UNI)).watched[1]).toBe(fileTs);
  });

  it('skips unknown data fields and reports them (forward compatibility)', async () => {
    const res = await importAllData(
      jsonFile({ version: 2, data: { futureDataset: { x: 1 } } }),
      UNI,
    );
    expect(res.parts).toEqual([]);
    expect(res.skipped).toEqual(['futureDataset']);
  });
});

describe('export round-trips', () => {
  /** @type {string[]} */
  const downloads = [];
  /** @type {Blob[]} */
  let blobs = [];

  beforeEach(() => {
    downloads.length = 0;
    blobs = [];
    // happy-dom doesn't implement createObjectURL; provide it so the
    // download path runs without throwing.
    URL.createObjectURL = vi.fn((b) => {
      blobs.push(/** @type {Blob} */ (b));
      return 'blob:mock';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      /** @this {HTMLAnchorElement} */ function () {
        downloads.push(this.download);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exportAllData downloads a v2 payload with non-empty datasets under data', async () => {
    store.set(HKEY, [colony(1)]);
    store.set(SKEY, { '1:2': { scannedAt: 100 } });

    const res = await exportAllData(UNI);

    expect(chromeStore.get).toHaveBeenCalledWith(HKEY);
    expect(chromeStore.get).toHaveBeenCalledWith(SKEY);
    expect(downloads[0]).toMatch(/^oge-s163-pl-\d{4}-\d{2}-\d{2}\.json$/);

    const payload = JSON.parse(await blobs[0].text());
    expect(payload.version).toBe(2);
    expect(payload.universeId).toBe(UNI);
    expect(payload.data.colonyHistory).toHaveLength(1);
    expect(payload.data.galaxyScans['1:2'].scannedAt).toBe(100);
    // Empty datasets are omitted — only the two seeded ones are present.
    expect(Object.keys(payload.data).sort()).toEqual(['colonyHistory', 'galaxyScans']);
    expect(res).toEqual({ datasets: 2, bytes: expect.any(Number) });
  });

  it('the exported file never carries secrets or sync bookkeeping', async () => {
    store.set(HKEY, [colony(1)]);
    // Plant secret-bearing keys the way a real profile holds them — none may
    // leak into the file (oge_sharedSettings holds the PAT + ntfy token).
    store.set('oge_sharedSettings', { gistToken: 'ghp_SECRET', alarmClockNtfyToken: 'ntfy_SECRET' });
    store.set(`${UNI}:oge_gistToken`, 'ghp_SECRET2');

    await exportAllData(UNI);

    const text = await blobs[0].text();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('gistToken');
    expect(text).not.toContain('sharedSettings');
  });

  it('exportColonyCsv emits a header + rows sorted newest-first', async () => {
    exportColonyCsv([colony(1), colony(3), colony(2)], UNI);

    expect(downloads[0]).toBe('oge-s163-pl-colony-history.csv');
    const text = await blobs[0].text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('CP,Coords,Position,Fields,Date');
    // timestamps are 1001/1002/1003 → newest (cp=3) first.
    expect(lines[1]).toContain('"3"');
    expect(lines[3]).toContain('"1"');
  });
});
