// @vitest-environment happy-dom
//
// Behavioural tests for the Alarm clock section's one-view shell: the channel
// bar's gating (nothing past it works without a push channel), the Setup fold
// that opens by itself only while the token is missing, the kind tiles whose
// drawers open one at a time, and the per-kind summary each tile carries so the
// player never has to open anything to learn their own setup. All driven from
// storage, so the harness is a Map-backed chrome.storage fake and the
// assertions read the rendered block.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(), set: vi.fn(), getAll: vi.fn(), remove: vi.fn(), onChanged: vi.fn(),
  },
  safeLS: { bool: () => false, get: vi.fn(), set: vi.fn(), remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore, safeLS } from '../../../src/lib/storage.js';
import { installAlarmTabs, _resetAlarmTabsForTest } from '../../../src/features/dashboard/alarmTabs.js';
import { SHARED_SETTINGS_KEY } from '../../../src/state/sharedSettings.js';
import { alarmClockConfigKeyFor } from '../../../src/state/alarmClockConfig.js';
import { galaxyScanConfigKeyFor } from '../../../src/state/galaxyScanConfig.js';

const mockStore = /** @type {any} */ (chromeStore);
const mockLS = /** @type {any} */ (safeLS);

const UNI = 's163-pl';
const VALID_NTFY = 'tk_abcdefghijklmnopqrstuvwxyz';

/** @type {Map<string, unknown>} */
const store = new Map();
/** @type {Array<(c: Record<string, unknown>) => void>} */
let onChangedCbs = [];

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
/** @param {string} kind @returns {any} */
const tile = (kind) => document.querySelector(`.alarm-kind[data-kind="${kind}"]`);
/** @param {string} kind @returns {string} */
const times = (kind) => document.querySelector(`[data-kind-times="${kind}"]`)?.textContent ?? '';
/** @returns {string[]} kinds whose drawer is open. */
const openDrawers = () => [...document.querySelectorAll('.alarm-drawer.open')]
  .map((d) => /** @type {any} */ (d).dataset.kind);

// The shipped block, trimmed to what this module touches. Each drawer follows
// its tile, as in dashboard.html (that order is what puts a drawer under its
// tile on phones).
const KINDS = ['adhoc', 'fs', 'expo'];
const buildDom = () => {
  document.body.innerHTML = `
    <section id="alarmClockSection">
      <div id="alarmTop">
        <div id="alarmBar">
          <span id="alarmChannelState"></span>
          <button id="alarmSetupBtn"></button>
        </div>
        <div id="alarmSetup" hidden></div>
        <div id="alarmKinds">
          ${KINDS.map((k) => `
            <div class="alarm-kind" data-kind="${k}" tabindex="0">
              <span class="ak-switch" data-kind-switch="${k}"><button class="toggle-chip"></button></span>
              <div data-kind-times="${k}"></div>
            </div>
            <div class="alarm-drawer" data-kind="${k}"></div>`).join('')}
          <div id="alarmCfgFooter" style="display:none"></div>
        </div>
      </div>
    </section>`;
};

/**
 * Seed the storage slots the shell reads.
 *
 * @param {{ master?: boolean, token?: string, waveOn?: boolean, fsOn?: boolean }} o
 */
const seed = ({ master = true, token = VALID_NTFY, waveOn = true, fsOn = true } = {}) => {
  store.set(SHARED_SETTINGS_KEY, { alarmClockMasterEnabled: master, alarmClockNtfyToken: token });
  store.set(alarmClockConfigKeyFor(UNI), {
    alarmClockEnabled: waveOn, alarmClockSchedule: '0m, 5m', adhocSchedule: '-5m, 0m',
  });
  store.set(galaxyScanConfigKeyFor(UNI), { fsEnabled: fsOn, fsOffsets: '0m, 10m' });
};

/** Fire the storage listener the shell subscribed with. @param {string[]} keys */
const fireChange = (keys) => {
  /** @type {Record<string, unknown>} */
  const changes = {};
  for (const k of keys) changes[k] = { newValue: store.get(k) };
  for (const cb of onChangedCbs) cb(changes);
};

const install = () => installAlarmTabs({ getUniverseId: () => UNI });

beforeEach(() => {
  store.clear();
  onChangedCbs = [];
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.onChanged.mockReset();
  mockLS.get.mockReset();
  mockLS.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  mockStore.onChanged.mockImplementation((/** @type {any} */ cb) => {
    onChangedCbs.push(cb);
    return () => {};
  });
  mockLS.get.mockReturnValue(null);
  buildDom();
});

afterEach(() => {
  _resetAlarmTabsForTest();
});

describe('Alarm clock shell — gating', () => {
  it('is ready only with the clock on AND a usable token', async () => {
    seed();
    install();
    await flush();
    expect($('alarmTop').classList.contains('ready')).toBe(true);
    expect($('alarmTop').classList.contains('off')).toBe(false);
    expect($('alarmChannelState').textContent).toBe('ntfy connected');
    expect($('alarmSetup').hidden).toBe(true); // set up once, folded away
  });

  it('clock off: marked off, no channel state, nothing opens', async () => {
    seed({ master: false });
    install();
    await flush();
    expect($('alarmTop').classList.contains('off')).toBe(true);
    expect($('alarmTop').classList.contains('ready')).toBe(false);
    expect($('alarmChannelState').textContent).toBe('');
    expect($('alarmSetup').hidden).toBe(true);
  });

  it('clock on without a usable token: not ready, says so, Setup opens by itself', async () => {
    for (const token of ['', 'not-a-token']) {
      _resetAlarmTabsForTest();
      buildDom();
      seed({ token });
      install();
      await flush();
      expect($('alarmTop').classList.contains('ready')).toBe(false);
      expect($('alarmChannelState').textContent).toBe('Set up ntfy');
      expect($('alarmSetup').hidden).toBe(false);
    }
  });

  it('an open drawer closes when the channel goes away', async () => {
    seed();
    install();
    await flush();
    tile('fs').click();
    expect(openDrawers()).toEqual(['fs']);
    seed({ master: false });
    fireChange([SHARED_SETTINGS_KEY]);
    await flush();
    expect(openDrawers()).toEqual([]);
  });

  it('the Setup button toggles the fold, and a manual choice sticks', async () => {
    seed();
    install();
    await flush();
    $('alarmSetupBtn').click();
    expect($('alarmSetup').hidden).toBe(false);
    fireChange([SHARED_SETTINGS_KEY]); // a repaint must not fold it back
    await flush();
    expect($('alarmSetup').hidden).toBe(false);
    $('alarmSetupBtn').click();
    expect($('alarmSetup').hidden).toBe(true);
  });
});

describe('Alarm clock shell — tile summaries', () => {
  it('shows each kind\'s times, and "off" for a switched-off kind only', async () => {
    seed({ fsOn: false });
    install();
    await flush();
    expect(times('adhoc')).toBe('-5m · 0m');
    expect(times('fs')).toBe('off');
    expect(times('expo')).toBe('0m · 5m');
  });

  it('repaints when a kind is changed elsewhere', async () => {
    seed();
    install();
    await flush();
    expect(times('expo')).toBe('0m · 5m');
    seed({ waveOn: false });
    fireChange([alarmClockConfigKeyFor(UNI)]);
    await flush();
    expect(times('expo')).toBe('off');
  });

  it('refresh() re-reads the newly selected universe', async () => {
    seed();
    let uni = UNI;
    const api = installAlarmTabs({ getUniverseId: () => uni });
    await flush();
    uni = 's999-pl';
    store.set(galaxyScanConfigKeyFor(uni), { fsEnabled: false });
    api.refresh();
    await flush();
    expect(times('fs')).toBe('off');
  });
});

describe('Alarm clock shell — drawers', () => {
  it('opens one drawer at a time, closes on a second click, remembers the choice', async () => {
    seed();
    install();
    await flush();
    tile('adhoc').click();
    expect(openDrawers()).toEqual(['adhoc']);
    expect(tile('adhoc').getAttribute('aria-expanded')).toBe('true');
    expect($('alarmCfgFooter').style.display).toBe('');
    tile('expo').click();
    expect(openDrawers()).toEqual(['expo']);
    expect(mockLS.set).toHaveBeenLastCalledWith('oge_alarmSubtab', 'expo');
    tile('expo').click();
    expect(openDrawers()).toEqual([]);
    // Read the attribute: happy-dom's .style cache goes stale after a ''→'none' flip.
    expect($('alarmCfgFooter').getAttribute('style')).toContain('none');
    expect(mockLS.set).toHaveBeenLastCalledWith('oge_alarmSubtab', '');
  });

  it('a click on the kind\'s own switch does not open the drawer', async () => {
    seed();
    install();
    await flush();
    tile('fs').querySelector('.toggle-chip').click();
    expect(openDrawers()).toEqual([]);
  });

  it('Enter on a focused tile opens it', async () => {
    seed();
    install();
    await flush();
    tile('fs').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openDrawers()).toEqual(['fs']);
  });

  it('reopens the remembered drawer on install — but not behind a missing channel', async () => {
    mockLS.get.mockReturnValue('fs');
    seed();
    install();
    await flush();
    expect(openDrawers()).toEqual(['fs']);

    _resetAlarmTabsForTest();
    buildDom();
    seed({ token: '' });
    install();
    await flush();
    expect(openDrawers()).toEqual([]);
  });

  it('installs idempotently — a second call does not double-wire the clicks', async () => {
    seed();
    install();
    install();
    await flush();
    tile('adhoc').click(); // double-wired would open then close again
    expect(openDrawers()).toEqual(['adhoc']);
  });
});
