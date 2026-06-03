// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard FS Routes clickable editor. We mock
// chrome.storage with a Map-backed fake, inject the tab's markup, then drive
// real clicks / select-changes and assert the observable output: rendered
// cards, the inventory hint, the saved chrome.storage payload, DSL apply, and
// revert.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
  // routes.js now imports syncRequestKeyFor from sync/scheduler.js, which
  // transitively pulls gist.js + logger.js — both read `safeLS` at import
  // time. Provide a no-op stub so the module graph loads under the mock.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
import { installRoutes } from '../../../src/features/dashboard/routes.js';
import { TARGET_PLANET, TARGET_MOON, SHIP_LARGE_CARGO } from '../../../src/domain/rules.js';

const mockStore = /** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

const UNI = 's163-pl';
const ROUTES_KEY = `${UNI}:oge_fsRoutes`;
const BODIES_KEY = `${UNI}:oge_bodies`;

/** @type {Map<string, unknown>} */
const store = new Map();

const MARKUP = `
  <p id="routesInvStatus"></p>
  <div id="routesList"></div>
  <button id="routesAddBtn"></button>
  <button id="routesSaveBtn"></button>
  <button id="routesRevertBtn"></button>
  <span id="routesStatus"></span>
  <details>
    <textarea id="routesDsl"></textarea>
    <button id="routesDslApply"></button>
    <span id="routesDslStatus"></span>
  </details>`;

const planet = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
  ({ galaxy: g, system: s, position: p, type: TARGET_PLANET });
const moon = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
  ({ galaxy: g, system: s, position: p, type: TARGET_MOON });

/** @param {Array<{cp:number,name:string,galaxy:number,system:number,position:number,type:number}>} bodies */
const seedBodies = (bodies) => store.set(BODIES_KEY, { bodies, capturedAt: 1 });
/** @param {any[]} routes @param {any} [collectTarget] */
const seedRoutes = (routes, collectTarget = null) => store.set(ROUTES_KEY, { routes, collectTarget });

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const install = () => installRoutes({ getUniverseId: () => UNI });

const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const list = () => $('#routesList');
/** Pick `value` in the first select with the given data-role and fire change. */
const pick = (/** @type {string} */ role, /** @type {string} */ value) => {
  const sel = /** @type {HTMLSelectElement} */ (list().querySelector(`[data-role="${role}"]`));
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  store.clear();
  mockStore.get.mockReset();
  mockStore.set.mockReset();
  mockStore.get.mockImplementation((/** @type {string} */ k) => Promise.resolve(store.get(k)));
  mockStore.set.mockImplementation((/** @type {string} */ k, /** @type {unknown} */ v) => {
    store.set(k, v);
    return Promise.resolve();
  });
  document.body.innerHTML = MARKUP;
});

describe('render from storage', () => {
  it('renders a card per route and labels endpoints from the inventory', async () => {
    seedBodies([
      { cp: 100, name: 'P1', ...planet(4, 467, 15) },
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8), planet(9, 9, 9)], microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 } },
    ]);
    install().refresh();
    await flush();

    const txt = list().textContent || '';
    expect(txt).toContain('K1'); // source labelled from inventory
    expect(txt).toContain('P2'); // valid target labelled
    // 9:9:9 isn't in the inventory → flagged stale.
    expect(txt).toContain('⚠');
    expect(txt).toContain('9:9:9');
    expect($('#routesInvStatus').textContent).toContain('2 planet(s) + 1 moon(s)');
  });

  it('shows the "open the game" hint and disables pickers when no inventory exists', async () => {
    seedBodies([]);
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], microFleet: { shipId: SHIP_LARGE_CARGO, count: 1 } }]);
    install().refresh();
    await flush();

    expect($('#routesInvStatus').textContent).toContain('No planet/moon inventory');
    const srcSel = /** @type {HTMLSelectElement} */ (list().querySelector('[data-role="add-source"]'));
    expect(srcSel.disabled).toBe(true);
  });
});

describe('build a route by clicking', () => {
  it('adds a route, picks a source + target, and saves the array (preserving collectTarget)', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([], moon(4, 472, 15)); // in-game collect target must survive

    install().refresh();
    await flush();

    $('#routesAddBtn').click();           // new empty route → card with pickers
    pick('add-source', '4:467:15:3');     // pick moon K1 as source
    pick('add-target', '5:172:8:1');      // pick planet P2 as target
    $('#routesSaveBtn').click();
    await flush();

    expect(store.get(ROUTES_KEY)).toEqual({
      routes: [
        {
          sources: [moon(4, 467, 15)],
          targets: [planet(5, 172, 8)],
          microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
        },
      ],
      collectTarget: moon(4, 472, 15),
    });
    expect($('#routesStatus').textContent).toContain('Saved 1 route');
    // Save also stamps the cross-device sync clock and pokes any open game
    // tab to push to the gist (whole-universe newest-wins).
    expect(typeof store.get(`${UNI}:oge_fsRoutesTs`)).toBe('number');
    expect(store.has(`${UNI}:oge_syncRequestAt`)).toBe(true);
  });

  it('drops an incomplete route (no targets) on save and says so', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3'); // source but no target → incomplete
    $('#routesSaveBtn').click();
    await flush();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes).toEqual([]);
    expect($('#routesStatus').textContent).toMatch(/dropped/);
  });

  it('removes a target chip via its × button', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
      { cp: 300, name: 'P3', ...planet(6, 100, 8) },
    ]);
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8), planet(6, 100, 8)], microFleet: { shipId: SHIP_LARGE_CARGO, count: 1 } }]);
    install().refresh();
    await flush();

    // Remove the first target (P2) via its chip ×.
    const removeBtn = /** @type {HTMLElement} */ (
      list().querySelector('button[aria-label="Remove 5:172:8"]')
    );
    removeBtn.click();
    $('#routesSaveBtn').click();
    await flush();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].targets).toEqual([planet(6, 100, 8)]);
  });
});

describe('advanced DSL + revert', () => {
  it('Apply parses the DSL into editor cards', async () => {
    seedBodies([]);
    seedRoutes([]);
    install().refresh();
    await flush();

    /** @type {HTMLTextAreaElement} */ ($('#routesDsl')).value =
      '4:472:15m = DT x15000 -> 4:475:14, 4:480:8m';
    $('#routesDslApply').click();

    expect(list().textContent).toContain('4:472:15');
    expect(list().textContent).toContain('4:475:14');
    expect($('#routesDslStatus').textContent).toContain('Applied 1 route');
  });

  it('Revert restores the last loaded routes', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], microFleet: { shipId: SHIP_LARGE_CARGO, count: 1 } }]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click(); // dirty: now 2 cards
    expect(list().querySelectorAll('button').length).toBeGreaterThan(0);
    $('#routesRevertBtn').click();

    // Back to exactly one route's worth of content.
    expect($('#routesStatus').textContent).toContain('Reverted');
    expect(list().textContent).toContain('K1');
  });
});
