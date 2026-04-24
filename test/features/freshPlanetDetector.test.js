// @vitest-environment happy-dom
//
// Behavioural tests for the stateless fresh-planet detector.
//
// # Coverage strategy
//
// The detector is a pure pipeline: scan planetList → pick first row
// with `usedFields === 0` → paint banner. We test each stage by
// arranging the DOM before calling `installFreshPlanetDetector`, then
// asserting the banner element's presence/content.
//
// Location.href is mocked the same way as in other feature tests —
// spy getter/setter so banner clicks can be observed without racing
// happy-dom's frame navigator.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installFreshPlanetDetector,
  findFirstFreshPlanet,
  _resetFreshPlanetDetectorForTest,
} from '../../src/features/freshPlanetDetector.js';

// ── location.href mocking ────────────────────────────────────────────

/** @type {string | null} */
let navTarget = null;

const mockLocationHref = () => {
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get() {
      return navTarget ?? 'https://example.com/game/index.php';
    },
    set(url) {
      navTarget = String(url);
    },
  });
};

const unmockLocationHref = () => {
  delete (/** @type {any} */ (window.location)).href;
};

/** @param {string} search */
const setSearch = (search) => {
  Object.defineProperty(window.location, 'search', {
    configurable: true,
    get() {
      return search;
    },
  });
};

const unsetSearch = () => {
  delete (/** @type {any} */ (window.location)).search;
};

// ── Scene helpers ────────────────────────────────────────────────────

/**
 * Build a real-shape OGame tooltip string. The parser walks the
 * `<b>Name [g:s:p]</b>` header for coords and `DDD.DDkm (used/max)`
 * for fields.
 *
 * @param {{ coords: string, name: string, diameter: string, used: number, max: number }} p
 * @returns {string}
 */
const buildTooltip = (p) =>
  `<b>${p.name} ${p.coords}</b><br/>Forma życia: Mechy` +
  `<br/>${p.diameter}km (${p.used}/${p.max})<br>od -148 °C do -108 °C`;

/**
 * Paint a minimal `#planetList` containing the given planets. Each
 * row mimics the real OGame shape: `.smallplanet` with
 * `id="planet-<cp>"`, a `.planetlink` anchor carrying
 * `data-tooltip-title`, and the usual `.planet-name` /
 * `.planet-koords` spans.
 *
 * @param {Array<{
 *   cp: number, coords: string, name: string, diameter?: string,
 *   used: number, max: number,
 * }>} planets
 * @returns {void}
 */
const setupPlanetList = (planets) => {
  document.body.innerHTML = `<div id="planetList">${planets
    .map(
      (p) => `
      <div class="smallplanet" id="planet-${p.cp}">
        <a class="planetlink" data-tooltip-title="${buildTooltip({
          ...p,
          diameter: p.diameter ?? '16.921',
        })}">
          <span class="planet-name">${p.name}</span>
          <span class="planet-koords">${p.coords}</span>
        </a>
      </div>
    `,
    )
    .join('')}</div>`;
};

const BANNER_ID = 'oge-fresh-planet-banner';

const getBanner = () =>
  /** @type {HTMLElement | null} */ (document.getElementById(BANNER_ID));

// ── Global setup / teardown ─────────────────────────────────────────

beforeEach(() => {
  _resetFreshPlanetDetectorForTest();
  document.body.innerHTML = '';
  navTarget = null;
  mockLocationHref();
  setSearch('?page=ingame&component=overview');
});

afterEach(() => {
  _resetFreshPlanetDetectorForTest();
  document.body.innerHTML = '';
  unmockLocationHref();
  unsetSearch();
});

// ─── findFirstFreshPlanet (pure) ─────────────────────────────────────

describe('findFirstFreshPlanet', () => {
  it('returns null when planetList is empty', () => {
    document.body.innerHTML = '<div id="planetList"></div>';
    expect(findFirstFreshPlanet()).toBeNull();
  });

  it('returns the first row whose usedFields is exactly 0', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
      { cp: 102, coords: '[4:469:15]', name: 'P3', used: 0, max: 180 },
    ]);
    const hit = findFirstFreshPlanet();
    expect(hit?.cp).toBe(101);
    expect(hit?.used).toBe(0);
    expect(hit?.max).toBe(200);
  });

  it('skips a planet with ANY built field (used > 0)', () => {
    // Regression guard for the previous bug: the earlier detector
    // fired for any `used < colMinFields`, which flashed the banner
    // on legitimately-in-progress colonies. Now only pristine
    // (`used === 0`) planets qualify.
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 1, max: 200 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 50, max: 180 },
    ]);
    expect(findFirstFreshPlanet()).toBeNull();
  });

  it('skips rows with a malformed tooltip instead of blocking', () => {
    document.body.innerHTML = `
      <div id="planetList">
        <div class="smallplanet" id="planet-100">
          <a class="planetlink" data-tooltip-title="<b>P1 [4:467:15]</b>"></a>
        </div>
        <div class="smallplanet" id="planet-101">
          <a class="planetlink" data-tooltip-title="${buildTooltip({
            coords: '[4:468:14]',
            name: 'P2',
            diameter: '16.9',
            used: 0,
            max: 180,
          })}"></a>
        </div>
      </div>
    `;
    const hit = findFirstFreshPlanet();
    expect(hit?.cp).toBe(101);
  });
});

// ─── install — banner behaviour ─────────────────────────────────────

describe('installFreshPlanetDetector — banner', () => {
  it('mounts the banner for the first fresh planet', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
    ]);

    installFreshPlanetDetector();

    const banner = getBanner();
    expect(banner).not.toBeNull();
    expect(banner?.dataset.cp).toBe('101');
    expect(banner?.textContent).toContain('[4:468:14]');
    expect(banner?.textContent).toContain('0/200');
  });

  it('does NOT mount a banner when no planet is used===0', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 1, max: 200 },
    ]);

    installFreshPlanetDetector();
    expect(getBanner()).toBeNull();
  });

  it('suppresses the banner when already on the overview of that cp', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
    ]);
    setSearch('?page=ingame&component=overview&cp=101');

    installFreshPlanetDetector();
    expect(getBanner()).toBeNull();
  });

  it('click on the banner navigates to the overview URL', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
    ]);

    installFreshPlanetDetector();
    const banner = getBanner();
    banner?.click();

    expect(navTarget).toContain('component=overview');
    expect(navTarget).toContain('cp=101');
  });

  it('is idempotent — second call returns the same dispose', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
    ]);

    const dispose1 = installFreshPlanetDetector();
    const dispose2 = installFreshPlanetDetector();
    expect(dispose2).toBe(dispose1);
    expect(document.querySelectorAll(`#${BANNER_ID}`).length).toBe(1);
  });

  it('dispose removes the banner', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 0, max: 200 },
    ]);

    const dispose = installFreshPlanetDetector();
    expect(getBanner()).not.toBeNull();

    dispose();
    expect(getBanner()).toBeNull();
  });
});
