// @vitest-environment happy-dom
//
// Unit tests for the split-half colonize button.
//
// # What we cover
//
// The module layers into three testable surfaces:
//
//   1. Pure algorithms — `findNextScanSystem`, `findNextColonizeTarget`,
//      and `getColonizeWaitTime`. Easy wins: seed inputs, assert
//      outputs. No DOM required for the first two; `getColonizeWaitTime`
//      reads `#durationOneWay` + `registryStore` so it gets a thin DOM.
//
//   2. Observable button state — `installSendCol` + label reactions to
//      clicks / events. We assert the DOM text + background, not
//      internal state — so even tests that overlap on behaviour stay
//      decoupled from the implementation.
//
//   3. Event reactors — `oge5:galaxyScanned` and `oge5:checkTargetResult`.
//      We dispatch `CustomEvent` on `document` and check label /
//      `scansStore` / `uiState` after.
//
// # What we do NOT cover
//
// - Drag threshold + touch handling (same trade-off as sendExp — 4.x
//   parity is eyeballed via QA).
// - Focus-persistence under real jQuery-UI dialog shuffling.
// - End-to-end stale flow beyond asserting the form swap + store
//   updates; driving the game's checkTarget XHR is outside scope.
//
// # Navigation testing
//
// Same pattern as sendExp.test.js: override `location.href` with a
// spy-friendly accessor so we can assert which URL the handler wrote
// without racing happy-dom's frame navigator.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installSendCol,
  _resetSendColForTest,
  findNextScanSystem,
  findNextColonizeTarget,
} from '../../src/features/sendCol.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';
import { scansStore } from '../../src/state/scans.js';
import { registryStore } from '../../src/state/registry.js';
import { uiState } from '../../src/state/uiState.js';

// ── Location.href mocking ────────────────────────────────────────────

/** @type {string | null} */
let navTarget = null;

/** @type {PropertyDescriptor | undefined} */
let originalHrefDescriptor;

const mockLocationHref = () => {
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

const unmockLocationHref = () => {
  delete (/** @type {any} */ (window.location)).href;
  void originalHrefDescriptor;
};

// ── Scene helpers ────────────────────────────────────────────────────

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

const resetUiState = () => {
  uiState.set({
    pendingColLink: null,
    pendingColVerify: null,
    staleRetryActive: false,
    staleTargetCoords: null,
  });
};

/**
 * Paint a planet-list row so `readHomePlanet` resolves.
 *
 * @param {{
 *   coords?: string,
 *   onGalaxy?: boolean,
 *   galaxyG?: number,
 *   galaxyS?: number,
 *   onFleetdispatch?: boolean,
 *   mission?: number | null,
 *   isOverview?: boolean,
 *   usedFields?: number,
 *   maxFields?: number,
 * }} [opts]
 */
const setupScene = ({
  coords = '[4:30:8]',
  onGalaxy = false,
  galaxyG = 4,
  galaxyS = 30,
  onFleetdispatch = false,
  mission = null,
  isOverview = false,
  usedFields = 0,
  maxFields = 200,
} = {}) => {
  if (onFleetdispatch) {
    location.search =
      mission !== null
        ? `?page=ingame&component=fleetdispatch&mission=${mission}`
        : '?page=ingame&component=fleetdispatch';
  } else if (onGalaxy) {
    location.search = `?page=ingame&component=galaxy&galaxy=${galaxyG}&system=${galaxyS}`;
  } else if (isOverview) {
    location.search = '?page=ingame&component=overview&cp=1';
  } else {
    location.search = '?page=ingame&component=overview&cp=1';
  }

  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet hightlightPlanet" id="planet-1">
        <span class="planet-koords">${coords}</span>
      </div>
    </div>
    <div id="diameterContentField">12345km (${usedFields}/${maxFields})</div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

const getWrap = () =>
  /** @type {HTMLElement | null} */ (document.getElementById('oge5-send-col'));
const getSend = () =>
  /** @type {HTMLButtonElement | null} */ (
    document.getElementById('oge5-col-send')
  );
const getScan = () =>
  /** @type {HTMLButtonElement | null} */ (
    document.getElementById('oge5-col-scan')
  );

beforeEach(() => {
  _resetSendColForTest();
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  resetUiState();
  scansStore.set({});
  registryStore.set([]);
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  _resetSendColForTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  resetUiState();
  scansStore.set({});
  registryStore.set([]);
  unmockLocationHref();
  navTarget = null;
  location.search = '';
});

// ──────────────────────────────────────────────────────────────────
// findNextScanSystem — pure
// ──────────────────────────────────────────────────────────────────

describe('findNextScanSystem', () => {
  const home = { galaxy: 4, system: 30 };

  it('returns home+1 when scans is empty and no currentView', () => {
    expect(findNextScanSystem({}, home, null)).toEqual({
      galaxy: 4,
      system: 31,
    });
  });

  it('continues past currentView when on galaxy view', () => {
    expect(findNextScanSystem({}, home, { galaxy: 4, system: 100 })).toEqual({
      galaxy: 4,
      system: 101,
    });
  });

  it('skips a fresh scan at home+1 and returns home+2', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:31': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    expect(findNextScanSystem(scans, home, null)).toEqual({
      galaxy: 4,
      system: 32,
    });
  });

  it('returns a stale scan position (does not skip it)', () => {
    // `abandoned` uses a dynamic "first 3 AM after scannedAt + 24h"
    // deadline (4.9.6). 72h ago is past any day's 3 AM regardless of
    // the current wall-clock, so it's always stale.
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:31': {
        scannedAt: Date.now() - 72 * 3600_000,
        positions: { 8: { status: 'abandoned' } },
      },
    };
    expect(findNextScanSystem(scans, home, null)).toEqual({
      galaxy: 4,
      system: 31,
    });
  });

  it('wraps within the same galaxy when starting near the top', () => {
    // currentView at system 499 → next is system 1 (via modular wrap).
    expect(findNextScanSystem({}, home, { galaxy: 4, system: 499 })).toEqual({
      galaxy: 4,
      system: 1,
    });
  });

  it('advances to the next galaxy when the home galaxy is all fresh', () => {
    // Mark every system in galaxy 4 fresh, with a stable `empty`
    // status (no rescan threshold → never stale).
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {};
    for (let s = 1; s <= 499; s++) {
      scans[/** @type {`${number}:${number}`} */ (`4:${s}`)] = {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      };
    }
    const next = findNextScanSystem(scans, home, null);
    // Next galaxy in `buildGalaxyOrder(4)` is 5.
    expect(next).toEqual({ galaxy: 5, system: 1 });
  });

  it('returns null when every galaxy is fresh', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {};
    for (let g = 1; g <= 7; g++) {
      for (let s = 1; s <= 499; s++) {
        scans[/** @type {`${number}:${number}`} */ (`${g}:${s}`)] = {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        };
      }
    }
    expect(findNextScanSystem(scans, home, null)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// findNextColonizeTarget — pure
// ──────────────────────────────────────────────────────────────────

describe('findNextColonizeTarget', () => {
  const home = { galaxy: 4, system: 30 };

  beforeEach(() => {
    // This helper builds URLs off `location.href`, so keep the search
    // minimal — tests that only care about coords don't need it.
    location.search = '';
  });

  it('returns null when targets is empty', () => {
    expect(findNextColonizeTarget({}, [], home, [], false)).toBeNull();
  });

  it('returns null when scans is empty', () => {
    expect(findNextColonizeTarget({}, [], home, [8], false)).toBeNull();
  });

  it('returns a match for an empty slot at a target position', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], false);
    expect(t).not.toBeNull();
    expect(t?.galaxy).toBe(4);
    expect(t?.system).toBe(30);
    expect(t?.position).toBe(8);
    expect(t?.link).toContain('galaxy=4');
    expect(t?.link).toContain('system=30');
    expect(t?.link).toContain('position=8');
    expect(t?.link).toContain('mission=7');
  });

  it('skips positions not in the user targets list', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 9: { status: 'empty' } },
      },
    };
    expect(findNextColonizeTarget(scans, [], home, [8], false)).toBeNull();
  });

  it('skips empty_sent (we dispatched already)', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty_sent' } },
      },
    };
    expect(findNextColonizeTarget(scans, [], home, [8], false)).toBeNull();
  });

  it('skips a slot with a pending in-flight fleet in the registry', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      {
        coords: '4:30:8',
        sentAt: Date.now(),
        arrivalAt: Date.now() + 10 * 60_000,
      },
    ];
    expect(findNextColonizeTarget(scans, registry, home, [8], false)).toBeNull();
  });

  it('with preferOther=true, skips home galaxy first and finds in galaxy 5', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      // Both home and a non-home galaxy have empties at position 8.
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
      '5:1': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], true);
    // buildGalaxyOrder(4) = [4, 5, 3, 6, 2, 7, 1].
    // preferOther rotates home to the end → [5, 3, 6, 2, 7, 1, 4].
    // First match → galaxy 5.
    expect(t?.galaxy).toBe(5);
    expect(t?.system).toBe(1);
  });

  it('home galaxy systems are searched farthest-first', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      // Two empties in the home galaxy — one next door (31), one far (250).
      '4:31': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
      '4:250': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], false);
    // sysDist(250, 30) = 220 > sysDist(31, 30) = 1 → farthest wins.
    expect(t?.system).toBe(250);
  });
});

// ──────────────────────────────────────────────────────────────────
// getColonizeWaitTime — observable via install → fleet click
// ──────────────────────────────────────────────────────────────────

describe('dispatchColonizeWithGapCheck (via sendHalf click)', () => {
  /**
   * @param {string} durationText  like "0:01:00" (1 min) or "1:0:0:0" (1 day)
   */
  const installFleetScene = (durationText = '0:01:00') => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({
      ...settingsStore.get(),
      colonizeMode: true,
    });
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = durationText;
    document.body.appendChild(dur);
    installSendCol();
  };

  it('paints Dispatch! / no wait when #durationOneWay is missing', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    // No #durationOneWay present — getColonizeWaitTime = 0.
    const seen = /** @type {string[]} */ ([]);
    /** @type {EventListener} */
    const listener = (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);
    getSend()?.click();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    // Synthesized Enter — sendFleet path fired.
    expect(seen).toContain('keydown');
    expect(seen).toContain('keyup');
  });

  it('no conflict → synthesizes Enter immediately (empty registry)', () => {
    installFleetScene();
    const seen = /** @type {string[]} */ ([]);
    /** @type {EventListener} */
    const listener = (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);
    getSend()?.click();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    expect(seen).toContain('keydown');
    expect(seen).toContain('keyup');
  });

  it('conflict within minGap → paints Wait Xs and does not Enter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // Duration 1 min (60s) → ourArrival = now + 60_000.
    installFleetScene('0:01:00');
    // minGap default = 20s → a registered entry at ourArrival + 10s
    // (gap 10_000 < 20_000) is a conflict.
    const now = Date.now();
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 10_000,
      },
    ]);
    const seen = /** @type {string[]} */ ([]);
    /** @type {EventListener} */
    const listener = (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);
    getSend()?.click();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    expect(seen).toEqual([]);
    expect(getSend()?.textContent ?? '').toMatch(/^Wait \d+s$/);
    vi.useRealTimers();
  });

  it('conflict exactly at the min-gap boundary → NOT a conflict', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    installFleetScene('0:01:00');
    const now = Date.now();
    // gap = minGap exactly (20s) → strict '<' → no conflict → Enter fires.
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 20_000,
      },
    ]);
    const seen = /** @type {string[]} */ ([]);
    /** @type {EventListener} */
    const listener = (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);
    getSend()?.click();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    expect(seen).toContain('keydown');
    vi.useRealTimers();
  });

  it('accepts a 4-part duration string (d:h:m:s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // 1 day = 86400s = 86_400_000 ms.
    installFleetScene('1:0:0:0');
    // An arriving fleet 5s after ours — within 20s minGap → conflict.
    const now = Date.now();
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 86_400_000 + 5_000,
      },
    ]);
    getSend()?.click();
    expect(getSend()?.textContent ?? '').toMatch(/^Wait \d+s$/);
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Button lifecycle
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — button lifecycle', () => {
  it('does not render when colonizeMode is off', () => {
    setupScene();
    // default colonizeMode = false
    installSendCol();
    expect(getWrap()).toBeNull();
  });

  it('renders both halves when colonizeMode is on', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    expect(getWrap()).not.toBeNull();
    expect(getSend()).not.toBeNull();
    expect(getScan()).not.toBeNull();
    expect(getSend()?.textContent).toBe('Send');
    expect(getScan()?.textContent).toBe('Scan');
  });

  it('applies colBtnSize from settings', () => {
    setupScene();
    settingsStore.set({
      ...settingsStore.get(),
      colonizeMode: true,
      colBtnSize: 400,
    });
    installSendCol();
    expect(getWrap()?.style.width).toBe('400px');
    expect(getWrap()?.style.height).toBe('400px');
  });

  it('dispose removes the button', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    const dispose = installSendCol();
    expect(getWrap()).not.toBeNull();
    dispose();
    expect(getWrap()).toBeNull();
  });

  it('is idempotent — second install returns the same dispose', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    const d1 = installSendCol();
    const d2 = installSendCol();
    expect(d2).toBe(d1);
    expect(document.querySelectorAll('#oge5-send-col').length).toBe(1);
  });

  it('on fleetdispatch?mission=7 initial label is Dispatch! / Skip', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    expect(getSend()?.textContent).toBe('Dispatch!');
    expect(getScan()?.textContent).toBe('Skip');
  });
});

// ──────────────────────────────────────────────────────────────────
// Click dispatches
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — click dispatches', () => {
  it('sendHalf click with empty DB shows "None available" and redirects to galaxy view', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    getSend()?.click();
    expect(getSend()?.textContent).toBe('None available');
    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('component=galaxy');
  });

  it('sendHalf click with an available target navigates immediately + sets pendingColVerify', () => {
    // v5 UX simplification: no intermediate "Found! Go" label.
    // Single sendHalf click finds the target and goes there; the
    // destination's checkTarget listener handles Ready/Stale.
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    scansStore.set({
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    });
    installSendCol();
    getSend()?.click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=30');
    expect(navTarget).toContain('position=8');
    expect(navTarget).toContain('mission=7');
    expect(uiState.get().pendingColLink).toBeNull();
    expect(uiState.get().pendingColVerify).toEqual({
      galaxy: 4,
      system: 30,
      position: 8,
    });
  });

  it('scanHalf click navigates to the next scan galaxy view', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    // Empty scans + home (4,30) → next is (4, 31).
    installSendCol();
    getScan()?.click();
    expect(navTarget).toContain('component=galaxy');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=31');
  });

  it('scanHalf click with all-scanned paints "All scanned!"', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {};
    for (let g = 1; g <= 7; g++) {
      for (let s = 1; s <= 499; s++) {
        scans[/** @type {`${number}:${number}`} */ (`${g}:${s}`)] = {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        };
      }
    }
    scansStore.set(scans);
    installSendCol();
    getScan()?.click();
    expect(getScan()?.textContent).toBe('All scanned!');
    expect(navTarget).toBeNull();
  });

  it('abandon mode: scanHalf click triggers abandonPlanet (which bails without password)', () => {
    setupScene({ isOverview: true, usedFields: 0, maxFields: 100 });
    // colMinFields default is 200 → 100 < 200 → abandon state.
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    // Scan half in abandon mode shows "Abandon".
    expect(getScan()?.textContent).toBe('Abandon');
    expect(getSend()?.textContent).toBe('Too small! (100)');
    // A click fires abandonPlanet. Without a password set it bails
    // early, so we can assert no navigation happened.
    getScan()?.click();
    expect(navTarget).toBeNull();
  });

  it('abandon mode: sendHalf click is a no-op', () => {
    setupScene({ isOverview: true, usedFields: 0, maxFields: 100 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    getSend()?.click();
    expect(navTarget).toBeNull();
    // Label stays as-is.
    expect(getSend()?.textContent).toBe('Too small! (100)');
  });
});

// ──────────────────────────────────────────────────────────────────
// Event reactors
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — oge5:galaxyScanned reactor', () => {
  it('empty target + canColonize → auto-navigate to fleetdispatch + pendingColVerify set', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:galaxyScanned', {
        detail: {
          galaxy: 4,
          system: 42,
          positions: { 8: { status: 'empty' } },
          canColonize: true,
        },
      }),
    );
    // v5 UX: no intermediate "Found! Go" label — the reactor
    // navigates straight to the fleetdispatch URL.
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=42');
    expect(navTarget).toContain('position=8');
    expect(uiState.get().pendingColLink).toBeNull();
    expect(uiState.get().pendingColVerify).toEqual({
      galaxy: 4,
      system: 42,
      position: 8,
    });
  });

  it('empty target + NOT canColonize → Send Colony with coords (defers no-ship check to checkTarget)', () => {
    // Galaxy XHR's `canColonize` reflects the scanning planet's ship
    // inventory — wrong context for "no ship" (user can colonize
    // from another planet). So we show coords anyway; the real
    // "No ship!" signal comes from the checkTarget reactor when
    // fleetdispatch rejects with error 140035.
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:galaxyScanned', {
        detail: {
          galaxy: 4,
          system: 42,
          positions: { 8: { status: 'empty' } },
          canColonize: false,
        },
      }),
    );
    expect(getSend()?.textContent).toContain('Send Colony');
    expect(getSend()?.textContent).toContain('[4:42:8]');
    expect(uiState.get().pendingColLink).toBeNull();
  });

  it('no target match → Scan next', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:galaxyScanned', {
        detail: {
          galaxy: 4,
          system: 42,
          // position 9 is empty but the default target is "8".
          positions: { 9: { status: 'empty' } },
          canColonize: true,
        },
      }),
    );
    expect(getSend()?.textContent).toBe('Send');
    expect(getScan()?.textContent).toBe('Scan next');
  });
});

describe('installSendCol — oge5:checkTargetResult reactor', () => {
  it('match + colonizable → Ready! label and verify cleared', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    uiState.update((s) => ({
      ...s,
      pendingColVerify: { galaxy: 4, system: 30, position: 8 },
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:checkTargetResult', {
        detail: {
          galaxy: 4,
          system: 30,
          position: 8,
          colonizable: true,
        },
      }),
    );
    // Two-line label now: "Ready!" caption + "[4:30:8]" coords. Use
    // toContain rather than toBe — textContent concatenates child
    // divs without spacing.
    expect(getSend()?.textContent).toContain('Ready!');
    expect(getSend()?.textContent).toContain('[4:30:8]');
    expect(uiState.get().pendingColVerify).toBeNull();
    expect(uiState.get().staleRetryActive).toBe(false);
  });

  it('match + stale → scansStore abandoned, staleRetryActive=true, Stale label', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    uiState.update((s) => ({
      ...s,
      pendingColVerify: { galaxy: 4, system: 30, position: 8 },
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:checkTargetResult', {
        detail: {
          galaxy: 4,
          system: 30,
          position: 8,
          colonizable: false,
        },
      }),
    );
    expect(getSend()?.textContent).toContain('Stale');
    expect(uiState.get().staleRetryActive).toBe(true);
    expect(uiState.get().pendingColVerify).toBeNull();
    // scansStore has position 8 marked 'abandoned'.
    const scan = scansStore.get()['4:30'];
    expect(scan).toBeDefined();
    expect(scan?.positions[8]?.status).toBe('abandoned');
  });

  it('non-matching coords → ignored', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    uiState.update((s) => ({
      ...s,
      pendingColVerify: { galaxy: 4, system: 30, position: 8 },
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge5:checkTargetResult', {
        detail: {
          galaxy: 9,
          system: 9,
          position: 9,
          colonizable: true,
        },
      }),
    );
    // Label unchanged — still the initial "Checking [coords]…" that
    // installSendCol paints when pendingColVerify is set on a
    // fleetdispatch page (v4 parity — show user which slot we're
    // waiting on).
    expect(getSend()?.textContent).toContain('Checking');
    expect(getSend()?.textContent).toContain('[4:30:8]');
    // verify kept — we're still waiting on our real coords.
    expect(uiState.get().pendingColVerify).toEqual({
      galaxy: 4,
      system: 30,
      position: 8,
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Stale retry — swap form inputs on next Send click
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — stale retry (navigation, DESIGN.md §9.2)', () => {
  it('click Send in staleRetry navigates to the stale system galaxy view', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    uiState.update((s) => ({
      ...s,
      staleRetryActive: true,
      staleTargetCoords: { galaxy: 4, system: 30 },
    }));
    installSendCol();

    getSend()?.click();

    expect(navTarget).not.toBeNull();
    expect(navTarget).toContain('component=galaxy');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=30');
    // Retry disarmed + coords consumed so a later accidental click
    // doesn't re-nav.
    expect(uiState.get().staleRetryActive).toBe(false);
    expect(uiState.get().staleTargetCoords).toBeNull();
  });

  it('click Send in staleRetry without coords paints error (should not happen, defensive)', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    uiState.update((s) => ({
      ...s,
      staleRetryActive: true,
      staleTargetCoords: null,
    }));
    installSendCol();
    getSend()?.click();
    expect(getSend()?.textContent).toBe('No stale target');
    expect(navTarget).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Live settings updates
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — live settings', () => {
  it('toggles off live removes the button; toggles on live re-mounts', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    expect(getWrap()).not.toBeNull();
    settingsStore.update((s) => ({ ...s, colonizeMode: false }));
    expect(getWrap()).toBeNull();
    settingsStore.update((s) => ({ ...s, colonizeMode: true }));
    expect(getWrap()).not.toBeNull();
  });
});
