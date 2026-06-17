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
  triggerSync,
  triggerResetGalaxy,
} from '../../../src/features/dashboard/io.js';
import { chromeStore } from '../../../src/lib/storage.js';
import { historyKeyFor } from '../../../src/state/history.js';
import { scansKeyFor } from '../../../src/state/scans.js';
import {
  syncRequestKeyFor,
  resetGalaxyKeyFor,
} from '../../../src/sync/scheduler.js';

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
    expect(res).toEqual({ colonies: 0, scans: 0, warning: 'Invalid JSON' });
    expect(chromeStore.set).not.toHaveBeenCalled();
  });

  it('returns Invalid JSON when the payload is not an object', async () => {
    const res = await importAllData(jsonFile('123'), UNI);
    expect(res.warning).toBe('Invalid JSON');
  });

  it('rejects an unsupported schema version without writing', async () => {
    const res = await importAllData(jsonFile({ version: 99, colonyHistory: [colony(1)] }), UNI);
    expect(res).toEqual({ colonies: 0, scans: 0, warning: 'Unsupported version' });
    expect(chromeStore.set).not.toHaveBeenCalled();
  });
});

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

    expect(res.colonies).toBe(1); // only cp=2 is new
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
    expect(res.colonies).toBe(0);
    // get for the re-read, but never a set (added === 0).
    expect(chromeStore.set).not.toHaveBeenCalledWith(HKEY, expect.anything());
  });

  it('treats absent local history as empty', async () => {
    const res = await importAllData(
      jsonFile({ version: 1, colonyHistory: [colony(5)] }),
      UNI,
    );
    expect(res.colonies).toBe(1);
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

    expect(res.scans).toBe(2); // 1:9 updated + 1:3 added
    const merged = store.get(SKEY);
    expect(merged['1:2'].scannedAt).toBe(100); // unchanged
    expect(merged['1:9'].scannedAt).toBe(200); // updated
    expect(merged['1:3'].scannedAt).toBe(10); // added
  });
});

describe('importAllData — partial & unknown fields', () => {
  it('imports colonyHistory only, leaving scans untouched', async () => {
    const res = await importAllData(
      jsonFile({ version: 1, colonyHistory: [colony(1)] }),
      UNI,
    );
    expect(res).toEqual({ colonies: 1, scans: 0 });
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
    expect(res.colonies).toBe(1);
    expect(store.get(HKEY).map((/** @type {any} */ e) => e.cp)).toEqual([3]);
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

  it('exportAllData reads both keys and downloads a version-tagged JSON', async () => {
    store.set(HKEY, [colony(1)]);
    store.set(SKEY, { '1:2': { scannedAt: 100 } });

    await exportAllData(UNI);

    expect(chromeStore.get).toHaveBeenCalledWith(HKEY);
    expect(chromeStore.get).toHaveBeenCalledWith(SKEY);
    expect(downloads[0]).toMatch(/^oge-s163-pl-\d{4}-\d{2}-\d{2}\.json$/);

    const payload = JSON.parse(await blobs[0].text());
    expect(payload.version).toBe(1);
    expect(payload.colonyHistory).toHaveLength(1);
    expect(payload.galaxyScans['1:2'].scannedAt).toBe(100);
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

describe('sync tombstone triggers', () => {
  it('triggerSync writes a numeric timestamp to the per-universe sync key', async () => {
    await triggerSync(UNI);
    expect(chromeStore.set).toHaveBeenCalledWith(syncRequestKeyFor(UNI), expect.any(Number));
  });

  it('triggerResetGalaxy writes "<galaxy>:<ts>" so repeats fire fresh onChanged', async () => {
    await triggerResetGalaxy(4, UNI);
    const [, value] = /** @type {import('vitest').Mock} */ (chromeStore.set).mock.calls.at(-1);
    expect(value).toMatch(/^4:\d+$/);
    expect(chromeStore.set).toHaveBeenCalledWith(resetGalaxyKeyFor(UNI), expect.stringMatching(/^4:/));
  });
});
