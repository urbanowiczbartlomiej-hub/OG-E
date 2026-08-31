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
// Preference-tile rendering + binding (the tiles replaced the old
// checkbox rows; each tile binds its Settings field via data-key and
// self-indicates with the `on` class + aria-pressed)
// ──────────────────────────────────────────────────────────────────

/**
 * @param {string} key
 * @returns {HTMLElement | null}
 */
const prefTile = (key) =>
  /** @type {HTMLElement | null} */ (
    document.querySelector(`.oge-pref-tile[data-key="${key}"]`)
  );

describe('installSettingsUi — preference tiles', () => {
  it('renders the tile lit (.on) when the underlying settings value is true', async () => {
    settingsStore.set({ ...settingsStore.get(), autoRedirectExpedition: true });
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const tile = prefTile('autoRedirectExpedition');
    expect(tile).not.toBeNull();
    expect(tile?.classList.contains('on')).toBe(true);
    expect(tile?.getAttribute('aria-pressed')).toBe('true');
  });

  it('click toggles the tile and writes the new boolean back to settingsStore', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const tile = prefTile('autoRedirectExpedition');
    expect(tile).not.toBeNull();

    // Default: true → click → false.
    expect(settingsStore.get().autoRedirectExpedition).toBe(true);
    tile?.click();
    expect(settingsStore.get().autoRedirectExpedition).toBe(false);
    expect(tile?.classList.contains('on')).toBe(false);
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
// Removed signpost sections + the Display section's fleet-status checkbox.
//
// The editable sync/alarmClock controls moved to the OG-E Dashboard long ago;
// the leftover static "it moved" notes were then dropped outright (the
// dashboard is self-describing — UX must explain itself, not via a paragraph
// in the AGR panel). The panel now renders ONLY the two live sections:
// the FAB command block and the preferences tile panel. The dashboard
// equivalents are tested separately under test/features/dashboard/.
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — removed signpost sections', () => {
  it('renders NO sync / alarm-clock signpost notes', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    expect(document.getElementById(INPUT_PREFIX + 'syncMovedNote')).toBeNull();
    expect(document.getElementById(INPUT_PREFIX + 'alarmClockMovedNote')).toBeNull();
  });

  it('renders the Expeditions FAB-module tile ABOVE the auto-redirect tile', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const show = /** @type {HTMLElement | null} */ (
      document.querySelector('.oge-module-tile[data-key="showExpeditionButton"]')
    );
    const redirect = prefTile('autoRedirectExpedition');
    expect(show).not.toBeNull();
    expect(redirect).not.toBeNull();
    // Placement is part of the spec: the FAB command block leads the tab.
    expect(!!(show && redirect
      && (show.compareDocumentPosition(redirect) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });

  it('renders the Display group\'s fleet-status-markers tile', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    expect(prefTile('expeditionBadges')).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-UI reactive sync
// ──────────────────────────────────────────────────────────────────

describe('installSettingsUi — reactive sync from store', () => {
  it('external settingsStore.update flips the pref tile to match', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    const tile = prefTile('autoRedirectExpedition');
    expect(tile?.classList.contains('on')).toBe(true);

    settingsStore.update((prev) => ({ ...prev, autoRedirectExpedition: false }));
    expect(tile?.classList.contains('on')).toBe(false);

    settingsStore.update((prev) => ({ ...prev, autoRedirectExpedition: true }));
    expect(tile?.classList.contains('on')).toBe(true);
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
    settingsStore.update((prev) => ({ ...prev, autoRedirectExpedition: true }));
    expect(document.getElementById(HEADER_ID)).toBeNull();
    expect(document.getElementById(INPUT_PREFIX + 'autoRedirectExpedition')).toBeNull();
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

// ──────────────────────────────────────────────────────────────────
// Planet-skip picker (expedition skip list)
// ──────────────────────────────────────────────────────────────────
//
// The picker is the one control in the panel bound to a STRING field, and the
// one that reads the GAME's DOM (`#planetList`) to build itself — so it needs
// a scene with both the AGR container and a planet list.

/**
 * Paint the AGR container next to a `#planetList` of `[cp, "g:s:p", name]`
 * rows, the two things the picker needs to exist.
 *
 * @param {Array<[number, string, string]>} rows
 */
const setupAGRWithPlanets = (rows) => {
  const items = rows
    .map(
      ([cp, coords, name]) => `
      <div id="planet-${cp}" class="smallplanet">
        <span class="planet-name">${name}</span>
        <span class="planet-koords">[${coords}]</span>
      </div>`,
    )
    .join('');
  document.body.innerHTML =
    `<div id="${AGR_ID}"></div><div id="planetList">${items}</div>`;
};

/** @returns {HTMLElement | null} */
const skipPicker = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector('.oge-pref-planets')
  );

/** @returns {HTMLElement[]} */
const skipChips = () =>
  /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.oge-planet-chip')]);

/** @returns {HTMLElement | null} */
const skipRow = () =>
  /** @type {HTMLElement | null} */ (document.querySelector('.oge-pref-row'));

const PLANETS = /** @type {Array<[number, string, string]>} */ ([
  [11, '1:234:5', 'Homeworld'],
  [22, '1:240:9', 'Mine'],
  [33, '1:301:4', 'Deut Farm'],
]);

describe('installSettingsUi — planet-skip picker', () => {
  it('builds one chip per body on the planet list, collapsed', async () => {
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    expect(skipChips().map((c) => c.dataset.coords)).toEqual([
      '1:234:5',
      '1:240:9',
      '1:301:4',
    ]);
    // Collapsed by default — a long planet list must not be something the
    // panel makes you scroll past on every visit.
    expect(skipPicker()?.hidden).toBe(true);
  });

  it('writes the tapped body into expSkipCoords, and untapping clears it', async () => {
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    const chip = skipChips()[2];
    chip.click();
    expect(settingsStore.get().expSkipCoords).toBe('1:301:4');
    expect(chip.classList.contains('skip')).toBe(true);

    chip.click();
    expect(settingsStore.get().expSkipCoords).toBe('');
    expect(chip.classList.contains('skip')).toBe(false);
  });

  it('lights the ROW while anything is excluded — emptying the list is the off switch', async () => {
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    expect(skipRow()?.classList.contains('active')).toBe(false);
    skipChips()[1].click();
    expect(skipRow()?.classList.contains('active')).toBe(true);
    skipChips()[1].click();
    expect(skipRow()?.classList.contains('active')).toBe(false);
  });

  it('keeps the row lit after the picker is folded away', async () => {
    // The regression this guards: the readout used to light while the picker
    // was OPEN, so collapsing it read as "the feature just turned off".
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    skipChips()[1].click();
    skipRow()?.click(); // open
    expect(skipPicker()?.hidden).toBe(false);
    skipRow()?.click(); // fold away again
    expect(skipPicker()?.hidden).toBe(true);
    expect(skipRow()?.classList.contains('active')).toBe(true);
    expect(settingsStore.get().expSkipCoords).toBe('1:240:9');
  });

  it('reads out names while the selection is small, a count beyond that', async () => {
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    const sum = () => document.querySelector('.oge-pref-sum')?.textContent;
    expect(sum()).toBe('None');
    skipChips()[1].click();
    expect(sum()).toBe('Mine');
    skipChips()[2].click();
    expect(sum()).toBe('Mine · Deut Farm');
    skipChips()[0].click();
    expect(sum()).toBe('3 planets');
  });

  it('ignores a stored body the player no longer owns', async () => {
    // A sold or abandoned planet leaves an entry that matches no row. It can
    // never affect a walk, so it must not inflate the readout either.
    settingsStore.set({ ...settingsStore.get(), expSkipCoords: '9:99:9' });
    setupAGRWithPlanets(PLANETS);
    installSettingsUi();
    await flushWaitFor();

    expect(document.querySelector('.oge-pref-sum')?.textContent).toBe('None');
    expect(skipRow()?.classList.contains('active')).toBe(false);
  });

  it('says so rather than rendering a blank box when there is no planet list', async () => {
    setupAGR();
    installSettingsUi();
    await flushWaitFor();

    expect(skipChips()).toHaveLength(0);
    expect(document.querySelector('.oge-pref-empty')).not.toBeNull();
  });
});
