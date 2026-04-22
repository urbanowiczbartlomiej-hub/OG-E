// @vitest-environment happy-dom
//
// Unit tests for the 3-click abandon feature.
//
// # What we cover
//
// The module splits into two layers:
//
//   1. Pure DOM helpers — `checkAbandonState` and the proxy-button /
//      dialog-expand helpers exercised through integration tests.
//      These are easy to test: seed the DOM, call, assert.
//
//   2. `abandonPlanet` — a 3-click async state machine. Fully exercising
//      it would require synthesising popup-close races, jQuery UI focus
//      semantics, and the game's hidden→shown #validate transition.
//      happy-dom can't replicate the game's jQuery UI behavior, so we
//      cover the observable pre-flight gates (state invalid, coords
//      mismatch, missing password, re-entry guard) and the DOM side-
//      effects of Click-1 work via a happy-path integration that uses
//      fake timers to drive `waitFor` polls.
//
// # Simplifications (documented)
//
//   - We do NOT assert the `location.reload()` call at the end of a
//     happy path. Driving the flow all the way through both user clicks
//     requires firing a synthetic click on a DOM node that appears mid-
//     flow; the click fires synchronously but the subsequent `waitFor`
//     polls are easier to cover with dedicated pre-flight tests.
//   - We do NOT assert `expandEnclosingDialog` via ui-dialog centering
//     math beyond the three unit tests below — the production path runs
//     inside a real jQuery-UI-wrapped dialog; we trust the unit-level
//     width/left assertions plus manual QA.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAbandonState,
  abandonPlanet,
  _resetAbandonForTest,
} from '../../src/features/abandon.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';
import { scansStore } from '../../src/state/scans.js';

// ── Scene helpers ────────────────────────────────────────────────────

/**
 * Reset {@link settingsStore} to the schema defaults so cases start
 * from a clean baseline. Same pattern as
 * `test/features/sendExp.test.js::resetSettingsToDefaults`.
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
 * Paint the overview page: the pieces `checkAbandonState` reads and
 * the coords anchor that `abandonPlanet` parses on entry. Leaves the
 * abandon-popup scaffolding (`.openPlanetRenameGiveupBox`, `#abandonplanet`,
 * etc.) to individual tests.
 *
 * @param {{
 *   isOverview?: boolean,
 *   usedFields?: number,
 *   maxFields?: number,
 *   coords?: string,
 * }} [opts]
 * @returns {void}
 */
const setupOverviewScene = ({
  isOverview = true,
  usedFields = 0,
  maxFields = 100,
  coords = '[4:30:8]',
} = {}) => {
  location.search = isOverview
    ? '?page=ingame&component=overview&cp=12345'
    : '?page=ingame&component=galaxy';
  document.body.innerHTML = `
    <div id="diameterContentField">12345km (${usedFields}/${maxFields})</div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

beforeEach(() => {
  resetSettingsToDefaults();
  scansStore.set({});
  document.body.innerHTML = '';
  location.search = '';
  _resetAbandonForTest();
});

afterEach(() => {
  _resetAbandonForTest();
  scansStore.set({});
  document.body.innerHTML = '';
  location.search = '';
});

// ──────────────────────────────────────────────────────────────────
// checkAbandonState
// ──────────────────────────────────────────────────────────────────

describe('checkAbandonState', () => {
  it('returns the parsed triple for a fresh small colony', () => {
    // Default `colMinFields` is 200; max=100 is below threshold.
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    const result = checkAbandonState();
    expect(result).toEqual({ used: 0, max: 100, minFields: 200 });
  });

  it('returns null when the page is not the overview', () => {
    setupOverviewScene({ isOverview: false });
    expect(checkAbandonState()).toBeNull();
  });

  it('returns null when max fields is at or above minFields', () => {
    // Boundary case — `max === minFields` is also "big enough".
    setupOverviewScene({ usedFields: 0, maxFields: 250 });
    expect(checkAbandonState()).toBeNull();
  });

  it('returns null when the planet is already built (usedFields > 0)', () => {
    // Any non-zero usedFields means the planet is not "fresh" and
    // therefore not a candidate for the abandon flow.
    setupOverviewScene({ usedFields: 5, maxFields: 100 });
    expect(checkAbandonState()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// makeInjectedButton — exercised via abandonPlanet injecting it
// ──────────────────────────────────────────────────────────────────

describe('makeInjectedButton (via abandonPlanet Click-1 work)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Paint every DOM node that abandonPlanet's Click-1 path needs so
   * we can reach the point where our SUBMIT PASSWORD proxy is
   * injected. The password input is deliberately left without a
   * value — the feature fills it.
   *
   * @returns {void}
   */
  const setupFullPopupScene = () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    const scaffold = document.createElement('div');
    scaffold.innerHTML = `
      <a class="openPlanetRenameGiveupBox" href="#"></a>
      <div id="abandonplanet">
        <span id="giveupCoordinates">[4:30:8]</span>
        <button id="block"></button>
        <div id="validate">
          <input type="password" />
          <input type="submit" />
        </div>
      </div>
    `;
    document.body.appendChild(scaffold);
  };

  it('injects an overlay-style SUBMIT PASSWORD button covering the popup content', async () => {
    // v4 4.9.3 UX: the button sits on top of the whole popup
    // content via `position: absolute; inset: 0`, so the user sees
    // only our big action button and not the native password
    // field / game-supplied text underneath.
    setupFullPopupScene();
    const promise = abandonPlanet();
    // Drive the two `waitFor` polls (giveupCoordinates is already
    // present, #validate is visible in happy-dom even without
    // jQuery show() — offsetParent is non-null for a div whose
    // only chain up is `body`).
    await vi.advanceTimersByTimeAsync(200);

    const injected = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('oge5-abandon-proxy-submit')
    );
    expect(injected).not.toBeNull();
    if (!injected) return; // narrow for TS — expect above already failed.
    expect(injected.textContent).toBe('SUBMIT PASSWORD');
    expect(injected.style.position).toBe('absolute');
    // `inset: 0` in cssText — happy-dom doesn't always expose the
    // shorthand via `style.inset`, so read the raw cssText instead.
    expect(injected.style.cssText).toContain('inset');
    // happy-dom preserves the input colour token; in a real browser
    // this normalises to `rgb(192, 112, 32)`. Match either form.
    expect(injected.style.background.toLowerCase()).toMatch(
      /#c07020|rgb\(192,\s*112,\s*32\)/,
    );
    // The host was prepared with `position:relative` + min-height so
    // the overlay has a concrete bounding box to anchor to.
    const host = document.getElementById('abandonplanet');
    expect(host?.style.position).toBe('relative');
    expect(host?.style.minHeight).toBe('200px');

    // Close the flow so the finally-block clears abandonInProgress.
    injected.remove();
    await vi.advanceTimersByTimeAsync(800);
    await promise;
  });
});

// ──────────────────────────────────────────────────────────────────
// The old `expandEnclosingDialog` helper is gone (v4 4.9.3 overlay
// pattern made it unnecessary — the overlay adapts to whatever size
// the native dialog already is). Three tests for it were removed
// with it.
// ──────────────────────────────────────────────────────────────────


// ──────────────────────────────────────────────────────────────────
// abandonPlanet — pre-flight safety gates (the easy-to-reach aborts)
// ──────────────────────────────────────────────────────────────────

describe('abandonPlanet — pre-flight gates', () => {
  it('returns false when checkAbandonState is not valid', async () => {
    // Not on overview → first gate rejects.
    setupOverviewScene({ isOverview: false });
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    const result = await abandonPlanet();
    expect(result).toBe(false);
  });

  it('returns false when no colPassword is configured', async () => {
    // All other gates satisfied; password is empty (schema default).
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    expect(settingsStore.get().colPassword).toBe('');
    const result = await abandonPlanet();
    expect(result).toBe(false);
  });

  it('returns false when the coords anchor is missing / malformed', async () => {
    // Fresh small colony DOM, password set, but coords anchor is
    // not a bracketed triple — Safety #2 rejects.
    setupOverviewScene({
      usedFields: 0,
      maxFields: 100,
      coords: 'not coords',
    });
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    const result = await abandonPlanet();
    expect(result).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// abandonPlanet — mid-flow aborts that need fake timers
// ──────────────────────────────────────────────────────────────────

describe('abandonPlanet — mid-flow aborts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts when #giveupCoordinates shows a different planet', async () => {
    // Overview shows [4:30:8], but our staged popup lies and says
    // [9:99:1] — Safety gate 2 rejects.
    setupOverviewScene({
      usedFields: 0,
      maxFields: 100,
      coords: '[4:30:8]',
    });
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    const scaffold = document.createElement('div');
    scaffold.innerHTML = `
      <a class="openPlanetRenameGiveupBox" href="#"></a>
      <div id="abandonplanet">
        <span id="giveupCoordinates">[9:99:1]</span>
      </div>
    `;
    document.body.appendChild(scaffold);

    const promise = abandonPlanet();
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe(false);
    // No Submit proxy injected — we bailed before the injection step.
    expect(document.getElementById('oge5-abandon-proxy-submit')).toBeNull();
  });

  it('blocks re-entry while a flow is in progress', async () => {
    // Start one flow at a state where it will hang waiting for the
    // user to click the proxy Submit; then call abandonPlanet again
    // and assert it short-circuits to false immediately.
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    settingsStore.set({ ...settingsStore.get(), colPassword: 'secret' });
    const scaffold = document.createElement('div');
    scaffold.innerHTML = `
      <a class="openPlanetRenameGiveupBox" href="#"></a>
      <div id="abandonplanet">
        <span id="giveupCoordinates">[4:30:8]</span>
        <button id="block"></button>
        <div id="validate">
          <input type="password" />
          <input type="submit" />
        </div>
      </div>
    `;
    document.body.appendChild(scaffold);

    const first = abandonPlanet();
    await vi.advanceTimersByTimeAsync(200);
    // Proxy Submit is injected → the first flow is parked in the
    // Click-2 waiter; now a second call must bounce.
    expect(document.getElementById('oge5-abandon-proxy-submit')).not.toBeNull();

    const second = await abandonPlanet();
    expect(second).toBe(false);

    // Close the first flow so the test doesn't leave a promise dangling.
    document.getElementById('oge5-abandon-proxy-submit')?.remove();
    await vi.advanceTimersByTimeAsync(800);
    await first;
  });
});
