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

import { chromeStore } from '../../../src/lib/storage.js';
import { installSync } from '../../../src/features/dashboard/sync.js';
import { formatBytes } from '../../../src/features/dashboard/syncInventory.js';

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
    await flush();

    expect($('.sync-empty')).toBeNull();
    expect($('.sync-universe').textContent).toBe('s1-en');
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
