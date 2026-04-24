// @vitest-environment happy-dom
//
// Behavioural tests for the stateless small-planet detector.
//
// # Coverage strategy
//
// The detector is a pure pipeline: read planetList + colMinFields →
// pick first row where `used < colMinFields` → paint banner. We test
// each stage by arranging the DOM + settings before calling
// `installSmallPlanetDetector`, then asserting the banner element's
// presence/content.
//
// Location.href is mocked the same way as in sendCol.test.js /
// newPlanetDetector.test.js — spy getter/setter so banner clicks can
// be observed without racing happy-dom's frame navigator.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installSmallPlanetDetector,
  findFirstSmallPlanet,
  _resetSmallPlanetDetectorForTest,
} from '../../src/features/smallPlanetDetector.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';

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

/** Override `location.search` the same way — needed for the
 *  "suppress on overview of cp" path.
 *  @param {string} search */
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
 * for fields. The rest of the tooltip (temperature, links) is
 * ignored but we paint it too so tests exercise realistic strings.
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

const BANNER_ID = 'oge5-small-planet-banner';

const getBanner = () =>
  /** @type {HTMLElement | null} */ (document.getElementById(BANNER_ID));

/** Restore settings to the schema defaults between tests. */
const resetSettings = () => {
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

// ── Global setup / teardown ─────────────────────────────────────────

beforeEach(() => {
  _resetSmallPlanetDetectorForTest();
  document.body.innerHTML = '';
  navTarget = null;
  mockLocationHref();
  setSearch('?page=ingame&component=overview');
  resetSettings();
});

afterEach(() => {
  _resetSmallPlanetDetectorForTest();
  document.body.innerHTML = '';
  unmockLocationHref();
  unsetSearch();
});

// ─── findFirstSmallPlanet (pure) ─────────────────────────────────────

describe('findFirstSmallPlanet', () => {
  it('returns null when planetList is empty', () => {
    document.body.innerHTML = '<div id="planetList"></div>';
    expect(findFirstSmallPlanet(200)).toBeNull();
  });

  it('returns the first row below the threshold', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 100, max: 200 },
      { cp: 102, coords: '[4:469:15]', name: 'P3', used: 50, max: 180 },
    ]);
    const hit = findFirstSmallPlanet(200);
    expect(hit).not.toBeNull();
    // P2 is the first row with used=100 < 200. P3 also qualifies but
    // the detector picks the first document-order hit, matching the
    // visible planetList order the user sees.
    expect(hit?.cp).toBe(101);
    expect(hit?.used).toBe(100);
    expect(hit?.max).toBe(200);
  });

  it('returns null when every planet is above the threshold', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 286, max: 363 },
    ]);
    expect(findFirstSmallPlanet(200)).toBeNull();
  });

  it('skips rows with a malformed tooltip instead of blocking', () => {
    // Row 100's tooltip has no "(used/max)" block at all. Row 101
    // is well-formed and small; the parser should skip 100 and
    // return 101 rather than falling over on the first error.
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
            used: 50,
            max: 180,
          })}"></a>
        </div>
      </div>
    `;
    const hit = findFirstSmallPlanet(200);
    expect(hit?.cp).toBe(101);
  });
});

// ─── install — banner behaviour ─────────────────────────────────────

describe('installSmallPlanetDetector — banner', () => {
  it('mounts the banner for the first small planet', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));

    installSmallPlanetDetector();

    const banner = getBanner();
    expect(banner).not.toBeNull();
    expect(banner?.dataset.cp).toBe('101');
    expect(banner?.textContent).toContain('[4:468:14]');
    expect(banner?.textContent).toContain('80/200');
  });

  it('does NOT mount a banner when every planet is big enough', () => {
    setupPlanetList([
      { cp: 100, coords: '[4:467:15]', name: 'P1', used: 275, max: 318 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));

    installSmallPlanetDetector();
    expect(getBanner()).toBeNull();
  });

  it('suppresses the banner when already on the overview of that cp', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));
    // Mirror the "I'm already looking at that planet" state — the
    // banner would be a no-op link, `abandonOverview` is doing the
    // work on the same page.
    setSearch('?page=ingame&component=overview&cp=101');

    installSmallPlanetDetector();
    expect(getBanner()).toBeNull();
  });

  it('click on the banner navigates to the overview URL', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));

    installSmallPlanetDetector();
    const banner = getBanner();
    expect(banner).not.toBeNull();
    banner?.click();

    expect(navTarget).toContain('component=overview');
    expect(navTarget).toContain('cp=101');
  });

  it('settings change (colMinFields bumped up) re-paints / hides', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    // Start with threshold BELOW planet's used fields — no banner.
    settingsStore.update((s) => ({ ...s, colMinFields: 50 }));
    installSmallPlanetDetector();
    expect(getBanner()).toBeNull();

    // Raise threshold above 80 — banner should appear on the subscribe
    // callback without any extra mount call.
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));
    expect(getBanner()).not.toBeNull();

    // Drop threshold back below — banner goes away again.
    settingsStore.update((s) => ({ ...s, colMinFields: 50 }));
    expect(getBanner()).toBeNull();
  });

  it('is idempotent — second call returns the same dispose', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));

    const dispose1 = installSmallPlanetDetector();
    const dispose2 = installSmallPlanetDetector();
    expect(dispose2).toBe(dispose1);

    // Only one banner in the DOM (no double-mount).
    expect(document.querySelectorAll(`#${BANNER_ID}`).length).toBe(1);
  });

  it('dispose removes the banner', () => {
    setupPlanetList([
      { cp: 101, coords: '[4:468:14]', name: 'P2', used: 80, max: 200 },
    ]);
    settingsStore.update((s) => ({ ...s, colMinFields: 200 }));

    const dispose = installSmallPlanetDetector();
    expect(getBanner()).not.toBeNull();

    dispose();
    expect(getBanner()).toBeNull();
  });
});
