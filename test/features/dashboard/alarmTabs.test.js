// @vitest-environment happy-dom
//
// Behavioural tests for the AlarmClock section's sub-tab strip. The strip's
// job is not "flip a class" — it is the two things that make the tab honest:
// LOCKING every pane that can't work without a push channel, and stamping each
// kind's on/off state onto its own tab so the player never has to open a pane
// to learn their own setup. Both are driven from storage, so the harness is a
// Map-backed chrome.storage fake and the assertions read the rendered strip.
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

/** @param {string} key @returns {any} */
const tab = (key) => document.querySelector(`#alarmSubtabs [data-subtab="${key}"]`);
/** @param {string} key @returns {any} */
const pane = (key) => document.querySelector(`#alarmClockSection > .subtabpane[data-subtab="${key}"]`);
/** The state marker's text for one tab ('' when it carries none). @param {string} key */
const marker = (key) => tab(key)?.querySelector('.subtab-state')?.textContent ?? '';
/** @returns {string[]} keys of the locked tabs, in strip order. */
const lockedKeys = () => [...document.querySelectorAll('#alarmSubtabs .subtab')]
  .filter((b) => b.classList.contains('locked'))
  .map((b) => /** @type {any} */ (b).dataset.subtab);
/** @returns {string | undefined} */
const activeKey = () => /** @type {any} */ (
  document.querySelector('#alarmSubtabs .subtab.active')
)?.dataset.subtab;

// The shipped strip + panes, trimmed to what this module touches. Order matches
// dashboard.html so a regression in the markup's tab order shows up here too.
const KEYS = ['general', 'reminders', 'adhoc', 'fs', 'expo'];
const buildDom = () => {
  document.body.innerHTML = `
    <section id="alarmClockSection">
      <div class="subtabs" id="alarmSubtabs" role="tablist">
        ${KEYS.map((k, i) => `<button type="button" class="subtab${i === 0 ? ' active' : ''}" data-subtab="${k}"></button>`).join('')}
      </div>
      ${KEYS.map((k, i) => `<div class="subtabpane${i === 0 ? ' active' : ''}" data-subtab="${k}"></div>`).join('')}
      <div id="alarmCfgFooter" style="display:none"></div>
    </section>`;
};

/**
 * Seed the two storage slots the strip reads.
 *
 * @param {{ master?: boolean, token?: string, waveOn?: boolean, fsOn?: boolean }} o
 */
const seed = ({ master = true, token = VALID_NTFY, waveOn = true, fsOn = true } = {}) => {
  store.set(SHARED_SETTINGS_KEY, { alarmClockMasterEnabled: master, alarmClockNtfyToken: token });
  store.set(alarmClockConfigKeyFor(UNI), { alarmClockEnabled: waveOn });
  store.set(galaxyScanConfigKeyFor(UNI), { fsEnabled: fsOn });
};

/** Fire the storage listener the strip subscribed with. @param {string[]} keys */
const fireChange = (keys) => {
  /** @type {Record<string, unknown>} */
  const changes = {};
  for (const k of keys) changes[k] = { newValue: store.get(k) };
  for (const cb of onChangedCbs) cb(changes);
};

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

describe('AlarmClock sub-tab strip — gating', () => {
  it('locks every pane past General until the clock is on AND has a token', async () => {
    seed({ master: false, token: '' });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(lockedKeys()).toEqual(['reminders', 'adhoc', 'fs', 'expo']);
    // General is where the channel gets set up, so it can never lock.
    expect(tab('general').classList.contains('locked')).toBe(false);
    expect(tab('fs').disabled).toBe(true);
  });

  it('a master switch with no usable token still locks — a token is not optional', async () => {
    seed({ master: true, token: '' });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(lockedKeys()).toEqual(['reminders', 'adhoc', 'fs', 'expo']);
    // …and General says WHICH half is missing, so the lock explains itself.
    expect(marker('general')).toBe('Set up');
  });

  it('a syntactically invalid token counts as no token', async () => {
    seed({ master: true, token: 'not-a-ntfy-token' });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(lockedKeys()).toEqual(['reminders', 'adhoc', 'fs', 'expo']);
  });

  it('unlocks everything once both prerequisites are in place', async () => {
    seed();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(lockedKeys()).toEqual([]);
    expect(marker('general')).toBe('');
  });

  it('clicking a locked tab does nothing — no inert pane opens', async () => {
    seed({ master: false, token: '' });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    tab('fs').click();
    await flush();

    expect(activeKey()).toBe('general');
    expect(pane('fs').classList.contains('active')).toBe(false);
    expect(mockLS.set).not.toHaveBeenCalled();
  });

  it('an OPEN pane that becomes locked falls back to General', async () => {
    seed();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();
    tab('fs').click();
    expect(activeKey()).toBe('fs');

    // The player switches the whole clock off from the General tab.
    store.set(SHARED_SETTINGS_KEY, { alarmClockMasterEnabled: false, alarmClockNtfyToken: '' });
    fireChange([SHARED_SETTINGS_KEY]);
    await flush();

    expect(activeKey()).toBe('general');
    expect(pane('general').classList.contains('active')).toBe(true);
    expect(pane('fs').classList.contains('active')).toBe(false);
  });
});

describe('AlarmClock sub-tab strip — per-kind state markers', () => {
  it('marks a switched-off kind on its own tab, and only that one', async () => {
    seed({ waveOn: false, fsOn: true });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(marker('expo')).toBe('Off');
    expect(marker('fs')).toBe('');
    // Ad-hoc has no enable flag at all (it is armed per entry in-game), so it
    // must never claim a state it doesn't have.
    expect(marker('adhoc')).toBe('');
  });

  it('repaints a marker when the kind is toggled elsewhere', async () => {
    seed({ fsOn: true });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();
    expect(marker('fs')).toBe('');

    store.set(galaxyScanConfigKeyFor(UNI), { fsEnabled: false });
    fireChange([galaxyScanConfigKeyFor(UNI)]);
    await flush();

    expect(marker('fs')).toBe('Off');
  });

  it('ignores a config change for a universe that is not selected', async () => {
    seed({ fsOn: true });
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    store.set(galaxyScanConfigKeyFor('other-uni'), { fsEnabled: false });
    fireChange([galaxyScanConfigKeyFor('other-uni')]);
    await flush();

    expect(marker('fs')).toBe('');
  });

  it('claims no per-kind state while no universe is selected', async () => {
    seed({ waveOn: false, fsOn: false });
    installAlarmTabs({ getUniverseId: () => '' });
    await flush();

    expect(marker('expo')).toBe('');
    expect(marker('fs')).toBe('');
  });

  it('refresh() re-reads the newly selected universe', async () => {
    let uni = 'other-uni';
    seed({ fsOn: true });
    store.set(galaxyScanConfigKeyFor('other-uni'), { fsEnabled: true });
    const api = installAlarmTabs({ getUniverseId: () => uni });
    await flush();
    expect(marker('fs')).toBe('');

    uni = UNI;
    store.set(galaxyScanConfigKeyFor(UNI), { fsEnabled: false });
    api.refresh();
    await flush();

    expect(marker('fs')).toBe('Off');
  });
});

describe('AlarmClock sub-tab strip — switching panes', () => {
  it('shows exactly one pane and remembers the choice', async () => {
    seed();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    tab('adhoc').click();
    await flush();

    expect(activeKey()).toBe('adhoc');
    expect([...document.querySelectorAll('#alarmClockSection > .subtabpane.active')]
      .map((p) => /** @type {any} */ (p).dataset.subtab)).toEqual(['adhoc']);
    expect(mockLS.set).toHaveBeenCalledWith('oge_alarmSubtab', 'adhoc');
  });

  it('reopens the remembered pane on install', async () => {
    seed();
    mockLS.get.mockReturnValue('fs');
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(activeKey()).toBe('fs');
  });

  it('a remembered pane that is now locked does not reopen', async () => {
    seed({ master: false, token: '' });
    mockLS.get.mockReturnValue('fs');
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    expect(activeKey()).toBe('general');
  });

  it('the shared Reset footer shows only on the three config panes', async () => {
    seed();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();
    const footer = /** @type {any} */ (document.getElementById('alarmCfgFooter'));

    tab('fs').click();
    expect(footer.style.display).toBe('');
    tab('adhoc').click();
    expect(footer.style.display).toBe('');
    tab('expo').click();
    expect(footer.style.display).toBe('');
    tab('reminders').click();
    expect(footer.style.display).toBe('none');
    tab('general').click();
    expect(footer.style.display).toBe('none');
  });

  it('installs idempotently — a second call does not double-wire the clicks', async () => {
    seed();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();
    installAlarmTabs({ getUniverseId: () => UNI });
    await flush();

    // One listener per button: two would still land on the same pane, so assert
    // on the persist call count instead.
    tab('adhoc').click();
    expect(mockLS.set).toHaveBeenCalledTimes(1);
  });
});
