// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard "Sync" tab renderer. A Map-backed
// chrome.storage fake feeds getAll(); we inject #syncBody, install, flush the
// async render, and assert the rendered cards / chips / table — plus that an
// onChanged with a :oge_ key and refresh() both repaint. textContent only
// (no innerHTML), so a stored err string with markup shows as literal text.
//
// @ts-check

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { getAll: vi.fn(), onChanged: vi.fn() },
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

vi.mock('../../../src/features/dashboard/io.js', () => ({
  exportAllData: vi.fn(),
  purgeUniverseData: vi.fn(),
  ARCHIVE_OMITS: ['API cache — re-downloads', 'Colonize password'],
}));

import { chromeStore } from '../../../src/lib/storage.js';
import * as io from '../../../src/features/dashboard/io.js';
import { installSync, _resetSyncForTest } from '../../../src/features/dashboard/sync.js';
import { formatBytes } from '../../../src/features/dashboard/syncInventory.js';

const mockIo = /** @type {{ exportAllData: import('vitest').Mock, purgeUniverseData: import('vitest').Mock }} */ (/** @type {any} */ (io));

const mockStore = /** @type {{ getAll: import('vitest').Mock, onChanged: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

/** @type {Map<string, unknown>} */
const store = new Map();
/** @type {Array<(c: Record<string, unknown>) => void>} */
let onChangedCbs = [];

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

beforeEach(() => {
  store.clear();
  onChangedCbs = [];
  mockStore.getAll.mockReset();
  mockStore.onChanged.mockReset();
  mockStore.getAll.mockImplementation(() => Promise.resolve(Object.fromEntries(store)));
  mockStore.onChanged.mockImplementation((/** @type {any} */ cb) => {
    onChangedCbs.push(cb);
    return () => {};
  });
  _resetSyncForTest();
  document.body.innerHTML = '<div id="syncBody"></div>';
});

describe('Sync tab renderer', () => {
  it('shows a "No synced data" paragraph when storage is empty', async () => {
    installSync();
    await flush();
    const empty = $('.sync-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/No synced data/i);
  });

  it('renders a card with the universe id, a freshness chip, and ↑/↓ line', async () => {
    const now = Date.now();
    store.set('s1-en:oge_syncStatus', { up: new Date(now - 5 * 60 * 1000).toISOString(), down: null });
    store.set('s1-en:oge_players', { a: 1, b: 2 });
    installSync();
    await flush();

    const card = $('.sync-card');
    expect(card).toBeTruthy();
    expect($('.sync-universe').textContent).toBe('s1-en');
    const chip = $('.sync-chip');
    expect(chip.className).toContain('sync-chip-ok');
    expect(chip.textContent).toBe('5m ago');
    const line = $('.sync-status-line');
    expect(line.textContent).toContain('↑');
    expect(line.textContent).toContain('↓');
  });

  it('renders an error line when status.err is present, as literal text', async () => {
    const markup = '<b>boom</b>';
    store.set('s1-en:oge_syncStatus', { err: markup });
    store.set('s1-en:oge_players', { a: 1 });
    installSync();
    await flush();
    const err = $('.sync-err');
    expect(err).toBeTruthy();
    expect(err.textContent).toContain(markup);
    // The markup is literal text, not parsed into a child element.
    expect(err.querySelector('b')).toBeNull();
  });

  it('renders the inventory table with a total row showing formatBytes(totalBytes)', async () => {
    const players = { a: 1, b: 2, c: 3 };
    store.set('s1-en:oge_players', players);
    installSync();
    await flush();

    const table = $('.sync-table');
    expect(table).toBeTruthy();
    const total = JSON.stringify(players).length;
    const tfoot = /** @type {HTMLElement} */ (table.querySelector('tfoot'));
    expect(tfoot.textContent).toContain('Total');
    expect(tfoot.textContent).toContain(formatBytes(total));
  });

  it('re-renders when onChanged fires with a :oge_ key', async () => {
    installSync();
    await flush();
    expect($('.sync-empty')).toBeTruthy();

    store.set('s1-en:oge_players', { a: 1 });
    onChangedCbs.forEach((cb) => cb({ 's1-en:oge_players': { newValue: { a: 1 } } }));

    // The onChanged repaint is debounced (REVIEW.md 7.5, 300 ms trailing
    // timer), so poll the real timer instead of just flushing microtasks.
    await vi.waitFor(() => {
      expect($('.sync-empty')).toBeNull();
      expect($('.sync-universe').textContent).toBe('s1-en');
    });
  });

  it('ignores onChanged keys without :oge_', async () => {
    installSync();
    await flush();
    store.set('s1-en:oge_players', { a: 1 });
    onChangedCbs.forEach((cb) => cb({ unrelatedKey: { newValue: 1 } }));
    await flush();
    // No repaint — still the empty placeholder.
    expect($('.sync-empty')).toBeTruthy();
  });

  it('refresh() repaints from the latest snapshot', async () => {
    const api = installSync();
    await flush();
    expect($('.sync-empty')).toBeTruthy();

    store.set('s2-pl:oge_players', { a: 1 });
    api.refresh();
    await flush();

    expect($('.sync-empty')).toBeNull();
    expect($('.sync-universe').textContent).toBe('s2-pl');
  });
});

describe('Sync tab — abandon a server (archive → delete gate)', () => {
  // The whole point of these tests: the destructive control must be
  // UNREACHABLE until an archive has actually downloaded AND the universe id
  // has been typed. io.js's own behaviour (what an archive contains, which
  // keys a purge removes) is covered in io.test.js; here we only pin the gate,
  // because that is what stands between "free some space" and "lose two years
  // of intel".
  const card = () => $('.sync-card');
  const q = (/** @type {string} */ sel) =>
    /** @type {HTMLButtonElement & HTMLInputElement} */ (card().querySelector(sel));

  beforeEach(() => {
    mockIo.exportAllData.mockReset();
    mockIo.purgeUniverseData.mockReset();
    mockIo.exportAllData.mockResolvedValue({ datasets: 4, bytes: 2048 });
    mockIo.purgeUniverseData.mockResolvedValue({ keys: 7, bytes: 4096 });
    store.set('s1-en:oge_colonyHistory', [1, 2, 3]);
    store.set('s1-en:oge_players', { a: 1 });
  });

  const openPanel = async () => {
    const handle = installSync();
    await flush();
    q('.abandon-toggle').click();
    await flush();
    return handle;
  };

  it('every card offers Abandon, and the panel states the cost before anything happens', async () => {
    await openPanel();
    const warn = card().querySelector('.abandon-warn');
    expect(warn?.textContent).toContain('s1-en');
    expect(warn?.textContent).toContain('No undo');
    // The numbers are on-screen text, not a tooltip — there is no hover on touch.
    expect(warn?.textContent).toMatch(/\d+ categories/);
    expect(card().querySelectorAll('.abandon-omits li').length).toBeGreaterThan(0);
  });

  it('locks the confirm input and Delete until the archive has downloaded', async () => {
    await openPanel();
    expect(q('.abandon-confirm').disabled).toBe(true);
    expect(q('.abandon-delete').disabled).toBe(true);
    expect(card().textContent).toContain('Delete unlocks once the archive is downloaded');

    q('.abandon-archive').click();
    await flush();

    expect(mockIo.exportAllData).toHaveBeenCalledWith('s1-en', { archive: true });
    expect(q('.abandon-confirm').disabled).toBe(false);
    expect(card().querySelector('.abandon-state')?.textContent).toContain('4 datasets');
  });

  it('keeps Delete locked until the typed id matches EXACTLY', async () => {
    await openPanel();
    q('.abandon-archive').click();
    await flush();

    const input = q('.abandon-confirm');
    const del = q('.abandon-delete');
    for (const typed of ['', 's1', 's1-e', 's2-en', 'S1-EN', ' s1-en']) {
      input.value = typed;
      input.dispatchEvent(new Event('input'));
      expect(del.disabled).toBe(true);
    }
    input.value = 's1-en';
    input.dispatchEvent(new Event('input'));
    expect(del.disabled).toBe(false);
  });

  it('purges only after both gates pass', async () => {
    await openPanel();
    // Clicking Delete while locked must do nothing even if the DOM were
    // tampered with — the handler re-checks rather than trusting `disabled`.
    q('.abandon-delete').disabled = false;
    q('.abandon-delete').click();
    await flush();
    expect(mockIo.purgeUniverseData).not.toHaveBeenCalled();

    q('.abandon-archive').click();
    await flush();
    const input = q('.abandon-confirm');
    input.value = 's1-en';
    input.dispatchEvent(new Event('input'));
    q('.abandon-delete').click();
    await flush();
    expect(mockIo.purgeUniverseData).toHaveBeenCalledWith('s1-en');
  });

  it('surfaces an archive failure and leaves the gate shut', async () => {
    mockIo.exportAllData.mockRejectedValue(new Error('disk full'));
    await openPanel();
    q('.abandon-archive').click();
    await flush();

    expect(card().textContent).toContain('Archive failed');
    expect(q('.abandon-confirm').disabled).toBe(true);
    expect(q('.abandon-delete').disabled).toBe(true);
  });

  it('a background repaint does not reset a half-finished confirmation', async () => {
    const handle = await openPanel();
    q('.abandon-archive').click();
    await flush();

    // A sync round lands under the open panel. onChanged debounces by 300 ms;
    // refresh() is the same render path without the timer, which is what we
    // care about here (state survival across a repaint, not the debounce).
    store.set('s1-en:oge_targetReports', { x: 1 });
    handle.refresh();
    await flush();

    // Panel still open, archive still counts as taken.
    expect(card().querySelector('.abandon-panel')).toBeTruthy();
    expect(card().querySelector('.abandon-state')?.className).toContain('ok');
  });

  it('Cancel closes the panel without discarding the archive', async () => {
    await openPanel();
    q('.abandon-archive').click();
    await flush();
    expect(q('.abandon-toggle').textContent).toBe('Cancel');

    q('.abandon-toggle').click();
    await flush();
    expect(card().querySelector('.abandon-panel')).toBeNull();

    q('.abandon-toggle').click();
    await flush();
    expect(q('.abandon-confirm').disabled).toBe(false);
    expect(mockIo.exportAllData).toHaveBeenCalledTimes(1);
  });
});
