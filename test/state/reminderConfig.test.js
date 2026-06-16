// Unit tests for the reminderConfig state store.
//
// Like state/galaxyScanConfig.js this is a thin createStore wrapper; the
// behaviour worth testing is the lazy persist wiring (init hydrates from
// chrome.storage.local) and the stamp helper. Per-universe keys: in this
// non-DOM (node) env `location` is undefined, so `currentUniverseKey` falls
// back to the bare base suffix. We mock lib/storage.js (chromeStore) before
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
  REMINDER_CONFIG_KEY_BASE,
  REMINDER_CONFIG_TS_BASE,
  reminderConfigKeyFor,
  reminderConfigTsKeyFor,
  reminderConfigStore,
  initReminderConfigStore,
  disposeReminderConfigStore,
  stampReminderConfigChanged,
} from '../../src/state/reminderConfig.js';
import { defaultReminderConfig } from '../../src/domain/reminderConfig.js';

const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  disposeReminderConfigStore();
  reminderConfigStore.set(defaultReminderConfig());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('reminderConfig store — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderConfigStore);

  it('composes per-universe keys from the base suffixes', () => {
    expect(REMINDER_CONFIG_KEY_BASE).toBe('oge_reminderConfig');
    expect(REMINDER_CONFIG_TS_BASE).toBe('oge_reminderConfigTs');
    expect(reminderConfigKeyFor('s163-pl')).toBe('s163-pl:oge_reminderConfig');
    expect(reminderConfigTsKeyFor('s163-pl')).toBe('s163-pl:oge_reminderConfigTs');
  });

  it('starts at the defaults before init', () => {
    expect(reminderConfigStore.get()).toEqual(defaultReminderConfig());
  });
});

describe('reminderConfig store — hydration', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderConfigStore);

  it('hydrates (and normalises) a stored config', async () => {
    mockStore.get.mockResolvedValue({ reminderEnabled: true, reminderSchedule: '5m' });
    initReminderConfigStore();
    await flushMicrotasks();
    const cfg = reminderConfigStore.get();
    expect(cfg.reminderEnabled).toBe(true);
    expect(cfg.reminderSchedule).toBe('5m');
    expect(cfg.adhocOffsetSec).toBe(60); // filled from default
  });

  it('keeps the defaults and does NOT write when nothing is stored', async () => {
    initReminderConfigStore();
    await flushMicrotasks();
    expect(reminderConfigStore.get()).toEqual(defaultReminderConfig());
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('reads the current-universe key (bare base in this non-DOM env)', async () => {
    initReminderConfigStore();
    await flushMicrotasks();
    expect(mockStore.get).toHaveBeenCalledWith(REMINDER_CONFIG_KEY_BASE);
  });
});

describe('stampReminderConfigChanged — flush then stamp', () => {
  beforeEach(resetAll);
  afterEach(disposeReminderConfigStore);

  it('writes the config value first, then the timestamp', async () => {
    reminderConfigStore.set({ ...defaultReminderConfig(), reminderEnabled: true });
    mockStore.set.mockClear();

    await stampReminderConfigChanged();

    const keys = mockStore.set.mock.calls.map((/** @type {any[]} */ c) => c[0]);
    expect(keys).toEqual([REMINDER_CONFIG_KEY_BASE, REMINDER_CONFIG_TS_BASE]);
    expect(mockStore.set.mock.calls[0][1].reminderEnabled).toBe(true);
    expect(typeof mockStore.set.mock.calls[1][1]).toBe('number');
  });
});
