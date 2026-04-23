// @vitest-environment happy-dom
//
// Behavioural tests for the new-planet detector.
//
// # Coverage strategy
//
// The detector has four observable phases (seed / prune / mark-built /
// compute-new) plus the banner UX. We test each phase in isolation by
// arranging the DOM + store + URL before calling `installNewPlanetDetector`,
// then asserting the store state and the banner element's presence or
// content.
//
// # Why we bypass `initKnownPlanetsStore`
//
// The production wire-through is a separate concern (covered by
// `state/knownPlanets.test.js`). Here we only care that the detector
// reads and writes the store correctly, so we interact with
// `knownPlanetsStore` directly and never boot the persist helper.
//
// # Location.href mocking
//
// Identical pattern to `sendCol.test.js` — we override `location.href`
// with a spy getter/setter so banner clicks can be observed without
// racing happy-dom's frame navigator.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installNewPlanetDetector,
  _resetNewPlanetDetectorForTest,
} from '../../src/features/newPlanetDetector.js';
import {
  knownPlanetsStore,
  _resetKnownPlanetsStoreForTest,
} from '../../src/state/knownPlanets.js';

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

// ── Scene helpers ────────────────────────────────────────────────────

/**
 * Paint a minimal `#planetList` containing the given planets. Each row
 * follows the real OGame shape: `.smallplanet` with `id="planet-<cp>"`,
 * a `.planet-name` span, and a `.planet-koords` span.
 *
 * @param {Array<{ cp: number, coords: string, name: string }>} planets
 * @returns {void}
 */
const setupPlanetList = (planets) => {
  document.body.innerHTML = `<div id="planetList">${planets
    .map(
      (p) => `
      <div class="smallplanet" id="planet-${p.cp}">
        <a><span class="planet-name">${p.name}</span><span class="planet-koords">${p.coords}</span></a>
      </div>
    `,
    )
    .join('')}</div>`;
};

/**
 * Add `#diameterContentField` to the DOM with the given text — mirrors
 * how the game renders `"<name> (used/max)"` in the overview sidebar.
 *
 * @param {string} text
 * @returns {void}
 */
const setDiameterField = (text) => {
  const existing = document.getElementById('diameterContentField');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'diameterContentField';
  el.textContent = text;
  document.body.appendChild(el);
};

const getBanner = () =>
  /** @type {HTMLElement | null} */ (
    document.getElementById('oge5-new-planet-banner')
  );

beforeEach(() => {
  _resetNewPlanetDetectorForTest();
  _resetKnownPlanetsStoreForTest();
  document.body.innerHTML = '';
  location.search = '';
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  _resetNewPlanetDetectorForTest();
  _resetKnownPlanetsStoreForTest();
  document.body.innerHTML = '';
  location.search = '';
  unmockLocationHref();
  navTarget = null;
});

// ──────────────────────────────────────────────────────────────────────
// Phase 1 — initial seed
// ──────────────────────────────────────────────────────────────────────

describe('first-run seeding', () => {
  it('seeds all current planets when the store is empty', () => {
    setupPlanetList([
      { cp: 101, coords: '[1:2:3]', name: 'Homeworld' },
      { cp: 102, coords: '[1:2:4]', name: 'Colony A' },
      { cp: 103, coords: '[1:2:5]', name: 'Colony B' },
    ]);
    installNewPlanetDetector();
    expect([...knownPlanetsStore.get()].sort((a, b) => a - b)).toEqual([
      101, 102, 103,
    ]);
    expect(getBanner()).toBeNull();
  });

  it('no-op when there are no current planets and the store is empty', () => {
    document.body.innerHTML = '';
    installNewPlanetDetector();
    expect(knownPlanetsStore.get().size).toBe(0);
    expect(getBanner()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — detect + banner
// ──────────────────────────────────────────────────────────────────────

describe('new-planet detection', () => {
  it('shows a banner for the only new planet when others are known', () => {
    knownPlanetsStore.set(new Set([1, 2]));
    setupPlanetList([
      { cp: 1, coords: '[1:2:3]', name: 'A' },
      { cp: 2, coords: '[1:2:4]', name: 'B' },
      { cp: 3, coords: '[4:30:8]', name: 'NewOne' },
    ]);
    installNewPlanetDetector();
    const banner = getBanner();
    expect(banner).not.toBeNull();
    // Text includes coords AND name.
    expect(banner?.textContent).toContain('[4:30:8]');
    expect(banner?.textContent).toContain('NewOne');
    expect(banner?.textContent).toContain('Nowa planeta');
  });

  it('shows the banner for the FIRST new planet only when multiple are new', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'Home' },
      { cp: 2, coords: '[2:2:2]', name: 'FirstNew' },
      { cp: 3, coords: '[3:3:3]', name: 'SecondNew' },
      { cp: 4, coords: '[4:4:4]', name: 'ThirdNew' },
    ]);
    installNewPlanetDetector();
    const banner = getBanner();
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('FirstNew');
    expect(banner?.textContent).not.toContain('SecondNew');
    expect(banner?.textContent).not.toContain('ThirdNew');
    // Exactly one banner in the document.
    expect(
      document.querySelectorAll('#oge5-new-planet-banner').length,
    ).toBe(1);
  });

  it('hides the banner when on the overview of the new cp', () => {
    knownPlanetsStore.set(new Set([1, 2]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'B' },
      { cp: 3, coords: '[4:30:8]', name: 'NewOne' },
    ]);
    location.search = '?page=ingame&component=overview&cp=3';
    // Without a diameter field (or with usedFields=0) the planet stays
    // "new" — we're testing the banner-suppression branch, not the
    // mark-built branch.
    setDiameterField('NewOne (0/150)');
    installNewPlanetDetector();
    // Banner is suppressed — redundant to link to the page we're on.
    expect(getBanner()).toBeNull();
    // And since usedFields === 0, the planet was NOT added to known.
    expect(knownPlanetsStore.get().has(3)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — mark-built on overview
// ──────────────────────────────────────────────────────────────────────

describe('mark-built on overview', () => {
  it('adds cp to known when on overview of that cp and usedFields > 0', () => {
    knownPlanetsStore.set(new Set([1, 2]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'B' },
      { cp: 3, coords: '[4:30:8]', name: 'NewOne' },
    ]);
    location.search = '?page=ingame&component=overview&cp=3';
    setDiameterField('NewOne (10/150)');
    installNewPlanetDetector();
    expect(knownPlanetsStore.get().has(3)).toBe(true);
    // Banner should NOT appear — cp 3 was just confirmed.
    expect(getBanner()).toBeNull();
  });

  it('does NOT add cp when usedFields === 0 (user still undecided)', () => {
    knownPlanetsStore.set(new Set([1, 2]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'B' },
      { cp: 3, coords: '[4:30:8]', name: 'NewOne' },
    ]);
    location.search = '?page=ingame&component=overview&cp=3';
    setDiameterField('NewOne (0/150)');
    installNewPlanetDetector();
    expect(knownPlanetsStore.get().has(3)).toBe(false);

    // Now navigate away — banner reappears for that planet.
    _resetNewPlanetDetectorForTest();
    location.search = '?page=ingame&component=overview&cp=1';
    installNewPlanetDetector();
    const banner = getBanner();
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('NewOne');
  });

  it('does nothing when the diameter field is absent', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 9, coords: '[9:9:9]', name: 'Ghost' },
    ]);
    location.search = '?page=ingame&component=overview&cp=9';
    // No diameter field mounted — mark-built should skip.
    installNewPlanetDetector();
    expect(knownPlanetsStore.get().has(9)).toBe(false);
    // Banner suppressed (we're on its overview).
    expect(getBanner()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — cleanup abandoned
// ──────────────────────────────────────────────────────────────────────

describe('abandoned-planet cleanup', () => {
  it('removes stored CPs that are no longer in the planet list', () => {
    // User had 3 planets; now only 2 remain (cp 3 abandoned since last run).
    knownPlanetsStore.set(new Set([1, 2, 3]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'B' },
    ]);
    installNewPlanetDetector();
    expect([...knownPlanetsStore.get()].sort((a, b) => a - b)).toEqual([1, 2]);
    // No banner — all current planets are known.
    expect(getBanner()).toBeNull();
  });

  it('keeps the set intact when no planets were abandoned', () => {
    knownPlanetsStore.set(new Set([1, 2]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'B' },
    ]);
    installNewPlanetDetector();
    expect([...knownPlanetsStore.get()].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Banner click → navigation
// ──────────────────────────────────────────────────────────────────────

describe('banner click', () => {
  it('navigates to the overview URL for the new cp', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 7, coords: '[4:30:8]', name: 'Freshly' },
    ]);
    installNewPlanetDetector();
    const banner = getBanner();
    expect(banner).not.toBeNull();
    banner?.click();
    expect(navTarget).toBeTruthy();
    expect(navTarget).toContain('component=overview');
    expect(navTarget).toContain('cp=7');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Install / dispose / idempotency
// ──────────────────────────────────────────────────────────────────────

describe('install / dispose', () => {
  it('dispose removes the banner', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'New' },
    ]);
    const dispose = installNewPlanetDetector();
    expect(getBanner()).not.toBeNull();
    dispose();
    expect(getBanner()).toBeNull();
  });

  it('dispose is idempotent (second call is a no-op)', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'New' },
    ]);
    const dispose = installNewPlanetDetector();
    dispose();
    expect(() => dispose()).not.toThrow();
    expect(getBanner()).toBeNull();
  });

  it('second install returns the same dispose fn without re-running', () => {
    knownPlanetsStore.set(new Set([1]));
    setupPlanetList([
      { cp: 1, coords: '[1:1:1]', name: 'A' },
      { cp: 2, coords: '[2:2:2]', name: 'New' },
    ]);
    const d1 = installNewPlanetDetector();
    const d2 = installNewPlanetDetector();
    expect(d2).toBe(d1);
    // Still exactly one banner.
    expect(
      document.querySelectorAll('#oge5-new-planet-banner').length,
    ).toBe(1);
  });
});
