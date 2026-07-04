// @vitest-environment happy-dom
//
// Unit tests for state/sharedSettings — the chrome.storage-bridged cross-universe
// shared settings (the four dashboard-owned fields).
//
// Two halves:
//  • pickShared / mergeShared are PURE and tested directly.
//  • initSharedSettings / disposeSharedSettings are bridged through chrome.storage
//    and settingsStore. Both collaborators are mocked: a Map-backed chromeStore
//    fake with a real onChanged dispatcher, and a tiny get/set settingsStore fake.
//    That keeps the behavioural assertions hermetic and honest to the source.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

// All shared mock state lives in a hoisted block so the vi.mock factories (which
// are themselves hoisted to the top of the module) can safely close over it.
const h = vi.hoisted(() => {
  /** @type {Map<string, unknown>} */
  const cstore = new Map();
  /** @type {Set<(changes: Record<string, unknown>, area: string) => void>} */
  const listeners = new Set();
  /** @type {{ value: any }} */
  const settingsState = { value: {} };

  // chromeStore fake: Map-backed get/set + a manual onChanged dispatcher.
  const fakeChromeStore = {
    get: vi.fn(async (/** @type {string} */ key) => cstore.get(key)),
    set: vi.fn(async (/** @type {string} */ key, /** @type {unknown} */ value) => {
      cstore.set(key, value);
    }),
    remove: vi.fn(async (/** @type {string} */ key) => {
      cstore.delete(key);
    }),
    onChanged: vi.fn((/** @type {(changes: Record<string, unknown>, area: string) => void} */ cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };

  // settingsStore fake: minimal get/set bag.
  const fakeSettingsStore = {
    get: vi.fn(() => settingsState.value),
    set: vi.fn((/** @type {any} */ next) => {
      settingsState.value = next;
    }),
  };

  return { cstore, listeners, settingsState, fakeChromeStore, fakeSettingsStore };
});

const { cstore, listeners, settingsState, fakeChromeStore } = h;

/** Fire an onChanged event to every registered listener. */
const emitChange = (/** @type {Record<string, unknown>} */ changes) => {
  for (const cb of listeners) cb(changes, 'local');
};

vi.mock('../../src/lib/storage.js', () => ({
  chromeStore: h.fakeChromeStore,
  // sharedSettings.js imports settingsStore from state/settings.js, which reads
  // safeLS at import time — provide an inert stub so that import is harmless.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

vi.mock('../../src/state/settings.js', () => ({
  settingsStore: h.fakeSettingsStore,
}));

import {
  SHARED_SETTINGS_KEY,
  pickShared,
  mergeShared,
  initSharedSettings,
  disposeSharedSettings,
} from '../../src/state/sharedSettings.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A full set of "local" shared values for merge inputs. */
const local = () => ({
  cloudSync: false,
  gistToken: '',
  alarmClockMasterEnabled: false,
  alarmClockNtfyToken: '',
});

beforeEach(() => {
  disposeSharedSettings();
  cstore.clear();
  listeners.clear();
  settingsState.value = {};
  vi.clearAllMocks();
});

// ── pure: pickShared ──────────────────────────────────────────────────────────
describe('pickShared', () => {
  it('selects exactly the four shared fields', () => {
    const full = {
      cloudSync: true,
      gistToken: 'gt',
      alarmClockMasterEnabled: true,
      alarmClockNtfyToken: 'nt',
      // noise that must NOT be carried over
      fabBtnSize: 42,
      somethingElse: 'x',
    };
    expect(pickShared(/** @type {any} */ (full))).toEqual({
      cloudSync: true,
      gistToken: 'gt',
      alarmClockMasterEnabled: true,
      alarmClockNtfyToken: 'nt',
    });
  });
});

// ── pure: mergeShared ─────────────────────────────────────────────────────────
describe('mergeShared', () => {
  it('falls back entirely to local when raw is null', () => {
    const l = { cloudSync: true, gistToken: 'L', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'N' };
    expect(mergeShared(null, l)).toEqual(l);
  });

  it('falls back entirely to local when raw is not an object', () => {
    const l = local();
    expect(mergeShared('nope', l)).toEqual(l);
    expect(mergeShared(123, l)).toEqual(l);
    expect(mergeShared([], l)).toEqual(l); // arrays are rejected
  });

  it('takes cloud booleans when present, including false', () => {
    const l = { cloudSync: true, gistToken: '', alarmClockMasterEnabled: true, alarmClockNtfyToken: '' };
    const merged = mergeShared({ cloudSync: false, alarmClockMasterEnabled: false }, l);
    expect(merged.cloudSync).toBe(false);
    expect(merged.alarmClockMasterEnabled).toBe(false);
  });

  it('keeps local booleans when cloud value is not a boolean', () => {
    const l = { cloudSync: true, gistToken: '', alarmClockMasterEnabled: true, alarmClockNtfyToken: '' };
    const merged = mergeShared({ cloudSync: 'yes', alarmClockMasterEnabled: 1 }, l);
    expect(merged.cloudSync).toBe(true);
    expect(merged.alarmClockMasterEnabled).toBe(true);
  });

  it('takes a cloud token whenever the key is PRESENT — even empty (authoritative clear)', () => {
    const l = { cloudSync: false, gistToken: 'localG', alarmClockMasterEnabled: false, alarmClockNtfyToken: 'localN' };
    // cloud has a real gistToken → wins; cloud's ntfy is present-but-empty → an
    // authoritative clear (dashboard "remove token"), NOT resurrected from local.
    const merged = mergeShared({ gistToken: 'cloudG', alarmClockNtfyToken: '' }, l);
    expect(merged.gistToken).toBe('cloudG');
    expect(merged.alarmClockNtfyToken).toBe('');
  });

  it('falls back to the local token only when the cloud key is ABSENT (migration)', () => {
    const l = { cloudSync: false, gistToken: 'localG', alarmClockMasterEnabled: false, alarmClockNtfyToken: 'localN' };
    // No ntfy key in the cloud value at all → the un-migrated local token lifts up.
    const merged = mergeShared({ gistToken: 'cloudG' }, l);
    expect(merged.alarmClockNtfyToken).toBe('localN');
  });

  it('keeps local token when cloud token is non-string', () => {
    const l = { cloudSync: false, gistToken: 'localG', alarmClockMasterEnabled: false, alarmClockNtfyToken: 'localN' };
    const merged = mergeShared({ gistToken: 123, alarmClockNtfyToken: null }, l);
    expect(merged.gistToken).toBe('localG');
    expect(merged.alarmClockNtfyToken).toBe('localN');
  });
});

// ── bridged: init / dispose ───────────────────────────────────────────────────
describe('initSharedSettings / disposeSharedSettings', () => {
  it('is idempotent — a second init before dispose registers only one listener', async () => {
    settingsState.value = local();
    await initSharedSettings();
    await initSharedSettings();
    expect(fakeChromeStore.onChanged).toHaveBeenCalledTimes(1);
  });

  it('writes the merged dict when a local token migrates up (differs from raw)', async () => {
    // raw is empty; local has a token → merge differs → must write back.
    settingsState.value = { cloudSync: false, gistToken: 'localG', alarmClockMasterEnabled: false, alarmClockNtfyToken: '' };
    await initSharedSettings();
    expect(fakeChromeStore.set).toHaveBeenCalledTimes(1);
    expect(fakeChromeStore.set).toHaveBeenCalledWith(SHARED_SETTINGS_KEY, {
      cloudSync: false,
      gistToken: 'localG',
      alarmClockMasterEnabled: false,
      // ntfy token is empty AND absent from raw → omitted (never seed '').
    });
  });

  it('does NOT write when the cloud value already equals the merged result', async () => {
    // The skip guard compares JSON.stringify(raw) vs JSON.stringify(merged), so
    // the steady cloud value must be byte-identical to what mergeShared emits —
    // i.e. stored in mergeShared's own key order (a value a prior init wrote).
    const merged = mergeShared(
      { cloudSync: true, gistToken: 'G', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'N' },
      local(),
    );
    cstore.set(SHARED_SETTINGS_KEY, merged);
    settingsState.value = { cloudSync: true, gistToken: 'G', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'N' };
    await initSharedSettings();
    expect(fakeChromeStore.set).not.toHaveBeenCalled();
  });

  it('applies the merged values onto settingsStore', async () => {
    settingsState.value = { cloudSync: false, gistToken: '', alarmClockMasterEnabled: false, alarmClockNtfyToken: '', other: 'keep' };
    cstore.set(SHARED_SETTINGS_KEY, { cloudSync: true, gistToken: 'cloudG', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'cloudN' });
    await initSharedSettings();
    // merged overlay applied, pre-existing non-shared field preserved
    expect(settingsState.value).toMatchObject({
      cloudSync: true,
      gistToken: 'cloudG',
      alarmClockMasterEnabled: true,
      alarmClockNtfyToken: 'cloudN',
      other: 'keep',
    });
  });

  it('re-applies on an onChanged event for SHARED_SETTINGS_KEY', async () => {
    settingsState.value = local();
    await initSharedSettings();
    // a new cloud value arrives
    cstore.set(SHARED_SETTINGS_KEY, { cloudSync: true, gistToken: 'newG', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'newN' });
    emitChange({ [SHARED_SETTINGS_KEY]: { newValue: 'whatever' } });
    await flush();
    expect(settingsState.value).toMatchObject({
      cloudSync: true,
      gistToken: 'newG',
      alarmClockMasterEnabled: true,
      alarmClockNtfyToken: 'newN',
    });
  });

  it('ignores onChanged events for unrelated keys', async () => {
    settingsState.value = local();
    await initSharedSettings();
    fakeChromeStore.get.mockClear();
    emitChange({ someOtherKey: { newValue: 1 } });
    await flush();
    expect(fakeChromeStore.get).not.toHaveBeenCalled();
  });

  it('dispose() unsubscribes so later onChanged events are ignored', async () => {
    settingsState.value = local();
    await initSharedSettings();
    disposeSharedSettings();
    fakeChromeStore.get.mockClear();
    cstore.set(SHARED_SETTINGS_KEY, { cloudSync: true, gistToken: 'x', alarmClockMasterEnabled: true, alarmClockNtfyToken: 'y' });
    emitChange({ [SHARED_SETTINGS_KEY]: { newValue: 'x' } });
    await flush();
    expect(fakeChromeStore.get).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', () => {
    expect(() => {
      disposeSharedSettings();
      disposeSharedSettings();
    }).not.toThrow();
  });

  it('re-init after dispose registers a fresh listener', async () => {
    settingsState.value = local();
    await initSharedSettings();
    disposeSharedSettings();
    await initSharedSettings();
    expect(fakeChromeStore.onChanged).toHaveBeenCalledTimes(2);
  });
});
