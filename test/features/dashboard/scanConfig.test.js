// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard Galaxy-Scan config editor. We mock
// chrome.storage with a Map-backed fake, inject the tab's container markup,
// then drive real input edits + a Save click and assert the observable
// output: the rendered field values, and the three chrome.storage writes
// (config value, the newest-wins timestamp, and the syncRequest poke).
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
  // scanConfig.js imports syncRequestKeyFor from sync/scheduler.js, which
  // transitively pulls gist.js + logger.js — both read safeLS at import time.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
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
const install = () => installScanConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));
const rescanInput = (/** @type {string} */ field) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`[data-field="${field}"]`));

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML = '<div id="scanConfigBody"></div>';
});

describe('Galaxy-Scan config editor', () => {
  it('fills fields from the default preset when nothing is stored', async () => {
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('8');
    expect($('#scanCfgPrefer').checked).toBe(true);
    expect($('#scanCfgColonyMinGap').value).toBe('15');
    expect($('#scanCfgColonyMinFields').value).toBe('320');
    expect($('#scanCfgColonyPassword').value).toBe('');
    expect($('#scanCfgAbandoned').checked).toBe(true);
    expect(rescanInput('inactive').value).toBe('5d');
    expect(rescanInput('empty').value).toBe('0'); // never, by default
  });

  it('hydrates fields from a stored config', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false, rescan: { occupied: 6 * 3600 } });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');
    expect($('#scanCfgPrefer').checked).toBe(false);
    expect(rescanInput('occupied').value).toBe('6h');
  });

  it('saves the config + timestamp + syncRequest, parsing the durable-text units', async () => {
    install().refresh();
    await flush();

    $('#scanCfgPositions').value = '9,10';
    $('#scanCfgPrefer').checked = false;
    $('#scanCfgColonyMinGap').value = '25';
    $('#scanCfgColonyMinFields').value = '250';
    $('#scanCfgColonyPassword').value = 'hunter2';
    rescanInput('occupied').value = '12h';
    rescanInput('empty').value = '2d';
    $('#scanCfgAbandoned').checked = false;

    $('#scanCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9,10');
    expect(saved.preferOtherGalaxies).toBe(false);
    expect(saved.colonyMinGap).toBe(25);
    expect(saved.colonyMinFields).toBe(250);
    expect(saved.colonyPassword).toBe('hunter2');
    expect(saved.rescan.occupied).toBe(12 * 3600);
    expect(saved.rescan.empty).toBe(2 * 86400);
    expect(saved.rescan.abandonedEnabled).toBe(false);
    // The two sync signals were written too.
    expect(typeof store.get(TS_KEY)).toBe('number');
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('rejects an unparseable re-scan time and does not save', async () => {
    install().refresh();
    await flush();

    rescanInput('inactive').value = 'soon';
    $('#scanCfgSave').dispatchEvent(new Event('click'));
    await flush();

    expect(store.has(CFG_KEY)).toBe(false);
    expect($('#scanCfgStatus').textContent || '').toMatch(/Invalid time/);
  });

  it('reset loads defaults into the fields (without saving until clicked)', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false, rescan: {} });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');

    $('#scanCfgReset').dispatchEvent(new Event('click'));
    expect($('#scanCfgPositions').value).toBe(defaultGalaxyScanConfig().positions);
    // Reset alone does not persist — the stored value is unchanged.
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions).toBe('12-15');
  });
});
