// @vitest-environment happy-dom
//
// Unit tests for the abandon-overview overlay.
//
// # What we cover
//
// The module has three observable surfaces:
//
//   1. Precondition gating — overlay mounts iff
//      `location.search` includes `component=overview`, settings
//      `colonizeMode` is on, `checkAbandonState` returns truthy, AND
//      `#planet` exists.
//   2. DOM side effects on mount — overlay element created inside
//      `#planet`, content (title / coords / size / hint), and the
//      `pointer-events: none → auto` transition after 500 ms.
//   3. Lifecycle — click handoff to `abandonPlanet()`, settings-change
//      refresh, dispose cleanup, idempotent install.
//
// # Why we mock `abandon.js`
//
// `checkAbandonState` reads the DOM + settings, and `abandonPlanet`
// runs a multi-click flow. For this feature's tests we only need to
// confirm that the overlay correctly consults `checkAbandonState` and
// routes clicks to `abandonPlanet`. Driving the real `checkAbandonState`
// would couple our tests to `#diameterContentField` DOM shape (already
// covered by abandon.js's own tests). So we mock the module and feed
// it deterministic return values per test.
//
// # Location mocking
//
// `location.search` is assignable directly on happy-dom's Location, so
// we just set it per test (same pattern as sendExp / sendCol tests).
// No getter/setter override needed — only `location.href` requires
// that trick, and we don't navigate here.
//
// @ts-check

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';

// Mock `abandon.js` BEFORE importing the module under test so vi.mock
// hoisting catches the static import. `checkAbandonState` is a spy we
// can retune per test via `mockReturnValue`; `abandonPlanet` is a
// no-op async spy so click assertions can verify it was called.
vi.mock('../../src/features/abandon.js', () => ({
  checkAbandonState: vi.fn(() => null),
  abandonPlanet: vi.fn(async () => true),
}));

import {
  installAbandonOverview,
  _resetAbandonOverviewForTest,
} from '../../src/features/abandonOverview.js';
import {
  checkAbandonState,
  abandonPlanet,
} from '../../src/features/abandon.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';

// ── Scene helpers ────────────────────────────────────────────────────

/**
 * Reset the settings store to schema defaults, plus the overrides
 * relevant to this feature (`colonizeMode`, `colMinFields`). `colonizeMode`
 * defaults to `false` in the schema, so this helper flips it on by
 * default — every test that wants the overlay to render needs it.
 *
 * @param {Partial<import('../../src/state/settings.js').Settings>} [overrides]
 * @returns {void}
 */
const resetSettings = (overrides = {}) => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (
    Object.keys(SETTINGS_SCHEMA)
  )) {
    defaults[key] = SETTINGS_SCHEMA[key].default;
  }
  const merged = /** @type {import('../../src/state/settings.js').Settings} */ (
    /** @type {unknown} */ ({
      ...defaults,
      colonizeMode: true,
      colMinFields: 200,
      ...overrides,
    })
  );
  settingsStore.set(merged);
};

/**
 * Paint the overview DOM: `#planet` container + `#positionContentField`
 * for coords. Pairs with the `checkAbandonState` mock — this helper
 * just sets up the DOM the overlay reads FROM; `checkAbandonState`
 * mock decides whether abandon is warranted.
 *
 * @param {{ coords?: string }} [opts]
 * @returns {void}
 */
const setupOverviewScene = ({ coords = '[4:30:8]' } = {}) => {
  location.search = '?page=ingame&component=overview&cp=1';
  document.body.innerHTML = `
    <div id="planet" style="width:400px;height:300px"></div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

const getOverlay = () =>
  /** @type {HTMLElement | null} */ (
    document.getElementById('oge-abandon-overlay')
  );

beforeEach(() => {
  _resetAbandonOverviewForTest();
  document.body.innerHTML = '';
  resetSettings();
  location.search = '';
  vi.mocked(checkAbandonState).mockReset();
  vi.mocked(checkAbandonState).mockReturnValue(null);
  vi.mocked(abandonPlanet).mockReset();
  vi.mocked(abandonPlanet).mockResolvedValue(true);
});

afterEach(() => {
  _resetAbandonOverviewForTest();
  document.body.innerHTML = '';
  resetSettings();
  location.search = '';
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────
// Mount gating
// ──────────────────────────────────────────────────────────────────

describe('installAbandonOverview — mount gating', () => {
  it('renders overlay aligned to #planet bounds (body-level, position absolute)', () => {
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    // Body-level (not nested in #planet) — avoids mutating #planet's
    // layout / CSS which historically broke the game's jQuery UI dialog
    // init for the abandon popup.
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay?.style.position).toBe('absolute');
  });

  it('does not render overlay when not on overview page', () => {
    location.search = '?page=ingame&component=galaxy';
    document.body.innerHTML = `
      <div id="planet"></div>
      <div id="positionContentField"><a>[4:30:8]</a></div>
    `;
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();

    expect(getOverlay()).toBeNull();
  });

  it('does not render overlay when checkAbandonState returns null', () => {
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue(null);

    installAbandonOverview();

    expect(getOverlay()).toBeNull();
  });

  it('does not render overlay when #planet div is missing from DOM', () => {
    location.search = '?page=ingame&component=overview&cp=1';
    // Deliberately no `#planet` element.
    document.body.innerHTML = `
      <div id="positionContentField"><a>[4:30:8]</a></div>
    `;
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();

    expect(getOverlay()).toBeNull();
  });

  it('does not render overlay when colonizeMode is off', () => {
    resetSettings({ colonizeMode: false });
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();

    expect(getOverlay()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Overlay content
// ──────────────────────────────────────────────────────────────────

describe('installAbandonOverview — overlay content', () => {
  it('contains coords and max fields number', () => {
    setupOverviewScene({ coords: '[4:30:8]' });
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();

    const overlay = getOverlay();
    const text = overlay?.textContent ?? '';
    expect(text).toContain('ABANDON');
    expect(text).toContain('[4:30:8]');
    expect(text).toContain('145');
  });
});

// ──────────────────────────────────────────────────────────────────
// Click handoff
// ──────────────────────────────────────────────────────────────────

describe('installAbandonOverview — click handoff', () => {
  it('click on overlay calls abandonPlanet() when colPassword is set', () => {
    setupOverviewScene();
    // Password is required — without it the overlay shows a "set
    // password" hint and does not fire abandonPlanet. Mirror the real
    // user setup by setting it in settings first.
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });
    vi.mocked(abandonPlanet).mockResolvedValue(true);

    installAbandonOverview();
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    overlay?.click();

    expect(vi.mocked(abandonPlanet)).toHaveBeenCalledTimes(1);
  });

  it('click with colPassword EMPTY shows hint and skips abandonPlanet', () => {
    setupOverviewScene();
    // Default password is empty — simulate that.
    settingsStore.set({ ...settingsStore.get(), colPassword: '' });
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });
    vi.mocked(abandonPlanet).mockClear();

    installAbandonOverview();
    const overlay = getOverlay();
    overlay?.click();

    expect(vi.mocked(abandonPlanet)).not.toHaveBeenCalled();
    // Hint line updated with the actionable message.
    expect(overlay?.textContent).toContain('Set password');
  });
});

// ──────────────────────────────────────────────────────────────────
// Pointer-events transition (anti-misclick)
// ──────────────────────────────────────────────────────────────────

describe('installAbandonOverview — immediate click responsiveness', () => {
  it('overlay is clickable immediately on mount (no pointer-events gate)', () => {
    // Earlier design had a 500 ms pointer-events: none → auto gate, but
    // the MutationObserver on document.body re-mounted the overlay
    // faster than setTimeout could fire, leaving pointer-events stuck
    // at none. Removed — abandon flow has three safety gates downstream.
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    // Default (no inline pointer-events) means clicks go through immediately.
    expect(overlay?.style.pointerEvents).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose + idempotency
// ──────────────────────────────────────────────────────────────────

describe('installAbandonOverview — lifecycle', () => {
  it('dispose removes overlay and unsubscribes from settings', () => {
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    const dispose = installAbandonOverview();
    expect(getOverlay()).not.toBeNull();

    dispose();
    expect(getOverlay()).toBeNull();

    // After dispose, a settings change must NOT re-mount the overlay.
    settingsStore.set({ ...settingsStore.get(), colMinFields: 500 });
    expect(getOverlay()).toBeNull();
  });

  it('mount + dispose + re-install is idempotent (no double mount)', () => {
    setupOverviewScene();
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    const dispose1 = installAbandonOverview();
    expect(getOverlay()).not.toBeNull();
    dispose1();
    expect(getOverlay()).toBeNull();

    // Re-install — should mount again cleanly.
    const dispose2 = installAbandonOverview();
    expect(getOverlay()).not.toBeNull();

    // Calling install a second time (still installed) must return the
    // same dispose without duplicating the overlay.
    const disposeAgain = installAbandonOverview();
    expect(disposeAgain).toBe(dispose2);
    expect(document.querySelectorAll('#oge-abandon-overlay').length).toBe(1);

    dispose2();
  });

  it('settings change (colMinFields bump) triggers refresh and unmounts when no longer warranted', () => {
    setupOverviewScene();
    // Start with abandon warranted.
    vi.mocked(checkAbandonState).mockReturnValue({
      used: 0,
      max: 145,
      minFields: 200,
    });

    installAbandonOverview();
    expect(getOverlay()).not.toBeNull();

    // Simulate: user bumps colMinFields DOWN below max, so the colony
    // no longer qualifies as "too small". Our mock now returns null to
    // mirror what real `checkAbandonState` would do.
    vi.mocked(checkAbandonState).mockReturnValue(null);
    settingsStore.set({ ...settingsStore.get(), colMinFields: 50 });

    expect(getOverlay()).toBeNull();
  });
});
