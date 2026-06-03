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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('mounts the unified button with three zones when fsCollectMode is on', () => {
    enable();
    installFsCollect();
    expect(document.getElementById('oge-fs-unified')).not.toBeNull();
    expect(document.getElementById('oge-fs-micro-zone')).not.toBeNull();
    expect(document.getElementById('oge-fs-target-zone')).not.toBeNull();
    expect(document.getElementById('oge-fs-collect-zone')).not.toBeNull();
  });

  it('removes the button when the toggle flips off at runtime', () => {
    enable();
    installFsCollect();
    settingsStore.set({ ...settingsStore.get(), fsCollectMode: false });
    expect(document.getElementById('oge-fs-unified')).toBeNull();
  });
});

describe('set collect target (via long-press on middle zone)', () => {
  it('writes the current body (from meta tags) as collectTarget on long-press', async () => {
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    const targetZone = /** @type {HTMLElement} */ (document.getElementById('oge-fs-target-zone'));
    targetZone.dispatchEvent(new PointerEvent('pointerdown'));
    // Simulate long-press: wait 300ms, then pointerup.
    await new Promise((resolve) => setTimeout(resolve, 350));
    targetZone.dispatchEvent(new PointerEvent('pointerup'));
    expect(fsRoutesStore.get().collectTarget).toEqual({
      galaxy: 4, system: 472, position: 15, type: TARGET_MOON,
    });
  });
});

describe('micro send — navigation (top zone)', () => {
  it('navigates to the next route target preloading the micro-fleet', () => {
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({
      routes: {
        '4:472:15': {
          targets: [{ galaxy: 4, system: 475, position: 14, type: TARGET_PLANET }],
          microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
        },
      },
      collectTarget: null,
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone')).click();
    expect(navTarget).toContain('galaxy=4&system=475&position=14&type=1&mission=4');
    expect(navTarget).toContain(`am${SHIP_LARGE_CARGO}=15000`);
  });

  it('skips a target that already has a deployment inbound', () => {
    enable();
    installFsCollect();
    setBodyMeta('4:472:15', 'moon');
    fsRoutesStore.set({
      routes: {
        '4:472:15': {
          targets: [
            { galaxy: 4, system: 475, position: 14, type: TARGET_PLANET },
            { galaxy: 4, system: 480, position: 8, type: TARGET_PLANET },
          ],
          microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
        },
      },
      collectTarget: null,
    });
    // An inbound deployment to the first target (planet 4:475:14).
    // insertAdjacentHTML appends WITHOUT reparsing the body, so the
    // already-mounted button keeps its click/drag listeners.
    document.body.insertAdjacentHTML('beforeend', `
      <table id="eventContent"><tbody>
        <tr class="eventFleet" data-mission-type="4" data-return-flight="false">
          <td class="coordsOrigin"><a>[4:472:15]</a></td>
          <td class="destFleet"><figure class="planetIcon planet"></figure></td>
          <td class="destCoords"><a>[4:475:14]</a></td>
        </tr>
      </tbody></table>`);
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-micro-zone')).click();
    // First target skipped → navigates to the second (4:480:8).
    expect(navTarget).toContain('system=480&position=8');
  });
});

describe('collect send — navigation + dispatch (bottom zone)', () => {
  it('navigates to buildCollectUrl(target) when idle on a planet', () => {
    enable();
    installFsCollect();
    fsRoutesStore.set({
      routes: {},
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
    });
    /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone')).click();
    expect(navTarget).toContain('galaxy=4&system=472&position=15&type=3&mission=4');
    expect(navTarget).not.toMatch(/&am\d+=/);
  });

  it('on step 2 stashes oge_fsRedirect and clicks the native dispatch button', () => {
    enable();
    installFsCollect();
    location.search = '?page=ingame&component=fleetdispatch&cp=100&mission=4&galaxy=4&system=472&position=15&type=3';
    fsRoutesStore.set({
      routes: {},
      collectTarget: { galaxy: 4, system: 472, position: 15, type: TARGET_MOON },
    });
    // Planet list (via insertAdjacentHTML — preserves the mounted button's
    // listeners) + step-2 controls created with a real click spy.
    document.body.insertAdjacentHTML('beforeend', `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-100"><span class="planet-koords">[4:472:15]</span></div>
        <div class="smallplanet" id="planet-200"><span class="planet-koords">[4:480:8]</span></div>
      </div>`);
    let dispatched = false;
    const dispatch = document.createElement('a');
    dispatch.id = 'dispatchFleet';
    dispatch.addEventListener('click', () => { dispatched = true; });
    document.body.appendChild(dispatch);
    const resources = document.createElement('a');
    resources.id = 'allresources';
    document.body.appendChild(resources);

    /** @type {HTMLElement} */ (document.getElementById('oge-fs-collect-zone')).click();
    expect(dispatched).toBe(true);
    expect(localStorage.getItem(FS_REDIRECT_KEY)).toContain('cp=200');
  });
});
