// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard's colonization config editor. Since §5d
// removed the per-status "Re-scan after" policy (occupancy freshness now comes
// from the OGame API; colonization state from the decision log with its own
// horizons), the editor is just the colonization & abandon group over ONE
// shared per-universe slot, on the Colonizations tab. We mock chrome.storage
// with a Map-backed fake, inject the tab's container, drive real input edits,
// trigger the debounced AUTOSAVE (there is no Save button — a bubbling change
// event schedules it; settle() advances fake timers past the window), and
// assert the observable output: rendered field values, the three
// chrome.storage writes (config value, newest-wins timestamp, syncRequest
// poke), and — crucially — that a save never clobbers fields the editor does
// NOT own (the AlarmClock tab's fleet-save `fs*` knobs, which share the same
// slot — read-modify-write merge).
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
/** Trigger the autosave (a bubbling change, as a real input edit fires) and
 *  run it: advance past the 500 ms debounce, then flush the async save. */
const settle = async () => {
  document.getElementById('colonizationConfigBody')
    ?.dispatchEvent(new Event('change', { bubbles: true }));
  vi.advanceTimersByTime(600);
  await flush();
};

const install = () => installScanColonyConfig({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (document.querySelector(sel));
// Reset / status are class hooks (not ids); scope to the editor body.
const reset = () =>
  document.querySelector('#colonizationConfigBody .scanCfgReset')?.dispatchEvent(new Event('click'));

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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Colonization config editor', () => {
  it('fills the colonization fields from the default preset when nothing is stored', async () => {
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('8');
    expect($('#scanCfgPrefer').classList.contains('on')).toBe(true);
    expect($('#scanCfgPreferFarthest').classList.contains('on')).toBe(true);
    expect($('#scanCfgColonyMinGap').value).toBe('15');
    expect($('#scanCfgColonyMinFields').value).toBe('320');
    expect($('#scanCfgColonyPassword').value).toBe('');
  });

  it('hydrates the colonization fields from a stored config', async () => {
    store.set(CFG_KEY, {
      positions: '12-15',
      preferOtherGalaxies: false,
      preferFarthestSystems: false,
    });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');
    expect($('#scanCfgPrefer').classList.contains('on')).toBe(false);
    expect($('#scanCfgPreferFarthest').classList.contains('on')).toBe(false);
  });

  it('saves the colonization fields + timestamp + syncRequest', async () => {
    install().refresh();
    await flush();

    $('#scanCfgPositions').value = '9,10';
    $('#scanCfgPrefer').click(); // default on → off
    $('#scanCfgPreferFarthest').click(); // default on → off
    $('#scanCfgColonyMinGap').value = '25';
    $('#scanCfgColonyMinFields').value = '250';
    $('#scanCfgColonyPassword').value = 'hunter2';

    await settle();

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

  it('reset is two-step: first tap only arms, second tap restores + autosaves defaults', async () => {
    store.set(CFG_KEY, { positions: '12-15', preferOtherGalaxies: false });
    install().refresh();
    await flush();
    expect($('#scanCfgPositions').value).toBe('12-15');

    // First tap arms (destructive under autosave — needs the confirm).
    reset();
    expect($('#scanCfgPositions').value).toBe('12-15');
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions).toBe('12-15');

    // Second tap applies + persists.
    reset();
    expect($('#scanCfgPositions').value).toBe(defaultGalaxyScanConfig().positions);
    vi.advanceTimersByTime(600);
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions)
      .toBe(defaultGalaxyScanConfig().positions);
  });

  it('an armed reset disarms after 3 s (a later single tap must not wipe)', async () => {
    store.set(CFG_KEY, { positions: '12-15' });
    install().refresh();
    await flush();

    reset(); // arm…
    vi.advanceTimersByTime(3100); // …let it expire
    reset(); // a FIRST tap again — arms, does not apply
    expect($('#scanCfgPositions').value).toBe('12-15');
    vi.advanceTimersByTime(600);
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).positions).toBe('12-15');
  });

  it('a no-op change (untouched fields) writes nothing and stamps no sync clock', async () => {
    store.set(CFG_KEY, { positions: '12-15' });
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    await settle(); // change event with no actual edits
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('a plain toggle-chip click autosaves (no change event, the click path)', async () => {
    install().refresh();
    await flush();

    $('#scanCfgPrefer').dispatchEvent(new Event('click', { bubbles: true })); // on → off
    vi.advanceTimersByTime(600);
    await flush();
    expect(/** @type {any} */ (store.get(CFG_KEY)).preferOtherGalaxies).toBe(false);
  });

  it('saving preserves fields the editor does NOT own (fleet-save knobs in the shared slot)', async () => {
    // Stored slot carries fleet-save knobs that no widget in this editor shows.
    store.set(CFG_KEY, { positions: 'OLD', fsEnabled: true, fsThreshold: 333000, fsOffsets: '-7m' });
    install().refresh();
    await flush();

    $('#scanCfgPositions').value = '9';
    await settle();

    const saved = /** @type {any} */ (store.get(CFG_KEY));
    expect(saved.positions).toBe('9'); // our edit landed
    // fs fields survive untouched via read-modify-write merge.
    expect(saved.fsEnabled).toBe(true);
    expect(saved.fsThreshold).toBe(333000);
    expect(saved.fsOffsets).toBe('-7m');
  });
});
