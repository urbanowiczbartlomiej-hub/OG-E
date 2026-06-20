// Unit tests for the pure landing-classification core of the planet status
// markers feature (`src/features/badges/pure.js`). No DOM, no clock — plain
// functions over plain data, so this is a node-environment test (no happy-dom
// pragma).
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  groupMarkers,
  bodyKey,
  MAX_MARKERS,
  MARKER_ORDER,
  MARKER_LABEL,
  TARGET_PLANET,
  TARGET_MOON,
} from '../../../src/features/badges/pure.js';

/**
 * Build one normalised fleet leg with sane defaults; override per-test.
 *
 * @param {Partial<import('../../../src/features/badges/pure.js').BadgeLeg>} [over]
 * @returns {import('../../../src/features/badges/pure.js').BadgeLeg}
 */
const leg = (over = {}) => ({
  id: 'eventRow-1',
  missionType: '15',
  isReturn: false,
  isHostile: false,
  origin: { coords: '1:1:1', type: TARGET_PLANET },
  dest: { coords: '2:2:2', type: TARGET_PLANET },
  arrivalAt: 1000,
  shipCount: 10,
  ...over,
});

/** @param {...string} keys bodyKey strings, e.g. '1:1:1:1' @returns {Set<string>} */
const keysOf = (...keys) => new Set(keys);

describe('bodyKey', () => {
  it('composes `${coords}:${type}`', () => {
    expect(bodyKey('1:2:3', TARGET_PLANET)).toBe('1:2:3:1');
    expect(bodyKey('1:2:3', TARGET_MOON)).toBe('1:2:3:3');
  });
});

describe('constants', () => {
  it('MAX_MARKERS is 3', () => {
    expect(MAX_MARKERS).toBe(3);
  });

  it('MARKER_ORDER is the documented priority order', () => {
    expect(MARKER_ORDER).toEqual(['threat', 'fs', 'aggro', 'explore', 'logistics', 'economy']);
  });

  it('MARKER_LABEL has a label for every category', () => {
    for (const cat of MARKER_ORDER) {
      expect(typeof MARKER_LABEL[cat]).toBe('string');
      expect(MARKER_LABEL[cat].length).toBeGreaterThan(0);
    }
  });

  it('re-exports the body-type constants', () => {
    expect(TARGET_PLANET).toBe(1);
    expect(TARGET_MOON).toBe(3);
  });
});

describe('groupMarkers — landing body', () => {
  it('an outbound leg lands at its dest', () => {
    const myKeys = keysOf(bodyKey('2:2:2', TARGET_PLANET));
    // origin is foreign (not mine), dest is mine, aggressive → threat there.
    const out = groupMarkers([leg({ isReturn: false, missionType: '1' })], myKeys);
    expect([...out.keys()]).toEqual([bodyKey('2:2:2', TARGET_PLANET)]);
    expect(out.get(bodyKey('2:2:2', TARGET_PLANET))?.[0].category).toBe('threat');
  });

  it('a return leg lands back at its origin (home)', () => {
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    // My expedition flying home: origin mine, return → lands at origin.
    const out = groupMarkers([leg({ isReturn: true, missionType: '15' })], myKeys);
    expect([...out.keys()]).toEqual([bodyKey('1:1:1', TARGET_PLANET)]);
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('explore');
  });

  it('attaches no marker when the landing body is not mine', () => {
    // outbound, dest not in myKeys → nothing (origin mine is irrelevant here).
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    const out = groupMarkers([leg({ isReturn: false, missionType: '15' })], myKeys);
    expect(out.size).toBe(0);
  });

  it('distinguishes planet from moon at the same coords', () => {
    // My fleet lands at a MOON; only the moon key is mine.
    const myKeys = keysOf(bodyKey('2:2:2', TARGET_MOON), bodyKey('1:1:1', TARGET_PLANET));
    const planetLand = groupMarkers(
      [leg({ dest: { coords: '2:2:2', type: TARGET_PLANET } })],
      myKeys,
    );
    expect(planetLand.size).toBe(0); // planet at 2:2:2 is not mine
    const moonLand = groupMarkers(
      [leg({ dest: { coords: '2:2:2', type: TARGET_MOON } })],
      myKeys,
    );
    expect(moonLand.has(bodyKey('2:2:2', TARGET_MOON))).toBe(true);
  });

  it('skips a leg whose landing coords are empty', () => {
    const myKeys = keysOf(bodyKey('', TARGET_PLANET));
    const out = groupMarkers(
      [leg({ isReturn: false, dest: { coords: '', type: TARGET_PLANET } })],
      myKeys,
    );
    expect(out.size).toBe(0);
  });
});

describe('groupMarkers — foreign arrivals (threat)', () => {
  /** @type {Set<string>} */
  const myKeys = keysOf(bodyKey('2:2:2', TARGET_PLANET));

  it.each([['1'], ['2'], ['6'], ['9']])(
    'a foreign aggressive arrival (mission %s) → threat',
    (mission) => {
      const out = groupMarkers(
        [leg({ origin: { coords: '9:9:9', type: TARGET_PLANET }, missionType: mission })],
        myKeys,
      );
      expect(out.get(bodyKey('2:2:2', TARGET_PLANET))?.[0].category).toBe('threat');
    },
  );

  it.each([['3'], ['4'], ['5'], ['8'], ['15']])(
    'a foreign non-aggressive arrival (mission %s) → no marker',
    (mission) => {
      const out = groupMarkers(
        [leg({ origin: { coords: '9:9:9', type: TARGET_PLANET }, missionType: mission })],
        myKeys,
      );
      expect(out.size).toBe(0);
    },
  );
});

describe('groupMarkers — my own fleets', () => {
  // origin AND landing both mine: lands home on a return leg.
  /** @type {Set<string>} */
  const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));

  /**
   * @param {string} mission
   * @param {Partial<import('../../../src/features/badges/pure.js').BadgeLeg>} [over]
   */
  const ownReturn = (mission, over = {}) =>
    leg({ isReturn: true, missionType: mission, ...over });

  it.each([['1'], ['2'], ['6'], ['9']])('my aggressive fleet (mission %s) → aggro', (mission) => {
    const out = groupMarkers([ownReturn(mission)], myKeys);
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('aggro');
  });

  it.each([['3'], ['4'], ['5']])('my logistics fleet (mission %s) → logistics', (mission) => {
    const out = groupMarkers([ownReturn(mission)], myKeys);
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('logistics');
  });

  it('my expedition (mission 15) → explore', () => {
    const out = groupMarkers([ownReturn('15')], myKeys);
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('explore');
  });

  it('my recycle (mission 8) → economy', () => {
    const out = groupMarkers([ownReturn('8')], myKeys);
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('economy');
  });

  it('fsIds membership (by leg.id) wins over aggro', () => {
    const out = groupMarkers(
      [ownReturn('1', { id: 'eventRow-42' })],
      myKeys,
      new Set(['eventRow-42']),
    );
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('fs');
  });

  it('fsIds only applies to the matching leg id', () => {
    const out = groupMarkers(
      [ownReturn('1', { id: 'eventRow-7' })],
      myKeys,
      new Set(['eventRow-999']),
    );
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('aggro');
  });
});

describe('groupMarkers — excluded missions', () => {
  /** @type {Set<string>} */
  const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET), bodyKey('2:2:2', TARGET_PLANET));

  it.each([['7'], ['18']])('mission %s is never a marker (own fleet)', (mission) => {
    const out = groupMarkers([leg({ isReturn: true, missionType: mission })], myKeys);
    expect(out.size).toBe(0);
  });

  it.each([['7'], ['18']])('mission %s is never a marker (foreign arrival)', (mission) => {
    const out = groupMarkers(
      [leg({ origin: { coords: '9:9:9', type: TARGET_PLANET }, missionType: mission })],
      myKeys,
    );
    expect(out.size).toBe(0);
  });
});

describe('groupMarkers — ordering & cap', () => {
  it('one marker per category, ordered by MARKER_ORDER', () => {
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    // own returns: economy(8), explore(15), logistics(3) — present out of order.
    const out = groupMarkers(
      [
        leg({ isReturn: true, missionType: '8', id: 'eventRow-1' }),
        leg({ isReturn: true, missionType: '15', id: 'eventRow-2' }),
        leg({ isReturn: true, missionType: '3', id: 'eventRow-3' }),
      ],
      myKeys,
    );
    const cats = out.get(bodyKey('1:1:1', TARGET_PLANET))?.map((m) => m.category);
    expect(cats).toEqual(['explore', 'logistics', 'economy']);
  });

  it('caps at MAX_MARKERS, dropping the lowest-priority overflow', () => {
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    // Build >3 categories on one body:
    //   threat (foreign aggressive arriving home), fs, aggro, explore,
    //   logistics, economy. Top 3 by priority = threat, fs, aggro.
    const legs = [
      // foreign aggressive arriving at my home → threat
      leg({
        id: 'eventRow-t',
        isReturn: false,
        missionType: '1',
        origin: { coords: '9:9:9', type: TARGET_PLANET },
        dest: { coords: '1:1:1', type: TARGET_PLANET },
      }),
      // my fleet, flagged fs → fs
      leg({ id: 'eventRow-fs', isReturn: true, missionType: '3' }),
      // my aggressive return → aggro
      leg({ id: 'eventRow-a', isReturn: true, missionType: '1' }),
      // my expedition return → explore
      leg({ id: 'eventRow-e', isReturn: true, missionType: '15' }),
      // my logistics return → logistics
      leg({ id: 'eventRow-l', isReturn: true, missionType: '4' }),
      // my recycle return → economy
      leg({ id: 'eventRow-ec', isReturn: true, missionType: '8' }),
    ];
    const out = groupMarkers(legs, myKeys, new Set(['eventRow-fs']));
    const cats = out.get(bodyKey('1:1:1', TARGET_PLANET))?.map((m) => m.category);
    expect(cats).toHaveLength(MAX_MARKERS);
    expect(cats).toEqual(['threat', 'fs', 'aggro']);
  });
});

describe('groupMarkers — fleets detail', () => {
  it("carries each leg's TileFleet fields", () => {
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    const out = groupMarkers(
      [
        leg({
          isReturn: true,
          missionType: '15',
          origin: { coords: '1:1:1', type: TARGET_PLANET },
          dest: { coords: '5:5:5', type: TARGET_PLANET },
          arrivalAt: 4242,
          shipCount: 77,
        }),
      ],
      myKeys,
    );
    const fleet = out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].fleets[0];
    expect(fleet).toEqual({
      origin: '1:1:1',
      dest: '5:5:5',
      isReturn: true,
      arrivalAt: 4242,
      shipCount: 77,
    });
  });

  it('stacks multiple legs of the same category into one marker', () => {
    const myKeys = keysOf(bodyKey('1:1:1', TARGET_PLANET));
    const out = groupMarkers(
      [
        leg({ id: 'eventRow-1', isReturn: true, missionType: '15', shipCount: 1 }),
        leg({ id: 'eventRow-2', isReturn: true, missionType: '15', shipCount: 2 }),
        leg({ id: 'eventRow-3', isReturn: true, missionType: '15', shipCount: 3 }),
      ],
      myKeys,
    );
    const markers = out.get(bodyKey('1:1:1', TARGET_PLANET));
    expect(markers).toHaveLength(1);
    expect(markers?.[0].category).toBe('explore');
    expect(markers?.[0].fleets.map((f) => f.shipCount)).toEqual([1, 2, 3]);
  });
});

describe('groupMarkers — independent bodies', () => {
  it('groups legs onto their own landing bodies', () => {
    const myKeys = keysOf(
      bodyKey('1:1:1', TARGET_PLANET),
      bodyKey('2:2:2', TARGET_PLANET),
    );
    const out = groupMarkers(
      [
        leg({ isReturn: true, missionType: '15', origin: { coords: '1:1:1', type: TARGET_PLANET } }),
        leg({ isReturn: true, missionType: '3', origin: { coords: '2:2:2', type: TARGET_PLANET } }),
      ],
      myKeys,
    );
    expect(out.get(bodyKey('1:1:1', TARGET_PLANET))?.[0].category).toBe('explore');
    expect(out.get(bodyKey('2:2:2', TARGET_PLANET))?.[0].category).toBe('logistics');
  });
});
