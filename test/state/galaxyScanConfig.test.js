// Unit tests for the galaxyScanConfig state store.
//
// Like state/fsRoutes.js, this is a thin createStore wrapper; the behaviour
// worth testing is the lazy persist wiring (init hydrates from
// chrome.storage.local, with a one-time legacy-settings seed) and the
// per-universe stamp helper. We mock lib/storage.js (chromeStore + safeLS)
// before importing the module. Node env — no DOM (currentUniverseKey falls
// back to the bare suffix).
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
  safeLS: {
    get: vi.fn(),
    bool: vi.fn(),
  },
}));

import { chromeStore, safeLS } from '../../src/lib/storage.js';
import {
  GALAXY_SCAN_CONFIG_KEY_BASE,
  GALAXY_SCAN_CONFIG_TS_BASE,
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
  galaxyScanConfigStore,
  initGalaxyScanConfigStore,
  disposeGalaxyScanConfigStore,
  stampGalaxyScanConfigChanged,
} from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';

const mockStore = /** @type {any} */ (chromeStore);
const mockLS = /** @type {any} */ (safeLS);

const resetAll = () => {
  disposeGalaxyScanConfigStore();
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockLS.get.mockReset();
  mockLS.bool.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
  // No legacy AGR keys by default.
  mockLS.get.mockReturnValue(null);
  mockLS.bool.mockImplementation((/** @type {string} */ _k, /** @type {boolean} */ d) => d);
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

  it('hydrates (and normalises) a stored config', async () => {
    mockStore.get.mockResolvedValue({ positions: '12-15', rescan: { inactive: 99 } });
    initGalaxyScanConfigStore();
    await flushMicrotasks();
    const cfg = galaxyScanConfigStore.get();
    expect(cfg.positions).toBe('12-15');
    expect(cfg.rescan.inactive).toBe(99);
    expect(cfg.rescan.occupied).toBe(30 * 86400); // filled from default
  });

  it('keeps the default preset and does NOT write when nothing is stored and no legacy keys exist', async () => {
    initGalaxyScanConfigStore();
    await flushMicrotasks();
    expect(galaxyScanConfigStore.get()).toEqual(defaultGalaxyScanConfig());
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('seeds positions/preference from the legacy AGR settings keys on first run', async () => {
    // chrome.storage empty, but the game origin still has the old keys.
    mockLS.get.mockImplementation((/** @type {string} */ key) => {
      if (key === 'oge_colPositions') return '9,10';
      if (key === 'oge_colPreferOtherGalaxies') return 'false';
      return null;
    });
    mockLS.bool.mockReturnValue(false);

    initGalaxyScanConfigStore();
    await flushMicrotasks();

    const cfg = galaxyScanConfigStore.get();
    expect(cfg.positions).toBe('9,10');
    expect(cfg.preferOtherGalaxies).toBe(false);
    // Rescan stays at defaults — only positions/preference migrate.
    expect(cfg.rescan.inactive).toBe(5 * 86400);
    // (The write-through to chrome.storage is debounced 200ms; we assert the
    // in-memory hydrate here, not the deferred persist.)
  });
});

describe('stampGalaxyScanConfigChanged — flush then stamp', () => {
  beforeEach(resetAll);
  afterEach(disposeGalaxyScanConfigStore);

  it('writes the config value first, then the timestamp', async () => {
    galaxyScanConfigStore.set({ ...defaultGalaxyScanConfig(), positions: '7' });
    mockStore.set.mockClear();

    await stampGalaxyScanConfigChanged();

    const keys = mockStore.set.mock.calls.map((/** @type {any[]} */ c) => c[0]);
    expect(keys).toEqual([GALAXY_SCAN_CONFIG_KEY_BASE, GALAXY_SCAN_CONFIG_TS_BASE]);
    expect(mockStore.set.mock.calls[0][1].positions).toBe('7');
    expect(typeof mockStore.set.mock.calls[1][1]).toBe('number');
  });
});
