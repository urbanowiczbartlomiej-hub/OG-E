// Unit tests for the galaxyScanConfig state store.
//
// Like state/dailyRunRoutes.js, this is a thin createStore wrapper; the behaviour
// worth testing is the lazy persist wiring (init hydrates from
// chrome.storage.local) and the per-universe stamp helper. We mock
// lib/storage.js (chromeStore) before importing the module. Node env — no DOM
// (currentUniverseKey falls back to the bare suffix).
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    onChanged: vi.fn(),
  },
  // The store now keeps a game-origin localStorage backup of colonyPassword
  // (survives an extension reinstall), so it reads/writes safeLS during
  // hydrate + write-through. A no-backup stub keeps these hydration tests
  // focused on the chrome.storage path.
  safeLS: {
    json: vi.fn(() => null),
    setJSON: vi.fn(),
    get: vi.fn(() => null),
    set: vi.fn(),
    remove: vi.fn(),
    int: vi.fn((_k, d = 0) => d),
    bool: vi.fn((_k, d = false) => d),
  },
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  GALAXY_SCAN_CONFIG_KEY_BASE,
  GALAXY_SCAN_CONFIG_TS_BASE,
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
  galaxyScanConfigStore,
  initGalaxyScanConfigStore,
  disposeGalaxyScanConfigStore,
} from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';

const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  disposeGalaxyScanConfigStore();
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('galaxyScanConfig store — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeGalaxyScanConfigStore);

  it('exports the expected key suffixes', () => {
    expect(GALAXY_SCAN_CONFIG_KEY_BASE).toBe('oge_galaxyScanConfig');
    expect(GALAXY_SCAN_CONFIG_TS_BASE).toBe('oge_galaxyScanConfigTs');
  });

  it('composes per-universe namespaced keys', () => {
    expect(galaxyScanConfigKeyFor('s163-pl')).toBe('s163-pl:oge_galaxyScanConfig');
    expect(galaxyScanConfigTsKeyFor('s163-pl')).toBe('s163-pl:oge_galaxyScanConfigTs');
  });

  it('starts at the default "free positions" preset before init', () => {
    expect(galaxyScanConfigStore.get()).toEqual(defaultGalaxyScanConfig());
  });
});

describe('galaxyScanConfig store — hydration', () => {
  beforeEach(resetAll);
  afterEach(disposeGalaxyScanConfigStore);

  it('hydrates (and normalises) a stored config, ignoring a legacy rescan field', async () => {
    // The legacy `rescan` field is dropped by normalizeGalaxyScanConfig (§5d).
    mockStore.get.mockResolvedValue({ positions: '12-15', rescan: { inactive: 99 } });
    initGalaxyScanConfigStore();
    await flushMicrotasks();
    const cfg = galaxyScanConfigStore.get();
    expect(cfg.positions).toBe('12-15');
    expect(/** @type {any} */ (cfg).rescan).toBeUndefined();
    expect(cfg.preferOtherGalaxies).toBe(true); // filled from default
  });

  it('keeps the default preset and does NOT write when nothing is stored', async () => {
    initGalaxyScanConfigStore();
    await flushMicrotasks();
    expect(galaxyScanConfigStore.get()).toEqual(defaultGalaxyScanConfig());
    expect(mockStore.set).not.toHaveBeenCalled();
  });
});
