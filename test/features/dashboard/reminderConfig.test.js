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
import { installColonizationConfig } from '../../../src/features/dashboard/scanConfig.js';
import { defaultGalaxyScanConfig } from '../../../src/domain/galaxyScanConfig.js';
import { defaultReminderGlobalConfig } from '../../../src/domain/reminderGlobalConfig.js';
import { defaultReminderTemplates } from '../../../src/domain/reminderTemplates.js';

const mockStore = /** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

const UNI = 's163-pl';
const CFG_KEY = `${UNI}:oge_galaxyScanConfig`;
const TS_KEY = `${UNI}:oge_galaxyScanConfigTs`;
const SYNC_KEY = `${UNI}:oge_syncRequestAt`;
// Global reminder config (NOT per-universe — see B3c).
const GLOBAL_KEY = 'oge_reminderGlobalConfig';
const GLOBAL_TS_KEY = 'oge_reminderGlobalConfigTs';

/** @type {Map<string, unknown>} */
const store = new Map();

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const install = () => installReminderConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));

// ── per-entry offset editor (B3d) helpers ─────────────────────────────────
// Each offset list is now a row editor (container id + `${id}Add` button, rows
// with `.oge-offset-input` / `.oge-offset-remove` / `.oge-offset-preview`).

/** Canonical comma string of an editor's row values. @param {string} id */
const readEditor = (id) =>
  [.../** @type {NodeListOf<HTMLInputElement>} */ (
    document.querySelectorAll(`#${id} .oge-offset-input`)
  )].map((i) => i.value).join(', ');

/** Preview phrases of an editor's rows, in order. @param {string} id */
const previewsOf = (id) =>
  [...document.querySelectorAll(`#${id} .oge-offset-preview`)].map((s) => s.textContent);

/** Remove every row of an editor. @param {string} id */
const clearEditor = (id) =>
  document.querySelectorAll(`#${id} .oge-offset-remove`).forEach((b) => b.dispatchEvent(new Event('click')));

/** Replace an editor's rows with `tokens`. @param {string} id @param {string[]} tokens */
const setEditor = (id, tokens) => {
  clearEditor(id);
  const addBtn = /** @type {HTMLButtonElement} */ (document.getElementById(`${id}Add`));
  for (const t of tokens) {
    addBtn.dispatchEvent(new Event('click'));
    const inputs = document.querySelectorAll(`#${id} .oge-offset-input`);
    const last = /** @type {HTMLInputElement} */ (inputs[inputs.length - 1]);
    last.value = t;
    last.dispatchEvent(new Event('input'));
  }
};

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML = '<div id="reminderConfigBody"></div><div id="colonizationConfigBody"></div>';
});

describe('Reminders fleet-save config editor', () => {
  it('fills fields from the default preset when nothing is stored', async () => {
    install().refresh();
    await flush();
    expect($('#remCfgFsEnabled').checked).toBe(false);
    expect($('#remCfgFsThreshold').value).toBe('100000');
    expect($('#remCfgFsMinFlight').value).toBe('10m');
    expect(readEditor('remCfgFsOffsets')).toBe('-10m, 0m, 10m');
  });

  it('hydrates fields from a stored config', async () => {
    store.set(CFG_KEY, { fsEnabled: true, fsThreshold: 50000, fsMinFlightSec: 900, fsOffsets: '-5m, 0m' });
    install().refresh();
    await flush();
    expect($('#remCfgFsEnabled').checked).toBe(true);
    expect($('#remCfgFsThreshold').value).toBe('50000');
    expect($('#remCfgFsMinFlight').value).toBe('15m');
    expect(readEditor('remCfgFsOffsets')).toBe('-5m, 0m');
  });

  it('renders a landing-relative impact preview per fleet-save offset row (B3d)', async () => {
    store.set(CFG_KEY, { fsOffsets: '-10m, 0m, 15m' });
    install().refresh();
    await flush();
    expect(previewsOf('remCfgFsOffsets')).toEqual([
      '10 min before landing', 'landing now', '15 min after landing',
    ]);
  });

  it('saves the fs config + timestamp + syncRequest, parsing the duration units', async () => {
    install().refresh();
    await flush();

    $('#remCfgFsEnabled').checked = true;
    $('#remCfgFsThreshold').value = '250000';
    $('#remCfgFsMinFlight').value = '5m';
    setEditor('remCfgFsOffsets', ['-20m', '0m']);
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
    clearEditor('remCfgFsOffsets');
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsOffsets).toBe('');
  });

  it('rejects an unparseable fleet-save offset row and does not save', async () => {
    install().refresh();
    await flush();
    setEditor('remCfgFsOffsets', ['-10m', 'soon']);
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(CFG_KEY)).toBe(false);
    expect($('#remCfgStatus').textContent || '').toMatch(/fleet-save schedule/i);
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
    installColonizationConfig({ getUniverseId: () => UNI }).refresh();
    await flush();
    $('#scanCfgPositions').value = '9';
    /** @type {HTMLElement} */ (
      document.querySelector('#colonizationConfigBody .scanCfgSave')
    ).dispatchEvent(new Event('click'));
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

describe('Reminders GLOBAL (wave + ad-hoc) config editor', () => {
  it('fills the global fields from defaults when nothing is stored', async () => {
    install().refresh();
    await flush();
    const d = defaultReminderGlobalConfig();
    expect($('#remCfgWaveEnabled').checked).toBe(d.reminderEnabled);
    expect(readEditor('remCfgWaveEditor')).toBe(d.reminderSchedule);
    expect($('#remCfgAdhoc').value).toBe('1m'); // 60 s
  });

  it('hydrates the global fields from the stored global config', async () => {
    store.set(GLOBAL_KEY, { reminderEnabled: true, reminderSchedule: '5m, 15m', adhocOffsetSec: 120 });
    install().refresh();
    await flush();
    expect($('#remCfgWaveEnabled').checked).toBe(true);
    expect(readEditor('remCfgWaveEditor')).toBe('5m, 15m');
    expect($('#remCfgAdhoc').value).toBe('2m');
  });

  it('renders a return-relative impact preview per wave offset row (B3d)', async () => {
    store.set(GLOBAL_KEY, { reminderSchedule: '0m, 10m' });
    install().refresh();
    await flush();
    expect(previewsOf('remCfgWaveEditor')).toEqual([
      'when the wave returns', '10 min after the wave returns',
    ]);
  });

  it('saves the global config to its own slot + timestamp (and pokes sync)', async () => {
    install().refresh();
    await flush();

    $('#remCfgWaveEnabled').checked = true;
    setEditor('remCfgWaveEditor', ['0m', '20m']);
    $('#remCfgAdhoc').value = '90s';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const saved = /** @type {any} */ (store.get(GLOBAL_KEY));
    expect(saved.reminderEnabled).toBe(true);
    expect(saved.reminderSchedule).toBe('0m, 20m');
    expect(saved.adhocOffsetSec).toBe(90);
    expect(typeof store.get(GLOBAL_TS_KEY)).toBe('number');
    // One poke triggers a full round-trip covering BOTH slots.
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('a save writes BOTH the per-server fs slot AND the global slot', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsEnabled').checked = true;
    $('#remCfgWaveEnabled').checked = true;
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsEnabled).toBe(true);
    expect(/** @type {any} */ (store.get(GLOBAL_KEY)).reminderEnabled).toBe(true);
  });

  it('rejects an unparseable ad-hoc lead time and does not save', async () => {
    install().refresh();
    await flush();
    $('#remCfgAdhoc').value = 'whenever';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(GLOBAL_KEY)).toBe(false);
    expect(store.has(CFG_KEY)).toBe(false); // the whole save aborted
    expect($('#remCfgStatus').textContent || '').toMatch(/lead time/i);
  });

  it('allows an empty wave schedule (no wave pings)', async () => {
    install().refresh();
    await flush();
    clearEditor('remCfgWaveEditor');
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(GLOBAL_KEY)).reminderSchedule).toBe('');
  });

  it('rejects an unparseable wave offset row and does not save', async () => {
    install().refresh();
    await flush();
    setEditor('remCfgWaveEditor', ['0m', 'later']);
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(GLOBAL_KEY)).toBe(false);
    expect($('#remCfgStatus').textContent || '').toMatch(/wave schedule/i);
  });
});

describe('Reminders message templates', () => {
  /** @param {string} sel */
  const ta = (sel) => /** @type {HTMLTextAreaElement} */ (document.querySelector(sel));

  it('fills the template editors from the default templates', async () => {
    install().refresh();
    await flush();
    const d = defaultReminderTemplates();
    expect(ta('#remCfgTplWaveBody').value).toBe(d.wave.body);
    expect($('#remCfgTplAdhocIcon').value).toBe(d.adhoc.icon);
    expect($('#remCfgTplFsPriority').value).toBe(String(d.fleetSave.priority));
  });

  it('renders a live preview from the kind sample context and warns on unknown wildcards', async () => {
    install().refresh();
    await flush();
    const body = ta('#remCfgTplWaveBody');
    body.value = 'Back {returnTime} #{index}/{total}';
    body.dispatchEvent(new Event('input'));
    expect(document.querySelector('#remCfgTplWave .oge-tpl-preview')?.textContent)
      .toBe('Back 14:32 #1/4');
    // {coords} is not a wave wildcard → warning.
    body.value = '{coords}';
    body.dispatchEvent(new Event('input'));
    expect(document.querySelector('#remCfgTplWave .oge-tpl-warn')?.textContent || '')
      .toMatch(/coords/);
  });

  it('saves edited wave body / icon / priority into the global slot', async () => {
    install().refresh();
    await flush();
    ta('#remCfgTplWaveBody').value = 'Wave back at {returnTime}!';
    $('#remCfgTplWaveIcon').value = 'urgent';
    $('#remCfgTplWavePriority').value = '4';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    const saved = /** @type {any} */ (store.get(GLOBAL_KEY));
    expect(saved.templates.wave).toEqual({ body: 'Wave back at {returnTime}!', icon: 'urgent', priority: 4 });
  });

  it('always saves the fleet-save template to the GLOBAL slot (presentation is server-independent)', async () => {
    install().refresh();
    await flush();
    ta('#remCfgTplFsBody').value = 'FS: {label}';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(GLOBAL_KEY)).templates.fleetSave.body).toBe('FS: {label}');
  });
});

describe('Reminders per-server override (this-server scope)', () => {
  /** @param {string} sel */
  const ta = (sel) => /** @type {HTMLTextAreaElement} */ (document.querySelector(sel));

  it('saves wave/ad-hoc edits to the per-server override, leaving the global wave intact', async () => {
    install().refresh();
    await flush();
    const ov = $('#remCfgOverride');
    ov.checked = true;
    ov.dispatchEvent(new Event('change'));
    $('#remCfgWaveEnabled').checked = true;
    ta('#remCfgTplWaveBody').value = 'SERVER wave';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const gsc = /** @type {any} */ (store.get(CFG_KEY));
    expect(gsc.reminderOverrideEnabled).toBe(true);
    expect(gsc.reminderOverride.reminderEnabled).toBe(true);
    expect(gsc.reminderOverride.templates.wave.body).toBe('SERVER wave');
    // The GLOBAL wave template is untouched by an override save.
    const global = /** @type {any} */ (store.get(GLOBAL_KEY));
    expect(global.templates.wave.body).toBe(defaultReminderTemplates().wave.body);
  });

  it('clears the override gate when the toggle is off (edits go to global)', async () => {
    store.set(CFG_KEY, { reminderOverrideEnabled: true, reminderOverride: { reminderSchedule: '5m' } });
    install().refresh();
    await flush();
    // Toggle override OFF, then save.
    const ov = $('#remCfgOverride');
    expect(ov.checked).toBe(true); // hydrated from the stored gate
    ov.checked = false;
    ov.dispatchEvent(new Event('change'));
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).reminderOverrideEnabled).toBe(false);
  });

  it('hydrates the override fields + gate from the stored per-server snapshot', async () => {
    store.set(CFG_KEY, {
      reminderOverrideEnabled: true,
      reminderOverride: { reminderSchedule: '7m', templates: { wave: { body: 'OV body' } } },
    });
    install().refresh();
    await flush();
    expect($('#remCfgOverride').checked).toBe(true);
    expect(readEditor('remCfgWaveEditor')).toBe('7m');
    expect(ta('#remCfgTplWaveBody').value).toBe('OV body');
  });
});
