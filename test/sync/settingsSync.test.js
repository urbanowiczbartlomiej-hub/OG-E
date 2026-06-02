// @vitest-environment happy-dom
//
// Pure helpers run in any env; readTsMap/writeTsMap/seed need a real
// localStorage, so happy-dom (same as the other sync I/O tests).
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EXCLUDED_SETTINGS,
  SETTINGS_TS_KEY,
  isSyncedSetting,
  pickSyncedValues,
  seedTsMap,
  stampChanged,
  readTsMap,
  writeTsMap,
  seedSettingsTsIfAbsent,
} from '../../src/sync/settingsSync.js';

beforeEach(() => {
  localStorage.clear();
});

describe('isSyncedSetting / EXCLUDED_SETTINGS', () => {
  it('excludes exactly the per-device keys', () => {
    expect([...EXCLUDED_SETTINGS].sort()).toEqual(['colBtnSize', 'enterBtnSize', 'gistToken']);
    expect(isSyncedSetting('reminderNtfyToken')).toBe(true);
    expect(isSyncedSetting('colPassword')).toBe(true);
    expect(isSyncedSetting('gistToken')).toBe(false);
    expect(isSyncedSetting('enterBtnSize')).toBe(false);
  });
});

describe('pickSyncedValues', () => {
  it('drops the excluded keys, keeps the rest', () => {
    const out = pickSyncedValues({
      mobileMode: true,
      enterBtnSize: 320,
      colBtnSize: 320,
      gistToken: 'ghp_x',
      reminderNtfyToken: 'tk_x',
    });
    expect(out).toEqual({ mobileMode: true, reminderNtfyToken: 'tk_x' });
  });
});

describe('seedTsMap', () => {
  it('stamps only keys that differ from their default', () => {
    const defaults = { a: 1, b: 'x', c: true };
    const ts = seedTsMap({ a: 1, b: 'changed', c: true }, 555, defaults);
    expect(ts).toEqual({ b: 555 }); // only b differs
  });

  it('never stamps an excluded key even if customised', () => {
    const ts = seedTsMap({ gistToken: 'ghp_x' }, 555, { gistToken: '' });
    expect(ts).toEqual({});
  });
});

describe('stampChanged', () => {
  it('stamps changed synced keys with now and reports changed', () => {
    const { ts, changed } = stampChanged(
      { a: 1, b: 2 },
      { a: 1, b: 9 },
      { a: 10 },
      777,
    );
    expect(changed).toBe(true);
    expect(ts).toEqual({ a: 10, b: 777 });
  });

  it('is a no-op (changed=false) when nothing synced changed', () => {
    const { ts, changed } = stampChanged({ a: 1 }, { a: 1 }, { a: 10 }, 777);
    expect(changed).toBe(false);
    expect(ts).toEqual({ a: 10 });
  });

  it('ignores changes to excluded keys', () => {
    const { changed } = stampChanged({ enterBtnSize: 1 }, { enterBtnSize: 2 }, {}, 777);
    expect(changed).toBe(false);
  });
});

describe('readTsMap / writeTsMap', () => {
  it('round-trips a map', () => {
    writeTsMap({ a: 1, b: 2 });
    expect(readTsMap()).toEqual({ a: 1, b: 2 });
  });

  it('returns {} when absent or unparseable', () => {
    expect(readTsMap()).toEqual({});
    localStorage.setItem(SETTINGS_TS_KEY, 'not json');
    expect(readTsMap()).toEqual({});
  });
});

describe('seedSettingsTsIfAbsent', () => {
  it('seeds non-default keys once, then no-ops', () => {
    const seeded = seedSettingsTsIfAbsent({ mobileMode: true, colMinGap: 99 }, 1234);
    expect(seeded).toBe(true);
    // colMinGap default is 15, so it's customised and stamped; mobileMode
    // default is true (unchanged) so it isn't.
    expect(readTsMap()).toEqual({ colMinGap: 1234 });

    // Second call is a no-op (map already present).
    expect(seedSettingsTsIfAbsent({ mobileMode: false }, 9999)).toBe(false);
    expect(readTsMap()).toEqual({ colMinGap: 1234 });
  });
});
