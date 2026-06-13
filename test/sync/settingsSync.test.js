// @vitest-environment happy-dom
//
// Pure helpers run in any env; readTsMap/writeTsMap/seed need a real
// localStorage, so happy-dom (same as the other sync I/O tests).
//
// @ts-check

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  EXCLUDED_SETTINGS,
  UNIVERSE_SCOPED_SETTINGS,
  SETTINGS_TS_KEY,
  isSyncedSetting,
  isUniverseScopedSetting,
  pickSyncedValues,
  seedTsMap,
  stampChanged,
  readTsMap,
  writeTsMap,
  seedSettingsTsIfAbsent,
  universeSettingsTsKeyFor,
  readUniverseTsMap,
  writeUniverseTsMap,
  seedUniverseTsIfAbsent,
} from '../../src/sync/settingsSync.js';

/** Minimal fake chromeStore for tests (no actual WebExtension API). */
const store = /** @type {Record<string, unknown>} */ ({});
beforeEach(() => {
  localStorage.clear();
  Object.keys(store).forEach((k) => delete store[k]);
  // Stub globalThis.chrome so chromeStore.get/set work in happy-dom.
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (/** @type {string} */ key, /** @type {(r: Record<string, unknown>) => void} */ cb) =>
          cb({ [key]: store[key] }),
        set: (/** @type {Record<string, unknown>} */ items, /** @type {(() => void) | undefined} */ cb) => {
          Object.assign(store, items);
          cb?.();
        },
        remove: (/** @type {string | string[]} */ keys, /** @type {(() => void) | undefined} */ cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((/** @type {string} */ k) => delete store[k]);
          cb?.();
        },
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isSyncedSetting / EXCLUDED_SETTINGS', () => {
  it('excludes exactly the per-device keys', () => {
    expect([...EXCLUDED_SETTINGS].sort()).toEqual(['fabBtnSize', 'gistToken']);
    expect(isSyncedSetting('reminderNtfyToken')).toBe(true);
    expect(isSyncedSetting('colPassword')).toBe(true);
    expect(isSyncedSetting('gistToken')).toBe(false);
    expect(isSyncedSetting('fabBtnSize')).toBe(false);
  });
});

describe('isUniverseScopedSetting / UNIVERSE_SCOPED_SETTINGS', () => {
  it('marks the universe-scoped keys', () => {
    // colPositions / colPreferOtherGalaxies moved OUT to the per-universe
    // Galaxy-Scan config store (synced via the gist's galaxyScanConfig slot).
    expect(UNIVERSE_SCOPED_SETTINGS.size).toBe(9);
    expect(isUniverseScopedSetting('colPassword')).toBe(true);
    expect(isUniverseScopedSetting('fsThreshold')).toBe(true);
    expect(isUniverseScopedSetting('reminderNtfyToken')).toBe(true);
    expect(isUniverseScopedSetting('colPositions')).toBe(false);
    expect(isUniverseScopedSetting('colPreferOtherGalaxies')).toBe(false);
    expect(isUniverseScopedSetting('fabMode')).toBe(false);
    expect(isUniverseScopedSetting('readabilityBoost')).toBe(false);
    // Excluded settings are not universe-scoped (they're not synced at all).
    expect(isUniverseScopedSetting('gistToken')).toBe(false);
  });
});

describe('pickSyncedValues', () => {
  it('drops the excluded keys, keeps the rest (scope=all by default)', () => {
    const out = pickSyncedValues({
      fabMode: true,
      fabBtnSize: 320,
      gistToken: 'ghp_x',
      reminderNtfyToken: 'tk_x',
    });
    expect(out).toEqual({ fabMode: true, reminderNtfyToken: 'tk_x' });
  });

  it('scope=global keeps only non-universe-scoped synced keys', () => {
    const out = pickSyncedValues(
      { fabMode: true, fsThreshold: 50000, fabBtnSize: 320 },
      'global',
    );
    expect(out).toEqual({ fabMode: true });
  });

  it('scope=universe keeps only universe-scoped keys', () => {
    const out = pickSyncedValues(
      { fabMode: true, fsThreshold: 50000, colPassword: 'abc', fabBtnSize: 320 },
      'universe',
    );
    expect(out).toEqual({ fsThreshold: 50000, colPassword: 'abc' });
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
    const { changed } = stampChanged({ fabBtnSize: 1 }, { fabBtnSize: 2 }, {}, 777);
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
  it('seeds only GLOBAL non-default keys once, then no-ops', () => {
    // colMinGap is now universe-scoped — must NOT appear in the global ts map.
    // adhocOffsetSec (default 60) is global — customised value 99 is stamped.
    const seeded = seedSettingsTsIfAbsent(
      { fabMode: true, colMinGap: 99, adhocOffsetSec: 99 },
      1234,
    );
    expect(seeded).toBe(true);
    const ts = readTsMap();
    // adhocOffsetSec is global + customised → stamped.
    expect(ts.adhocOffsetSec).toBe(1234);
    // colMinGap is universe-scoped → must NOT be in the global ts map.
    expect('colMinGap' in ts).toBe(false);

    // Second call is a no-op (map already present).
    expect(seedSettingsTsIfAbsent({ fabMode: false }, 9999)).toBe(false);
    expect(readTsMap().adhocOffsetSec).toBe(1234);
  });
});

describe('per-universe chrome.storage wrappers', () => {
  it('universeSettingsTsKeyFor follows the <id>:oge_settingsTs pattern', () => {
    expect(universeSettingsTsKeyFor('s163-pl')).toBe('s163-pl:oge_settingsTs');
  });

  it('readUniverseTsMap / writeUniverseTsMap round-trip via chromeStore', async () => {
    await writeUniverseTsMap('s163-pl', { fsThreshold: 42 });
    const loaded = await readUniverseTsMap('s163-pl');
    expect(loaded).toEqual({ fsThreshold: 42 });
  });

  it('readUniverseTsMap returns {} when absent', async () => {
    expect(await readUniverseTsMap('s999-de')).toEqual({});
  });

  it('seedUniverseTsIfAbsent stamps customised universe-scoped keys, returns seeded map', async () => {
    // fsThreshold default=100000; custom value 50000 should be stamped.
    // fabMode is global → must NOT appear in universe ts map.
    const result = await seedUniverseTsIfAbsent(
      's163-pl',
      { fabMode: true, fsThreshold: 50000, colPassword: '' },
      777,
    );
    expect(result).not.toBeNull();
    // fsThreshold customised → stamped
    expect(result?.fsThreshold).toBe(777);
    // colPassword is at default ('') → not stamped
    expect('colPassword' in (result ?? {})).toBe(false);
    // fabMode is global → not stamped in universe map
    expect('fabMode' in (result ?? {})).toBe(false);

    // Persisted to chromeStore
    const stored = await readUniverseTsMap('s163-pl');
    expect(stored.fsThreshold).toBe(777);

    // Second call: already exists → returns null (no-op)
    const result2 = await seedUniverseTsIfAbsent(
      's163-pl',
      { fsThreshold: 99999 },
      9999,
    );
    expect(result2).toBeNull();
    // Map unchanged
    expect((await readUniverseTsMap('s163-pl')).fsThreshold).toBe(777);
  });
});
