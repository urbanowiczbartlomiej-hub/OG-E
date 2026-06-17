// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard scan/colonization config editors. The
// colonization knobs (Colonizations tab) and the scan re-scan policy (Galaxy
// Observations tab) are two editors over ONE shared per-universe slot. We mock
// chrome.storage with a Map-backed fake, inject each tab's container, drive
// real input edits + a Save click, and assert the observable output: rendered
// field values, the three chrome.storage writes (config value, newest-wins
// timestamp, syncRequest poke), and — crucially — that saving one editor never
// clobbers the other editor's fields (read-modify-write merge).
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
import {
  installColonizationConfig,
  installScanRescanConfig,
} from '../../../src/features/dashboard/scanConfig.js';
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

const installCol = () => installColonizationConfig({ getUniverseId: () => UNI });
const installRescan = () => installScanRescanConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));
const rescanInput = (/** @type {string} */ field) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`[data-field="${field}"]`));
// Save / Reset / status are per-editor (class hooks, not ids) so the same
// markup can render twice on one page — scope the lookup to the editor's body.
const save = (/** @type {string} */ container) =>
  document.querySelector(`#${container} .scanCfgSave`)?.dispatchEvent(new Event('click'));
const reset = (/** @type {string} */ container) =>
  document.querySelector(`#${container} .scanCfgReset`)?.dispatchEvent(new Event('click'));
const status = (/** @type {string} */ container) =>
  /** @type {HTMLElement} */ (document.querySelector(`#${container} .scanCfgStatus`));

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML =
    '<div id="colonizationConfigBody"></div><div id="scanRescanBody"></div>';
});

describe('Colonization config editor', () => {
  it('fills fields from the default preset when nothing is stored', async () => {
    installCol().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('8');
    expect($('#scanCfgPrefer').checked).toBe(true);
    expect($('#scanCfgColonyMinGap').value).toBe('15');
    expect($('#scanCfgColonyMinFields').value).toBe('320');
    expect($('#scanCfgColonyPassword').value).toBe('');
  });

  it('hydrates fields from a stored config', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false, preferFarthestSystems: false });
    installCol().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');
    expect($('#scanCfgPrefer').checked).toBe(false);
    expect($('#scanCfgPreferFarthest').checked).toBe(false);
  });

  it('saves the colonization fields + timestamp + syncRequest', async () => {
    installCol().refresh();
    await flush();

    $('#scanCfgPositions').value = '9,10';
    $('#scanCfgPrefer').checked = false;
    $('#scanCfgPreferFarthest').checked = false;
    $('#scanCfgColonyMinGap').value = '25';
    $('#scanCfgColonyMinFields').value = '250';
    $('#scanCfgColonyPassword').value = 'hunter2';

    save('colonizationConfigBody');
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9,10');
    expect(saved.preferOtherGalaxies).toBe(false);
    expect(saved.preferFarthestSystems).toBe(false);
    expect(saved.colonyMinGap).toBe(25);
    expect(saved.colonyMinFields).toBe(250);
    expect(saved.colonyPassword).toBe('hunter2');
    expect(typeof store.get(TS_KEY)).toBe('number');
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('reset loads defaults into the fields (without saving until clicked)', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false });
    installCol().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');

    reset('colonizationConfigBody');
    expect($('#scanCfgPositions').value).toBe(defaultGalaxyScanConfig().positions);
    // Reset alone does not persist — the stored value is unchanged.
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions).toBe('12-15');
  });
});

describe('Scan re-scan config editor', () => {
  it('fills fields from the default preset when nothing is stored', async () => {
    installRescan().refresh();
    await flush();
    expect($('#scanCfgAbandoned').checked).toBe(true);
    expect(rescanInput('inactive').value).toBe('5d');
    expect(rescanInput('empty').value).toBe('0'); // never, by default
  });

  it('hydrates fields from a stored config', async () => {
    store.set(CFG_KEY, { rescan: { occupied: 6 * 3600 } });
    installRescan().refresh();
    await flush();
    expect(rescanInput('occupied').value).toBe('6h');
  });

  it('saves the rescan fields + timestamp + syncRequest, parsing the durable-text units', async () => {
    installRescan().refresh();
    await flush();

    rescanInput('occupied').value = '12h';
    rescanInput('empty').value = '2d';
    $('#scanCfgAbandoned').checked = false;

    save('scanRescanBody');
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.rescan.occupied).toBe(12 * 3600);
    expect(saved.rescan.empty).toBe(2 * 86400);
    expect(saved.rescan.abandonedEnabled).toBe(false);
    expect(typeof store.get(TS_KEY)).toBe('number');
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('rejects an unparseable re-scan time and does not save', async () => {
    installRescan().refresh();
    await flush();

    rescanInput('inactive').value = 'soon';
    save('scanRescanBody');
    await flush();

    expect(store.has(CFG_KEY)).toBe(false);
    expect(status('scanRescanBody').textContent || '').toMatch(/Invalid time/);
  });

  it('saving one editor preserves the OTHER editor\'s fields (shared slot)', async () => {
    // Stored slot carries both a colonization field and a rescan field.
    store.set(CFG_KEY, { positions: 'KEEP-ME', rescan: { occupied: 3600 } });
    installRescan().refresh();
    await flush();

    rescanInput('occupied').value = '2h';
    save('scanRescanBody');
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.rescan.occupied).toBe(2 * 3600); // our edit landed
    expect(saved.positions).toBe('KEEP-ME'); // the colonization field survived
  });
});
