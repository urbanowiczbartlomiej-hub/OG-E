// Tests for the sharedSettings state store: lazy persist wiring (init
// hydrates from chrome.storage.local, normalises a partial blob, writes
// nothing on an empty read) and debounced write-through. We mock
// lib/storage.js (chromeStore) before importing. Node env — no DOM.
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
}));

import { chromeStore } from '../../src/lib/storage.js';
import {
  SHARED_SETTINGS_KEY,
  sharedSettingsStore,
  initSharedSettingsStore,
  disposeSharedSettingsStore,
} from '../../src/state/sharedSettings.js';
import { defaultSharedSettings } from '../../src/domain/sharedSettings.js';

const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  disposeSharedSettingsStore();
  sharedSettingsStore.set(defaultSharedSettings());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('sharedSettings store — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeSharedSettingsStore);

  it('exports the global storage key', () => {
    expect(SHARED_SETTINGS_KEY).toBe('oge_sharedSettings');
  });

  it('starts at defaults before init', () => {
    expect(sharedSettingsStore.get()).toEqual(defaultSharedSettings());
  });
});

describe('sharedSettings store — hydration', () => {
  beforeEach(resetAll);
  afterEach(disposeSharedSettingsStore);

  it('hydrates (and normalises) a stored blob', async () => {
    mockStore.get.mockResolvedValue({ colonyMinGap: '45', fsEnabled: true });
    initSharedSettingsStore();
    await flushMicrotasks();
    const s = sharedSettingsStore.get();
    expect(s.colonyMinGap).toBe(45);
    expect(s.fsEnabled).toBe(true);
    expect(s.colonyMinFields).toBe(320); // filled from default
  });

  it('keeps defaults and does NOT write when nothing is stored', async () => {
    initSharedSettingsStore();
    await flushMicrotasks();
    expect(sharedSettingsStore.get()).toEqual(defaultSharedSettings());
    expect(mockStore.set).not.toHaveBeenCalled();
  });
});

describe('sharedSettings store — write-through', () => {
  beforeEach(resetAll);
  afterEach(() => {
    disposeSharedSettingsStore();
    vi.useRealTimers();
  });

  it('persists changes to chrome.storage (debounced)', async () => {
    vi.useFakeTimers();
    initSharedSettingsStore();
    await vi.runAllTimersAsync(); // settle the async hydrate
    mockStore.set.mockClear();

    sharedSettingsStore.set({ ...defaultSharedSettings(), colonyMinGap: 99 });
    await vi.advanceTimersByTimeAsync(200);

    expect(mockStore.set).toHaveBeenCalledWith(
      'oge_sharedSettings',
      expect.objectContaining({ colonyMinGap: 99 }),
    );
  });
});
