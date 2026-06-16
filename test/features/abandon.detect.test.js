// @vitest-environment happy-dom
//
// Unit tests for the fresh-planet detection helpers used by the colony FAB.
//
// @ts-check

import { describe, it, expect, afterEach } from 'vitest';
import {
  findFirstFreshPlanet,
  getOverviewCp,
  buildOverviewUrl,
} from '../../src/features/abandon/detect.js';

/**
 * Append a `#planetList` with the given rows. Each row's tooltip carries the
 * `[g:s:p] DDDkm (used/max)` shape the parser reads.
 *
 * @param {Array<{ cp: number, coords: string, name?: string, used: number, max: number }>} rows
 * @returns {void}
 */
const stagePlanetList = (rows) => {
  const list = document.createElement('div');
  list.id = 'planetList';
  list.innerHTML = rows.map((r) => `
    <div class="smallplanet" id="planet-${r.cp}">
      <a class="planetlink" data-tooltip-title="${r.name ?? 'P'} ${r.coords} 9.000km (${r.used}/${r.max})">
        <span class="planet-name">${r.name ?? ''}</span>
      </a>
    </div>
  `).join('');
  document.body.appendChild(list);
};

afterEach(() => {
  document.body.innerHTML = '';
  location.search = '';
});

describe('findFirstFreshPlanet', () => {
  it('returns the first row with used === 0', () => {
    stagePlanetList([
      { cp: 1001, coords: '[1:2:3]', name: 'Built', used: 50, max: 200 },
      { cp: 1002, coords: '[1:2:4]', name: 'Fresh', used: 0, max: 163 },
      { cp: 1003, coords: '[1:2:5]', name: 'AlsoFresh', used: 0, max: 180 },
    ]);
    const p = findFirstFreshPlanet();
    expect(p).not.toBeNull();
    expect(p?.cp).toBe(1002);
    expect(p?.coords).toBe('[1:2:4]');
    expect(p?.max).toBe(163);
  });

  it('returns null when every planet has buildings', () => {
    stagePlanetList([{ cp: 1001, coords: '[1:2:3]', used: 12, max: 200 }]);
    expect(findFirstFreshPlanet()).toBeNull();
  });

  it('returns null for an empty / absent planet list', () => {
    expect(findFirstFreshPlanet()).toBeNull();
  });

  it('with belowFields, skips fresh colonies at/above the threshold', () => {
    stagePlanetList([
      { cp: 1001, coords: '[1:2:3]', used: 0, max: 400 }, // fresh but large
      { cp: 1002, coords: '[1:2:4]', used: 0, max: 163 }, // fresh and small
    ]);
    // No filter → first fresh (the large one).
    expect(findFirstFreshPlanet()?.cp).toBe(1001);
    // belowFields=320 → skips the large one, returns the small one.
    expect(findFirstFreshPlanet({ belowFields: 320 })?.cp).toBe(1002);
    // belowFields below both → nothing qualifies.
    expect(findFirstFreshPlanet({ belowFields: 100 })).toBeNull();
  });
});

describe('getOverviewCp', () => {
  it('returns the cp when on the overview page', () => {
    location.search = '?page=ingame&component=overview&cp=1002';
    expect(getOverviewCp()).toBe(1002);
  });

  it('returns null off the overview page', () => {
    location.search = '?page=ingame&component=galaxy&cp=1002';
    expect(getOverviewCp()).toBeNull();
  });

  it('returns null when cp is missing or invalid', () => {
    location.search = '?page=ingame&component=overview';
    expect(getOverviewCp()).toBeNull();
  });
});

describe('buildOverviewUrl', () => {
  it('builds an overview URL for a cp, dropping any stale query tail', () => {
    expect(buildOverviewUrl(1002)).toMatch(/\?page=ingame&component=overview&cp=1002$/);
  });
});
