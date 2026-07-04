// @vitest-environment happy-dom
//
// Behavioural tests for the colonize button (see `src/features/sendColony/index.js`).
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
//   3. `installSendColony` + click handlers + event reactors — integration.
//      Drive happy-dom, observe DOM text/bg, assert store writes and
//      location.href navigations.
//
// # What we do NOT cover
//
// - Real drag gestures (same trade-off as sendExpedition.test.js).
// - Focus-persistence across happy-dom reloads (the shared helper has
//   its own tests in lib/).
// - The live waitGap countdown (dropped with the courier migration — min-gap
//   now shows a static "Wait Ns" the user re-taps past, so there is no
//   fake-timer countdown to drive here).
//
// # Navigation testing
//
// Override `location.href` with a spy getter/setter so we can observe
// which URL the handler wrote without racing happy-dom's frame
// navigator. Same pattern as the sendExpedition tests.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installSendColony,
  _resetSendColonyForTest,
  _onSendHoldForTest,
  derive,
  render,
} from '../../src/features/sendColony/index.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';
import { scansStore } from '../../src/state/scans.js';
import { registryStore } from '../../src/state/registry.js';
import { galaxyScanConfigStore } from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';
import {
  colonizeDecisionsStore,
  disposeColonizeDecisionsStore,
} from '../../src/state/colonizeDecisions.js';
import { blockingCoords, DEC_TAKEN } from '../../src/domain/colonizeDecisions.js';

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
// The colonize button is now a SINGLE-zone button (the Scan half was removed in
// §2d), so the clickable host element IS `oge-send-col` — it carries the click
// handler and the painted label text. There is no separate `oge-col-send` half
// any more (that only existed in the old split layout).
const getSend = () =>
  /** @type {HTMLButtonElement | null} */ (
    document.getElementById('oge-send-col')
  );
// ── courier two-click harness ─────────────────────────────────────────
// A fake MAIN executor + a step-1→step-2 DOM, so a tap-1 select() can
// reach a ready step 2 (the real courier flow is covered in
// fleetCourier.test.js; here we prove sendColony wires into it). Module
// scope: used by both the fleetdispatch-branch and onSendHold suites.
/** @param {{ errorCode?: number|null, missionOk?: boolean, orders?: Record<string,boolean> }} [opts] */
const armCourier = (opts = {}) => {
  document.dispatchEvent(new CustomEvent('oge:fleetDispatcher', {
    detail: { shipsOnPlanet: [{ id: 208, number: 1 }], orders: {} },
  }));
  document.body.insertAdjacentHTML('beforeend', '<div id="fleet1"></div>');
  let lastTarget = /** @type {any} */ (null);
  const cont = document.createElement('a');
  cont.id = 'continueToFleet2';
  cont.className = 'off';
  cont.addEventListener('click', () => {
    document.getElementById('fleet1')?.remove();
    const d = document.createElement('a');
    d.id = 'dispatchFleet';
    d.className = 'off';
    document.body.appendChild(d);
    // The game fires checkTarget as fleet2 loads (carries orders + errorCode).
    const t = lastTarget || {};
    document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
      detail: {
        galaxy: t.galaxy, system: t.system, position: t.position,
        errorCode: opts.errorCode ?? null,
        orders: opts.orders ?? { 7: true },
      },
    }));
  });
  document.body.appendChild(cont);
  const onCmd = (/** @type {any} */ e) => {
    const { id, op, args } = e.detail;
    /** @type {any} */ let res = { id, ok: true };
    if (op === 'setTarget') {
      lastTarget = args;
      // AGR enables "continue" once the target is applied.
      setTimeout(() => document.getElementById('continueToFleet2')?.classList.remove('off'), 0);
    } else if (op === 'selectMission') {
      const ok = opts.missionOk ?? true;
      res = { id, ok, data: { available: ok } };
      if (ok) setTimeout(() => document.getElementById('dispatchFleet')?.classList.remove('off'), 0);
    }
    document.dispatchEvent(new CustomEvent('oge:fd:res', { detail: res }));
  };
  document.addEventListener('oge:fd:cmd', onCmd);
  return () => document.removeEventListener('oge:fd:cmd', onCmd);
};

const settle = () => new Promise((r) => setTimeout(r, 500));

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
 * `installSendColony()`. Replaces the old window-only pattern.
 *
 * @param {ReturnType<typeof makeFleetDispatcher>} snap
 */
const setFleetDispatcher = (snap) => {
  /** @type {any} */ (window).fleetDispatcher = snap;
  document.dispatchEvent(
    new CustomEvent('oge:fleetDispatcher', { detail: snap }),
  );
};

/**
 * Reset the colonization decision log between tests. The picker
 * (`findNextColonizeTarget`) subtracts these blocking coords, and the reactor /
 * skip handlers WRITE to this store — so a decision recorded by one test (e.g.
 * a `taken`/`sent` mark on 4:30:8) would otherwise leak and silently block the
 * same candidate in a later test. Dispose the persist wiring (if any) then
 * reset the in-memory value to the empty map, per the store reset convention.
 */
const resetDecisions = () => {
  disposeColonizeDecisionsStore();
  colonizeDecisionsStore.set({});
};

beforeEach(() => {
  _resetSendColonyForTest();
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  scansStore.set({});
  registryStore.set([]);
  resetDecisions();
  delete (/** @type {any} */ (window)).fleetDispatcher;
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  _resetSendColonyForTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  scansStore.set({});
  registryStore.set([]);
  resetDecisions();
  delete (/** @type {any} */ (window)).fleetDispatcher;
  unmockLocationHref();
  navTarget = null;
  location.search = '';
});

// ──────────────────────────────────────────────────────────────────
// install / dispose / idempotency
// ──────────────────────────────────────────────────────────────────

describe('installSendColony — lifecycle', () => {
  it('does not render when fabMode is off', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    installSendColony();
    expect(getWrap()).toBeNull();
  });

  it('renders the single Send zone when fabMode is on', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    expect(getWrap()).not.toBeNull();
    expect(getSend()).not.toBeNull();
  });

  it('applies fabBtnSize from settings', () => {
    setupScene();
    settingsStore.set({
      ...settingsStore.get(),
      fabMode: true,
      fabBtnSize: 400,
    });
    installSendColony();
    expect(getWrap()?.style.width).toBe('400px');
    expect(getWrap()?.style.height).toBe('400px');
  });

  it('dispose removes the button', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    const dispose = installSendColony();
    expect(getWrap()).not.toBeNull();
    dispose();
    expect(getWrap()).toBeNull();
  });

  it('is idempotent — second install returns the same dispose', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    const d1 = installSendColony();
    const d2 = installSendColony();
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
      // passed explicitly (see sendColony/pure.js DeriveEnv). `setupScene`
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
  it('returns galaxy kind with no candidate when scans is empty', () => {
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
      expect(ctx.candidate).toBeNull();
      // The Scan half is gone (§2d); the only fields are the candidate +
      // the "N free" stat inputs. No API index here → freeUniverse is null.
      expect(ctx.freeUniverse).toBeNull();
      expect(ctx.targetPositions).toEqual([8]);
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

// (The derive() "fleetdispatch branch" was removed with the courier
// migration — on a bare fleetdispatch derive uses the idle branch, and the
// Send half's ready/reserved/no-ship/stale states are owned by the
// courier-driven handler. Those paths are covered by the "onSendClick —
// fleetdispatch branch" courier tests + the oge:checkTargetResult reactor.)

// ──────────────────────────────────────────────────────────────────
// render — each kind × phase
// ──────────────────────────────────────────────────────────────────

describe('render — pure paint instructions', () => {
  // The Scan half is gone (§2d): render now returns ONLY a Send zone. Primary
  // stays "Colonize"; a candidate is reflected via the brighter "ready" rim,
  // not extra text. Configured target positions add a "(positions)" hint and,
  // when the API "N free" stat is available, an "N free" sub-label.

  it('idle without candidate or targets → plain "Colonize", no sub-lines', () => {
    const r = render({ kind: 'idle', candidate: null });
    expect(r.send.text).toBe('Colonize');
    expect(r.send.subtext).toBeUndefined();
    expect(r.send.hint).toBeUndefined();
  });

  it('a candidate brightens the rim but adds no text lines', () => {
    const idle = render({ kind: 'idle', candidate: null });
    const r = render({
      kind: 'idle',
      candidate: { galaxy: 4, system: 30, position: 8 },
    });
    expect(r.send.text).toBe('Colonize');
    expect(r.send.subtext).toBeUndefined();
    expect(r.send.hint).toBeUndefined();
    expect(r.send.bg).not.toBe(idle.send.bg); // ready rim ≠ idle rim
  });

  it('configured target positions add a "(positions)" hint', () => {
    const r = render({
      kind: 'idle',
      candidate: null,
      freeUniverse: null,
      targetPositions: [8, 10, 11, 12],
    });
    // No freeUniverse yet → no "N free" sub-label, but the hint still shows.
    expect(r.send.subtext).toBeUndefined();
    expect(r.send.hint).toBe('(8·10-12)');
  });

  it('freeUniverse present → "N free" sub-label (grouped thousands)', () => {
    const r = render({
      kind: 'galaxy',
      candidate: null,
      freeUniverse: 38421,
      targetPositions: [8],
    });
    // The thousands separator is a narrow no-break space (U+202F), not a
    // plain space — strip any non-digit/non-letter grouping char before
    // asserting so the test doesn't hard-code the exotic codepoint.
    expect(r.send.subtext).toBeDefined();
    expect((r.send.subtext ?? '').replace(/[^\d]/g, '')).toBe('38421');
    expect((r.send.subtext ?? '').endsWith('free')).toBe(true);
    expect(r.send.hint).toBe('(8)');
  });
});

// ──────────────────────────────────────────────────────────────────
// onSendClick — integration
// ──────────────────────────────────────────────────────────────────

describe('onSendClick — idle/galaxy branch', () => {
  it('idle with a candidate → navigates to a bare fleetdispatch', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
    getSend()?.click();
    // bare-URL entry — the courier sets the colony ship + target in-page.
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
    expect(navTarget).not.toMatch(/mission=/);
  });

  it('idle with no candidate → paints "No more candidates" (no nav)', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    getSend()?.click();
    // The single-zone host's textContent also carries the lens glyph + title
    // chrome ("…COLONIZATIONOG-E"), so match on substring, not exact equality.
    expect(getSend()?.textContent).toContain('No more candidates');
    expect(navTarget).toBeNull();
  });
});

describe('onSendClick — fleetdispatch branch', () => {
  /** @param {Parameters<typeof makeFleetDispatcher>[0]} fdOpts */
  const installFleet = (fdOpts = {}) => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    setFleetDispatcher(makeFleetDispatcher(fdOpts));
    installSendColony();
    // Open the shared eventbox-readiness gate so the button is enabled (on
    // fleetdispatch it starts disabled until OGame's eventbox XHR lands).
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
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

  it('stale with no candidates → shows "No more candidates", no nav', () => {
    // scansStore is empty (beforeEach), so findNextColonizeTarget returns
    // null → handler shows the label and returns without navigating.
    installFleet({ canColonize: false, hasColonizer: true });
    getSend()?.click();
    expect(navTarget).toBeNull();
    expect(getSend()?.textContent).toContain('No more candidates');
  });

  it('two taps: select arms a ready send, then dispatch fires', async () => {
    setupScene({ onFleetdispatch: true });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded')); // open the gate
    const unhook = armCourier({ errorCode: null, missionOk: true });
    // Tap 1 — select; walks to a ready step 2.
    getSend()?.click();
    await settle();
    expect(getSend()?.textContent).toContain('Send!');
    // Tap 2 — dispatch.
    let clicks = 0;
    document.getElementById('dispatchFleet')?.addEventListener('click', () => {
      clicks += 1;
      document.dispatchEvent(new CustomEvent('oge:sendFleetResult', {
        detail: { success: true, errorCode: null, mission: 7 },
      }));
    });
    getSend()?.click();
    await settle();
    expect(clicks).toBe(1);
    unhook();
  });

  it('tap 2 with a min-gap conflict shows "Wait Ns" and does not dispatch', async () => {
    setupScene({ onFleetdispatch: true });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded')); // open the gate
    const unhook = armCourier({ errorCode: null, missionOk: true });
    getSend()?.click();
    await settle();
    // Arm a min-gap conflict: a colony arrival within the default gap.
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = '0:01:00';
    document.body.appendChild(dur);
    const now = Date.now();
    registryStore.set([
      { coords: '4:40:8', sentAt: now, arrivalAt: now + 60_000 + 10_000 },
    ]);
    let clicks = 0;
    document.getElementById('dispatchFleet')?.addEventListener('click', () => (clicks += 1));
    getSend()?.click();
    await settle();
    expect(getSend()?.textContent).toMatch(/Wait \d+s/);
    expect(clicks).toBe(0);
    unhook();
  });

  it('dead target → marks it + next tap retargets IN PLACE on fleet2 (no nav)', async () => {
    // The soft-lock regression: a candidate the DB still shows 'empty' that the
    // game reports un-colonizable. Tap 1 detects it (Stale) and the reactor
    // marks it; tap 2 must edit the native fleet2 coords to the NEXT free slot
    // instead of re-checking the same dead target or navigating away.
    setupScene({ onFleetdispatch: true });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    galaxyScanConfigStore.set({ ...galaxyScanConfigStore.get(), positions: '8' });
    // Two empty candidates; the farther system (4:31) is picked first.
    scansStore.set({
      '4:31': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded')); // open the gate

    // Fake form: fleet1 + a continue control that drops to fleet2 (dispatch
    // present) and fires the game's checkTarget for the transitioned target —
    // which comes back un-colonizable (orders 7 = false).
    document.body.insertAdjacentHTML('beforeend', '<div id="fleet1"></div>');
    let lastTarget = /** @type {any} */ (null);
    const cont = document.createElement('a');
    cont.id = 'continueToFleet2';
    cont.className = 'off';
    cont.addEventListener('click', () => {
      document.getElementById('fleet1')?.remove();
      const d = document.createElement('a');
      d.id = 'dispatchFleet';
      d.className = 'off';
      document.body.appendChild(d);
      const t = lastTarget || {};
      document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: t.galaxy, system: t.system, position: t.position,
          errorCode: null, orders: { 7: false }, ships: { 208: 1 },
        },
      }));
    });
    document.body.appendChild(cont);
    document.dispatchEvent(new CustomEvent('oge:fleetDispatcher', {
      detail: { shipsOnPlanet: [{ id: 208, number: 1 }], orders: {} },
    }));

    const onCmd = (/** @type {any} */ e) => {
      const { id, op, args } = e.detail;
      /** @type {any} */ let res = { id, ok: true };
      if (op === 'setTarget') {
        lastTarget = args;
        setTimeout(() => document.getElementById('continueToFleet2')?.classList.remove('off'), 0);
      } else if (op === 'setTargetNative') {
        // In-place retarget: the freshly aimed slot IS colonizable.
        document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
          detail: {
            galaxy: args.galaxy, system: args.system, position: args.position,
            errorCode: null, orders: { 7: true },
          },
        }));
      } else if (op === 'selectMission') {
        res = { id, ok: true, data: { available: true } };
        setTimeout(() => document.getElementById('dispatchFleet')?.classList.remove('off'), 0);
      }
      document.dispatchEvent(new CustomEvent('oge:fd:res', { detail: res }));
    };
    document.addEventListener('oge:fd:cmd', onCmd);

    // Tap 1 — select() to 4:31:8; the game reports it un-colonizable.
    getSend()?.click();
    await settle();
    expect(scansStore.get()['4:31']?.positions?.[8]?.status).toBe('abandoned');
    expect(getSend()?.textContent).toContain('Stale');

    // Tap 2 — retarget IN PLACE to the next free slot (4:30:8). No navigation,
    // no re-check of the dead target.
    getSend()?.click();
    await settle();
    expect(navTarget).toBeNull();
    expect(getSend()?.textContent).toContain('Send!');
    expect(getSend()?.textContent).toContain('4:30:8');
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('empty');

    document.removeEventListener('oge:fd:cmd', onCmd);
  });
});

// ──────────────────────────────────────────────────────────────────
// Eventbox readiness gate + post-send lock (button-state hardening)
// ──────────────────────────────────────────────────────────────────
describe('eventbox readiness gate', () => {
  it('before the eventbox loads: holds "Wait…" and a tap is a no-op', () => {
    // On fleetdispatch the gate stays CLOSED until OGame's eventList XHR lands
    // (or window 'load'). happy-dom reports readyState 'complete', which would
    // make whenEventBoxReady fire synchronously at install — force 'loading' so
    // the gate behaves as it does on a fresh post-reload page view.
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    try {
      setupScene({ onFleetdispatch: true, mission: 7 });
      settingsStore.set({ ...settingsStore.get(), fabMode: true });
      setFleetDispatcher(makeFleetDispatcher({ canColonize: false, hasColonizer: true }));
      // scansStore is empty, so an ungated tap would compute a candidate from
      // half-loaded data and flash the false "No more candidates".
      installSendColony();
      // Deliberately do NOT dispatch oge:eventBoxLoaded — the gate stays closed.
      expect(getSend()?.textContent).toContain('Wait');
      getSend()?.click();
      expect(navTarget).toBeNull();
      expect(getSend()?.textContent).not.toContain('No more candidates');
    } finally {
      // Restore the real (prototype) getter so later tests see 'complete'.
      delete (/** @type {any} */ (document)).readyState;
    }
  });

  it('once the eventbox loads: the gate opens and the real label paints', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    setFleetDispatcher(makeFleetDispatcher({ canColonize: false, hasColonizer: true }));
    installSendColony();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    // Gate open + an empty DB → the honest "No more candidates" (not the
    // gated "Wait…"), and the tap is processed.
    getSend()?.click();
    expect(getSend()?.textContent).toContain('No more candidates');
  });
});

describe('post-send lock', () => {
  it('a successful dispatch holds the button on "Sent!" through later refreshes', async () => {
    setupScene({ onFleetdispatch: true });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded')); // open the gate
    const unhook = armCourier({ errorCode: null, missionOk: true });
    // Tap 1 — arm a ready send.
    getSend()?.click();
    await settle();
    expect(getSend()?.textContent).toContain('Send!');
    // Tap 2 — dispatch; the fake form reports success.
    document.getElementById('dispatchFleet')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('oge:sendFleetResult', {
        detail: { success: true, errorCode: null, mission: 7 },
      }));
    });
    getSend()?.click();
    await settle();
    expect(getSend()?.textContent).toContain('Sent!');
    // A store change fires the refresh subscription — but the busy lock held
    // through the post-send nav window must NOT let it repaint a stale state.
    scansStore.set({ ...scansStore.get() });
    expect(getSend()?.textContent).toContain('Sent!');
    unhook();
  });
});

// (The onScanClick integration suite was removed with the Scan half (§2d):
// there is no second zone, no in-page galaxy-submit, and no scan cooldown —
// galaxy occupancy is now sourced from the OGame public API.)

// ──────────────────────────────────────────────────────────────────
// Event reactors
// ──────────────────────────────────────────────────────────────────

describe('oge:checkTargetResult reactor', () => {
  // The reactor downgrades an EXISTING 'empty' colonize candidate from the
  // checkTarget DETAIL alone — never the fleetDispatcher snapshot (which is one
  // checkTarget behind this synchronous handler). Each case seeds the slot as
  // 'empty' first, since the reactor only ever downgrades, never creates.
  /** @param {number} [pos] */
  const seedEmpty = (pos = 8) =>
    scansStore.set({
      '4:30': { scannedAt: 1000, positions: { [pos]: { status: 'empty' } } },
    });

  it('errorCodes[0]=140016 on an empty candidate → marks it Reserved', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty();
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCodes: [140016], ships: { 208: 1 } },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('reserved');
    // Original scannedAt preserved (downgrade in place, not a fresh entry).
    expect(scansStore.get()['4:30']?.scannedAt).toBe(1000);
  });

  it('orders["7"]=false (inhabited, no errorCode) on an empty candidate → Abandoned', () => {
    // This is the soft-lock case: the DB still shows the slot 'empty' but the
    // game reports colonize is not allowed (someone lives there now). The
    // reactor reads orders straight from the detail and downgrades the slot so
    // findNextColonizeTarget stops proposing it.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty();
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 4, system: 30, position: 8,
          errorCode: null, orders: { 7: false }, ships: { 208: 1 },
        },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('abandoned');
  });

  it('marks from the DETAIL even when the snapshot is a stale, different target', () => {
    // Regression guard for the soft-lock root cause: the fleetDispatcher
    // snapshot is published one microtask AFTER this synchronous handler, so it
    // always lags by one checkTarget. The OLD code read coords/orders from it
    // and bailed on the coord mismatch (snapshot still on the PREVIOUS target),
    // so the dead candidate was never marked → wait→Stale→nothing forever. The
    // detail is authoritative for its own coords, so we mark from it regardless.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty(); // 4:30:8 empty — the candidate we just tried
    // Snapshot still describes the PREVIOUS target (4:31:8), reported colonizable.
    setFleetDispatcher(makeFleetDispatcher({
      target: { galaxy: 4, system: 31, position: 8 },
      canColonize: true,
    }));
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 4, system: 30, position: 8,
          errorCode: null, orders: { 7: false }, ships: { 208: 1 },
        },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('abandoned');
  });

  it('orders["7"]=true (colonizable) → leaves the empty candidate alone', () => {
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty();
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 4, system: 30, position: 8,
          errorCode: null, orders: { 7: true },
        },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('empty');
  });

  it('errorCode 140008 (player on vacation, no orders) → marks Abandoned', () => {
    // A checkTarget FAILURE: status "failure", errors:[{error:140008}], NO
    // orders map. Earlier this fell through every branch (not 140016, not a
    // success-with-orders) → unmarked → retarget rewrote the same coords →
    // the game deduped checkTarget → wait→timeout forever. Now any target-side
    // error (≠140035) downgrades the slot so the next tap moves on.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty();
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: 4, system: 30, position: 8, errorCode: 140008 },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('abandoned');
  });

  it('errorCode 140035 (no colony ship) → does NOT mark the slot', () => {
    // 140035 means "you lack a colony ship", not "the slot is bad" — so the
    // reactor leaves the DB alone (the user can build/move a ship and retry).
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    seedEmpty();
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 4, system: 30, position: 8,
          errorCode: 140035, orders: { 7: false },
        },
      }),
    );
    expect(scansStore.get()['4:30']?.positions?.[8]?.status).toBe('empty');
  });

  it('un-colonizable result on a slot with no empty candidate → no phantom entry', () => {
    // The reactor only ever DOWNGRADES an existing 'empty' candidate. A result
    // for a slot we never proposed (not in scans) must not create an entry —
    // that would falsely mark the whole system scan-fresh.
    setupScene({ onFleetdispatch: true, mission: 7 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 9, system: 9, position: 9,
          errorCode: null, orders: { 7: false },
        },
      }),
    );
    expect(scansStore.get()['9:9']).toBeUndefined();
  });
});

describe('oge:colonizeSent reactor', () => {
  it('marks the sent slot empty_sent in scansStore + NO auto-redirect', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    // Preload scansStore with TWO candidates — if auto-redirect fired
    // we'd observe a nav to the next one.
    scansStore.set({
      '4:31': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
      '4:32': { scannedAt: Date.now(), positions: { 8: { status: 'empty' } } },
    });
    installSendColony();
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
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    // No galaxy/system/position → no-op.
    document.dispatchEvent(
      new CustomEvent('oge:colonizeSent', { detail: { galaxy: 'oops' } }),
    );
    expect(Object.keys(scansStore.get())).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// onSendHold — manual skip (hold-to-skip)
// ──────────────────────────────────────────────────────────────────

describe('onSendHold — manual skip', () => {
  it('is a no-op when no candidate is shown (empty scansStore)', () => {
    setupScene(); // overview, no galaxy view → derive finds no candidate
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony(); // refresh() → lastDerivedCandidate = null
    _onSendHoldForTest();
    expect(Object.keys(scansStore.get())).toHaveLength(0);
  });

  it('skips the ARMED candidate via a taken decision without dispatching', async () => {
    // The skip is only available after tap 1 armed a target (in the idle
    // state the hold is a no-op — no visible hint, no known target). Arm
    // [4:30:9] through the courier, then hold to skip it. The skip now records
    // a durable `taken` DECISION (not the old scansStore empty_sent write) so
    // it also blocks API-only candidates that have no scan entry.
    setupScene({ onFleetdispatch: true });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    galaxyScanConfigStore.set({ ...galaxyScanConfigStore.get(), positions: '9' });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 9: { status: 'empty' } } },
    });
    installSendColony();
    // Open the eventbox-readiness gate so the button accepts taps.
    document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
    const unhook = armCourier({ errorCode: null, missionOk: true });
    getSend()?.click(); // tap 1 — arms [4:30:9]
    await settle();
    expect(getSend()?.textContent).toContain('Send!');
    let clicks = 0;
    document.getElementById('dispatchFleet')?.addEventListener('click', () => (clicks += 1));
    _onSendHoldForTest();
    // The decision log now blocks 4:30:9 (taken), so the picker stops proposing it.
    expect(colonizeDecisionsStore.get()['4:30:9']?.s).toBe(DEC_TAKEN);
    expect(blockingCoords(colonizeDecisionsStore.get(), Date.now()).has('4:30:9')).toBe(true);
    expect(clicks).toBe(0); // skipped, not dispatched
    unhook();
  });

  it('is a no-op in the idle (un-armed) state even with a derivable candidate', () => {
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 30 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    galaxyScanConfigStore.set({ ...galaxyScanConfigStore.get(), positions: '9' });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 9: { status: 'empty' } } },
    });
    installSendColony();
    _onSendHoldForTest(); // nothing armed → nothing skipped
    expect(scansStore.get()['4:30']?.positions[9]?.status).toBe('empty');
  });

  it('does not trigger any navigation', () => {
    setupScene({ onGalaxy: true, galaxyG: 4, galaxyS: 30 });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    galaxyScanConfigStore.set({ ...galaxyScanConfigStore.get(), positions: '9' });
    scansStore.set({
      '4:30': { scannedAt: Date.now(), positions: { 9: { status: 'empty' } } },
    });
    installSendColony();
    _onSendHoldForTest();
    expect(navTarget).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Ticker — 1 Hz repaint drives waitGap countdown
// ──────────────────────────────────────────────────────────────────

// (The live waitGap countdown was dropped with the courier migration —
// min-gap now shows a static "Wait Ns" the user re-taps past. The 1 Hz
// ticker still repaints the scan + candidate labels.)

// ──────────────────────────────────────────────────────────────────
// Settings reactions
// ──────────────────────────────────────────────────────────────────

describe('settings reactions', () => {
  it('fabMode toggle off → button removed; on → remounted', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    expect(getWrap()).not.toBeNull();
    settingsStore.update((s) => ({ ...s, fabMode: false }));
    expect(getWrap()).toBeNull();
    settingsStore.update((s) => ({ ...s, fabMode: true }));
    expect(getWrap()).not.toBeNull();
  });

  it('fabBtnSize change → button resizes live', () => {
    setupScene();
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    installSendColony();
    expect(getWrap()?.style.width).toBe('320px'); // default
    settingsStore.update((s) => ({ ...s, fabBtnSize: 500 }));
    expect(getWrap()?.style.width).toBe('500px');
  });
});
