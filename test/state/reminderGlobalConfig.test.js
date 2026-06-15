// Unit tests for the reminderGlobalConfig state store.
//
// Like state/galaxyScanConfig.js this is a thin createStore wrapper; the
// behaviour worth testing is the lazy persist wiring (init hydrates from
// chrome.storage.local) and the stamp helper. Unlike galaxyScanConfig the keys
// are GLOBAL (no universe prefix). We mock lib/storage.js (chromeStore) before
// importing the module.
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
  REMINDER_GLOBAL_CONFIG_KEY,
  REMINDER_GLOBAL_CONFIG_TS_KEY,
  reminderGlobalConfigStore,
  initReminderGlobalConfigStore,
  disposeReminderGlobalConfigStore,
  stampReminderGlobalConfigChanged,
} from '../../src/state/reminderGlobalConfig.js';
import { defaultReminderGlobalConfig } from '../../src/domain/reminderGlobalConfig.js';

const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  disposeReminderGlobalConfigStore();
  reminderGlobalConfigStore.set(defaultReminderGlobalConfig());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('reminderGlobalConfig store — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderGlobalConfigStore);

  it('exports bare (non-universe) keys', () => {
    expect(REMINDER_GLOBAL_CONFIG_KEY).toBe('oge_reminderGlobalConfig');
    expect(REMINDER_GLOBAL_CONFIG_TS_KEY).toBe('oge_reminderGlobalConfigTs');
  });

  it('starts at the defaults before init', () => {
    expect(reminderGlobalConfigStore.get()).toEqual(defaultReminderGlobalConfig());
  });
});

describe('reminderGlobalConfig store — hydration', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderGlobalConfigStore);

  it('hydrates (and normalises) a stored config', async () => {
    mockStore.get.mockResolvedValue({ reminderEnabled: true, reminderSchedule: '5m' });
    initReminderGlobalConfigStore();
    await flushMicrotasks();
    const cfg = reminderGlobalConfigStore.get();
    expect(cfg.reminderEnabled).toBe(true);
    expect(cfg.reminderSchedule).toBe('5m');
    expect(cfg.adhocOffsetSec).toBe(60); // filled from default
  });

  it('keeps the defaults and does NOT write when nothing is stored', async () => {
    initReminderGlobalConfigStore();
    await flushMicrotasks();
    expect(reminderGlobalConfigStore.get()).toEqual(defaultReminderGlobalConfig());
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('reads the global key (no universe prefix)', async () => {
    initReminderGlobalConfigStore();
    await flushMicrotasks();
    expect(mockStore.get).toHaveBeenCalledWith(REMINDER_GLOBAL_CONFIG_KEY);
  });
});

describe('stampReminderGlobalConfigChanged — flush then stamp', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderGlobalConfigStore);

  it('writes the config value first, then the timestamp', async () => {
    reminderGlobalConfigStore.set({ ...defaultReminderGlobalConfig(), reminderEnabled: true });
    mockStore.set.mockClear();

    await stampReminderGlobalConfigChanged();

    const keys = mockStore.set.mock.calls.map((/** @type {any[]} */ c) => c[0]);
    expect(keys).toEqual([REMINDER_GLOBAL_CONFIG_KEY, REMINDER_GLOBAL_CONFIG_TS_KEY]);
    expect(mockStore.set.mock.calls[0][1].reminderEnabled).toBe(true);
    expect(typeof mockStore.set.mock.calls[1][1]).toBe('number');
  });
});
