// Unit tests for the v1.1.0 legacy-key migration.
//
// Mocks `../../src/lib/storage.js` so every chromeStore.get / set /
// remove call is observable. The migration's only side effect is on
// chrome.storage.local, so the spies are sufficient — no DOM or
// `location` is needed.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    onChanged: vi.fn(),
    getAll: vi.fn(),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import { migrateLegacyStorageKeys } from '../../src/state/migrate.js';
import { HISTORY_KEY_BASE, historyKeyFor } from '../../src/state/history.js';
import { SCANS_KEY_BASE, scansKeyFor } from '../../src/state/scans.js';

/**
 * @type {{
 *   get: import('vitest').Mock,
 *   set: import('vitest').Mock,
 *   remove: import('vitest').Mock,
 *   onChanged: import('vitest').Mock,
 *   getAll: import('vitest').Mock,
 * }}
 */
const mockStore = /** @type {any} */ (chromeStore);

/**
 * Build a `chromeStore.get` mock that resolves based on the key passed
 * in. Defaults missing entries to `undefined` (matching the real wrapper
 * for absent storage keys).
 *
 * @param {Record<string, unknown>} table
 */
const seedGet = (table) => {
  mockStore.get.mockImplementation(async (key) =>
    key in table ? table[key] : undefined,
  );
};

describe('migrateLegacyStorageKeys', () => {
  beforeEach(() => {
    mockStore.get.mockReset();
    mockStore.set.mockReset();
    mockStore.remove.mockReset();
    mockStore.set.mockResolvedValue(undefined);
    mockStore.remove.mockResolvedValue(undefined);
  });

  it('moves legacy history into the per-universe slot when the slot is empty', async () => {
    seedGet({
      [HISTORY_KEY_BASE]: [{ cp: 1, fields: 100, coords: '[1:2:3]', position: 3, timestamp: 1 }],
      // No legacy scans, no namespaced data — sole interesting case here.
    });

    await migrateLegacyStorageKeys('s163-pl');

    expect(mockStore.set).toHaveBeenCalledWith(
      historyKeyFor('s163-pl'),
      [{ cp: 1, fields: 100, coords: '[1:2:3]', position: 3, timestamp: 1 }],
    );
    expect(mockStore.remove).toHaveBeenCalledWith(HISTORY_KEY_BASE);
  });

  it('moves legacy scans into the per-universe slot when the slot is empty', async () => {
    seedGet({
      [SCANS_KEY_BASE]: { '4:30': { scannedAt: 100, positions: {} } },
    });

    await migrateLegacyStorageKeys('s163-pl');

    expect(mockStore.set).toHaveBeenCalledWith(
      scansKeyFor('s163-pl'),
      { '4:30': { scannedAt: 100, positions: {} } },
    );
    expect(mockStore.remove).toHaveBeenCalledWith(SCANS_KEY_BASE);
  });

  it('deletes legacy without overwriting when the namespaced slot already has data', async () => {
    // Realistic recovery scenario: an earlier (partial) migration or a
    // direct write happened on this universe before. Whatever sits at
    // the namespaced slot wins — we don't clobber it.
    seedGet({
      [HISTORY_KEY_BASE]: [{ cp: 1, fields: 100, coords: '[1:1:1]', position: 1, timestamp: 1 }],
      [historyKeyFor('s163-pl')]: [{ cp: 2, fields: 200, coords: '[2:2:2]', position: 2, timestamp: 2 }],
    });

    await migrateLegacyStorageKeys('s163-pl');

    // The set call for the history key must NOT have fired — the
    // namespaced slot already held data and overwriting it would lose
    // recent local progress. The legacy key gets removed either way
    // (cleanup invariant: legacy is absent post-call).
    const historySet = mockStore.set.mock.calls.find(
      (c) => c[0] === historyKeyFor('s163-pl'),
    );
    expect(historySet).toBeUndefined();
    expect(mockStore.remove).toHaveBeenCalledWith(HISTORY_KEY_BASE);
  });

  it('is a no-op when neither legacy nor namespaced data exists', async () => {
    seedGet({});

    await migrateLegacyStorageKeys('s163-pl');

    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.remove).not.toHaveBeenCalled();
  });

  it('is idempotent — a second run after migration is a clean no-op', async () => {
    // First run: legacy present, namespaced empty. Second run: legacy
    // has been removed (we model that by re-seeding the table). The
    // second run must not call set or remove.
    const initial = {
      [HISTORY_KEY_BASE]: [{ cp: 1, fields: 100, coords: '[1:1:1]', position: 1, timestamp: 1 }],
    };
    seedGet(initial);

    await migrateLegacyStorageKeys('s163-pl');

    mockStore.set.mockClear();
    mockStore.remove.mockClear();
    // Reflect the post-migration state: legacy gone, namespaced populated.
    seedGet({
      [historyKeyFor('s163-pl')]: initial[HISTORY_KEY_BASE],
    });

    await migrateLegacyStorageKeys('s163-pl');

    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.remove).not.toHaveBeenCalled();
  });

  it('resolves immediately on empty universe id (no storage touch)', async () => {
    seedGet({
      [HISTORY_KEY_BASE]: [{ cp: 1, fields: 100, coords: '[1:1:1]', position: 1, timestamp: 1 }],
    });

    await migrateLegacyStorageKeys('');

    // The defensive early-return must not even peek at storage when
    // there is no universe to migrate to.
    expect(mockStore.get).not.toHaveBeenCalled();
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.remove).not.toHaveBeenCalled();
  });

  it('handles history and scans independently in a single call', async () => {
    // History has legacy data that needs moving; scans has nothing
    // anywhere. Each branch acts on its own without interfering with
    // the other.
    seedGet({
      [HISTORY_KEY_BASE]: [{ cp: 9, fields: 99, coords: '[9:9:9]', position: 9, timestamp: 9 }],
    });

    await migrateLegacyStorageKeys('s163-pl');

    expect(mockStore.set).toHaveBeenCalledWith(
      historyKeyFor('s163-pl'),
      [{ cp: 9, fields: 99, coords: '[9:9:9]', position: 9, timestamp: 9 }],
    );
    // Scans never appeared anywhere, so no set / remove for it.
    const scansSet = mockStore.set.mock.calls.find(
      (c) => c[0] === scansKeyFor('s163-pl'),
    );
    expect(scansSet).toBeUndefined();
    const scansRemove = mockStore.remove.mock.calls.find(
      (c) => c[0] === SCANS_KEY_BASE,
    );
    expect(scansRemove).toBeUndefined();
  });
});
