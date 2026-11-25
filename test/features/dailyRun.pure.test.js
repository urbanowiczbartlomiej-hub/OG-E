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
  SPY_SAVE_POSITION,
  microLegs,
  isMicroLegSent,
  planMicro,
  spyFleet,
  pairTarget,
  pairedOriginKeys,
} from '../../src/features/dailyRun/pure.js';
import {
  TARGET_PLANET,
  TARGET_MOON,
  SHIP_SMALL_CARGO,
  SHIP_LARGE_CARGO,
  SHIP_ESPIONAGE_PROBE,
  MISSION_DEPLOYMENT,
  MISSION_TRANSPORT,
  MISSION_ESPIONAGE,
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

describe('microLegs (own-body target → Spy-16)', () => {
  const hub = tgt(4, 470, 15, TARGET_MOON);
  const other = tgt(4, 480, 15, TARGET_MOON);
  const route = { targets: [hub, other], mission: MISSION_TRANSPORT };

  it('keeps every other target as-is with the route mission', () => {
    expect(microLegs(route, other, true)).toEqual([
      { target: hub, mission: MISSION_TRANSPORT, spy: false },
      { target: tgt(4, 480, SPY_SAVE_POSITION, TARGET_PLANET), mission: MISSION_ESPIONAGE, spy: true },
    ]);
  });

  it('turns the body itself into Espionage to [g:s:16] of its own system', () => {
    const legs = microLegs(route, hub, true);
    expect(legs[0]).toEqual({ target: tgt(4, 470, 16, TARGET_PLANET), mission: MISSION_ESPIONAGE, spy: true });
    expect(legs[1]).toEqual({ target: other, mission: MISSION_TRANSPORT, spy: false });
  });

  it('drops the own-body leg when there is no probe to fly it', () => {
    expect(microLegs(route, hub, false)).toEqual([{ target: other, mission: MISSION_TRANSPORT, spy: false }]);
  });

  it('defaults the mission to deployment', () => {
    expect(microLegs({ targets: [other] }, hub, true)[0].mission).toBe(MISSION_DEPLOYMENT);
  });
});

describe('isMicroLegSent / planMicro', () => {
  const hub = tgt(4, 470, 15, TARGET_MOON);
  const other = tgt(4, 480, 15, TARGET_MOON);
  const spot = tgt(4, 470, 16, TARGET_PLANET);
  const route = { targets: [hub, other], mission: MISSION_DEPLOYMENT };

  it('counts a normal leg as sent by any inbound fleet of its mission to its target', () => {
    const leg = { target: other, mission: MISSION_DEPLOYMENT, spy: false };
    expect(isMicroLegSent(leg, hub, [{ origin: null, dest: other, mission: MISSION_DEPLOYMENT }])).toBe(true);
    expect(isMicroLegSent(leg, hub, [{ origin: null, dest: other, mission: MISSION_TRANSPORT }])).toBe(false);
  });

  it('counts a Spy-16 leg only when it flies from THIS body', () => {
    const leg = { target: spot, mission: MISSION_ESPIONAGE, spy: true };
    const fromHub = { origin: hub, dest: spot, mission: MISSION_ESPIONAGE };
    const fromPlanet = { origin: tgt(4, 470, 15, TARGET_PLANET), dest: spot, mission: MISSION_ESPIONAGE };
    expect(isMicroLegSent(leg, hub, [fromHub])).toBe(true);
    expect(isMicroLegSent(leg, hub, [fromPlanet])).toBe(false);
    expect(isMicroLegSent(leg, hub, [{ origin: null, dest: spot, mission: MISSION_ESPIONAGE }])).toBe(false);
  });

  it('plans the next unsent leg in route order and counts what is left', () => {
    expect(planMicro(route, hub, [], true)).toEqual({
      next: { target: spot, mission: MISSION_ESPIONAGE, spy: true }, left: 2,
    });
    const afterSpy = planMicro(route, hub, [{ origin: hub, dest: spot, mission: MISSION_ESPIONAGE }], true);
    expect(afterSpy).toEqual({ next: { target: other, mission: MISSION_DEPLOYMENT, spy: false }, left: 1 });
    const done = planMicro(route, hub, [
      { origin: hub, dest: spot, mission: MISSION_ESPIONAGE },
      { origin: hub, dest: other, mission: MISSION_DEPLOYMENT },
    ], true);
    expect(done).toEqual({ next: null, left: 0 });
  });
});

describe('spyFleet', () => {
  it('adds one probe to a fleet without any', () => {
    expect(spyFleet([{ shipId: SHIP_LARGE_CARGO, count: 5 }])).toEqual([
      { shipId: SHIP_LARGE_CARGO, count: 5 },
      { shipId: SHIP_ESPIONAGE_PROBE, count: 1 },
    ]);
  });

  it('leaves a fleet that already carries probes alone', () => {
    const fleet = [{ shipId: SHIP_ESPIONAGE_PROBE, count: 3 }];
    expect(spyFleet(fleet)).toBe(fleet);
  });
});

describe('pairTarget / pairedOriginKeys (Drop / Up)', () => {
  it('maps a moon to its planet and a planet to its moon', () => {
    expect(pairTarget(tgt(4, 470, 15, TARGET_MOON))).toEqual(tgt(4, 470, 15, TARGET_PLANET));
    expect(pairTarget(tgt(4, 470, 15, TARGET_PLANET))).toEqual(tgt(4, 470, 15, TARGET_MOON));
  });

  it('collects origins of same-slot deployments only', () => {
    const moon = tgt(4, 470, 15, TARGET_MOON);
    const planet = tgt(4, 470, 15, TARGET_PLANET);
    const keys = pairedOriginKeys([
      { origin: moon, dest: planet, mission: MISSION_DEPLOYMENT }, // Drop ✓
      { origin: tgt(5, 1, 1, TARGET_PLANET), dest: tgt(5, 1, 1, TARGET_MOON), mission: MISSION_TRANSPORT }, // not deployment ✗
      { origin: tgt(6, 1, 1, TARGET_MOON), dest: tgt(6, 2, 1, TARGET_PLANET), mission: MISSION_DEPLOYMENT }, // other slot ✗
      { origin: null, dest: planet, mission: MISSION_DEPLOYMENT }, // unknown origin ✗
    ]);
    expect([...keys]).toEqual(['4:470:15:3']);
  });
});
