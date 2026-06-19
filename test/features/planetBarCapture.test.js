// @vitest-environment happy-dom
//
// Behavioural tests for the planet-bar capture feature. The module reads
// `#planetList` (the in-game left bar) and writes a {@link Body} snapshot to
// `bodiesStore`. We drive a representative `#planetList` through happy-dom
// and assert the observable output (the stored snapshot), not internals.
//
// Tests bypass `initBodiesStore` and use `bodiesStore` directly (same
// approach as the colony-recorder suite), so `whenBodiesHydrated()` is the
// pre-resolved sentinel and the deferred capture fires on the next
// microtask — hence the `await Promise.resolve()` after each install.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installPlanetBarCapture,
  _resetPlanetBarCaptureForTest,
  bodiesFromRow,
  readPlanetBar,
} from '../../src/features/planetBarCapture.js';
import { bodiesStore, disposeBodiesStore } from '../../src/state/bodies.js';
import { dailyRunRoutesStore, disposeDailyRunRoutesStore } from '../../src/state/dailyRunRoutes.js';
import { TARGET_PLANET, TARGET_MOON } from '../../src/domain/rules.js';

const HOST = 'https://s163-pl.ogame.gameforge.com/game/index.php';
const fd = (/** @type {number} */ cp) =>
  `${HOST}?page=ingame&component=fleetdispatch&cp=${cp}`;

/**
 * One `.smallplanet` row markup: a planet (id `planet-<cp>`, name, koords),
 * plus an optional moon anchor sharing the planet's coords.
 *
 * @param {{ cp: number, name: string, koords: string,
 *   moon?: { cp: number, name: string } }} p
 * @returns {string}
 */
const planetRow = ({ cp, name, koords, moon }) => `
  <div class="smallplanet" id="planet-${cp}">
    <a class="planetlink" href="${fd(cp)}">
      <span class="planet-name">${name}</span>
      <span class="planet-koords">${koords}</span>
    </a>
    ${moon ? `
      <a class="moonlink" href="${fd(moon.cp)}">
        <img alt="${moon.name}" class="icon-moon">
      </a>` : ''}
  </div>`;

/**
 * Paint a `#planetList` with the given rows. Pass `null` to paint a page
 * with no planet bar at all.
 *
 * @param {string[] | null} rows
 * @returns {void}
 */
const setupBar = (rows) => {
  document.body.innerHTML =
    rows === null ? '<div id="other"></div>' : `<div id="planetList">${rows.join('')}</div>`;
};

/** Drain the hydrate-gate + reconcile microtask chain. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = '';
  disposeBodiesStore();
  bodiesStore.set({ bodies: [], capturedAt: 0 });
  disposeDailyRunRoutesStore();
  dailyRunRoutesStore.set({ routes: [], collectTarget: null });
  _resetPlanetBarCaptureForTest();
});

afterEach(() => {
  disposeBodiesStore();
  bodiesStore.set({ bodies: [], capturedAt: 0 });
  disposeDailyRunRoutesStore();
  dailyRunRoutesStore.set({ routes: [], collectTarget: null });
  _resetPlanetBarCaptureForTest();
});

describe('bodiesFromRow', () => {
  it('extracts a planet and its moon (moon shares the planet coords)', () => {
    setupBar([planetRow({ cp: 100, name: 'P1', koords: '[4:467:15]', moon: { cp: 101, name: 'K1' } })]);
    const row = /** @type {Element} */ (document.querySelector('.smallplanet'));
    expect(bodiesFromRow(row)).toEqual([
      { cp: 100, name: 'P1', galaxy: 4, system: 467, position: 15, type: 1 },
      { cp: 101, name: 'K1', galaxy: 4, system: 467, position: 15, type: 3 },
    ]);
  });

  it('extracts only the planet when no moon anchor is present', () => {
    setupBar([planetRow({ cp: 200, name: 'P2', koords: '[5:172:8]' })]);
    const row = /** @type {Element} */ (document.querySelector('.smallplanet'));
    expect(bodiesFromRow(row)).toEqual([
      { cp: 200, name: 'P2', galaxy: 5, system: 172, position: 8, type: 1 },
    ]);
  });

  it('returns nothing for a row with no parseable koords', () => {
    document.body.innerHTML = '<div class="smallplanet" id="planet-1"></div>';
    const row = /** @type {Element} */ (document.querySelector('.smallplanet'));
    expect(bodiesFromRow(row)).toEqual([]);
  });
});

describe('readPlanetBar', () => {
  it('reads every row, planets and moons, in document order', () => {
    setupBar([
      planetRow({ cp: 100, name: 'P1', koords: '[4:467:15]', moon: { cp: 101, name: 'K1' } }),
      planetRow({ cp: 200, name: 'P2', koords: '[5:172:8]' }),
    ]);
    expect(readPlanetBar().map((b) => [b.cp, b.type])).toEqual([
      [100, 1], [101, 3], [200, 1],
    ]);
  });

  it('returns [] when the bar is absent', () => {
    setupBar(null);
    expect(readPlanetBar()).toEqual([]);
  });
});

describe('installPlanetBarCapture', () => {
  it('captures the bar into bodiesStore on the synchronous path', async () => {
    setupBar([
      planetRow({ cp: 100, name: 'P1', koords: '[4:467:15]', moon: { cp: 101, name: 'K1' } }),
      planetRow({ cp: 200, name: 'P2', koords: '[5:172:8]' }),
    ]);
    const before = Date.now();
    installPlanetBarCapture();
    await Promise.resolve();

    const inv = bodiesStore.get();
    expect(inv.bodies.map((b) => b.cp)).toEqual([100, 101, 200]);
    expect(inv.capturedAt).toBeGreaterThanOrEqual(before);
    expect(inv.capturedAt).toBeLessThanOrEqual(Date.now());
  });

  it('never persists an empty capture (no bar) — store stays untouched', async () => {
    setupBar(null);
    installPlanetBarCapture();
    await Promise.resolve();
    expect(bodiesStore.get()).toEqual({ bodies: [], capturedAt: 0 });
  });

  it('does not wipe a prior snapshot when the bar reads empty', async () => {
    const prior = {
      bodies: [{ cp: 9, name: 'old', galaxy: 1, system: 1, position: 1, type: 1 }],
      capturedAt: 42,
    };
    bodiesStore.set(prior);
    setupBar([]); // #planetList present but with zero rows
    installPlanetBarCapture();
    await Promise.resolve();
    expect(bodiesStore.get()).toEqual(prior);
  });

  it('is idempotent — repeat installs return the same handle and capture once', async () => {
    setupBar([planetRow({ cp: 100, name: 'P1', koords: '[4:467:15]' })]);
    const d1 = installPlanetBarCapture();
    const d2 = installPlanetBarCapture();
    expect(d2).toBe(d1);
    await Promise.resolve();
    expect(bodiesStore.get().bodies).toHaveLength(1);
  });
});

describe('installPlanetBarCapture — route reconciliation', () => {
  const moon = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
    ({ galaxy: g, system: s, position: p, type: TARGET_MOON });
  const planet = (/** @type {number} */ g, /** @type {number} */ s, /** @type {number} */ p) =>
    ({ galaxy: g, system: s, position: p, type: TARGET_PLANET });
  const fleet = [{ shipId: 203, count: 15000 }];

  // Bar: planet+moon at 4:467:15, planet at 5:172:8.
  const fullBar = () => setupBar([
    planetRow({ cp: 100, name: 'P1', koords: '[4:467:15]', moon: { cp: 101, name: 'K1' } }),
    planetRow({ cp: 200, name: 'P2', koords: '[5:172:8]' }),
  ]);

  it('prunes a route target whose body is gone from the bar', async () => {
    dailyRunRoutesStore.set({
      routes: [{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8), planet(9, 9, 9)], fleet }],
      collectTarget: null,
    });
    fullBar();
    installPlanetBarCapture();
    await flush();
    const routes = dailyRunRoutesStore.get().routes;
    expect(routes).toHaveLength(1);
    expect(routes[0].targets).toEqual([planet(5, 172, 8)]); // 9:9:9 pruned
  });

  it('removes a route whose only source no longer exists', async () => {
    dailyRunRoutesStore.set({
      routes: [{ sources: [moon(6, 6, 6)], targets: [planet(5, 172, 8)], fleet }],
      collectTarget: null,
    });
    fullBar();
    installPlanetBarCapture();
    await flush();
    expect(dailyRunRoutesStore.get().routes).toEqual([]);
  });

  it('leaves routes untouched (same reference) when every endpoint still exists', async () => {
    const routes = [{ sources: [moon(4, 467, 15)], targets: [planet(5, 172, 8)], fleet }];
    dailyRunRoutesStore.set({ routes, collectTarget: null });
    fullBar();
    installPlanetBarCapture();
    await flush();
    expect(dailyRunRoutesStore.get().routes[0]).toBe(routes[0]);
  });

  it('does not touch routes when the capture is empty (no bar)', async () => {
    const routes = [{ sources: [moon(6, 6, 6)], targets: [planet(9, 9, 9)], fleet }];
    dailyRunRoutesStore.set({ routes, collectTarget: null });
    setupBar(null); // no inventory captured → reconcile must not run
    installPlanetBarCapture();
    await flush();
    expect(dailyRunRoutesStore.get().routes).toBe(routes); // untouched, dead endpoints kept
  });
});
