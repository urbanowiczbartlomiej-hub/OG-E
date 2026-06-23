// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard AlarmClock-tab config editor. Same harness
// as scanConfig.test.js: a Map-backed chrome.storage fake, the tab container
// injected, real input edits + a Save click, asserting the rendered values and
// the chrome.storage writes. Everything is per-server now, split across two
// per-universe slots: the wave/ad-hoc config + message templates in
// `oge_alarmClockConfig`, and the fleet-save knobs in `oge_galaxyScanConfig`
// (shared with the scan-config editor — the crux test is that neither editor
// clobbers the other's fields, read-modify-write on save).
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
  // alarmClockConfig.js (like scanConfig.js) imports syncRequestKeyFor from
  // sync/scheduler.js, which transitively pulls gist.js + logger.js — both
  // read safeLS at import time.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
import { installAlarmClockConfig } from '../../../src/features/dashboard/alarmClockConfig.js';
import { installScanColonyConfig } from '../../../src/features/dashboard/scanConfig.js';
import { defaultGalaxyScanConfig } from '../../../src/domain/galaxyScanConfig.js';
import { defaultAlarmClockConfig } from '../../../src/domain/alarmClockConfig.js';
import { defaultAlarmClockTemplates } from '../../../src/domain/alarmClockTemplates.js';

const mockStore = /** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

const UNI = 's163-pl';
const CFG_KEY = `${UNI}:oge_galaxyScanConfig`;
const TS_KEY = `${UNI}:oge_galaxyScanConfigTs`;
const SYNC_KEY = `${UNI}:oge_syncRequestAt`;
// Per-universe alarmClock config (wave/ad-hoc + the three message templates).
const ALARM_CLOCK_KEY = `${UNI}:oge_alarmClockConfig`;
const ALARM_CLOCK_TS_KEY = `${UNI}:oge_alarmClockConfigTs`;

/** @type {Map<string, unknown>} */
const store = new Map();

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const install = () => installAlarmClockConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));

// ── per-entry offset editor helpers ───────────────────────────────────────
// Each offset list is a row editor (container id + `${id}Add` button, rows with
// `.oge-offset-input` / `.oge-offset-remove`; the full impact phrase is the
// chip's hover `title`).

/** Canonical comma string of an editor's row values. @param {string} id */
const readEditor = (id) =>
  [.../** @type {NodeListOf<HTMLInputElement>} */ (
    document.querySelectorAll(`#${id} .oge-offset-input`)
  )].map((i) => i.value).join(', ');

/** Hover-title impact phrases of an editor's chips, in order. @param {string} id */
const previewsOf = (id) =>
  [...document.querySelectorAll(`#${id} .oge-offset-row`)].map((r) => r.getAttribute('title'));

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
  document.body.innerHTML = '<div id="alarmClockConfigBody"></div><div id="colonizationConfigBody"></div>';
});

describe('AlarmClock fleet-save config editor', () => {
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

  it('renders a compact landing-relative impact preview per fleet-save offset chip', async () => {
    store.set(CFG_KEY, { fsOffsets: '-10m, 0m, 15m' });
    install().refresh();
    await flush();
    expect(previewsOf('remCfgFsOffsets')).toEqual([
      '10 min before landing', 'landing now', '15 min after landing',
    ]);
  });

  it('shows a combined plain-language summary under the fleet-save chips', async () => {
    store.set(CFG_KEY, { fsOffsets: '-15m, -5m, 0m, 20m' });
    install().refresh();
    await flush();
    const wrap = document.getElementById('remCfgFsOffsets');
    const summary = wrap?.parentElement?.querySelector('.oge-offset-summary');
    expect(summary?.textContent).toBe('15m & 5m before landing · at landing · 20m after landing');
  });

  it('saves the fs config + timestamp + syncRequest, parsing the duration units', async () => {
    install().refresh();
    await flush();

    $('#remCfgFsEnabled').checked = true;
    $('#remCfgFsThreshold').value = '250000';
    $('#remCfgFsMinFlight').value = '5m';
    setEditor('remCfgFsOffsets', ['-20m', '0m']);
    // Guardian off so the offsets pass through verbatim (its "never-enters net"
    // would otherwise inject a post-landing chip — covered by its own tests).
    $('#remCfgGuardianEnabled').checked = false;
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
    // Guardian off, else it injects a post-landing chip into the empty list.
    $('#remCfgGuardianEnabled').checked = false;
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsOffsets).toBe('');
  });

  it('guardian on: injects a post-landing offset at the guardian interval', async () => {
    // "Never-enters net" — the guardian arms on ENTRY, so a player who never
    // re-enters after landing would otherwise get no ping. When no offset
    // fires at or after the guardian interval, save auto-adds one (and reflects
    // it in the editor) so the classic fleet-save alarmClock still reaches them.
    install().refresh();
    await flush();
    $('#remCfgFsEnabled').checked = true;
    $('#remCfgFsThreshold').value = '0';
    $('#remCfgFsMinFlight').value = '0';
    setEditor('remCfgFsOffsets', ['-20m', '0m']);
    $('#remCfgGuardianEnabled').checked = true;
    $('#remCfgGuardianInterval').value = '20';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.guardianEnabled).toBe(true);
    expect(saved.guardianIntervalMin).toBe(20);
    expect(saved.fsOffsets).toBe('-20m, 0m, 20m'); // 20m chip injected
  });

  it('guardian on: does NOT inject when an offset already covers the interval', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsEnabled').checked = true;
    $('#remCfgFsThreshold').value = '0';
    $('#remCfgFsMinFlight').value = '0';
    setEditor('remCfgFsOffsets', ['0m', '30m']);
    $('#remCfgGuardianEnabled').checked = true;
    $('#remCfgGuardianInterval').value = '20';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    // 30m ≥ the 20m interval already guarantees a post-landing ping — no inject.
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsOffsets).toBe('0m, 30m');
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

  // The crux: the AlarmClock editor and the scan-config editor write the SAME
  // per-universe galaxyScanConfig slot. Each must read-modify-write so neither
  // resets the other's fields to defaults.
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
    installScanColonyConfig({ getUniverseId: () => UNI }).refresh();
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

describe('AlarmClock wave + ad-hoc config editor', () => {
  it('fills the fields from defaults when nothing is stored', async () => {
    install().refresh();
    await flush();
    const d = defaultAlarmClockConfig();
    expect($('#remCfgWaveEnabled').checked).toBe(d.alarmClockEnabled);
    expect(readEditor('remCfgWaveEditor')).toBe(d.alarmClockSchedule);
    // The ad-hoc lead time is now a signed chip editor; default '-1m'.
    expect(readEditor('remCfgAdhocOffsets')).toBe(d.adhocSchedule);
  });

  it('hydrates the fields from the stored per-universe alarmClock config', async () => {
    store.set(ALARM_CLOCK_KEY, { alarmClockEnabled: true, alarmClockSchedule: '5m, 15m', adhocSchedule: '-10m, 0m' });
    install().refresh();
    await flush();
    expect($('#remCfgWaveEnabled').checked).toBe(true);
    expect(readEditor('remCfgWaveEditor')).toBe('5m, 15m');
    expect(readEditor('remCfgAdhocOffsets')).toBe('-10m, 0m');
  });

  it('renders a compact return-relative impact preview per wave offset chip', async () => {
    store.set(ALARM_CLOCK_KEY, { alarmClockSchedule: '0m, 10m' });
    install().refresh();
    await flush();
    expect(previewsOf('remCfgWaveEditor')).toEqual([
      'when the wave returns', '10 min after the wave returns',
    ]);
  });

  it('saves the wave/ad-hoc config to the per-universe slot + timestamp (and pokes sync)', async () => {
    install().refresh();
    await flush();

    $('#remCfgWaveEnabled').checked = true;
    setEditor('remCfgWaveEditor', ['0m', '20m']);
    setEditor('remCfgAdhocOffsets', ['-90s', '0m']);
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();

    const saved = /** @type {any} */ (store.get(ALARM_CLOCK_KEY));
    expect(saved.alarmClockEnabled).toBe(true);
    expect(saved.alarmClockSchedule).toBe('0m, 20m');
    expect(saved.adhocSchedule).toBe('-90s, 0m');
    expect(typeof store.get(ALARM_CLOCK_TS_KEY)).toBe('number');
    // One poke triggers a full round-trip covering BOTH slots.
    expect(typeof store.get(SYNC_KEY)).toBe('number');
  });

  it('a save writes BOTH the fleet-save slot AND the alarmClock slot', async () => {
    install().refresh();
    await flush();
    $('#remCfgFsEnabled').checked = true;
    $('#remCfgWaveEnabled').checked = true;
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).fsEnabled).toBe(true);
    expect(/** @type {any} */ (store.get(ALARM_CLOCK_KEY)).alarmClockEnabled).toBe(true);
  });

  it('rejects an unparseable ad-hoc lead time and does not save', async () => {
    install().refresh();
    await flush();
    setEditor('remCfgAdhocOffsets', ['whenever']);
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(ALARM_CLOCK_KEY)).toBe(false);
    expect(store.has(CFG_KEY)).toBe(false); // the whole save aborted
    expect($('#remCfgStatus').textContent || '').toMatch(/ad-hoc schedule/i);
  });

  it('allows an empty wave schedule (no wave pings)', async () => {
    install().refresh();
    await flush();
    clearEditor('remCfgWaveEditor');
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(ALARM_CLOCK_KEY)).alarmClockSchedule).toBe('');
  });

  it('rejects an unparseable wave offset row and does not save', async () => {
    install().refresh();
    await flush();
    setEditor('remCfgWaveEditor', ['0m', 'later']);
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(store.has(ALARM_CLOCK_KEY)).toBe(false);
    expect($('#remCfgStatus').textContent || '').toMatch(/wave schedule/i);
  });
});

describe('AlarmClock message templates', () => {
  /** @param {string} sel */
  const ta = (sel) => /** @type {HTMLTextAreaElement} */ (document.querySelector(sel));

  it('fills the template editors from the default templates', async () => {
    install().refresh();
    await flush();
    const d = defaultAlarmClockTemplates();
    expect(ta('#remCfgTplWaveBody').value).toBe(d.wave.body);
    // Icon picker → the selected swatch's data-icon; priority → selected segment.
    expect(document.querySelector('#remCfgTplAdhocIcon .oge-icon-swatch.selected')
      ?.getAttribute('data-icon')).toBe(d.adhoc.icon);
    expect(document.querySelector('#remCfgTplFsPriority .oge-prio-seg.selected')
      ?.getAttribute('data-prio')).toBe(String(d.fleetSave.priority));
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

  it('saves edited wave body / icon / priority into the per-universe alarmClock slot', async () => {
    install().refresh();
    await flush();
    ta('#remCfgTplWaveBody').value = 'Wave back at {returnTime}!';
    /** @type {HTMLElement} */ (document.querySelector('#remCfgTplWaveIcon .oge-icon-swatch[data-icon="urgent"]'))
      .dispatchEvent(new Event('click'));
    /** @type {HTMLElement} */ (document.querySelector('#remCfgTplWavePriority .oge-prio-seg[data-prio="4"]'))
      .dispatchEvent(new Event('click'));
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    const saved = /** @type {any} */ (store.get(ALARM_CLOCK_KEY));
    expect(saved.templates.wave).toEqual({ body: 'Wave back at {returnTime}!', icon: 'urgent', priority: 4 });
  });

  it('saves the fleet-save template into the per-universe alarmClock slot', async () => {
    install().refresh();
    await flush();
    ta('#remCfgTplFsBody').value = 'FS: {label}';
    $('#remCfgSave').dispatchEvent(new Event('click'));
    await flush();
    expect(/** @type {any} */ (store.get(ALARM_CLOCK_KEY)).templates.fleetSave.body).toBe('FS: {label}');
  });
});
