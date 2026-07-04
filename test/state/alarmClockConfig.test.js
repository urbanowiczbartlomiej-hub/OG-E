// Unit tests for the alarmClockConfig state store.
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
  ALARM_CLOCK_CONFIG_KEY_BASE,
  ALARM_CLOCK_CONFIG_TS_BASE,
  alarmClockConfigKeyFor,
  alarmClockConfigTsKeyFor,
  alarmClockConfigStore,
  initAlarmClockConfigStore,
  disposeAlarmClockConfigStore,
} from '../../src/state/alarmClockConfig.js';
import { defaultAlarmClockConfig } from '../../src/domain/alarmClockConfig.js';

const mockStore = /** @type {any} */ (chromeStore);

const resetAll = () => {
  disposeAlarmClockConfigStore();
  alarmClockConfigStore.set(defaultAlarmClockConfig());
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockResolvedValue(undefined);
  mockStore.set.mockResolvedValue(undefined);
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('alarmClockConfig store — keys + defaults', () => {
  beforeEach(resetAll);
  afterEach(disposeAlarmClockConfigStore);

  it('composes per-universe keys from the base suffixes', () => {
    expect(ALARM_CLOCK_CONFIG_KEY_BASE).toBe('oge_alarmClockConfig');
    expect(ALARM_CLOCK_CONFIG_TS_BASE).toBe('oge_alarmClockConfigTs');
    expect(alarmClockConfigKeyFor('s163-pl')).toBe('s163-pl:oge_alarmClockConfig');
    expect(alarmClockConfigTsKeyFor('s163-pl')).toBe('s163-pl:oge_alarmClockConfigTs');
  });

  it('starts at the defaults before init', () => {
    expect(alarmClockConfigStore.get()).toEqual(defaultAlarmClockConfig());
  });
});

describe('alarmClockConfig store — hydration', () => {
  beforeEach(resetAll);
  afterEach(disposeAlarmClockConfigStore);

  it('hydrates (and normalises) a stored config', async () => {
    mockStore.get.mockResolvedValue({ alarmClockEnabled: true, alarmClockSchedule: '5m' });
    initAlarmClockConfigStore();
    await flushMicrotasks();
    const cfg = alarmClockConfigStore.get();
    expect(cfg.alarmClockEnabled).toBe(true);
    expect(cfg.alarmClockSchedule).toBe('5m');
    expect(cfg.adhocSchedule).toBe('-1m'); // filled from default
  });

  it('keeps the defaults and does NOT write when nothing is stored', async () => {
    initAlarmClockConfigStore();
    await flushMicrotasks();
    expect(alarmClockConfigStore.get()).toEqual(defaultAlarmClockConfig());
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('reads the current-universe key (bare base in this non-DOM env)', async () => {
    initAlarmClockConfigStore();
    await flushMicrotasks();
    expect(mockStore.get).toHaveBeenCalledWith(ALARM_CLOCK_CONFIG_KEY_BASE);
  });
});
