// @vitest-environment happy-dom
//
// Install-idempotency + test-reset coverage for the dashboard reminders tab.
// The tab wires its DOM exactly once (a module-level `wired` guard). Before
// `_resetRemindersForTest` existed, that guard never reset, so a SECOND
// install in a fresh test was a silent no-op (the new DOM stayed unwired).
// These tests pin both halves: install is idempotent while wired, and the
// test-reset re-opens the gate so a clean re-install re-wires.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// reminders.js (and its transitive state imports) only touch chrome.storage at
// runtime; stub it so install doesn't reach real storage. `get` resolves so
// the fire-and-forget `updateTopic`/`refreshPreview` awaits settle cleanly.
vi.mock('../../../src/lib/storage.js', () => ({
  safeLS: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    bool: vi.fn((_k, d = false) => d),
    int: vi.fn((_k, d = 0) => d),
    json: vi.fn((_k, d = null) => d),
    setJSON: vi.fn(),
  },
  chromeStore: {
    get: vi.fn(() => Promise.resolve(undefined)),
    set: vi.fn(),
    remove: vi.fn(),
    onChanged: vi.fn(),
  },
}));

import {
  installReminders,
  _resetRemindersForTest,
} from '../../../src/features/dashboard/reminders.js';

const HTML = `
  <span id="remTopic">—</span>
  <button id="remCopyTopic"></button>
  <div id="remPreview"></div>
  <span id="remPreviewStatus"></span>
  <button id="remRefresh"></button>
`;

beforeEach(() => {
  _resetRemindersForTest();
  document.body.innerHTML = HTML;
});

describe('installReminders — idempotency + test-reset', () => {
  it('wires the copy-topic listener once, skips a second install, re-wires after reset', () => {
    const copyBtn = /** @type {HTMLElement} */ (document.getElementById('remCopyTopic'));
    const spy = vi.spyOn(copyBtn, 'addEventListener');

    installReminders();
    expect(spy).toHaveBeenCalledTimes(1);

    // Already wired → second install short-circuits (no duplicate listener).
    installReminders();
    expect(spy).toHaveBeenCalledTimes(1);

    // The test-reset re-opens the `wired` gate so a fresh install re-wires
    // (the silent-no-op this reset exists to prevent).
    _resetRemindersForTest();
    installReminders();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns a refresh handle on every call (wired or not)', () => {
    const first = installReminders();
    const second = installReminders();
    expect(typeof first.refresh).toBe('function');
    expect(typeof second.refresh).toBe('function');
  });
});
