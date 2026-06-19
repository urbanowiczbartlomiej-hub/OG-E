// @ts-check

// Unit tests for the `features/dailyRun` pure core.
//
// Pure functions — no DOM, no timers, no `location`. Plain Node, no
// happy-dom. Covers coord keys, route lookup (incl. the enabled gate), and
// target picking.

import { describe, it, expect } from 'vitest';
import {
  coordKey,
  coordTypeKey,
  findRouteForBody,
  findNextMicroTarget,
  countRemainingMicroTargets,
} from '../../src/features/dailyRun/pure.js';
import {
  TARGET_PLANET,
  TARGET_MOON,
  SHIP_SMALL_CARGO,
  SHIP_LARGE_CARGO,
} from '../../src/domain/rules.js';

/**
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @param {number} type
 * @returns {import('../../src/state/dailyRunRoutes.js').TargetCoord}
 */
const tgt = (galaxy, system, position, type) => ({ galaxy, system, position, type });

describe('coordKey / coordTypeKey', () => {
  it('coordKey ignores type', () => {
    expect(coordKey(tgt(4, 475, 14, TARGET_PLANET))).toBe('4:475:14');
  });

  it('coordTypeKey includes type so planet and moon differ', () => {
    expect(coordTypeKey(tgt(4, 475, 14, TARGET_PLANET))).toBe('4:475:14:1');
    expect(coordTypeKey(tgt(4, 475, 14, TARGET_MOON))).toBe('4:475:14:3');
  });
});

describe('findNextMicroTarget', () => {
  const targets = [
    tgt(4, 475, 14, TARGET_PLANET),
    tgt(4, 475, 14, TARGET_MOON),
    tgt(4, 480, 8, TARGET_PLANET),
  ];

  it('returns the first target when nothing is in flight', () => {
    expect(findNextMicroTarget(targets, new Set())).toEqual(targets[0]);
  });

  it('skips targets that already have a deployment inbound (type-aware)', () => {
    const inFlight = new Set(['4:475:14:1']); // planet only
    // planet skipped, moon at same slot is still a valid target
    expect(findNextMicroTarget(targets, inFlight)).toEqual(targets[1]);
  });

  it('returns null when every target is covered', () => {
    const inFlight = new Set(targets.map(coordTypeKey));
    expect(findNextMicroTarget(targets, inFlight)).toBeNull();
  });

  it('is null-safe on a non-array', () => {
    // @ts-expect-error intentional bad input
    expect(findNextMicroTarget(null, new Set())).toBeNull();
  });
});

describe('countRemainingMicroTargets', () => {
  const targets = [tgt(1, 1, 1, TARGET_PLANET), tgt(1, 1, 2, TARGET_PLANET)];

  it('counts targets without an inbound deployment', () => {
    expect(countRemainingMicroTargets(targets, new Set())).toBe(2);
    expect(countRemainingMicroTargets(targets, new Set(['1:1:1:1']))).toBe(1);
    expect(countRemainingMicroTargets(targets, new Set(['1:1:1:1', '1:1:2:1']))).toBe(0);
  });
});

describe('findRouteForBody', () => {
  const routes = [
    {
      sources: [tgt(4, 472, 15, TARGET_MOON), tgt(4, 473, 15, TARGET_MOON)],
      targets: [tgt(4, 475, 14, TARGET_PLANET)],
      fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }],
    },
    {
      sources: [tgt(5, 120, 6, TARGET_PLANET)],
      targets: [tgt(5, 120, 7, TARGET_PLANET)],
      fleet: [{ shipId: SHIP_SMALL_CARGO, count: 1000 }],
    },
  ];

  it('matches a body against any source (type-aware)', () => {
    expect(findRouteForBody(routes, tgt(4, 473, 15, TARGET_MOON))).toBe(routes[0]);
    expect(findRouteForBody(routes, tgt(5, 120, 6, TARGET_PLANET))).toBe(routes[1]);
  });

  it('does not match when the type differs (planet at a moon source slot)', () => {
    expect(findRouteForBody(routes, tgt(4, 472, 15, TARGET_PLANET))).toBeNull();
  });

  it('skips a disabled route — a paused route is invisible to firing', () => {
    const paused = [
      {
        enabled: false,
        sources: [tgt(4, 472, 15, TARGET_MOON)],
        targets: [tgt(4, 475, 14, TARGET_PLANET)],
        fleet: [{ shipId: SHIP_LARGE_CARGO, count: 1 }],
      },
    ];
    expect(findRouteForBody(paused, tgt(4, 472, 15, TARGET_MOON))).toBeNull();
    // enabled:true (and an absent flag) still match.
    paused[0].enabled = true;
    expect(findRouteForBody(paused, tgt(4, 472, 15, TARGET_MOON))).toBe(paused[0]);
  });

  it('returns null for an unknown body / null body / non-array routes', () => {
    expect(findRouteForBody(routes, tgt(9, 9, 9, TARGET_PLANET))).toBeNull();
    expect(findRouteForBody(routes, null)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(findRouteForBody(null, tgt(1, 1, 1, 1))).toBeNull();
  });
});
