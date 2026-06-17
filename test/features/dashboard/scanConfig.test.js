// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard's combined scan/colonization config
// editor. The colonization knobs and the scan re-scan policy are two field
// groups in ONE editor over ONE shared per-universe slot, on the Colonizations
// tab. We mock chrome.storage with a Map-backed fake, inject the tab's
// container, drive real input edits + a Save click, and assert the observable
// output: rendered field values, the three chrome.storage writes (config value,
// newest-wins timestamp, syncRequest poke), and — crucially — that a save never
// clobbers fields the editor does NOT own (the Reminders tab's fleet-save `fs*`
// knobs, which share the same slot — read-modify-write merge).
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
import { installScanColonyConfig } from '../../../src/features/dashboard/scanConfig.js';
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

const install = () => installScanColonyConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));
const rescanInput = (/** @type {string} */ field) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`[data-field="${field}"]`));
// Save / Reset / status are class hooks (not ids); scope to the editor body.
const save = () =>
  document.querySelector('#colonizationConfigBody .scanCfgSave')?.dispatchEvent(new Event('click'));
const reset = () =>
  document.querySelector('#colonizationConfigBody .scanCfgReset')?.dispatchEvent(new Event('click'));
const status = () =>
  /** @type {HTMLElement} */ (document.querySelector('#colonizationConfigBody .scanCfgStatus'));

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML = '<div id="colonizationConfigBody"></div>';
});

describe('Combined scan/colonization config editor', () => {
  it('fills both field groups from the default preset when nothing is stored', async () => {
    install().refresh();
    await flush();
    // Colonization group.
    expect($('#scanCfgPositions').value).toBe('8');
    expect($('#scanCfgPrefer').checked).toBe(true);
    expect($('#scanCfgColonyMinGap').value).toBe('15');
    expect($('#scanCfgColonyMinFields').value).toBe('320');
    expect($('#scanCfgColonyPassword').value).toBe('');
    // Scan re-scan group.
    expect($('#scanCfgAbandoned').checked).toBe(true);
    expect(rescanInput('inactive').value).toBe('5d');
    expect(rescanInput('empty').value).toBe('0'); // never, by default
  });

  it('hydrates both field groups from a stored config', async () => {
    store.set(CFG_KEY, {
      positions: '12-15',
      preferOtherGalaxies: false,
      preferFarthestSystems: false,
      rescan: { occupied: 6 * 3600 },
    });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');
    expect($('#scanCfgPrefer').checked).toBe(false);
    expect($('#scanCfgPreferFarthest').checked).toBe(false);
    expect(rescanInput('occupied').value).toBe('6h');
  });

  it('saves both field groups + timestamp + syncRequest, parsing the durable-text units', async () => {
    install().refresh();
    await flush();

    $('#scanCfgPositions').value = '9,10';
    $('#scanCfgPrefer').checked = false;
    $('#scanCfgPreferFarthest').checked = false;
    $('#scanCfgColonyMinGap').value = '25';
    $('#scanCfgColonyMinFields').value = '250';
    $('#scanCfgColonyPassword').value = 'hunter2';
    rescanInput('occupied').value = '12h';
    rescanInput('empty').value = '2d';
    $('#scanCfgAbandoned').checked = false;

    save();
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9,10');
    expect(saved.preferOtherGalaxies).toBe(false);
    expect(saved.preferFarthestSystems).toBe(false);
    expect(saved.colonyMinGap).toBe(25);
    expect(saved.colonyMinFields).toBe(250);
    expect(saved.colonyPassword).toBe('hunter2');
    expect(saved.rescan.occupied).toBe(12 * 3600);
    expect(saved.rescan.empty).toBe(2 * 86400);
    expect(saved.rescan.abandonedEnabled).toBe(false);
    expect(typeof store.get(TS_KEY)).toBe('number');
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('reset loads defaults into the fields (without saving until clicked)', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');

    reset();
    expect($('#scanCfgPositions').value).toBe(defaultGalaxyScanConfig().positions);
    // Reset alone does not persist — the stored value is unchanged.
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions).toBe('12-15');
  });

  it('rejects an unparseable re-scan time and does not save', async () => {
    install().refresh();
    await flush();

    rescanInput('inactive').value = 'soon';
    save();
    await flush();

    expect(store.has(CFG_KEY)).toBe(false);
    expect(status().textContent || '').toMatch(/Invalid time/);
  });

  it('saving preserves fields the editor does NOT own (fleet-save knobs in the shared slot)', async () => {
    // Stored slot carries fleet-save knobs that no widget in this editor shows.
    store.set(CFG_KEY, { positions: 'OLD', fsEnabled: true, fsThreshold: 333000, fsOffsets: '-7m' });
    install().refresh();
    await flush();

    $('#scanCfgPositions').value = '9';
    save();
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9'); // our edit landed
    // fs fields survive untouched via read-modify-write merge.
    expect(saved.fsEnabled).toBe(true);
    expect(saved.fsThreshold).toBe(333000);
    expect(saved.fsOffsets).toBe('-7m');
  });
});
