// @vitest-environment happy-dom
//
// Behavioral tests for the dailyRun orchestrator (the unified floating
// button with three zones: micro, target, collect). We drive real clicks
// and long-press through happy-dom and assert observable outputs: mount/unmount,
// the collect-target write via long-press, and the navigations / dispatch +
// redirect handoff. The pure URL/target logic and the redirect bridge are
// covered by their own unit tests; here we prove the wiring.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installDailyRun,
  _resetDailyRunForTest,
} from '../../src/features/dailyRun/index.js';
import { settingsStore } from '../../src/state/settings.js';
import { SETTINGS_SCHEMA } from '../../src/state/settings.js';
import {
  dailyRunRoutesStore,
  disposeDailyRunRoutesStore,
  DAILY_RUN_REDIRECT_KEY,
} from '../../src/state/dailyRunRoutes.js';
import { TARGET_PLANET, TARGET_MOON, SHIP_LARGE_CARGO, MISSION_DEPLOYMENT } from '../../src/domain/rules.js';

/** The three "collect" config defaults every DailyRunRoutes value now carries
 * (deployment mission + "most" ships + "most" cargo). Spread into each
 * `dailyRunRoutesStore.set({...})` so the literal is a complete config. */
const COLLECT_DEFAULTS = /** @type {const} */ ({
  collectMission: MISSION_DEPLOYMENT,
  collectShips: 'most',
  collectResources: 'most',
});

// ── location.href spy (mirrors sendExpedition.test.js) ──────────────────────────
let navTarget = /** @type {string | null} */ (null);
const mockLocationHref = () => {
  const proto = Object.getPrototypeOf(window.location);
  Object.getOwnPropertyDescriptor(proto, 'href');
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get() { return navTarget ?? 'about:blank'; },
    set(url) { navTarget = String(url); },
  });
};
const unmockLocationHref = () => { delete (/** @type {any} */ (window.location)).href; };

const resetSettingsToDefaults = () => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    defaults[key] = /** @type {any} */ (SETTINGS_SCHEMA)[key].default;
  }
  settingsStore.set(/** @type {any} */ (defaults));
};

/**
 * Set the OGame per-page body meta tags so readCurrentBody resolves.
 * @param {string} coords  "g:s:p"
 * @param {'planet'|'moon'} type
 */
const setBodyMeta = (coords, type) => {
  document.head.innerHTML =
    `<meta name="ogame-planet-coordinates" content="${coords}">` +
    `<meta name="ogame-planet-type" content="${type}">`;
};

beforeEach(() => {
  _resetDailyRunForTest();
  disposeDailyRunRoutesStore();
  dailyRunRoutesStore.set({ routes: [], collectTarget: null, ...COLLECT_DEFAULTS });
  resetSettingsToDefaults();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  navTarget = null;
  localStorage.clear();
  location.search = '?page=ingame&component=overview&cp=100';
  mockLocationHref();
});

afterEach(() => {
  _resetDailyRunForTest();
  unmockLocationHref();
  localStorage.clear();
});

const enable = () => {
  settingsStore.set({ ...settingsStore.get(), fabMode: true });
};

// T13 eventbox readiness gate: fixtures mount without the game's
// `#eventContent`, so installDailyRun holds both zones in "Wait…" until
// the event list is known to be loaded. Open the gate the way the bridge
// does — by firing the `oge:eventBoxLoaded` signal after install.
const openEventBoxGate = () => {
  document.dispatchEvent(new CustomEvent('oge:eventBoxLoaded'));
};

describe('mount / unmount', () => {
  it('does not mount when fabMode is off', () => {
    // fabMode defaults to true (unlike the legacy dailyRunMode) — turn it
    // off explicitly to exercise the gate.
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    installDailyRun();
    expect(document.getElementById('oge-fs-unified')).toBeNull();
  });

  it('mounts the unified button with two zones when fabMode is on', () => {
    enable();
    installDailyRun();
    expect(document.getElementById('oge-fs-unified')).not.toBeNull();
    expect(document.getElementById('oge-fs-micro-zone')).not.toBeNull();
    expect(document.getElementById('oge-fs-collect-zone')).not.toBeNull();
    // The dedicated middle target zone is gone — folded into Collect.
    expect(document.getElementById('oge-fs-target-zone')).toBeNull();
  });

  it('removes the button when the toggle flips off at runtime', () => {
    enable();
    installDailyRun();
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    expect(document.getElementById('oge-fs-unified')).toBeNull();
  });
});

describe('set collect target (via long-press on the Collect zone)', () => {
  it('writes the current body (from meta tags) as collectTarget on long-press', async () => {
    vi.useFakeTimers();
    try {
      enable();
      installDailyRun();
      setBodyMeta('4:472:15', 'moon');
      const collectZone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
      collectZone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
      // Advance past the 2000ms long-press threshold.
      await vi.advanceTimersByTimeAsync(3100);
      collectZone.dispatchEvent(new PointerEvent('pointerup'));
      expect(dailyRunRoutesStore.get().collectTarget).toEqual({
        galaxy: 4, system: 472, position: 15, type: TARGET_MOON,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quick tap collects instead of setting the target', () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    setBodyMeta('4:472:15', 'moon');
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 480, position: 8, type: TARGET_PLANET },
      ...COLLECT_DEFAULTS,
    });
    const collectZone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    // pointerdown + immediate pointerup (no long-press) then click → collect.
    collectZone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    collectZone.dispatchEvent(new PointerEvent('pointerup'));
    collectZone.click();
    // Target unchanged (no long-press fired) and we navigated to a BARE
    // fleetdispatch — the courier sets ships+target in-page (no params).
    expect(dailyRunRoutesStore.get().collectTarget).toEqual({
      galaxy: 4, system: 480, position: 8, type: TARGET_PLANET,
    });
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
  });
});

describe('micro send — navigation (top zone)', () => {
  it('navigates to a bare fleetdispatch when a route target is available', () => {
    // With bare-URL entry the target is no longer in the URL — the courier
    // selects ships + sets the target in-page on the next tap. So idle nav
    // just lands on a bare fleetdispatch (no ship/target params).
    enable();
    installDailyRun();
    openEventBoxGate();
    setBodyMeta('4:472:15', 'moon');
    dailyRunRoutesStore.set({
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: TARGET_MOON }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }],
        },
      ],
      collectTarget: null,
      ...COLLECT_DEFAULTS,
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone')).click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
    expect(navTarget).not.toMatch(/&am\d+=/);
  });

  it('flashes "All sent" and does not navigate when every target is inbound', () => {
    enable();
    installDailyRun();
    setBodyMeta('4:472:15', 'moon');
    dailyRunRoutesStore.set({
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: TARGET_MOON }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }],
        },
      ],
      collectTarget: null,
      ...COLLECT_DEFAULTS,
    });
    // The route's only target already has an inbound deployment.
    document.body.insertAdjacentHTML('beforeend', `
      <table id="eventContent"><tbody>
        <tr class="eventFleet" data-mission-type="4" data-return-flight="false">
          <td class="coordsOrigin"><a>[4:472:15]</a></td>
          <td class="destFleet"><figure class="planetIcon planet"></figure></td>
          <td class="destCoords"><a>[4:475:14]</a></td>
        </tr>
      </tbody></table>`);
    openEventBoxGate();
    const micro = /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone'));
    micro.click();
    expect(navTarget).toBeNull();
    expect(micro.textContent).toContain('All sent');
  });

  it('mission-scoped guard: a transport route ignores a deployment leg to its target', () => {
    enable();
    installDailyRun();
    setBodyMeta('4:472:15', 'moon');
    dailyRunRoutesStore.set({
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: TARGET_MOON }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }],
          mission: 3, // transport — NOT deployment
        },
      ],
      collectTarget: null,
      ...COLLECT_DEFAULTS,
    });
    // An inbound DEPLOYMENT (mission 4) to the same target must NOT count as
    // "already sent" for a transport (mission 3) route.
    document.body.insertAdjacentHTML('beforeend', `
      <table id="eventContent"><tbody>
        <tr class="eventFleet" data-mission-type="4" data-return-flight="false">
          <td class="coordsOrigin"><a>[4:472:15]</a></td>
          <td class="destFleet"><figure class="planetIcon planet"></figure></td>
          <td class="destCoords"><a>[4:475:14]</a></td>
        </tr>
      </tbody></table>`);
    openEventBoxGate();
    const micro = /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone'));
    micro.click();
    // Target still considered available → navigates to a bare fleetdispatch.
    expect(navTarget).toContain('component=fleetdispatch');
  });

  it('does not navigate when no route matches the current body', () => {
    // With no route for this body, the Send zone is a "set up" affordance:
    // it opens the dashboard (when the runtime URL resolves) and otherwise
    // flashes "No route". Either way it must NOT build a deploy navigation.
    // The dashboard URL is unresolved in tests (no chrome.runtime), so this
    // exercises the fallback branch.
    enable();
    installDailyRun();
    openEventBoxGate();
    setBodyMeta('4:472:15', 'moon');
    dailyRunRoutesStore.set({ routes: [], collectTarget: null, ...COLLECT_DEFAULTS });
    const micro = /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone'));
    micro.click();
    expect(navTarget).toBeNull();
    expect(micro.textContent).toContain('No route');
  });
});

describe('collect send — navigation + dispatch (bottom zone)', () => {
  it('navigates to a bare fleetdispatch when idle with a collect target', () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
      ...COLLECT_DEFAULTS,
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone')).click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
  });

  /** Removes the fake MAIN executor's oge:fd:cmd listener after each test. */
  let cleanupExecutor = () => {};
  afterEach(() => {
    cleanupExecutor();
    cleanupExecutor = () => {};
  });

  /** Poll until `cond()` is truthy (real timers — the courier's own waits
   *  run on them).
   *  @param {() => unknown} cond @param {number} [timeoutMs] */
  const until = async (cond, timeoutMs = 4000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('until(): condition not met');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /**
   * Build a full two-step fleetdispatch scene: planet list, fleet1 controls
   * and a fake MAIN executor (mirrors test/features/fleetCourier.test.js).
   * Since T5, a bare step-2 DOM is a FOREIGN fleet2 the button refuses to
   * dispatch — the FS zone may only complete a fleet2 its own tap 1 armed.
   * So tap 1 walks the courier's select() through fleet1→fleet2 (claiming
   * the ownership session) and tap 2 dispatches. The dispatch click fires a
   * fake game sendFleet result with `success`, mirroring
   * bridges/sendFleetResultHook.
   *
   * @param {boolean} success
   * @param {number | null} [errorCode]
   * @returns {{ clicks: () => number }}
   */
  const buildTwoStep = (success, errorCode = null) => {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-100"><span class="planet-koords">[4:472:15]</span></div>
        <div class="smallplanet" id="planet-200"><span class="planet-koords">[4:480:8]</span></div>
      </div>
      <div id="fleet1"></div>
      <a id="allresources"></a>`);
    let clicks = 0;
    /** @type {any} */
    let lastTarget = null;
    const cont = document.createElement('a');
    cont.id = 'continueToFleet2';
    cont.className = 'off';
    cont.addEventListener('click', () => {
      document.getElementById('fleet1')?.remove();
      const dispatch = document.createElement('a');
      dispatch.id = 'dispatchFleet';
      dispatch.className = 'off'; // not ready until the mission is armed
      dispatch.addEventListener('click', () => {
        clicks += 1;
        document.dispatchEvent(new CustomEvent('oge:sendFleetResult', {
          detail: { success, errorCode, mission: 4 },
        }));
      });
      document.body.appendChild(dispatch);
      // The game fires its checkTarget as fleet2 loads.
      const t = lastTarget || {};
      document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: t.galaxy, system: t.system, position: t.position,
          errorCode: null, orders: { 4: true },
        },
      }));
    });
    document.body.appendChild(cont);
    // Fake MAIN executor answering the courier's oge:fd:cmd RPCs.
    const onCmd = (/** @type {any} */ e) => {
      const { id, op, args } = e.detail;
      /** @type {any} */
      const res = { id, ok: true };
      if (op === 'setTarget') {
        lastTarget = args;
        // AGR enables "continue" once the target is applied.
        setTimeout(() => document.getElementById('continueToFleet2')?.classList.remove('off'), 0);
      } else if (op === 'selectMission') {
        res.data = { available: true };
        setTimeout(() => document.getElementById('dispatchFleet')?.classList.remove('off'), 0);
      }
      document.dispatchEvent(new CustomEvent('oge:fd:res', { detail: res }));
    };
    document.addEventListener('oge:fd:cmd', onCmd);
    cleanupExecutor = () => document.removeEventListener('oge:fd:cmd', onCmd);
    // Ship-availability snapshot so select({ kind: 'all' }) resolves a fleet.
    document.dispatchEvent(new CustomEvent('oge:fleetDispatcher', {
      detail: { shipsOnPlanet: [{ id: 203, number: 100 }], orders: { 4: true } },
    }));
    return { clicks: () => clicks };
  };

  it('two taps: arms its own fleet2, stashes oge_dailyRunRedirect and dispatches on a successful send', async () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
      ...COLLECT_DEFAULTS,
    });
    const spy = buildTwoStep(true);
    const zone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    // Tap 1 — select all ships, walk to a ready fleet2 (claims ownership).
    zone.click();
    await until(() => zone.textContent?.includes('(tap to send)'));
    // Tap 2 — stash the redirect, then the one server-visible dispatch.
    zone.click();
    await until(() => spy.clicks() === 1);
    expect(spy.clicks()).toBe(1);
    // Success → redirect to the next collect planet survives.
    expect(localStorage.getItem(DAILY_RUN_REDIRECT_KEY)).toContain('cp=200');
  });

  it('on a rejected send (no fuel) drops the redirect and flashes the error', async () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
      ...COLLECT_DEFAULTS,
    });
    buildTwoStep(false, 140026);
    const zone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    zone.click(); // tap 1 — arm our own fleet2
    await until(() => zone.textContent?.includes('(tap to send)'));
    zone.click(); // tap 2 — dispatch, rejected by the game
    await until(() => zone.textContent?.includes('No fuel'));
    expect(localStorage.getItem(DAILY_RUN_REDIRECT_KEY)).toBeNull();
  });
});

// The collect "Send All" order builder maps the store's collect config onto the
// FleetOrder the courier executes. We can't unit-test buildOrder directly (it's
// closure-scoped), so we drive tap 1 of a collect send and read the order at the
// observable courier seam: which AGR ship control it clicked (#sendmost for
// "most" vs the selectShips RPC for "all"), which resource control (#mostresources
// vs #allresources), and the mission arg of selectMission.
describe('collect order builder — ship/resource/mission selection from store config', () => {
  /** Removes the probe executor's listener after each test. */
  let cleanupProbe = () => {};
  afterEach(() => {
    cleanupProbe();
    cleanupProbe = () => {};
  });

  /** Poll until `cond()` is truthy (real timers — the courier waits on them).
   *  @param {() => unknown} cond @param {number} [timeoutMs] */
  const until = async (cond, timeoutMs = 4000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('until(): condition not met');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /**
   * Build a fleetdispatch scene that RECORDS the order-shaping calls a collect
   * tap 1 makes: the AGR "send most" / "all resources" / "most resources"
   * clicks and the RPC ops (selectShips, selectMission). Mirrors
   * {@link buildTwoStep} but adds the resource/ship controls and a recorder.
   *
   * @returns {{ sendMost: () => number, allRes: () => number, mostRes: () => number,
   *   ops: () => Array<{ op: string, args: any }> }}
   */
  const buildOrderProbe = () => {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-100"><span class="planet-koords">[4:472:15]</span></div>
        <div class="smallplanet" id="planet-200"><span class="planet-koords">[4:480:8]</span></div>
      </div>
      <div id="fleet1"></div>
      <a id="sendmost"></a>
      <a id="allresources"></a>
      <a id="mostresources"></a>`);
    let sendMost = 0;
    let allRes = 0;
    let mostRes = 0;
    /** @type {Array<{ op: string, args: any }>} */
    const ops = [];
    document.getElementById('sendmost')?.addEventListener('click', () => { sendMost += 1; });
    document.getElementById('allresources')?.addEventListener('click', () => { allRes += 1; });
    document.getElementById('mostresources')?.addEventListener('click', () => { mostRes += 1; });
    /** @type {any} */
    let lastTarget = null;
    const cont = document.createElement('a');
    cont.id = 'continueToFleet2';
    cont.className = 'off';
    cont.addEventListener('click', () => {
      document.getElementById('fleet1')?.remove();
      const dispatch = document.createElement('a');
      dispatch.id = 'dispatchFleet';
      dispatch.className = 'off';
      document.body.appendChild(dispatch);
      const t = lastTarget || {};
      document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
        detail: { galaxy: t.galaxy, system: t.system, position: t.position, errorCode: null, orders: { 3: true, 4: true } },
      }));
    });
    document.body.appendChild(cont);
    const onCmd = (/** @type {any} */ e) => {
      const { id, op, args } = e.detail;
      ops.push({ op, args });
      /** @type {any} */
      const res = { id, ok: true };
      if (op === 'setTarget') {
        lastTarget = args;
        setTimeout(() => document.getElementById('continueToFleet2')?.classList.remove('off'), 0);
      } else if (op === 'selectMission') {
        res.data = { available: true };
        setTimeout(() => document.getElementById('dispatchFleet')?.classList.remove('off'), 0);
      }
      document.dispatchEvent(new CustomEvent('oge:fd:res', { detail: res }));
    };
    document.addEventListener('oge:fd:cmd', onCmd);
    cleanupProbe = () => document.removeEventListener('oge:fd:cmd', onCmd);
    document.dispatchEvent(new CustomEvent('oge:fleetDispatcher', {
      detail: { shipsOnPlanet: [{ id: 203, number: 100 }], orders: { 3: true, 4: true } },
    }));
    return { sendMost: () => sendMost, allRes: () => allRes, mostRes: () => mostRes, ops: () => ops };
  };

  /** Mission arg of the (last) selectMission RPC the courier issued.
   *  @param {Array<{ op: string, args: any }>} ops */
  const missionOf = (ops) => {
    const m = ops.filter((o) => o.op === 'selectMission').at(-1);
    return m ? m.args.mission : undefined;
  };

  it('most/most/mission-3 → selectMostShips (AGR send-most), most resources, mission 3', async () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
      collectMission: 3,
      collectShips: 'most',
      collectResources: 'most',
    });
    const p = buildOrderProbe();
    const zone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    zone.click(); // tap 1 — select+target+mission+resources
    await until(() => zone.textContent?.includes('(tap to send)'));
    // selectMostShips === true → AGR "send most" clicked, NO explicit selectShips.
    expect(p.sendMost()).toBe(1);
    expect(p.ops().some((o) => o.op === 'selectShips')).toBe(false);
    // resources === 'most' → #mostresources clicked, not #allresources.
    expect(p.mostRes()).toBe(1);
    expect(p.allRes()).toBe(0);
    // mission flows straight through.
    expect(missionOf(p.ops())).toBe(3);
  });

  it('all/all → explicit selectShips (not send-most) and all resources', async () => {
    enable();
    installDailyRun();
    openEventBoxGate();
    dailyRunRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
      collectMission: 4,
      collectShips: 'all',
      collectResources: 'all',
    });
    const p = buildOrderProbe();
    const zone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    zone.click();
    await until(() => zone.textContent?.includes('(tap to send)'));
    // selectMostShips === false → explicit selectShips RPC, NO AGR send-most.
    expect(p.ops().some((o) => o.op === 'selectShips')).toBe(true);
    expect(p.sendMost()).toBe(0);
    // resources === 'all' → #allresources clicked, not #mostresources.
    expect(p.allRes()).toBe(1);
    expect(p.mostRes()).toBe(0);
  });
});
