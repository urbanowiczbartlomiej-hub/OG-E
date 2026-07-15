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
  overviewUrl,
  readColoArrivals,
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

describe('overviewUrl', () => {
  it('builds a plain overview URL with no cp', () => {
    expect(overviewUrl()).toMatch(/\?page=ingame&component=overview$/);
  });
});

/**
 * Append `#eventContent` with the given fleet rows.
 *
 * @param {Array<{ mission: string, ret: string, arrival: string }>} rows
 * @returns {void}
 */
const stageEventList = (rows) => {
  const box = document.createElement('div');
  box.id = 'eventContent';
  box.innerHTML = `<table><tbody>${rows.map((r, i) => `
    <tr class="eventFleet" id="eventRow-${i}"
        data-mission-type="${r.mission}"
        data-return-flight="${r.ret}"
        data-arrival-time="${r.arrival}"></tr>
  `).join('')}</tbody></table>`;
  document.body.appendChild(box);
};

describe('readColoArrivals', () => {
  it('returns null when the event box is absent (unknown → use the cache)', () => {
    expect(readColoArrivals()).toBeNull();
  });

  it('returns an empty array when the box is present but has no colonization', () => {
    stageEventList([{ mission: '3', ret: 'false', arrival: '1784000100' }]); // transport
    expect(readColoArrivals()).toEqual([]);
  });

  it('collects arrival times of OUTBOUND colonization (mission 7) legs only', () => {
    stageEventList([
      { mission: '7', ret: 'false', arrival: '1784000100' }, // colonize outbound ✓
      { mission: '7', ret: 'true', arrival: '1784000200' }, // colonize RETURN ✗
      { mission: '1', ret: 'false', arrival: '1784000300' }, // attack ✗
      { mission: '7', ret: 'false', arrival: '1784000400' }, // colonize outbound ✓
    ]);
    expect(readColoArrivals()).toEqual([1784000100, 1784000400]);
  });

  it('skips rows with a non-finite / non-positive arrival time', () => {
    stageEventList([
      { mission: '7', ret: 'false', arrival: '' },
      { mission: '7', ret: 'false', arrival: '0' },
      { mission: '7', ret: 'false', arrival: '1784000500' },
    ]);
    expect(readColoArrivals()).toEqual([1784000500]);
  });
});
