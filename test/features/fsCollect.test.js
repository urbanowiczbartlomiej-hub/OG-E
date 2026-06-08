// @vitest-environment happy-dom
//
// Behavioral tests for the fsCollect orchestrator (the unified floating
// button with three zones: micro, target, collect). We drive real clicks
// and long-press through happy-dom and assert observable outputs: mount/unmount,
// the collect-target write via long-press, and the navigations / dispatch +
// redirect handoff. The pure URL/target logic and the redirect bridge are
// covered by their own unit tests; here we prove the wiring.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installFsCollect,
  _resetFsCollectForTest,
} from '../../src/features/fsCollect/index.js';
import { settingsStore } from '../../src/state/settings.js';
import { SETTINGS_SCHEMA } from '../../src/state/settings.js';
import {
  fsRoutesStore,
  _resetFsRoutesStoreForTest,
  FS_REDIRECT_KEY,
} from '../../src/state/fsRoutes.js';
import { TARGET_PLANET, TARGET_MOON, SHIP_LARGE_CARGO } from '../../src/domain/rules.js';

// ── location.href spy (mirrors sendExp.test.js) ──────────────────────────
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
  _resetFsCollectForTest();
  _resetFsRoutesStoreForTest();
  resetSettingsToDefaults();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  navTarget = null;
  localStorage.clear();
  location.search = '?page=ingame&component=overview&cp=100';
  mockLocationHref();
});

afterEach(() => {
  _resetFsCollectForTest();
  unmockLocationHref();
  localStorage.clear();
});

const enable = () => {
  settingsStore.set({ ...settingsStore.get(), fsCollectMode: true });
};

describe('mount / unmount', () => {
  it('does not mount when fsCollectMode is off', () => {
    installFsCollect();
    expect(document.getElementById('oge-fs-unified')).toBeNull();
  });

  it('mounts the unified button with two zones when fsCollectMode is on', () => {
    enable();
    installFsCollect();
    expect(document.getElementById('oge-fs-unified')).not.toBeNull();
    expect(document.getElementById('oge-fs-micro-zone')).not.toBeNull();
    expect(document.getElementById('oge-fs-collect-zone')).not.toBeNull();
    // The dedicated middle target zone is gone — folded into Collect.
    expect(document.getElementById('oge-fs-target-zone')).toBeNull();
  });

  it('removes the button when the toggle flips off at runtime', () => {
    enable();
    installFsCollect();
    settingsStore.set({ ...settingsStore.get(), fsCollectMode: false });
    expect(document.getElementById('oge-fs-unified')).toBeNull();
  });
});

describe('set collect target (via long-press on the Collect zone)', () => {
  it('writes the current body (from meta tags) as collectTarget on long-press', async () => {
    vi.useFakeTimers();
    try {
      enable();
      installFsCollect();
      setBodyMeta('4:472:15', 'moon');
      const collectZone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
      collectZone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
      // Advance past the 3000ms long-press threshold.
      await vi.advanceTimersByTimeAsync(3100);
      collectZone.dispatchEvent(new PointerEvent('pointerup'));
      expect(fsRoutesStore.get().collectTarget).toEqual({
        galaxy: 4, system: 472, position: 15, type: TARGET_MOON,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quick tap collects instead of setting the target', () => {
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 480, position: 8, type: TARGET_PLANET },
    });
    const collectZone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    // pointerdown + immediate pointerup (no long-press) then click → collect.
    collectZone.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    collectZone.dispatchEvent(new PointerEvent('pointerup'));
    collectZone.click();
    // Target unchanged (no long-press fired) and we navigated to a BARE
    // fleetdispatch — the courier sets ships+target in-page (no params).
    expect(fsRoutesStore.get().collectTarget).toEqual({
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
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: TARGET_MOON }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
        },
      ],
      collectTarget: null,
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone')).click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
    expect(navTarget).not.toMatch(/&am\d+=/);
  });

  it('flashes "All sent" and does not navigate when every target is inbound', () => {
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({
      routes: [
        {
          sources: [{ galaxy: 4, system: 472, position: 15, type: TARGET_MOON }],
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
        },
      ],
      collectTarget: null,
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
    const micro = /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone'));
    micro.click();
    expect(navTarget).toBeNull();
    expect(micro.textContent).toContain('All sent');
  });

  it('does not navigate when no route matches the current body', () => {
    // With no route for this body, the Send zone is a "set up" affordance:
    // it opens the dashboard (when the runtime URL resolves) and otherwise
    // flashes "No route". Either way it must NOT build a deploy navigation.
    // The dashboard URL is unresolved in tests (no chrome.runtime), so this
    // exercises the fallback branch.
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({ routes: [], collectTarget: null });
    const micro = /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone'));
    micro.click();
    expect(navTarget).toBeNull();
    expect(micro.textContent).toContain('No route');
  });
});

describe('collect send — navigation + dispatch (bottom zone)', () => {
  it('navigates to a bare fleetdispatch when idle with a collect target', () => {
    enable();
    installFsCollect();
    fsRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone')).click();
    expect(navTarget).toContain('component=fleetdispatch');
    expect(navTarget).not.toMatch(/galaxy=/);
  });

  /**
   * Build a step-2 fleetdispatch DOM (planet list + dispatch/resources
   * controls). The dispatch click fires a fake game sendFleet result with
   * `success`, mirroring bridges/sendFleetResultHook.
   *
   * @param {boolean} success
   * @param {number | null} [errorCode]
   * @returns {{ clicks: () => number }}
   */
  const buildStep2 = (success, errorCode = null) => {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-100"><span class="planet-koords">[4:472:15]</span></div>
        <div class="smallplanet" id="planet-200"><span class="planet-koords">[4:480:8]</span></div>
      </div>`);
    let clicks = 0;
    const dispatch = document.createElement('a');
    dispatch.id = 'dispatchFleet'; // ready (no .off)
    dispatch.addEventListener('click', () => {
      clicks += 1;
      document.dispatchEvent(new CustomEvent('oge:sendFleetResult', {
        detail: { success, errorCode, mission: 4 },
      }));
    });
    document.body.appendChild(dispatch);
    const resources = document.createElement('a');
    resources.id = 'allresources';
    document.body.appendChild(resources);
    return { clicks: () => clicks };
  };

  it('on step 2 stashes oge_fsRedirect and dispatches on a successful send', async () => {
    enable();
    installFsCollect();
    fsRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
    });
    const spy = buildStep2(true);
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone')).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(spy.clicks()).toBe(1);
    // Success → redirect to the next collect planet survives.
    expect(localStorage.getItem(FS_REDIRECT_KEY)).toContain('cp=200');
  });

  it('on a rejected send (no fuel) drops the redirect and flashes the error', async () => {
    enable();
    installFsCollect();
    fsRoutesStore.set({
      routes: [],
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
    });
    buildStep2(false, 140026);
    const zone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone'));
    zone.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem(FS_REDIRECT_KEY)).toBeNull();
    expect(zone.textContent).toContain('No fuel');
  });
});
