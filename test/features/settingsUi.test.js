// @vitest-environment happy-dom
//
// Unit tests for the settings UI feature.
//
// # Scene setup
//
// The module's only real dependency is a DOM container matching
// `.ago_menu_content`. We paint the container in `beforeEach` for the
// "AGR present" cases (the vast majority), and deliberately leave it
// absent for the "silent no-op on timeout" case so we can assert the
// 10-second fallback.
//
// # Fake timers
//
// `installSettingsUi` calls `waitFor` under the hood with a 200 ms poll
// and 10 s timeout. Under fake timers a `waitFor` that is already
// satisfied on the first sync check resolves on the next microtask
// (`await Promise.resolve()` flushes the chain). The no-AGR case needs
// `vi.advanceTimersByTimeAsync(10_001)` to push past the timeout. We
// toggle fake timers per-suite to stay explicit about which cases care
// about timing.
//
// # Settings reset strategy
//
// The `settingsStore` is a module-singleton that survives across tests.
// We reset it to schema defaults in `beforeEach` (same pattern as the
// sendExpedition / badges tests) so every case starts from a known baseline.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installSettingsUi,
  _resetSettingsUiForTest,
} from '../../src/features/settingsUi/index.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';
import { deriveNtfyTopic } from '../../src/sync/reminders.js';

/** AGR container id selector — mirrors the production constant. */
const AGR_ID = 'ago_menu_content';

/** Settings header id — mirrors the production constant. */
const HEADER_ID = 'oge-settings-header';

/** Settings table id — mirrors the production constant. */
const TABLE_ID = 'oge-settings-table';

/** Input id prefix — mirrors the production constant. */
const INPUT_PREFIX = 'oge-setting-';

/**
 * Paint a fresh `#ago_menu_content` container into `document.body` so
 * the AGR-wait resolves on its first poll. Idempotent — safe to call
 * even when the container is already present (the previous call's
 * node is replaced via innerHTML).
 *
 * @returns {void}
 */
const setupAGR = () => {
  document.body.innerHTML = `<div id="${AGR_ID}"></div>`;
};

/**
 * Reset the settings store to schema defaults. Mirrors the pattern
 * used by the sendExpedition / badges test suites.
 *
 * @returns {void}
 */
const resetSettingsToDefaults = () => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (
    Object.keys(SETTINGS_SCHEMA)
  )) {
    defaults[key] = SETTINGS_SCHEMA[key].default;
  }
  settingsStore.set(
    /** @type {import('../../src/state/settings.js').Settings} */ (
      /** @type {unknown} */ (defaults)
    ),
  );
};

/**
 * Resolve once the AGR wait has had a chance to fire. `waitFor` polls
 * at 200 ms intervals; even though its first check is synchronous, the
 * resolution callback runs on a microtask, so we need a timer advance
 * to flush it. Under fake timers, a 0 ms advance plus a microtask flush
 * is sufficient for the "AGR already present" case — the sync first
 * check inside `waitFor` will have returned truthy already, but the
 * `.then` chain still needs a tick to run.
 *
 * @returns {Promise<void>}
 */
const flushWaitFor = async () => {
  // Two microtask flushes: one for the `waitFor` sync-resolve path,
  // one for the install's own `.then(container => ...)` to run.
  await Promise.resolve();
  await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Global setup / teardown
// ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetSettingsUiForTest();
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
});

afterEach(() => {
  _resetSettingsUiForTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────
// AGR availability handling
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — AGR availability', () => {
  it('silently no-ops when AGR never appears (10s timeout)', async () => {
    vi.useFakeTimers();
    // No AGR container. Install and wait past the 10s timeout.
    installSettingsUi();
    // Push past AGR_TIMEOUT_MS=10_000.
    await vi.advanceTimersByTimeAsync(10_001);
    // Nothing injected.
    expect(document.getElementById(HEADER_ID)).toBeNull();
    expect(document.getElementById(TABLE_ID)).toBeNull();
  });

  it('inserts header into #ago_menu_content when AGR is present', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const header = document.getElementById(HEADER_ID);
    expect(header).not.toBeNull();
    // Header contains the two arrow glyphs + the label text; use
    // `toContain` rather than `toBe` so the check stays meaningful
    // regardless of where AGR positions the arrows.
    expect(header?.textContent).toContain('OG-E Settings');
    // The header sits inside the `.ago_menu_tab` wrapper, which sits
    // inside the AGR container. Two levels up from the header.
    expect(header?.parentElement?.className).toBe('ago_menu_tab');
    expect(header?.parentElement?.parentElement?.id).toBe(AGR_ID);
  });

  it('inserts the settings table when AGR is present', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const table = document.getElementById(TABLE_ID);
    expect(table).not.toBeNull();
    expect(table?.tagName).toBe('TABLE');
    // Table lives inside the `.ago_menu_tab` wrapper alongside the
    // header; two parents up is the AGR container.
    expect(table?.parentElement?.className).toBe('ago_menu_tab');
    expect(table?.parentElement?.parentElement?.id).toBe(AGR_ID);
  });

  it('renders when AGR appears AFTER install (install races AGR hydration)', async () => {
    vi.useFakeTimers();
    // No AGR yet at install time.
    installSettingsUi();

    // Let the first sync check run (no container → schedule a poll).
    await flushWaitFor();
    expect(document.getElementById(HEADER_ID)).toBeNull();

    // AGR appears a few hundred ms later.
    setupAGR();
    await vi.advanceTimersByTimeAsync(250);

    // Wait finishes, header gets injected.
    expect(document.getElementById(HEADER_ID)).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Checkbox rendering + binding
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — checkbox', () => {
  it('renders checked=true when underlying settings value is true', async () => {
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const cb = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabMode')
    );
    expect(cb).not.toBeNull();
    expect(cb?.type).toBe('checkbox');
    expect(cb?.checked).toBe(true);
  });

  it('change event writes the new boolean back to settingsStore', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const cb = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabMode')
    );
    expect(cb).not.toBeNull();

    // Default: true → uncheck → false.
    expect(settingsStore.get().fabMode).toBe(true);
    if (cb) {
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    }
    expect(settingsStore.get().fabMode).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// Range rendering + binding
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — range', () => {
  it('renders slider value + unit display from current settings', async () => {
    settingsStore.set({ ...settingsStore.get(), fabBtnSize: 400 });
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const slider = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabBtnSize')
    );
    expect(slider).not.toBeNull();
    expect(slider?.type).toBe('range');
    expect(slider?.value).toBe('400');
    // Display sits to the right of the slider inside its wrapper.
    const display = slider?.nextElementSibling;
    expect(display?.textContent).toBe('400px');
  });

  it('input event writes a Number back to settingsStore', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const slider = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabBtnSize')
    );
    expect(slider).not.toBeNull();
    if (slider) {
      slider.value = '200';
      slider.dispatchEvent(new Event('input'));
    }
    const next = settingsStore.get().fabBtnSize;
    expect(next).toBe(200);
    expect(typeof next).toBe('number');
  });
});

// ──────────────────────────────────────────────────────────────────
// Text / password rendering + binding
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — text + password', () => {
  // The 'text' / 'duration' string + numeric fields (reminderSchedule,
  // adhocOffsetSec, fsThreshold, colPositions) all moved out of the AGR panel
  // to the dashboard (B2/B3); only the password fields (gistToken,
  // reminderNtfyToken) remain. The dashboard editors validate their own
  // numeric/duration fields — see test/features/dashboard/{scanConfig,reminderConfig}.test.js.

  it('password field uses type="password"', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const input = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'gistToken')
    );
    expect(input).not.toBeNull();
    expect(input?.type).toBe('password');
  });
});

// ──────────────────────────────────────────────────────────────────
// Reminders section: asyncStatus (ntfy account). The free-form wave
// schedule (text) + ad-hoc lead time (duration) moved to the dashboard's
// Reminders tab (B3c) — see test/features/dashboard/reminderConfig.test.js.
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — asyncStatus (ntfy account)', () => {
  it('renders the account-status row read-only (the "Check now" button moved to the master row)', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const span = document.getElementById(INPUT_PREFIX + 'ntfyAccountStatus');
    expect(span).not.toBeNull();
    // The manual re-probe trigger now lives on the master row, not here.
    expect(document.getElementById(INPUT_PREFIX + 'ntfyAccountStatus-btn')).toBeNull();
  });

  it('the master row\'s "Check now" button dispatches oge:ntfyCheckNow', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    // Disabled while the section is off (default) — turn the master on so the
    // button is clickable. The store subscriber re-runs syncInputsFromState.
    settingsStore.update((s) => ({ ...s, remindersMasterEnabled: true }));

    /** @type {string[]} */
    const received = [];
    /** @type {EventListener} */
    const handler = (e) => {
      received.push(e.type);
    };
    document.addEventListener('oge:ntfyCheckNow', handler);

    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'remindersMasterEnabled-btn')
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Check now');
    expect(btn?.disabled).toBe(false);
    btn?.click();

    document.removeEventListener('oge:ntfyCheckNow', handler);
    expect(received).toContain('oge:ntfyCheckNow');
  });

  it('disables the master row\'s "Check now" button while the section is off', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    settingsStore.update((s) => ({ ...s, remindersMasterEnabled: false }));
    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'remindersMasterEnabled-btn')
    );
    expect(btn?.disabled).toBe(true);
  });

  it('renders the derived-topic row (read-only, no button) with the no-token hint', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const span = document.getElementById(INPUT_PREFIX + 'ntfyTopic');
    expect(span).not.toBeNull();
    // No manual button on this row — it's purely informational (read-only
    // derived topic). The text resolves asynchronously via the same
    // asyncStatus path the account row uses; its content is exercised by
    // the deriveNtfyTopic + formatter tests, so here we pin the structure.
    expect(document.getElementById(INPUT_PREFIX + 'ntfyTopic-btn')).toBeNull();
  });

  it('renders the topic masked, behind an eye toggle + a Copy button', async () => {
    // A token UNIQUE to this case: the asyncStatus `lastKey` cache is
    // module-scoped, so reusing another test's token would make that test's
    // in-DOM re-probe a no-op (the very bug the next test guards against).
    const token = 'tk_secrettopictest0000000000';
    settingsStore.update((s) => ({
      ...s, remindersMasterEnabled: true, reminderNtfyToken: token,
    }));
    const topic = await deriveNtfyTopic(token);

    setupAGR();
    installSettingsUi();

    const span = /** @type {HTMLElement} */ (document.getElementById(INPUT_PREFIX + 'ntfyTopic'));
    // Wait until the async derivation has painted the secret onto the row.
    // `vi.waitFor` THROWS on timeout, so a late SubtleCrypto resolution (under
    // machine load) fails loudly instead of falling through to assert against
    // a still-blank `dataset.full`.
    await vi.waitFor(() => {
      expect(span.dataset.full).toBe(topic);
    }, { timeout: 4000, interval: 20 });

    // Masked on screen, real value stashed for the buttons to act on.
    expect(span.dataset.full).toBe(topic);
    expect(span.textContent).toBe('oge-' + '•'.repeat(topic.length - 4));
    expect(span.textContent).not.toBe(topic);

    const eye = /** @type {HTMLElement} */ (document.getElementById(INPUT_PREFIX + 'ntfyTopic-eye'));
    const copy = /** @type {HTMLButtonElement} */ (document.getElementById(INPUT_PREFIX + 'ntfyTopic-copy'));
    expect(eye).not.toBeNull();
    expect(copy).not.toBeNull();

    // Eye reveals the full topic.
    eye.click();
    expect(span.textContent).toBe(topic);

    // Copy writes the REAL topic to the clipboard, not the masked text.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    copy.click();
    // The clipboard write settles a microtask after the click handler runs;
    // wait deterministically (throws on timeout) rather than polling silently.
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(topic);
    }, { timeout: 4000, interval: 20 });
  });

  it('paints the topic row on load, without waiting for a token change (regression)', async () => {
    // A returning user already has a token in the store. The derived topic
    // must show on first render — the bug left the asyncStatus rows blank
    // until the token changed, because the build-time probe (fired while the
    // row was still detached) recorded the refreshKey and made the later
    // in-DOM refresh a no-op.
    settingsStore.update((s) => ({
      ...s, remindersMasterEnabled: true, reminderNtfyToken: 'tk_' + 'a'.repeat(24),
    }));
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    const topic = document.getElementById(INPUT_PREFIX + 'ntfyTopic');
    const status = document.getElementById(INPUT_PREFIX + 'ntfyAccountStatus');
    // Painted (resolved text, "Checking…", or an error line) — never blank.
    // The rows fill via the async asyncStatus path, which can land a tick late
    // under load; `vi.waitFor` throws on timeout so a never-painted row fails
    // loudly instead of flaking on a fixed microtask budget.
    await vi.waitFor(() => {
      expect(topic?.textContent).toBeTruthy();
      expect(status?.textContent).toBeTruthy();
    }, { timeout: 4000, interval: 20 });
  });
});

// ──────────────────────────────────────────────────────────────────
// Checkbox inline action button (sync master row "Sync now") + click
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — checkbox inline button', () => {
  it('the "Sync now" button (inline on the cloudSync master row) dispatches oge:syncForce', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    // The button is disabled while cloudSync is off (default) — a disabled
    // button never fires click — so turn the master on first. The store
    // subscriber re-runs syncInputsFromState and un-disables it.
    settingsStore.update((s) => ({ ...s, cloudSync: true }));

    /** @type {string[]} */
    const received = [];
    /** @type {EventListener} */
    const handler = (e) => {
      received.push(e.type);
    };
    document.addEventListener('oge:syncForce', handler);

    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'cloudSync-btn')
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Sync now');
    expect(btn?.disabled).toBe(false);
    btn?.click();

    document.removeEventListener('oge:syncForce', handler);
    expect(received).toContain('oge:syncForce');
  });

  it('disables the "Sync now" button while cloudSync is off', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    settingsStore.update((s) => ({ ...s, cloudSync: false }));
    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'cloudSync-btn')
    );
    expect(btn?.disabled).toBe(true);
  });
});

// Per-group enable gating (each group's options lock when its own `enable`
// is off) used to be tested here, but BOTH reminder groups moved to the
// dashboard: the wave group (B3c) and the fleet-save group (B3b). The AGR
// panel now keeps only the reminders master switch + token + status rows.

// ──────────────────────────────────────────────────────────────────
// Static status rendering
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — static status', () => {
  it('renders formatSyncStatus output populated from localStorage timestamps', async () => {
    const iso = '2026-01-02T03:04:05.000Z';
    localStorage.setItem('oge_lastSyncAt', iso);
    localStorage.setItem('oge_lastDownAt', iso);
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const span = document.getElementById(INPUT_PREFIX + 'syncStatus');
    expect(span).not.toBeNull();
    // The string format includes both the up/down arrows. We don't
    // assert the exact locale rendering of the date because it depends
    // on the happy-dom locale, but we can assert the arrows + that
    // both "—" are replaced (i.e. some locale string is present).
    const text = span?.textContent ?? '';
    expect(text).toContain('↑');
    expect(text).toContain('↓');
    // Not em-dashes because we supplied both ISO values.
    expect(text).not.toContain('↑ —');
    expect(text).not.toContain('↓ —');
  });

  it('includes error line when oge_lastSyncErr is set', async () => {
    localStorage.setItem('oge_lastSyncErr', 'rate limited');
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const span = document.getElementById(INPUT_PREFIX + 'syncStatus');
    expect(span?.textContent).toContain('⚠ rate limited');
  });

  it('repaints the status row when oge:syncStatus fires (sync-layer push)', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    // Simulate the sync layer writing a fresh error + emitting the event.
    localStorage.setItem('oge_lastSyncErr', 'HTTP 401: Bad credentials');
    document.dispatchEvent(new CustomEvent('oge:syncStatus'));

    const span = document.getElementById(INPUT_PREFIX + 'syncStatus');
    expect(span?.textContent).toContain('⚠ HTTP 401: Bad credentials');
  });

  it('paints "Syncing…" immediately when the master "Sync now" is clicked', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();
    settingsStore.update((s) => ({ ...s, cloudSync: true }));

    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'cloudSync-btn')
    );
    btn?.click(); // no scheduler in this test → status stays at the optimistic paint
    const span = document.getElementById(INPUT_PREFIX + 'syncStatus');
    expect(span?.textContent).toBe('Syncing…');
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-UI reactive sync
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — reactive sync from store', () => {
  it('external settingsStore.update flips the checkbox to match', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const cb = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabMode')
    );
    expect(cb?.checked).toBe(true);

    settingsStore.update((prev) => ({ ...prev, fabMode: false }));
    expect(cb?.checked).toBe(false);

    settingsStore.update((prev) => ({ ...prev, fabMode: true }));
    expect(cb?.checked).toBe(true);
  });

  it('external settingsStore.update updates the range slider + display', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const slider = /** @type {HTMLInputElement | null} */ (
      document.getElementById(INPUT_PREFIX + 'fabBtnSize')
    );
    const display = slider?.nextElementSibling;
    settingsStore.update((prev) => ({ ...prev, fabBtnSize: 120 }));

    expect(slider?.value).toBe('120');
    expect(display?.textContent).toBe('120px');
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose + idempotency
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — dispose + idempotency', () => {
  it('dispose removes header and table from the document', async () => {
    setupAGR();
    const dispose = installSettingsUi();
    await flushWaitFor();

    expect(document.getElementById(HEADER_ID)).not.toBeNull();
    expect(document.getElementById(TABLE_ID)).not.toBeNull();

    dispose();

    expect(document.getElementById(HEADER_ID)).toBeNull();
    expect(document.getElementById(TABLE_ID)).toBeNull();
  });

  it('dispose unsubscribes — later settings change does not resurrect DOM mutations', async () => {
    setupAGR();
    const dispose = installSettingsUi();
    await flushWaitFor();

    dispose();

    // Grab a no-longer-in-DOM snapshot and bump settings. Nothing
    // should re-appear, and the nuked input element must not somehow
    // be auto-reinserted.
    settingsStore.update((prev) => ({ ...prev, fabMode: true }));
    expect(document.getElementById(HEADER_ID)).toBeNull();
    expect(document.getElementById(INPUT_PREFIX + 'fabMode')).toBeNull();
  });

  it('second install returns the same dispose without duplicating DOM', async () => {
    setupAGR();
    const d1 = installSettingsUi();
    const d2 = installSettingsUi();
    await flushWaitFor();

    expect(d2).toBe(d1);
    expect(document.querySelectorAll('#' + HEADER_ID).length).toBe(1);
    expect(document.querySelectorAll('#' + TABLE_ID).length).toBe(1);
  });

  it('dispose before AGR becomes available cleans up without error', async () => {
    vi.useFakeTimers();
    // No AGR yet.
    const dispose = installSettingsUi();
    // Dispose while waitFor is still pending.
    expect(() => dispose()).not.toThrow();

    // Now AGR appears — nothing should render, since install was cancelled.
    setupAGR();
    await vi.advanceTimersByTimeAsync(500);
    expect(document.getElementById(HEADER_ID)).toBeNull();
    expect(document.getElementById(TABLE_ID)).toBeNull();
  });
});
