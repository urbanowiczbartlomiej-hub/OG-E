// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard Reminders-tab fleet-save config editor
// (B3). Same harness as scanConfig.test.js: a Map-backed chrome.storage fake,
// the tab container injected, real input edits + a Save click, asserting the
// rendered values and the three chrome.storage writes. The crux test is that
// this editor and the scan-config editor — which share ONE per-universe slot —
// never clobber each other's fields (read-modify-write on save).
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
  // reminderConfig.js (like scanConfig.js) imports syncRequestKeyFor from
  // sync/scheduler.js, which transitively pulls gist.js + logger.js — both
  // read safeLS at import time.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
import { installReminderConfig } from '../../../src/features/dashboard/reminderConfig.js';
import { installScanConfig } from '../../../src/features/dashboard/scanConfig.js';
import { defaultGalaxyScanConfig } from '../../../src/domain/galaxyScanConfig.js';

const mockStore = /** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

const UNI = 's163-pl';
const CFG_KEY = `${UNI}:oge_galaxyScanConfig`;
const TS_KEY = `${UNI}:oge_galaxyScanConfigTs`;
const SYNC_KEY = `${UNI}:oge_syncRequestAt`;

/** @type {Map<string, unknown>} */
const store = new Map();

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const install = () => installReminderConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML = '<div id="reminderConfigBody"></div><div id="scanConfigBody"></div>';
});

describe('Reminders fleet-save config editor', () => {
  it('fills fields from the default preset when nothing is stored', async () => {
    install().refresh();
    await flush();
    expect($('#remCfgFsEnabled').checked).toBe(false);
    expect($('#remCfgFsThreshold').value).toBe('100000');
    expect($('#remCfgFsMinFlight').value).toBe('10m');
    expect($('#remCfgFsOffsets').value).toBe('-10m, 0m, 10m');
  });

  it('hydrates fields from a stored config', async () => {
    store.set(CFG_KEY, { fsEnabled: true, fsThreshold: 50000, fsMinFlightSec: 900, fsOffsets: '-5m, 0m' });
    install().refresh();
    await flush();
    expect($('#remCfgFsEnabled').checked).toBe(true);
    expect($('#remCfgFsThreshold').value).toBe('50000');
    expect($('#remCfgFsMinFlight').value).toBe('15m');
    expect($('#remCfgFsOffsets').value).toBe('-5m, 0m');
  });

  it('saves the fs config + timestamp + syncRequest, parsing the duration units', async () => {
    install().refresh();
    await flush();

    $('#remCfgFsEnabled').checked = true;
    $('#remCfgFsThreshold').value = '250000';
    $('#remCfgFsMinFlight').value = '5m';
    $('#remCfgFsOffsets').value = '-20m, 0m';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.fsEnabled).toBe(true);
    expect(saved.fsThreshold).toBe(250000);
    expect(saved.fsMinFlightSec).toBe(300); // 5m → 300s
    expect(saved.fsOffsets).toBe('-20m, 0m');
    expect(typeof store.get(TS_KEY)).toBe('number');
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('rejects a non-numeric ship threshold and does not save', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsThreshold').value = 'lots';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(CFG_KEY)).toBe(false);
    expect($('#remCfgStatus').textContent || '').toMatch(/threshold/i);
  });

  it('rejects an unparseable min flight time and does not save', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsMinFlight').value = 'soon';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(CFG_KEY)).toBe(false);
    expect($('#remCfgStatus').textContent || '').toMatch(/flight/i);
  });

  it('allows an empty offset schedule (no fleet-save pings)', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsOffsets').value = '   ';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsOffsets).toBe('');
  });

  // The crux: the Reminders editor and the scan-config editor write the SAME
  // per-universe slot. Each must read-modify-write so neither resets the
  // other's fields to defaults.
  it('preserves the scan-config fields when saving fs config', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false, colonyPassword: 'hunter2' });
    install().refresh();
    await flush();
    $('#remCfgFsEnabled').checked = true;
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.fsEnabled).toBe(true);
    // Scan-config fields survive untouched.
    expect(saved.positions).toBe('12-15');
    expect(saved.preferOtherGalaxies).toBe(false);
    expect(saved.colonyPassword).toBe('hunter2');
  });

  it('scan-config save preserves the fs fields (the reverse direction)', async () => {
    store.set(CFG_KEY, { fsEnabled: true, fsThreshold: 333000, fsOffsets: '-7m' });
    installScanConfig({ getUniverseId: () => UNI }).refresh();
    await flush();
    $('#scanCfgPositions').value = '9';
    $('#scanCfgSave').dispatchEvent(new Event('click'));
    await flush();
    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9');
    // fs fields survive a scan-config save untouched.
    expect(saved.fsEnabled).toBe(true);
    expect(saved.fsThreshold).toBe(333000);
    expect(saved.fsOffsets).toBe('-7m');
  });

  it('reset loads defaults into the fields (without saving until clicked)', async () => {
    store.set(CFG_KEY, { fsEnabled: true, fsThreshold: 50000 });
    install().refresh();
    await flush();
    expect($('#remCfgFsThreshold').value).toBe('50000');

    $('#remCfgReset').dispatchEvent(new Event('click'));
    expect($('#remCfgFsEnabled').checked).toBe(defaultGalaxyScanConfig().fsEnabled);
    expect($('#remCfgFsThreshold').value).toBe(String(defaultGalaxyScanConfig().fsThreshold));
    // Reset alone does not persist — the stored value is unchanged.
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsThreshold).toBe(50000);
  });
});
