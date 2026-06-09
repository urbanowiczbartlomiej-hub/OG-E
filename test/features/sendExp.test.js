// @vitest-environment happy-dom
//
// Unit tests for the floating Send Exp button.
//
// The module reads three things from the page:
//   - `settings.mobileMode` gates visibility,
//   - `settings.enterBtnSize` drives diameter + font scaling,
//   - `settings.maxExpPerPlanet` gates the click handler.
// ... and writes the button to `document.body`, plus JSON position to
// `oge_enterBtnPos` and focus marker to `oge_focusedBtn`.
//
// # Navigation testing strategy
//
// happy-dom routes `location.href = url` assignment to an asynchronous
// `browserFrame.goto(url)`. That is wrong for our click semantics —
// the click handler fires a sync assignment and returns, and we want
// to assert the URL it wrote without racing the frame navigator.
//
// We therefore override `location.href` with a spy-friendly
// getter/setter in `beforeEach` via `Object.defineProperty`. Tests
// read `navTarget` to assert which URL the handler picked. The
// override is scoped per-test and reverted in `afterEach`.
//
// # Drag testing is NOT covered
//
// Drag threshold / touch handling is exercised under manual QA.
// Tests here cover the observable outcome (saved position restored on
// install; default position when unset) instead of synthesising
// multi-step pointer sequences in jsdom.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installSendExp,
  _resetSendExpForTest,
  _resetFleetDispatcherSnapshotForSendExpTest,
} from '../../src/features/sendExp/index.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';

/**
 * Publish a fleetDispatcher snapshot into the module's event listener
 * AND assign to `window.fleetDispatcher` so the install-time bootstrap
 * reads it regardless of whether the test dispatches before or after
 * `installSendExp()`. Mirrors the helper in `sendCol.test.js`.
 *
 * @param {{
 *   expeditionCount: number,
 *   maxExpeditionCount: number,
 * }} snap
 */
const setFleetDispatcher = (snap) => {
  const full = {
    currentPlanet: { galaxy: 1, system: 2, position: 3 },
    targetPlanet: null,
    orders: null,
    shipsOnPlanet: [],
    ...snap,
  };
  /** @type {any} */ (window).fleetDispatcher = full;
  document.dispatchEvent(
    new CustomEvent('oge:fleetDispatcher', { detail: full }),
  );
};

// ── Location.href mocking ────────────────────────────────────────────

/**
 * Holds the most recent URL assigned to `location.href` via our spy.
 * Reset per-test in `beforeEach`.
 *
 * @type {string | null}
 */
let navTarget = null;

/**
 * Remembers the original `href` property descriptor so `afterEach` can
 * restore it and the next test case sees a vanilla happy-dom Location.
 *
 * @type {PropertyDescriptor | undefined}
 */
let originalHrefDescriptor;

/**
 * Install a spy-friendly `href` override on the current
 * `window.location`. The getter returns the last URL written so
 * production code that reads-after-write (rare, but possible in
 * principle) sees its own value back.
 *
 * @returns {void}
 */
const mockLocationHref = () => {
  // Walk up the prototype chain to find the `href` accessor — happy-dom
  // defines it on Location.prototype, not the instance.
  const proto = Object.getPrototypeOf(window.location);
  originalHrefDescriptor = Object.getOwnPropertyDescriptor(proto, 'href');
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get() {
      return navTarget ?? 'about:blank';
    },
    set(url) {
      navTarget = String(url);
    },
  });
};

/**
 * Undo `mockLocationHref` by deleting our instance-level override so
 * subsequent access resolves through the prototype again.
 *
 * @returns {void}
 */
const unmockLocationHref = () => {
  // Dropping the instance-level descriptor falls back to the prototype
  // getter/setter that happy-dom originally installed.
  delete (/** @type {any} */ (window.location)).href;
  // `originalHrefDescriptor` is retained for debuggability only; we do
  // not reinstall it because deleting the instance override is enough.
  void originalHrefDescriptor;
};

// ── Scene setup ──────────────────────────────────────────────────────

/**
 * Reset the settings store to schema defaults so cases start from a
 * known baseline.
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
 * Paint the DOM to look like the game, apply settings, and point
 * `location.search` at whichever scene we need.
 *
 * @param {{
 *   mobileMode?: boolean,
 *   enterBtnSize?: number,
 *   maxExpPerPlanet?: number,
 *   onFleetdispatch?: boolean,
 *   mission?: number | null,
 *   activeCp?: number | null,
 *   activeExpeditions?: number,
 * }} [opts]
 */
const setupScene = ({
  mobileMode = true,
  enterBtnSize = 560,
  maxExpPerPlanet = 1,
  onFleetdispatch = false,
  mission = null,
  activeCp = 12345,
  activeExpeditions = 0,
} = {}) => {
  settingsStore.set({
    ...settingsStore.get(),
    mobileMode,
    enterBtnSize,
    maxExpPerPlanet,
  });

  if (onFleetdispatch) {
    const query = mission !== null
      ? `?page=ingame&component=fleetdispatch&cp=${activeCp}&mission=${mission}`
      : `?page=ingame&component=fleetdispatch&cp=${activeCp}`;
    location.search = query;
  } else {
    location.search = `?page=ingame&component=overview&cp=${activeCp}`;
  }

  // Fixture coords are shared between the planet row and every
  // synthetic expedition row so `countActiveExpeditions` (which filters
  // by `.coordsOrigin` matching the active planet) counts them.
  const FIXTURE_COORDS = '1:1:8';

  const expRows = Array(activeExpeditions)
    .fill(0)
    .map(
      () => `
        <tr class="eventFleet" data-mission-type="15" data-return-flight="true">
          <td class="originFleet">X</td>
          <td class="coordsOrigin">[${FIXTURE_COORDS}]</td>
          <td class="detailsFleet"><span>1</span></td>
        </tr>
      `,
    )
    .join('');

  // Include `.planet-koords` so `getActivePlanetCoords` and
  // `findPlanetWithExpSlot` can read coords from the fixture —
  // without it both helpers short-circuit on missing coords.
  const planetRow = activeCp !== null
    ? `<div class="smallplanet hightlightPlanet" id="planet-${activeCp}">
         <a class="planetlink"><span class="planet-koords">[${FIXTURE_COORDS}]</span></a>
       </div>`
    : '';

  document.body.innerHTML = `
    <div id="planetList">${planetRow}</div>
    <div id="eventContent"><table><tbody>${expRows}</tbody></table></div>
  `;
};

const getBtn = () =>
  /** @type {HTMLButtonElement | null} */ (document.getElementById('oge-send-exp'));

/**
 * Read the button's label. Since the engraved title-ring SVG lives inside
 * the button, its label is painted into the shared Button's
 * `.oge-btn-label` span rather than the button's textContent (which now
 * also contains the ring title). Tests assert on the span.
 *
 * @param {HTMLElement | null} [btn]
 * @returns {string | null | undefined}
 */
const labelOf = (btn = getBtn()) =>
  btn?.querySelector('.oge-btn-label')?.textContent;

beforeEach(() => {
  _resetSendExpForTest();
  _resetFleetDispatcherSnapshotForSendExpTest();
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  delete (/** @type {any} */ (window)).fleetDispatcher;
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  _resetSendExpForTest();
  _resetFleetDispatcherSnapshotForSendExpTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  delete (/** @type {any} */ (window)).fleetDispatcher;
  unmockLocationHref();
  navTarget = null;
});

// ──────────────────────────────────────────────────────────────────
// Visibility gating via mobileMode
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — visibility via mobileMode', () => {
  it('does not render a button when mobileMode is off', () => {
    setupScene({ mobileMode: false });
    installSendExp();
    expect(getBtn()).toBeNull();
  });

  it('renders the button with the correct id + text when mobileMode is on', () => {
    setupScene({ mobileMode: true });
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();
    expect(labelOf(btn)).toBe('Send');
    expect(btn?.getAttribute('aria-label')).toBe('Send expedition');
    expect(btn?.tabIndex).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Size from settings
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — size from settings', () => {
  it('applies enterBtnSize to width and height', () => {
    setupScene({ enterBtnSize: 400 });
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();
    expect(btn?.style.width).toBe('400px');
    expect(btn?.style.height).toBe('400px');
    // font-size is ~23% of size, less 1px for single-zone → 92 - 1.
    expect(btn?.style.fontSize).toBe('91px');
  });
});

// ──────────────────────────────────────────────────────────────────
// Click handler — three scenarios
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — click navigation', () => {
  it('on overview → navigates to fleetdispatch (no mission param; AGR assigns it)', () => {
    setupScene({ onFleetdispatch: false, activeCp: 99 });
    installSendExp();
    getBtn()?.click();

    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).toContain('cp=99');
    // `mission` is NOT in the URL — AGR sets it when the user taps
    // its expedition routine on the fleetdispatch page.
    expect(navTarget).not.toContain('mission=');
  });

  // ── AGR routine flow (ago_routine_7) ───────────────────────────────────
  const settle = () => new Promise((r) => setTimeout(r, 600));

  /**
   * Mount AGR's `#ago_routine_7` element with the given readiness check
   * class. When `hydrateOnClick` is set, clicking the routine adds the
   * native dispatch button + AGR fleet panel (simulating AGR firing).
   *
   * @param {string} checkClass e.g. 'ago_routine_check_3' (ready).
   * @param {boolean} [hydrateOnClick]
   */
  const mountRoutine = (checkClass, hydrateOnClick = false) => {
    const routine = document.createElement('div');
    routine.id = 'ago_routine_7';
    routine.innerHTML = `<span class="ago_routine_check ${checkClass}"></span>`;
    if (hydrateOnClick) {
      routine.addEventListener('click', () => {
        if (!document.getElementById('ago_fleet2_main')) {
          const panel = document.createElement('div');
          panel.id = 'ago_fleet2_main';
          document.body.appendChild(panel);
          const d = document.createElement('button');
          d.id = 'dispatchFleet';
          document.body.appendChild(d);
        }
      });
    }
    document.body.appendChild(routine);
    return routine;
  };

  it('on fleetdispatch with no fleet panel and no routine yet → Phase 2 "Wait...", no nav', () => {
    setupScene({ onFleetdispatch: true, mission: 7, activeCp: 42 });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    const btn = getBtn();
    btn?.click();
    expect(navTarget).toBeNull();
    expect(labelOf(btn)).toBe('Wait...');
  });

  it('Phase 1: fleet panel + #dispatchFleet present → clicks dispatch, paints "Sent!"', () => {
    setupScene({ onFleetdispatch: true, mission: 15, activeCp: 42 });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    const panel = document.createElement('div');
    panel.id = 'ago_fleet2_main';
    document.body.appendChild(panel);
    const dispatch = document.createElement('button');
    dispatch.id = 'dispatchFleet';
    document.body.appendChild(dispatch);
    let clicks = 0;
    dispatch.addEventListener('click', () => { clicks += 1; });

    getBtn()?.click();

    expect(navTarget).toBeNull();
    expect(labelOf(getBtn())).toBe('Sent!');
    expect(clicks).toBe(1);
  });

  it('Phase 2: routine ready (check_3) → clicks it, panel hydrates, label flips to "Send!"', async () => {
    setupScene({ onFleetdispatch: true, mission: 15, activeCp: 42 });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    mountRoutine('ago_routine_check_3', /* hydrateOnClick */ true);
    const btn = getBtn();
    btn?.click();
    await settle();
    expect(navTarget).toBeNull();
    expect(labelOf(btn)).toBe('Send!');
  });

  it('Phase 2: routine reports no ships (check_1) and no other planet → "All maxed!", no nav', async () => {
    setupScene({ onFleetdispatch: true, mission: 15, activeCp: 42 });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    mountRoutine('ago_routine_check_1');
    const btn = getBtn();
    btn?.click();
    await settle();
    expect(navTarget).toBeNull();
    expect(labelOf(btn)).toBe('All maxed!');
  });
});

// ──────────────────────────────────────────────────────────────────
// Max-exp guard
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — max expedition guard', () => {
  it('paints "All maxed!" and does NOT navigate when every planet is at the limit', () => {
    // Single-planet fixture: that planet is maxed, no other planets
    // to fall back to → `findPlanetWithExpSlot` returns null, we
    // paint the transient "All maxed!" warning and stay put.
    vi.useFakeTimers();
    setupScene({ maxExpPerPlanet: 1, activeExpeditions: 1 });
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();

    btn?.click();

    expect(labelOf(btn)).toBe('All maxed!');
    expect(navTarget).toBeNull();

    // After 2s the label reverts.
    vi.advanceTimersByTime(2000);
    expect(labelOf(btn)).toBe('Send');

    vi.useRealTimers();
  });

  it('navigates normally when active expeditions are below the limit', () => {
    setupScene({
      maxExpPerPlanet: 2,
      activeExpeditions: 1,
      onFleetdispatch: false,
      activeCp: 7,
    });
    installSendExp();
    getBtn()?.click();

    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('cp=7');
    // No `mission` param — AGR assigns it after the user taps its
    // expedition routine on the fleetdispatch page.
    expect(navTarget).not.toContain('mission=');
  });
});

// ──────────────────────────────────────────────────────────────────
// Button position
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — position', () => {
  it('restores position from localStorage when oge_enterBtnPos is set', () => {
    // Need to set BEFORE install; setupScene only writes settings.
    localStorage.setItem('oge_enterBtnPos', JSON.stringify({ x: 50, y: 60 }));
    setupScene({});
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();
    expect(btn?.style.left).toBe('50px');
    expect(btn?.style.top).toBe('60px');
  });

  it('uses bottom-right default when no saved position is present', () => {
    setupScene({});
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();
    expect(btn?.style.right).toBe('20px');
    expect(btn?.style.bottom).toBe('20px');
    // No explicit left/top when using edge-anchor defaults.
    expect(btn?.style.left).toBe('');
    expect(btn?.style.top).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────
// Live settings updates
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — live settings updates', () => {
  it('removes the button when mobileMode is toggled off after install', () => {
    setupScene({ mobileMode: true });
    installSendExp();
    expect(getBtn()).not.toBeNull();

    settingsStore.update((s) => ({ ...s, mobileMode: false }));
    expect(getBtn()).toBeNull();
  });

  it('creates the button when mobileMode is toggled on after install', () => {
    setupScene({ mobileMode: false });
    installSendExp();
    expect(getBtn()).toBeNull();

    settingsStore.update((s) => ({ ...s, mobileMode: true }));
    expect(getBtn()).not.toBeNull();
  });

  it('resizes the button when enterBtnSize changes live', () => {
    setupScene({ enterBtnSize: 560 });
    installSendExp();
    const btn = getBtn();
    expect(btn?.style.width).toBe('560px');

    settingsStore.update((s) => ({ ...s, enterBtnSize: 300 }));
    expect(btn?.style.width).toBe('300px');
    expect(btn?.style.height).toBe('300px');
    // 300 * 0.23 = 69, less 1px for single-zone.
    expect(btn?.style.fontSize).toBe('68px');
  });
});

// ──────────────────────────────────────────────────────────────────
// Focus persistence
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — focus persistence', () => {
  it('restores focus to the button 50ms after install when focus marker is present', () => {
    vi.useFakeTimers();
    localStorage.setItem('oge_focusedBtn', 'send-exp');
    setupScene({});
    installSendExp();
    const btn = getBtn();
    expect(btn).not.toBeNull();
    // Focus restore is deferred to a 50ms setTimeout.
    expect(document.activeElement).not.toBe(btn);

    vi.advanceTimersByTime(60);

    expect(document.activeElement).toBe(btn);
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — dispose', () => {
  it('dispose removes the button and settings updates no longer resurrect it', () => {
    setupScene({ mobileMode: true });
    const dispose = installSendExp();
    expect(getBtn()).not.toBeNull();

    dispose();
    expect(getBtn()).toBeNull();

    // Flipping settings after dispose is a no-op (subscriber was
    // unsubscribed, and even if re-install were called we'd want the
    // button to come back ONLY via an explicit install).
    settingsStore.update((s) => ({ ...s, mobileMode: false }));
    settingsStore.update((s) => ({ ...s, mobileMode: true }));
    expect(getBtn()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Idempotency + edge cases
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — idempotency + edges', () => {
  it('second install returns the same dispose handle without duplicating the button', () => {
    setupScene({});
    const d1 = installSendExp();
    const d2 = installSendExp();
    expect(d2).toBe(d1);

    // Only one button in the DOM.
    expect(document.querySelectorAll('#oge-send-exp').length).toBe(1);
  });

  it('click is a safe no-op when there is no active planet', () => {
    setupScene({ activeCp: null });
    installSendExp();
    // getBtn works because mobileMode is on — but with no .hightlightPlanet
    // the click handler short-circuits and never navigates.
    getBtn()?.click();
    expect(navTarget).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// fleetDispatcher snapshot — global-cap short-circuits
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — fleetDispatcher snapshot gates', () => {
  it('snapshot at max (14/14) → "All maxed!" painted, no nav', () => {
    // Global expedition cap already reached per the game — we should
    // short-circuit the DOM walk entirely and paint the transient
    // warning instead of navigating anywhere. Scene is a non-fleet
    // page so without the snapshot the default flow would navigate.
    vi.useFakeTimers();
    setupScene({ onFleetdispatch: false, activeCp: 42, activeExpeditions: 0 });
    installSendExp();
    setFleetDispatcher({ expeditionCount: 14, maxExpeditionCount: 14 });

    const btn = getBtn();
    btn?.click();

    expect(labelOf(btn)).toBe('All maxed!');
    expect(navTarget).toBeNull();

    vi.advanceTimersByTime(2000);
    expect(labelOf(btn)).toBe('Send');
    vi.useRealTimers();
  });

  it('snapshot below cap (5/14) → normal navigation to next planet with slot', () => {
    // Snapshot reports plenty of headroom. Behaviour should be
    // identical to the no-snapshot case — navigate to the active
    // planet's fleetdispatch URL.
    setupScene({
      maxExpPerPlanet: 2,
      activeExpeditions: 0,
      onFleetdispatch: false,
      activeCp: 7,
    });
    installSendExp();
    setFleetDispatcher({ expeditionCount: 5, maxExpeditionCount: 14 });

    getBtn()?.click();

    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).toContain('cp=7');
  });

  it('snapshot at 13/14 on fleetdispatch + current planet maxed → skip auto-redirect, paint All maxed!', () => {
    // Post-send guard: the user is on fleetdispatch with the active
    // planet at its per-planet cap AND one send away from the global
    // 14/14 cap. Walking to another planet would waste a navigation
    // only for the next planet to also report full seconds later, so
    // we paint "All maxed!" and stay put.
    vi.useFakeTimers();
    setupScene({
      onFleetdispatch: true,
      mission: 15,
      activeCp: 42,
      maxExpPerPlanet: 1,
      activeExpeditions: 1,
    });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    setFleetDispatcher({ expeditionCount: 13, maxExpeditionCount: 14 });

    const btn = getBtn();
    btn?.click();

    expect(labelOf(btn)).toBe('All maxed!');
    expect(navTarget).toBeNull();

    vi.advanceTimersByTime(2000);
    expect(labelOf(btn)).toBe('Send');
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Eventbox-readiness gate (added 1.0.1)
// ──────────────────────────────────────────────────────────────────

describe('installSendExp — eventbox readiness gate', () => {
  it('on fleetdispatch, click before eventbox loads paints "Wait..." and bails (no nav, busy stays false)', () => {
    // Pre-1.0.1 a tap on fleetdispatch immediately after navigation
    // entered Phase 2 against a half-hydrated DOM and locked the button
    // for the full 15 s POLL_TIMEOUT_MS. The gate suppresses the Phase
    // 1/2 entry until OGame's eventbox refresh XHR has fired — dimming
    // but NOT setting busy, so the user can simply tap again once the page settles.
    vi.useFakeTimers();
    setupScene({ onFleetdispatch: true, mission: 15, activeCp: 42 });
    installSendExp();
    // Note: NO `oge:eventBoxLoaded` dispatched here — that's the whole
    // point of this case.

    const btn = getBtn();
    btn?.click();

    expect(labelOf(btn)).toBe('Wait...');
    expect(navTarget).toBeNull();

    // The cue clears after EVENTBOX_LOADING_LABEL_MS and restores the idle
    // label (the page is not on a routine/dispatch state → "Send").
    vi.advanceTimersByTime(800);
    expect(labelOf(btn)).toBe('Send');
    vi.useRealTimers();
  });

  it('off fleetdispatch the gate is a no-op (clicks navigate immediately)', () => {
    // The gate is fleetdispatch-only — pages that don't trigger an
    // eventbox refresh XHR shouldn't gate clicks against an event that
    // will never arrive.
    setupScene({ onFleetdispatch: false, activeCp: 11 });
    installSendExp();
    // Deliberately no event dispatched — overview page doesn't depend
    // on it.
    getBtn()?.click();
    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('cp=11');
  });

  it('after oge:eventBoxLoaded fires, clicks proceed normally', () => {
    // Same fleetdispatch scene; once the bridge event arrives the gate
    // opens permanently (until next page navigation re-installs). With no
    // fleet panel in the DOM the click enters Phase 2 (locks + "Wait...")
    // rather than being suppressed by the gate.
    setupScene({ onFleetdispatch: true, mission: 15, activeCp: 42 });
    installSendExp();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));

    const btn = getBtn();
    btn?.click();
    expect(navTarget).toBeNull();
    expect(labelOf(btn)).toBe('Wait...');
  });
});
