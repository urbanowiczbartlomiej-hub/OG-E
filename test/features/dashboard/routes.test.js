// @vitest-environment happy-dom
//
// Behavioural tests for the dashboard FS Routes clickable editor. We mock
// chrome.storage with a Map-backed fake, inject the tab's markup, then drive
// real clicks / select-changes and assert the observable output: rendered
// cards, the inventory hint, and the AUTOSAVED chrome.storage payload (the
// editor persists on a debounced autosave — there is no Save button; tests
// advance fake timers past the debounce via settle()).
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/storage.js', () => ({
  chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
  // routes.js now imports syncRequestKeyFor from sync/scheduler.js, which
  // transitively pulls gist.js + logger.js — both read `safeLS` at import
  // time. Provide a no-op stub so the module graph loads under the mock.
  safeLS: { bool: () => false, get: () => null, set: () => {}, remove: () => {}, json: () => null, setJSON: () => {} },
}));

import { chromeStore } from '../../../src/lib/storage.js';
import { installRoutes } from '../../../src/features/dashboard/routes.js';
import { TARGET_PLANET, TARGET_MOON, SHIP_LARGE_CARGO, SHIP_SMALL_CARGO, MISSION_TRANSPORT, MISSION_DEPLOYMENT } from '../../../src/domain/rules.js';

const mockStore = /** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */ (
  /** @type {any} */ (chromeStore)
);

const UNI = 's163-pl';
const ROUTES_KEY = `${UNI}:oge_dailyRunRoutes`;
const BODIES_KEY = `${UNI}:oge_bodies`;

/** @type {Map<string, unknown>} */
const store = new Map();

const MARKUP = `
  <p id="routesInvStatus"></p>
  <div id="routesList"></div>
  <button id="routesAddBtn"></button>
  <span id="routesStatus"></span>
  <div class="chip-group seg" id="routesCollectMission" data-value="4">
    <button type="button" data-value="4">Deployment</button>
    <button type="button" data-value="3">Transport</button>
  </div>
  <div class="chip-group seg" id="routesCollectShips" data-value="most">
    <button type="button" data-value="most">Most</button>
    <button type="button" data-value="all">All</button>
  </div>
  <div class="chip-group seg" id="routesCollectResources" data-value="most">
    <button type="button" data-value="most">Most</button>
    <button type="button" data-value="all">All</button>
  </div>`;

const planet = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
  ({ galaxy: g, system: s, position: p, type: TARGET_PLANET });
const moon = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
  ({ galaxy: g, system: s, position: p, type: TARGET_MOON });

/** @param {Array<{cp:number,name:string,galaxy:number,system:number,position:number,type:number}>} bodies */
const seedBodies = (bodies) => store.set(BODIES_KEY, { bodies, capturedAt: 1 });
/** @param {any[]} routes @param {any} [collectTarget] */
const seedRoutes = (routes, collectTarget = null) => store.set(ROUTES_KEY, { routes, collectTarget });

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** Run the debounced autosave: advance past its 600 ms window, then flush. */
const settle = async () => { vi.advanceTimersByTime(700); await flush(); };
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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('render from storage', () => {
  it('renders a card per route and labels endpoints from the inventory', async () => {
    seedBodies([
      { cp: 100, name: 'P1', ...planet(4, 467, 15) },
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8), planet(9, 9, 9)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
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
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 1 }] }]);
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
    await settle();

    expect(store.get(ROUTES_KEY)).toEqual({
      routes: [
        {
          sources: [moon(4, 467, 15)],
          targets: [planet(5, 172, 8)],
          fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }],
        },
      ],
      collectTarget: moon(4, 472, 15),
      // Save persists the full config: the collect "Send All" defaults
      // (deployment mission + "most" ships + "most" cargo) ride along untouched.
      collectMission: MISSION_DEPLOYMENT,
      collectShips: 'most',
      collectResources: 'most',
    });
    expect($('#routesStatus').textContent).toContain('Saved 1 route');
    // Save also stamps the cross-device sync clock and pokes any open game
    // tab to push to the gist (whole-universe newest-wins).
    expect(typeof store.get(`${UNI}:oge_dailyRunRoutesTs`)).toBe('number');
    expect(store.has(`${UNI}:oge_syncRequestAt`)).toBe(true);
  });

  it('persists a route with EMPTY targets (mid-swap) — matching the domain read rule', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3'); // source + default fleet, no target yet
    await settle();

    // Persisted WITH empty targets: normalizeRoute keeps such routes (they
    // just do nothing in-game), and dropping them instead turned a target
    // swap on a saved route into a cross-device deletion.
    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes).toEqual([
      { sources: [moon(4, 467, 15)], targets: [], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
  });

  it('a sourceless card stays editor-only and does not stamp the sync clock', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([]);
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    $('#routesAddBtn').click(); // empty card: no source → not persistable
    await settle();

    // Projection unchanged vs the store → no write at all (a content-
    // identical write would still bump the newest-wins clock and could win
    // merges against a genuinely newer device).
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(list().querySelectorAll('[data-role="add-source"]').length).toBe(1);
  });

  it('clearing a ship count mid-retype never persists the route away', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    const countInp = /** @type {HTMLInputElement} */ (list().querySelector('input[type="number"]'));
    countInp.value = ''; // cleared before typing the new number
    countInp.dispatchEvent(new Event('input'));
    await settle();

    // An invalid count schedules nothing — the stored route survives intact.
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes).toHaveLength(1);
  });

  it('flushes a pending edit on universe switch instead of dropping it', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
    let uni = UNI;
    const api = installRoutes({ getUniverseId: () => uni });
    api.refresh();
    await flush();

    pick('ship', String(SHIP_SMALL_CARGO)); // schedule for UNI…
    uni = 's999-xx';                        // …then switch universes
    api.refresh();                          // flush persists for the OLD uni
    await flush();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].fleet[0].shipId)
      .toBe(SHIP_SMALL_CARGO);
    expect(store.has('s999-xx:oge_dailyRunRoutes')).toBe(false);
  });

  it('removes a target chip via its × button', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
      { cp: 300, name: 'P3', ...planet(6, 100, 8) },
    ]);
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8), planet(6, 100, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 1 }] }]);
    install().refresh();
    await flush();

    // Remove the first target (P2) via its chip ×.
    const removeBtn = /** @type {HTMLElement} */ (
      list().querySelector('button[aria-label="Remove 5:172:8"]')
    );
    removeBtn.click();
    await settle();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].targets).toEqual([planet(6, 100, 8)]);
  });
});

describe('new route options — multi-ship / mission / pause / custom target', () => {
  it('adds a second ship to the fleet and saves both entries', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3');
    pick('add-target', '5:172:8:1');
    /** @type {HTMLButtonElement} */ (list().querySelector('[data-role="add-ship"]')).click();
    expect(list().querySelectorAll('[data-role="ship"]').length).toBe(2);
    await settle();

    const saved = /** @type {any} */ (store.get(ROUTES_KEY)).routes[0];
    expect(saved.fleet).toHaveLength(2);
    // addBtn seeds Large Cargo; the add-ship button auto-picks the next
    // unused catalog ship for the second row.
    expect(saved.fleet[0].shipId).toBe(SHIP_LARGE_CARGO);
  });

  it('saves a non-default mission chosen from the dropdown', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3');
    pick('add-target', '5:172:8:1');
    pick('mission', String(MISSION_TRANSPORT));
    await settle();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].mission).toBe(MISSION_TRANSPORT);
  });

  it('pauses a route via the Enabled toggle and persists enabled:false', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 1 }] },
    ]);
    install().refresh();
    await flush();

    const toggle = /** @type {HTMLButtonElement} */ (list().querySelector('[data-role="enabled"]'));
    expect(toggle.classList.contains('on')).toBe(true);
    toggle.click(); // on → off (pause)
    await settle();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].enabled).toBe(false);
  });

  it('adds a custom external target via the custom-coords form, flagged custom', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([]);
    install().refresh();
    await flush();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3');
    // Fill the custom-coords form (its own g/s/p number inputs) and Add.
    const addCustom = /** @type {HTMLButtonElement} */ (list().querySelector('[data-role="add-custom-target"]'));
    const form = /** @type {HTMLElement} */ (addCustom.parentElement);
    const nums = form.querySelectorAll('input[type="number"]');
    /** @type {HTMLInputElement} */ (nums[0]).value = '1';
    /** @type {HTMLInputElement} */ (nums[1]).value = '99';
    /** @type {HTMLInputElement} */ (nums[2]).value = '4';
    addCustom.click();
    await settle();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].targets).toEqual([
      { galaxy: 1, system: 99, position: 4, type: TARGET_PLANET, custom: true },
    ]);
  });
});

describe('autosave', () => {
  it('a clean load never writes (no sync-clock churn from a plain repaint)', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    await settle();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('a ship-type change autosaves after the debounce', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
    install().refresh();
    await flush();

    pick('ship', String(SHIP_SMALL_CARGO));
    await settle();
    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].fleet[0].shipId).toBe(SHIP_SMALL_CARGO);
  });

  it('a ship-count edit autosaves WITHOUT stealing focus (no repaint on save)', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([
      { sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] },
    ]);
    install().refresh();
    await flush();

    const countInp = /** @type {HTMLInputElement} */ (list().querySelector('input[type="number"]'));
    countInp.value = '999';
    countInp.dispatchEvent(new Event('input'));
    await settle();

    expect(/** @type {any} */ (store.get(ROUTES_KEY)).routes[0].fleet[0].count).toBe(999);
    // The exact input element survives the save — the card was not re-rendered
    // under the user's caret.
    expect(list().querySelector('input[type="number"]')).toBe(countInp);
  });

  it('a burst of edits collapses into ONE debounced write of the route slot', async () => {
    seedBodies([
      { cp: 101, name: 'K1', ...moon(4, 467, 15) },
      { cp: 200, name: 'P2', ...planet(5, 172, 8) },
    ]);
    seedRoutes([]);
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    $('#routesAddBtn').click();
    pick('add-source', '4:467:15:3');
    pick('add-target', '5:172:8:1');
    await settle();

    const routeWrites = mockStore.set.mock.calls.filter((c) => c[0] === ROUTES_KEY);
    expect(routeWrites).toHaveLength(1);
  });
});

describe('Send All collect config chips (mission / ships / resources)', () => {
  /** Click the chip with `value` in the `#groupId` group. */
  const click = (/** @type {string} */ groupId, /** @type {string} */ value) => {
    const btn = /** @type {HTMLButtonElement} */ (
      document.querySelector(`#${groupId} button[data-value="${value}"]`)
    );
    btn.click();
  };
  /** The chip group's current value (data-value === the `.on` button). */
  const chipValue = (/** @type {string} */ groupId) =>
    /** @type {HTMLElement} */ (document.getElementById(groupId)).dataset.value;

  it('reflects the stored collect config onto the chips on refresh', async () => {
    seedRoutes([], null);
    store.set(ROUTES_KEY, { routes: [], collectTarget: null, collectMission: MISSION_TRANSPORT, collectShips: 'all', collectResources: 'all' });
    install().refresh();
    await flush();

    expect(chipValue('routesCollectMission')).toBe('3');
    expect(chipValue('routesCollectShips')).toBe('all');
    expect(chipValue('routesCollectResources')).toBe('all');
  });

  it('persists a mission change IMMEDIATELY (no Save click needed), preserving routes/collectTarget', async () => {
    seedBodies([{ cp: 101, name: 'K1', ...moon(4, 467, 15) }]);
    seedRoutes([{ sources: [moon(4, 467, 15)], targets: [], fleet: [] }], moon(4, 472, 15));
    install().refresh();
    await flush();

    click('routesCollectMission', '3'); // Transport
    await flush();

    expect(store.get(ROUTES_KEY)).toMatchObject({
      collectTarget: moon(4, 472, 15),
      collectMission: MISSION_TRANSPORT,
      collectShips: 'most',
      collectResources: 'most',
    });
    // The unsaved route-card edit state is untouched by this instant write —
    // Save is a separate, still-clean action (no incomplete-route drop noise).
    expect($('#routesStatus').textContent).not.toContain('Saved');
    // Same cross-device sync stamps the route Save uses.
    expect(typeof store.get(`${UNI}:oge_dailyRunRoutesTs`)).toBe('number');
    expect(store.has(`${UNI}:oge_syncRequestAt`)).toBe(true);
  });

  it('ignores an out-of-range mission value defensively (only 3/4 are wired here)', async () => {
    seedRoutes([]);
    install().refresh();
    await flush();
    mockStore.set.mockClear();

    // Tamper a mission chip with a rogue value and click it.
    const btn = /** @type {HTMLButtonElement} */ (document.querySelector('#routesCollectMission button[data-value="4"]'));
    btn.dataset.value = '99';
    btn.click();
    await flush();

    expect(mockStore.set).not.toHaveBeenCalledWith(ROUTES_KEY, expect.anything());
  });

  it('persists ships + resources changes independently of each other', async () => {
    seedRoutes([]);
    install().refresh();
    await flush();

    click('routesCollectShips', 'all');
    await flush();
    expect(store.get(ROUTES_KEY)).toMatchObject({ collectShips: 'all', collectResources: 'most' });

    click('routesCollectResources', 'all');
    await flush();
    expect(store.get(ROUTES_KEY)).toMatchObject({ collectShips: 'all', collectResources: 'all' });
  });
});
