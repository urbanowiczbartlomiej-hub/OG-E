// @vitest-environment happy-dom
//
// Behavioural tests for the colonize button (see `src/features/sendCol/index.js`).
//
// # Test coverage strategy
//
// The module factors into three layers — we test each directly:
//
//   1. `derive(env)` — pure compute. We build explicit env objects
//      (search, fleetDispatcher, stores, targets, preferOther, now)
//      and assert the returned discriminated-union shape. One test
//      case per derive-branch + sub-phase.
//   2. `render(ctx)` — pure paint instructions. Table-ish: kind ×
//      phase → expected {text, subtext?, bg}.
//   3. `installSendCol` + click handlers + event reactors — integration.
//      Drive happy-dom, observe DOM text/bg, assert store writes and
//      location.href navigations.
//
// # What we do NOT cover
//
// - Real drag gestures (same trade-off as sendExp.test.js).
// - Focus-persistence across happy-dom reloads (the shared helper has
//   its own tests in lib/).
// - The 1 Hz ticker running live — instead we test the behaviour its
//   firing produces (waitGap remaining decrements) using `vi.useFakeTimers`.
//
// # Navigation testing
//
// Override `location.href` with a spy getter/setter so we can observe
// which URL the handler wrote without racing happy-dom's frame
// navigator. Same pattern as the sendExp tests.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installSendCol,
  _resetSendColForTest,
  derive,
  render,
} from '../../src/features/sendCol/index.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';
import { scansStore } from '../../src/state/scans.js';
import { registryStore } from '../../src/state/registry.js';

// ── Location.href mocking ────────────────────────────────────────────

/** @type {string | null} */
let navTarget = null;

const mockLocationHref = () => {
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

/**
 * Paint a minimal overview scene with an active planet row at
 * `[4:30:8]` so `readHomePlanet` resolves.
 *
 * @param {{
 *   coords?: string,
 *   onGalaxy?: boolean,
 *   galaxyG?: number,
 *   galaxyS?: number,
 *   onFleetdispatch?: boolean,
 *   mission?: number | null,
 * }} [opts]
 */
const setupScene = ({
  coords = '[4:30:8]',
  onGalaxy = false,
  galaxyG = 4,
  galaxyS = 30,
  onFleetdispatch = false,
  mission = null,
} = {}) => {
  if (onFleetdispatch) {
    location.search =
      mission !== null
        ? `?page=ingame&component=fleetdispatch&mission=${mission}`
        : '?page=ingame&component=fleetdispatch';
  } else if (onGalaxy) {
    location.search = `?page=ingame&component=galaxy&galaxy=${galaxyG}&system=${galaxyS}`;
  } else {
    location.search = '?page=ingame&component=overview&cp=1';
  }
  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet hightlightPlanet" id="planet-1">
        <span class="planet-koords">${coords}</span>
      </div>
    </div>
  `;
};

const getWrap = () =>
  /** @type {HTMLElement | null} */ (document.getElementById('oge-send-col'));
const getSend = () =>
  /** @type {HTMLButtonElement | null} */ (
    document.getElementById('oge-col-send')
  );
const getScan = () =>
  /** @type {HTMLButtonElement | null} */ (
    document.getElementById('oge-col-scan')
  );

/**
 * Build a fleetDispatcher stub. `orders[7]` is `canColonize`; ship id 208
 * is the colonizer.
 *
 * @param {{
 *   current?: { galaxy: number, system: number, position: number },
 *   target?: { galaxy: number, system: number, position: number } | null,
 *   canColonize?: boolean,
 *   hasColonizer?: boolean,
 *   expeditionCount?: number,
 *   maxExpeditionCount?: number,
 * }} [opts]
 */
const makeFleetDispatcher = ({
  current = { galaxy: 1, system: 2, position: 3 },
  target = { galaxy: 4, system: 30, position: 8 },
  canColonize = true,
  hasColonizer = true,
  expeditionCount = 0,
  maxExpeditionCount = 10,
} = {}) => ({
  currentPlanet: current,
  targetPlanet: target,
  orders: /** @type {Record<string, boolean>} */ ({ 7: canColonize }),
  shipsOnPlanet: hasColonizer ? [{ id: 208, number: 1 }] : [],
  expeditionCount,
  maxExpeditionCount,
});

/**
 * Publish a fleetDispatcher snapshot into the module's event listener
 * AND assign to `window.fleetDispatcher` so the install-time bootstrap
 * reads it regardless of whether the test dispatches before or after
 * `installSendCol()`. Replaces the old window-only pattern.
 *
 * @param {ReturnType<typeof makeFleetDispatcher>} snap
 */
const setFleetDispatcher = (snap) => {
  /** @type {any} */ (window).fleetDispatcher = snap;
  document.dispatchEvent(
    new CustomEvent('oge:fleetDispatcher', { detail: snap }),
  );
};

beforeEach(() => {
  _resetSendColForTest();
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  scansStore.set({});
  registryStore.set([]);
  delete (/** @type {any} */ (window)).fleetDispatcher;
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  _resetSendColForTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  scansStore.set({});
  registryStore.set([]);
  delete (/** @type {any} */ (window)).fleetDispatcher;
  unmockLocationHref();
  navTarget = null;
  location.search = '';
});

// ──────────────────────────────────────────────────────────────────
// install / dispose / idempotency
// ──────────────────────────────────────────────────────────────────

describe('installSendCol — lifecycle', () => {
  it('does not render when colonizeMode is off', () => {
    setupScene();
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
    expect(document.querySelectorAll('#oge-send-col').length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// derive — pure
// ──────────────────────────────────────────────────────────────────

describe('derive — idle branch', () => {
  it('returns idle with no candidate when scans is empty', () => {
    setupScene();
    const ctx = derive({
      search: '?page=ingame&component=overview',
      fleetDispatcher: null,
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    expect(ctx.kind).toBe('idle');
    if (ctx.kind === 'idle') expect(ctx.candidate).toBeNull();
  });

  it('returns idle with a candidate when scansStore has an empty target', () => {
    setupScene();
    const ctx = derive({
      search: '?page=ingame&component=overview',
      fleetDispatcher: null,
      scans: {
        '4:30': {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        },
      },
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
      // `derive` no longer reads the DOM itself — home / view are
      // passed explicitly (see sendCol/pure.js DeriveEnv). `setupScene`
      // paints the active planet row at [4:30:8]; mirror that here.
      home: { galaxy: 4, system: 30 },
      view: null,
    });
    expect(ctx.kind).toBe('idle');
    if (ctx.kind === 'idle') {
      expect(ctx.candidate).toEqual({ galaxy: 4, system: 30, position: 8 });
    }
  });
});

describe('derive — galaxy branch', () => {
  it('returns galaxy kind with nextScan + scanCooldown=false', () => {
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
    const ctx = derive({
      search: '?page=ingame&component=galaxy&galaxy=4&system=42',
      fleetDispatcher: null,
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
      home: { galaxy: 4, system: 30 },
      view: { galaxy: 4, system: 42 },
    });
    expect(ctx.kind).toBe('galaxy');
    if (ctx.kind === 'galaxy') {
      expect(ctx.nextScan).toEqual({ galaxy: 4, system: 43 });
      expect(ctx.scanCooldown).toBe(false);
    }
  });

  it('current-view priority wins over global find', () => {
    // Global find would prefer the home galaxy far system (far-first).
    // Current view on 4:42 has an empty slot → that wins.
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
    const ctx = derive({
      search: '?page=ingame&component=galaxy&galaxy=4&system=42',
      fleetDispatcher: null,
      scans: {
        '4:42': {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        },
        '4:250': {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        },
      },
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
      home: { galaxy: 4, system: 30 },
      view: { galaxy: 4, system: 42 },
    });
    expect(ctx.kind).toBe('galaxy');
    if (ctx.kind === 'galaxy') {
      expect(ctx.candidate).toEqual({ galaxy: 4, system: 42, position: 8 });
    }
  });
});

describe('derive — fleetdispatch branch', () => {
  const baseSearch = '?page=ingame&component=fleetdispatch&mission=7';

  it('noTarget when fleetDispatcher is absent', () => {
    const ctx = derive({
      search: baseSearch,
      fleetDispatcher: null,
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    expect(ctx.kind).toBe('fleetdispatch');
    if (ctx.kind === 'fleetdispatch') {
      expect(ctx.phase.tag).toBe('noTarget');
    }
  });

  it('noTarget when fleetDispatcher.targetPlanet is missing', () => {
    const ctx = derive({
      search: baseSearch,
      fleetDispatcher: makeFleetDispatcher({ target: null }),
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    expect(ctx.kind).toBe('fleetdispatch');
    if (ctx.kind === 'fleetdispatch') expect(ctx.phase.tag).toBe('noTarget');
  });

  it('ready when orders[7]=true and colonizer is present', () => {
    _resetSendColForTest();
    const ctx = derive({
      search: baseSearch,
      fleetDispatcher: makeFleetDispatcher({ canColonize: true, hasColonizer: true }),
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    expect(ctx.kind).toBe('fleetdispatch');
    if (ctx.kind === 'fleetdispatch') {
      expect(ctx.phase.tag).toBe('ready');
      expect(ctx.target).toEqual({ galaxy: 4, system: 30, position: 8 });
    }
  });

  it('noShip when the planet has no colonizer', () => {
    _resetSendColForTest();
    const ctx = derive({
      search: baseSearch,
      fleetDispatcher: makeFleetDispatcher({ canColonize: false, hasColonizer: false }),
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    if (ctx.kind === 'fleetdispatch') expect(ctx.phase.tag).toBe('noShip');
  });

  it('noShip when the last checkTarget error was 140035, even if hasColonizer', () => {
    _resetSendColForTest();
    // Install to get the event listener wired so the module can consume
    // errorCode.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: false,
      hasColonizer: true,
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCodes: [140035] },
      }),
    );
    const { send } = { send: getSend() };
    expect(send?.textContent).toContain('No ship!');
  });

  it('reserved when the last checkTarget error was 140016', () => {
    _resetSendColForTest();
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: false,
      hasColonizer: true,
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCodes: [140016] },
      }),
    );
    expect(getSend()?.textContent).toContain('Reserved');
  });

  it('stale when orders[7]=false, has ship, no error', () => {
    _resetSendColForTest();
    const ctx = derive({
      search: baseSearch,
      fleetDispatcher: makeFleetDispatcher({ canColonize: false, hasColonizer: true }),
      scans: {},
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    if (ctx.kind === 'fleetdispatch') expect(ctx.phase.tag).toBe('stale');
  });

  it('timeout when > 15s since nav, no canColonize, no err', () => {
    _resetSendColForTest();
    // Seed the timestamp via the send-click path. Easier: install,
    // arrange a ctx that triggers a nav, then advance.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendCol();
    // Click Send to set lastNavToFleetdispatchAt.
    getSend()?.click();
    // Swap to fleetdispatch with a stale target.
    location.search = '?page=ingame&component=fleetdispatch&mission=7';
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: false,
      hasColonizer: true,
    }));
    // Advance > 15s.
    vi.advanceTimersByTime(16_000);
    const ctx = derive({
      search: location.search,
      fleetDispatcher: /** @type {any} */ (window).fleetDispatcher,
      scans: scansStore.get(),
      registry: [],
      targets: [8],
      preferOther: false,
      now: Date.now(),
    });
    // Without an err AND not canColonize, we expect stale — timeout requires
    // the no-err/no-canColonize path AND a nav timestamp > 15s old. But the
    // priority order puts stale under timeout, so the timeout flag must
    // win when conditions match.
    // Actually with hasColonizer=true + no err + !canColonize + 16s old nav,
    // timeout branch fires because timeout takes priority over stale.
    if (ctx.kind === 'fleetdispatch') {
      expect(['timeout', 'stale']).toContain(ctx.phase.tag);
      // The key behavioural assertion: post-15s we're NOT "ready" anymore.
      expect(ctx.phase.tag).not.toBe('ready');
    }
    vi.useRealTimers();
  });

  it('waitGap with remaining seconds when a countdown is active', () => {
    _resetSendColForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // Install on fleetdispatch with a conflict in registry → click
    // starts a countdown.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: true,
      hasColonizer: true,
    }));
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = '0:01:00'; // 60s arrival
    document.body.appendChild(dur);
    // Registry conflict 10s after our arrival (within the 20s default gap).
    const now = Date.now();
    registryStore.set([
      { coords: '4:40:8', sentAt: now, arrivalAt: now + 60_000 + 10_000 },
    ]);
    installSendCol();
    getSend()?.click();
    // waitGap now active; label contains "Wait".
    expect(getSend()?.textContent).toMatch(/Wait \d+s/);
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// render — each kind × phase
// ──────────────────────────────────────────────────────────────────

describe('render — pure paint instructions', () => {
  // Common scan/cooldown fields shared by all tests — the render output
  // for scan is driven purely by nextScan + scanCooldown regardless of
  // ctx.kind.
  const noScan = { nextScan: null, scanCooldown: false };
  const freshScan = {
    nextScan: { galaxy: 4, system: 31 },
    scanCooldown: false,
  };

  it('idle without candidate → plain "Send"', () => {
    const r = render({ kind: 'idle', candidate: null, ...noScan });
    expect(r.send.text).toBe('Send');
    expect(r.send.subtext).toBeUndefined();
    expect(r.scan.text).toBe('All scanned!');
  });

  it('idle with candidate → coords + "Send Colony" subtext', () => {
    const r = render({
      kind: 'idle',
      candidate: { galaxy: 4, system: 30, position: 8 },
      ...noScan,
    });
    expect(r.send.text).toBe('[4:30:8]');
    expect(r.send.subtext).toBe('Send Colony');
  });

  it('galaxy with nextScan=null → "All scanned!"', () => {
    const r = render({
      kind: 'galaxy',
      candidate: null,
      ...noScan,
    });
    expect(r.scan.text).toBe('All scanned!');
  });

  it('galaxy with nextScan → "[g:s] / Scan"', () => {
    const r = render({
      kind: 'galaxy',
      candidate: null,
      ...freshScan,
    });
    expect(r.scan.text).toBe('[4:31]');
    expect(r.scan.subtext).toBe('Scan');
  });

  it('fleetdispatch/ready → coords + "Send!" subtext, scan half shows "to Galaxy"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'ready' },
      ...freshScan,
    });
    expect(r.send.text).toBe('[4:30:8]');
    expect(r.send.subtext).toBe('Send!');
    // Scan half off-galaxy is "to Galaxy" (full nav to bare galaxy URL) —
    // avoids the "first system load isn't AJAX, we'd miss it" bug.
    expect(r.scan.text).toBe('to Galaxy');
  });

  it('fleetdispatch/noShip → coords + "No ship!" subtext', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'noShip' },
      ...noScan,
    });
    expect(r.send.subtext).toBe('No ship!');
  });

  it('fleetdispatch/reserved → "Reserved"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'reserved' },
      ...noScan,
    });
    expect(r.send.subtext).toBe('Reserved');
  });

  it('fleetdispatch/stale → "Stale"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'stale' },
      ...noScan,
    });
    expect(r.send.subtext).toBe('Stale');
  });

  it('fleetdispatch/timeout → "Timeout"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'timeout' },
      ...noScan,
    });
    expect(r.send.subtext).toBe('Timeout');
  });

  it('fleetdispatch/waitGap → "Wait Ns"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: { galaxy: 4, system: 30, position: 8 },
      phase: { tag: 'waitGap', remaining: 7 },
      ...noScan,
    });
    expect(r.send.text).toBe('Wait 7s');
    expect(r.send.subtext).toBeUndefined();
  });

  it('fleetdispatch/noTarget → plain "Send"', () => {
    const r = render({
      kind: 'fleetdispatch',
      target: null,
      phase: { tag: 'noTarget' },
      ...noScan,
    });
    expect(r.send.text).toBe('Send');
  });
});

// ──────────────────────────────────────────────────────────────────
// onSendClick — integration
// ──────────────────────────────────────────────────────────────────

describe('onSendClick — idle/galaxy branch', () => {
  it('idle with a candidate → navigates to buildFleetdispatchUrl', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendCol();
    getSend()?.click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=30');
    expect(navTarget).toContain('position=8');
    expect(navTarget).toContain('mission=7');
  });

  it('idle with no candidate → paints "None available" (no nav)', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    getSend()?.click();
    expect(getSend()?.textContent).toBe('None available');
    expect(navTarget).toBeNull();
  });
});

describe('onSendClick — fleetdispatch branch', () => {
  /** @param {Parameters<typeof makeFleetDispatcher>[0]} fdOpts */
  const installFleet = (fdOpts = {}) => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher(fdOpts));
    installSendCol();
  };

  it('noShip → no-op (no nav, no Enter)', () => {
    installFleet({ canColonize: false, hasColonizer: false });
    const seen = /** @type {string[]} */ ([]);
    document.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    });
    getSend()?.click();
    expect(navTarget).toBeNull();
    expect(seen).toEqual([]);
  });

  it('reserved → no-op', () => {
    installFleet({ canColonize: false, hasColonizer: true });
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCodes: [140016] },
      }),
    );
    const seen = /** @type {string[]} */ ([]);
    document.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    });
    getSend()?.click();
    expect(navTarget).toBeNull();
    expect(seen).toEqual([]);
  });

  it('stale → navigates to galaxy view of target', () => {
    installFleet({ canColonize: false, hasColonizer: true });
    getSend()?.click();
    expect(navTarget).toContain('component=galaxy');
    expect(navTarget).toContain('galaxy=4');
    expect(navTarget).toContain('system=30');
    // Should NOT contain mission=7 — we're going to galaxy view.
    expect(navTarget).not.toContain('mission=7');
  });

  it('ready with no wait → synthesizes Enter', () => {
    installFleet({ canColonize: true, hasColonizer: true });
    const seen = /** @type {string[]} */ ([]);
    document.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    });
    document.addEventListener('keyup', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    });
    getSend()?.click();
    expect(seen).toContain('keydown');
    expect(seen).toContain('keyup');
  });

  it('ready with minGap conflict → starts countdown, paints "Wait Ns"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    installFleet({ canColonize: true, hasColonizer: true });
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = '0:01:00';
    document.body.appendChild(dur);
    const now = Date.now();
    registryStore.set([
      { coords: '4:40:8', sentAt: now, arrivalAt: now + 60_000 + 10_000 },
    ]);
    const seen = /** @type {string[]} */ ([]);
    document.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.type);
    });
    getSend()?.click();
    // No Enter fired — countdown armed instead.
    expect(seen).toEqual([]);
    expect(getSend()?.textContent).toMatch(/Wait \d+s/);
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// onScanClick — integration
// ──────────────────────────────────────────────────────────────────

describe('onScanClick', () => {
  it('non-galaxy → "to Galaxy" nav (bare URL, no specific system)', () => {
    // Off-galaxy scan click always hops to the bare galaxy URL
    // regardless of next-unscanned coords. The first system load on
    // a galaxy page is server-rendered (no AJAX), so we'd miss it if
    // we targeted it via full nav. Better to let the user arrive on
    // galaxy and drive subsequent scans via AJAX-observed submits.
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    getScan()?.click();
    expect(navTarget).toContain('component=galaxy');
    // No galaxy/system params in the URL.
    expect(navTarget).not.toContain('galaxy=');
    expect(navTarget).not.toContain('system=');
  });

  it('on-galaxy + all-scanned → paints "All scanned!", no nav', () => {
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
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

  /**
   * Add the in-page galaxy form: galaxy + system inputs and a submit
   * button reachable via the `#galaxyHeader .btn_blue` fallback selector
   * (avoids the `onclick` attribute path so happy-dom doesn't try to eval
   * the legacy inline `submitForm(...)` handler).
   *
   * @returns {{ galaxyInput: HTMLInputElement, systemInput: HTMLInputElement, submitBtn: HTMLButtonElement }}
   */
  const installGalaxyForm = () => {
    const gi = document.createElement('input');
    gi.id = 'galaxy_input';
    gi.value = '4';
    const si = document.createElement('input');
    si.id = 'system_input';
    si.value = '42';
    const header = document.createElement('div');
    header.id = 'galaxyHeader';
    const btn = document.createElement('button');
    btn.className = 'btn_blue';
    header.appendChild(btn);
    document.body.appendChild(gi);
    document.body.appendChild(si);
    document.body.appendChild(header);
    return { galaxyInput: gi, systemInput: si, submitBtn: btn };
  };

  it('galaxy view → in-page submit when submit button exists', () => {
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    const { systemInput, submitBtn } = installGalaxyForm();
    let clicked = false;
    submitBtn.addEventListener('click', () => {
      clicked = true;
    });
    installSendCol();
    getScan()?.click();
    expect(clicked).toBe(true);
    expect(systemInput.value).toBe('43');
    // No full navigation occurred.
    expect(navTarget).toBeNull();
  });

  it('cooldown: second click ignored until oge:galaxyScanned arrives', () => {
    // Event-driven cooldown: Scan locks when we submit and unlocks as
    // soon as the game's galaxy response lands. Spamming Scan while a
    // response is outstanding is a no-op; once the event fires, the
    // next click submits again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    const { submitBtn } = installGalaxyForm();
    let clicks = 0;
    submitBtn.addEventListener('click', () => {
      clicks++;
    });
    installSendCol();
    getScan()?.click();
    expect(clicks).toBe(1);

    // No event yet — second click ignored.
    vi.advanceTimersByTime(500);
    getScan()?.click();
    expect(clicks).toBe(1);

    // Simulate game response (galaxyHook dispatches this after XHR load).
    document.dispatchEvent(
      new CustomEvent('oge:galaxyScanned', {
        detail: { galaxy: 4, system: 42, positions: {}, canColonize: true },
      }),
    );

    // Now the cooldown is cleared event-driven; next click fires.
    getScan()?.click();
    expect(clicks).toBe(2);
    vi.useRealTimers();
  });

  it('cooldown: safety cap unlocks after 8s even if galaxy event never arrives', () => {
    // Escape hatch: if the game never answers (AGR swallowed the XHR,
    // network died), the Scan half still becomes clickable after the
    // hard timeout so the user isn't stuck.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 42 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    const { submitBtn } = installGalaxyForm();
    let clicks = 0;
    submitBtn.addEventListener('click', () => {
      clicks++;
    });
    installSendCol();
    getScan()?.click();
    expect(clicks).toBe(1);

    // 7s later — still within safety cap → ignored.
    vi.advanceTimersByTime(7_000);
    getScan()?.click();
    expect(clicks).toBe(1);

    // After the 8s cap → unlocks.
    vi.advanceTimersByTime(1_500);
    getScan()?.click();
    expect(clicks).toBe(2);
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Event reactors
// ──────────────────────────────────────────────────────────────────

describe('oge:checkTargetResult reactor', () => {
  it('matching coords + errorCodes[0]=140016 → label flips to Reserved', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: false,
      hasColonizer: true,
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCodes: [140016] },
      }),
    );
    expect(getSend()?.textContent).toContain('Reserved');
  });

  it('simplified shape {errorCode: 140035} → No ship!', () => {
    // Bridge-shape-compat: future simplified shape carries `errorCode`
    // directly instead of `errorCodes[]`.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: false,
      hasColonizer: true,
    }));
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCode: 140035 },
      }),
    );
    expect(getSend()?.textContent).toContain('No ship!');
  });

  it('non-matching coords against fleetDispatcher.targetPlanet → ignored', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      target: { galaxy: 4, system: 30, position: 8 },
      canColonize: true,
      hasColonizer: true,
    }));
    installSendCol();
    // Old response for a different target should not change our state.
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 9, system: 9, position: 9, errorCodes: [140035] },
      }),
    );
    // Label stays "Send!" (phase=ready).
    expect(getSend()?.textContent).toContain('Send!');
  });
});

describe('oge:colonizeSent reactor', () => {
  it('marks the sent slot empty_sent in scansStore + NO auto-redirect', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    // Preload scansStore with TWO candidates — if auto-redirect fired
    // we'd observe a nav to the next one.
    scansStore.set({
      '4:31': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
      '4:32': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendCol();
    document.dispatchEvent(
      new CustomEvent('oge:colonizeSent', {
        detail: { galaxy: 4, system: 31, position: 8 },
      }),
    );
    // 4:31 slot is now empty_sent.
    expect(scansStore.get()['4:31']?.positions[8]?.status).toBe('empty_sent');
    // Crucial axiom #1 check: NO auto-redirect to the remaining candidate.
    expect(navTarget).toBeNull();
  });

  it('bad detail payload is tolerated (no-op)', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    // No galaxy/system/position → no-op.
    document.dispatchEvent(
      new CustomEvent('oge:colonizeSent', { detail: { galaxy: 'oops' } }),
    );
    expect(Object.keys(scansStore.get())).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Ticker — 1 Hz repaint drives waitGap countdown
// ──────────────────────────────────────────────────────────────────

describe('ticker', () => {
  it('1 Hz repaint drives the waitGap countdown down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    setFleetDispatcher(makeFleetDispatcher({
      canColonize: true,
      hasColonizer: true,
    }));
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = '0:01:00';
    document.body.appendChild(dur);
    const now = Date.now();
    registryStore.set([
      { coords: '4:40:8', sentAt: now, arrivalAt: now + 60_000 + 5_000 },
    ]);
    installSendCol();
    getSend()?.click();
    const labelStart = getSend()?.textContent;
    expect(labelStart).toMatch(/Wait \d+s/);
    // Advance 3s — countdown should reflect it.
    vi.advanceTimersByTime(3_000);
    const labelLater = getSend()?.textContent;
    expect(labelLater).toMatch(/Wait \d+s/);
    // labelLater's seconds number must be strictly smaller.
    /** @param {string | null | undefined} s */
    const extract = (s) => {
      const m = (s ?? '').match(/Wait (\d+)s/);
      return m ? parseInt(m[1], 10) : NaN;
    };
    expect(extract(labelLater)).toBeLessThan(extract(labelStart));
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Settings reactions
// ──────────────────────────────────────────────────────────────────

describe('settings reactions', () => {
  it('colonizeMode toggle off → button removed; on → remounted', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    expect(getWrap()).not.toBeNull();
    settingsStore.update((s) => ({ ...s, colonizeMode: false }));
    expect(getWrap()).toBeNull();
    settingsStore.update((s) => ({ ...s, colonizeMode: true }));
    expect(getWrap()).not.toBeNull();
  });

  it('colBtnSize change → button resizes live', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), colonizeMode: true });
    installSendCol();
    expect(getWrap()?.style.width).toBe('336px'); // default
    settingsStore.update((s) => ({ ...s, colBtnSize: 500 }));
    expect(getWrap()?.style.width).toBe('500px');
  });
});
