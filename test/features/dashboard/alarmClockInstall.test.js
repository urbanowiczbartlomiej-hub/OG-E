// @vitest-environment happy-dom
//
// Install-idempotency + test-reset coverage for the dashboard alarmClock tab.
// The tab wires its DOM exactly once (a module-level `wired` guard). Before
// `_resetAlarmClockForTest` existed, that guard never reset, so a SECOND
// install in a fresh test was a silent no-op (the new DOM stayed unwired).
// These tests pin both halves: install is idempotent while wired, and the
// test-reset re-opens the gate so a clean re-install re-wires.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// alarmClock.js (and its transitive state imports) only touch chrome.storage at
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
    // Real chromeStore.onChanged returns an idempotent unsubscribe (see
    // lib/storage.js); installAlarmClock now stores it and _resetAlarmClockForTest
    // calls it (REVIEW.md 7.6), so the mock must hand back a function too.
    onChanged: vi.fn(() => () => {}),
  },
}));

import {
  installAlarmClock,
  _resetAlarmClockForTest,
} from '../../../src/features/dashboard/alarmClock.js';
import { chromeStore } from '../../../src/lib/storage.js';
import { deriveNtfyTopic, ALARM_CLOCK_NTFY_TOKEN_KEY } from '../../../src/sync/alarmClock.js';

const HTML = `
  <span id="remTopic">—</span>
  <button id="remRevealTopic"></button>
  <button id="remCopyTopic"></button>
  <div id="remPreview"></div>
  <span id="remPreviewStatus"></span>
  <button id="remRefresh"></button>
`;

beforeEach(() => {
  _resetAlarmClockForTest();
  document.body.innerHTML = HTML;
});

/**
 * Spin the event loop until `cond()` holds, FAILING LOUDLY on timeout.
 *
 * The old hand-rolled poller returned silently after a fixed 30 macrotask
 * ticks. The alarmClock topic is painted asynchronously (`deriveNtfyTopic`
 * runs a SubtleCrypto digest); under machine load that paint can land after
 * 30 ticks, so the poller gave up, the assertion ran against a stale/blank
 * slot, and a clicked Copy early-returned on the still-empty `currentTopic` —
 * a flaky false-pass. Delegating to vitest's built-in `vi.waitFor` keeps a
 * generous, descriptive budget and THROWS on timeout instead of returning.
 *
 * @param {() => boolean} cond
 * @param {string} [label] Human-readable description for the timeout error.
 * @returns {Promise<void>}
 */
const waitFor = (cond, label = 'condition') =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error(`waitFor timed out: ${label}`);
    },
    { timeout: 4000, interval: 20 },
  );

describe('installAlarmClock — idempotency + test-reset', () => {
  it('wires the copy-topic listener once, skips a second install, re-wires after reset', () => {
    const copyBtn = /** @type {HTMLElement} */ (document.getElementById('remCopyTopic'));
    const spy = vi.spyOn(copyBtn, 'addEventListener');

    installAlarmClock();
    expect(spy).toHaveBeenCalledTimes(1);

    // Already wired → second install short-circuits (no duplicate listener).
    installAlarmClock();
    expect(spy).toHaveBeenCalledTimes(1);

    // The test-reset re-opens the `wired` gate so a fresh install re-wires
    // (the silent-no-op this reset exists to prevent).
    _resetAlarmClockForTest();
    installAlarmClock();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns a refresh handle on every call (wired or not)', () => {
    const first = installAlarmClock();
    const second = installAlarmClock();
    expect(typeof first.refresh).toBe('function');
    expect(typeof second.refresh).toBe('function');
  });
});

describe('alarmClock topic — mask / reveal / copy', () => {
  const TOKEN = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';
  /** @type {any} */
  let writeText;

  beforeEach(() => {
    // Only the ntfy-token key resolves to a value; everything else stays
    // undefined so refreshPreview short-circuits before any network fetch.
    /** @type {import('vitest').Mock} */ (chromeStore.get).mockImplementation(
      /** @param {string} key */ (key) =>
        Promise.resolve(key === ALARM_CLOCK_NTFY_TOKEN_KEY ? TOKEN : undefined));
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });
  });

  it('shows the topic masked, and the eye toggle reveals the real value', async () => {
    const topic = await deriveNtfyTopic(TOKEN);
    installAlarmClock();
    const slot = /** @type {HTMLElement} */ (document.getElementById('remTopic'));
    await waitFor(() => (slot.textContent || '').includes('•'), 'topic painted (masked)');

    // Masked by default: oge- label kept, secret hidden, no raw hex on screen.
    expect(slot.textContent).toBe('oge-' + '•'.repeat(topic.length - 4));
    expect(slot.textContent).not.toBe(topic);

    // Eye reveals the full topic, and toggles back.
    document.getElementById('remRevealTopic')?.click();
    expect(slot.textContent).toBe(topic);
    document.getElementById('remRevealTopic')?.click();
    expect(slot.textContent).toContain('•');
  });

  it('Copy copies the real topic even while masked, and repeat clicks never corrupt the slot', async () => {
    const topic = await deriveNtfyTopic(TOKEN);
    installAlarmClock();
    const slot = /** @type {HTMLElement} */ (document.getElementById('remTopic'));
    const copyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('remCopyTopic'));
    // Gate on the async topic paint BEFORE clicking — `currentTopic` is what
    // the copy handler reads, and a click before it's set silently no-ops.
    await waitFor(() => (slot.textContent || '').includes('•'), 'topic painted (masked)');

    // First click (while masked): the REAL topic reaches the clipboard, the
    // feedback lands on the button — never on the secret slot. Wait on the
    // button text (it settles a microtask after writeText resolves).
    copyBtn.click();
    await waitFor(() => copyBtn.textContent === 'Copied!', "copy button shows 'Copied!'");
    expect(writeText).toHaveBeenLastCalledWith(topic);
    expect(slot.textContent).toContain('•'); // slot untouched (this was the bug)

    // Rapid second click: copies the real topic again, slot still intact — the
    // old code re-copied the "copied!" label and stuck the slot on it.
    copyBtn.click();
    await waitFor(() => writeText.mock.calls.length === 2, 'second clipboard write');
    expect(writeText).toHaveBeenLastCalledWith(topic);
    expect(slot.textContent).toContain('•');
    expect(slot.textContent).not.toContain('Copied');
    expect(slot.textContent).not.toContain('copied');
  });
});
