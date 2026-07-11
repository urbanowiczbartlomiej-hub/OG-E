// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard settings controls (the four cross-universe
// shared settings moved out of the in-game panel). A Map-backed chrome.storage
// fake backs the shared-settings dict + the per-universe key discovery; global
// fetch is stubbed per test for the two live token probes. We inject the inputs
// by id, install, flush, then drive change/click events and assert the writes
// + rendered status.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: {
    get: vi.fn(), set: vi.fn(), getAll: vi.fn(), remove: vi.fn(), onChanged: vi.fn(),
  },
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
import { installSettingsControls } from '../../../src/features/dashboard/settingsControls.js';
import { SHARED_SETTINGS_KEY } from '../../../src/state/sharedSettings.js';
import { syncRequestKeyFor } from '../../../src/sync/scheduler.js';
import { ALARM_CLOCK_NTFY_TOKEN_KEY } from '../../../src/sync/alarmClock.js';

const mockStore = /** @type {any} */ (chromeStore);

/** @type {Map<string, unknown>} */
const store = new Map();
/** @type {Array<(c: Record<string, unknown>) => void>} */
let onChangedCbs = [];

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

const VALID_NTFY = 'tk_abcdefghijklmnopqrstuvwxyz';

const buildDom = () => {
  // Master switches are toggle-chip buttons (state = the `.on` class), matching
  // the shipped dashboard.html; the credential inputs stay text/password.
  document.body.innerHTML = `
    <button type="button" class="toggle-chip" id="syncCloudToggle">Sync across devices</button>
    <div id="syncControlsBody">
      <input type="password" id="syncGistToken" />
      <button id="syncRevealGist"></button>
      <button id="syncNowBtn"></button>
      <div id="syncTokenStatus"></div>
    </div>
    <button type="button" class="toggle-chip" id="remMasterToggle">Enable alarm clock</button>
    <div id="remBody">
      <input type="password" id="remNtfyToken" />
      <button id="remRevealNtfy"></button>
      <button id="remValidateBtn"></button>
      <div id="remTokenStatus"></div>
    </div>
  `;
};

beforeEach(() => {
  store.clear();
  onChangedCbs = [];
  for (const k of ['get', 'set', 'getAll', 'remove', 'onChanged']) mockStore[k].mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v); return Promise.resolve();
  });
  mockStore.remove.mockImplementation((/** @type {string} */ k) => { store.delete(k); return Promise.resolve(); });
  mockStore.getAll.mockImplementation(() => Promise.resolve(Object.fromEntries(store)));
  mockStore.onChanged.mockImplementation((/** @type {any} */ cb) => { onChangedCbs.push(cb); return () => {}; });
  buildDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('populate()', () => {
  it('fills the toggles + inputs from the shared-settings dict', async () => {
    store.set(SHARED_SETTINGS_KEY, {
      cloudSync: true, gistToken: 'ghp_xyz',
      alarmClockMasterEnabled: true, alarmClockNtfyToken: VALID_NTFY,
    });
    installSettingsControls();
    await flush();
    expect($('syncCloudToggle').classList.contains('on')).toBe(true);
    expect($('syncGistToken').value).toBe('ghp_xyz');
    expect($('remMasterToggle').classList.contains('on')).toBe(true);
    expect($('remNtfyToken').value).toBe(VALID_NTFY);
  });

  it('hides remBody when master off and syncControlsBody when cloud off', async () => {
    store.set(SHARED_SETTINGS_KEY, { cloudSync: false, alarmClockMasterEnabled: false });
    installSettingsControls();
    await flush();
    expect($('remBody').style.display).toBe('none');
    expect($('syncControlsBody').style.display).toBe('none');
  });

  it('shows both bodies when their toggles are on', async () => {
    store.set(SHARED_SETTINGS_KEY, { cloudSync: true, alarmClockMasterEnabled: true });
    installSettingsControls();
    await flush();
    expect($('remBody').style.display).toBe('');
    expect($('syncControlsBody').style.display).toBe('');
  });
});

describe('toggles', () => {
  it('toggling syncCloudToggle writes the patch and updates visibility', async () => {
    installSettingsControls();
    await flush();
    $('syncCloudToggle').click(); // off → on
    await flush();
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).cloudSync).toBe(true);
    expect($('syncControlsBody').style.display).toBe('');
  });

  it('toggling remMasterToggle writes the patch and updates visibility', async () => {
    installSettingsControls();
    await flush();
    $('remMasterToggle').click(); // off → on
    await flush();
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).alarmClockMasterEnabled).toBe(true);
    expect($('remBody').style.display).toBe('');
  });
});

describe('token editing', () => {
  it('editing the gist token trims and writes the patch', async () => {
    installSettingsControls();
    await flush();
    $('syncGistToken').value = '  ghp_trimmed  ';
    $('syncGistToken').dispatchEvent(new Event('change'));
    await flush();
    expect($('syncGistToken').value).toBe('ghp_trimmed');
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).gistToken).toBe('ghp_trimmed');
  });

  it('a valid ntfy token writes the patch, mirrors ALARM_CLOCK_NTFY_TOKEN_KEY, and resets status to —', async () => {
    installSettingsControls();
    await flush();
    $('remTokenStatus').textContent = 'old verdict';
    $('remNtfyToken').value = `  ${VALID_NTFY}  `;
    $('remNtfyToken').dispatchEvent(new Event('change'));
    await flush();
    expect($('remNtfyToken').value).toBe(VALID_NTFY);
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).alarmClockNtfyToken).toBe(VALID_NTFY);
    expect(store.get(ALARM_CLOCK_NTFY_TOKEN_KEY)).toBe(VALID_NTFY);
    expect($('remTokenStatus').textContent).toBe('—');
  });

  it('clearing the ntfy token removes the mirror', async () => {
    store.set(ALARM_CLOCK_NTFY_TOKEN_KEY, VALID_NTFY);
    installSettingsControls();
    await flush();
    $('remNtfyToken').value = '';
    $('remNtfyToken').dispatchEvent(new Event('change'));
    await flush();
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).alarmClockNtfyToken).toBe('');
    expect(store.has(ALARM_CLOCK_NTFY_TOKEN_KEY)).toBe(false);
  });

  it('an invalid ntfy token writes the patch but does not mirror', async () => {
    installSettingsControls();
    await flush();
    $('remNtfyToken').value = 'not-a-token';
    $('remNtfyToken').dispatchEvent(new Event('change'));
    await flush();
    expect(/** @type {any} */ (store.get(SHARED_SETTINGS_KEY)).alarmClockNtfyToken).toBe('not-a-token');
    expect(store.has(ALARM_CLOCK_NTFY_TOKEN_KEY)).toBe(false);
  });
});

describe('reveal buttons', () => {
  it('toggles the gist input between password/text + class + aria-pressed', async () => {
    installSettingsControls();
    await flush();
    expect($('syncGistToken').type).toBe('password');
    $('syncRevealGist').dispatchEvent(new Event('click'));
    expect($('syncGistToken').type).toBe('text');
    expect($('syncRevealGist').classList.contains('revealed')).toBe(true);
    expect($('syncRevealGist').getAttribute('aria-pressed')).toBe('true');
    $('syncRevealGist').dispatchEvent(new Event('click'));
    expect($('syncGistToken').type).toBe('password');
    expect($('syncRevealGist').classList.contains('revealed')).toBe(false);
    expect($('syncRevealGist').getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the ntfy input between password/text', async () => {
    installSettingsControls();
    await flush();
    $('remRevealNtfy').dispatchEvent(new Event('click'));
    expect($('remNtfyToken').type).toBe('text');
    expect($('remRevealNtfy').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('remValidateBtn (ntfy account probe)', () => {
  it('shows Checking… then renders the ✓ head + detail lines', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        username: 'alice',
        tier: { name: 'pro' },
        stats: { messages: 5, messages_remaining: 95 },
        limits: { messages: 100 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    installSettingsControls();
    await flush();
    $('remNtfyToken').value = VALID_NTFY;

    $('remValidateBtn').dispatchEvent(new Event('click'));
    // Synchronous first paint before the await resolves.
    expect($('remTokenStatus').textContent).toBe('Checking…');
    await flush();

    const status = $('remTokenStatus');
    const head = status.querySelector('.rem-status-head');
    expect(head).toBeTruthy();
    expect(head.textContent).toBe('✓ Valid');
    expect(head.classList.contains('ok')).toBe(true);
    const detail = [...status.querySelectorAll('.rem-substatus')].map((d) => d.textContent);
    expect(detail).toContain('alice · pro');
    expect(detail).toContain('5 / 100 messages · 95 left');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('ntfy.sh/v1/account');
  });
});

describe('syncNowBtn', () => {
  it('validates the gist token (ok) and writes per-universe syncRequest keys', async () => {
    store.set('s1-en:oge_players', { a: 1 });
    store.set('s2-pl:oge_galaxyScans', [1]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: () => Promise.resolve({ login: 'octocat' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    installSettingsControls();
    await flush();
    $('syncGistToken').value = 'ghp_good';

    $('syncNowBtn').dispatchEvent(new Event('click'));
    expect($('syncTokenStatus').textContent).toBe('Validating…');
    await flush();

    expect($('syncTokenStatus').textContent).toContain('✓ Valid — octocat');
    expect($('syncTokenStatus').textContent).toContain('syncing…');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/user');
    // requestSyncAll wrote one syncRequest key per discovered universe.
    expect(typeof store.get(syncRequestKeyFor('s1-en'))).toBe('number');
    expect(typeof store.get(syncRequestKeyFor('s2-pl'))).toBe('number');
  });

  it('renders ✗ <status> for a non-ok gist validation', async () => {
    store.set('s1-en:oge_players', { a: 1 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
    }));
    installSettingsControls();
    await flush();
    $('syncGistToken').value = 'ghp_bad';

    $('syncNowBtn').dispatchEvent(new Event('click'));
    await flush();
    expect($('syncTokenStatus').textContent).toContain('✗ 401');
    // Still pokes the schedulers after the (failed) validation.
    expect(typeof store.get(syncRequestKeyFor('s1-en'))).toBe('number');
  });

  it('settles the syncing… suffix when a status mirror changes', async () => {
    store.set('s1-en:oge_players', { a: 1 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: () => Promise.resolve({ login: 'octocat' }),
    }));
    installSettingsControls();
    await flush();
    $('syncGistToken').value = 'ghp_good';

    $('syncNowBtn').dispatchEvent(new Event('click'));
    await flush();
    expect($('syncTokenStatus').textContent).toContain('syncing…');

    // A status-mirror change settles the label back to the bare verdict.
    onChangedCbs.forEach((cb) => cb({ 's1-en:oge_syncStatus': { newValue: {} } }));
    await flush();
    expect($('syncTokenStatus').textContent).toBe('✓ Valid — octocat');
  });
});
