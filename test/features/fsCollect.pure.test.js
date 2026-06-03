// @ts-check

// Unit tests for the `features/fsCollect` pure core.
//
// Pure functions — no DOM, no timers, no `location`. Plain Node, no
// happy-dom. Covers coord keys, the two URL builders, and target picking.

import { describe, it, expect } from 'vitest';
import {
  coordKey,
  coordTypeKey,
  findRouteForBody,
  buildDeployUrl,
  buildCollectUrl,
  findNextMicroTarget,
  countRemainingMicroTargets,
  parseRoutesDsl,
  formatRoutesDsl,
} from '../../src/features/fsCollect/pure.js';
import {
  MISSION_DEPLOYMENT,
  TARGET_PLANET,
  TARGET_MOON,
  SHIP_SMALL_CARGO,
  SHIP_LARGE_CARGO,
  SHIP_PATHFINDER,
} from '../../src/domain/rules.js';

const BASE = 'https://s163-pl.ogame.gameforge.com/game/index.php';

/**
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @param {number} type
 * @returns {import('../../src/state/fsRoutes.js').TargetCoord}
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

describe('buildDeployUrl', () => {
  it('builds a deployment URL with target type and mission=4', () => {
    const url = buildDeployUrl(BASE, tgt(4, 472, 15, TARGET_MOON), null);
    expect(url).toBe(
      `${BASE}?page=ingame&component=fleetdispatch` +
        `&galaxy=4&system=472&position=15&type=3&mission=${MISSION_DEPLOYMENT}`,
    );
  });

  it('appends am<shipId>=count when a micro-fleet is given', () => {
    const url = buildDeployUrl(BASE, tgt(4, 475, 14, TARGET_PLANET), {
      shipId: SHIP_LARGE_CARGO,
      count: 15000,
    });
    expect(url).toContain('&type=1&mission=4');
    expect(url).toContain(`&am${SHIP_LARGE_CARGO}=15000`);
  });

  it('omits the am param for a zero or missing micro-fleet', () => {
    expect(buildDeployUrl(BASE, tgt(1, 1, 1, TARGET_PLANET), { shipId: 203, count: 0 })).not.toContain('am203');
    expect(buildDeployUrl(BASE, tgt(1, 1, 1, TARGET_PLANET), undefined)).not.toMatch(/&am\d+=/);
  });
});

describe('buildCollectUrl', () => {
  it('builds a deployment URL with no ship preload', () => {
    const url = buildCollectUrl(BASE, tgt(4, 472, 15, TARGET_MOON));
    expect(url).toBe(
      `${BASE}?page=ingame&component=fleetdispatch` +
        `&galaxy=4&system=472&position=15&type=3&mission=${MISSION_DEPLOYMENT}`,
    );
    expect(url).not.toMatch(/&am\d+=/);
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

describe('parseRoutesDsl', () => {
  it('parses a single-source route with alias ship and mixed planet/moon targets', () => {
    const { routes, errors } = parseRoutesDsl(
      '4:472:15m = DT x15000 -> 4:475:14, 4:480:8m, 5:120:6',
    );
    expect(errors).toEqual([]);
    expect(routes).toEqual([
      {
        sources: [tgt(4, 472, 15, TARGET_MOON)],
        targets: [
          tgt(4, 475, 14, TARGET_PLANET),
          tgt(4, 480, 8, TARGET_MOON),
          tgt(5, 120, 6, TARGET_PLANET),
        ],
        microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
      },
    ]);
  });

  it('parses MULTIPLE sources (planets and moons) sharing one fleet + targets', () => {
    const { routes, errors } = parseRoutesDsl(
      '4:472:15m, 4:473:15m, 5:120:6 = DT x15000 -> 4:475:14',
    );
    expect(errors).toEqual([]);
    expect(routes[0].sources).toEqual([
      tgt(4, 472, 15, TARGET_MOON),
      tgt(4, 473, 15, TARGET_MOON),
      tgt(5, 120, 6, TARGET_PLANET),
    ]);
    expect(routes[0].targets).toEqual([tgt(4, 475, 14, TARGET_PLANET)]);
  });

  it('parses a bare (no-m) source as a PLANET', () => {
    const { routes } = parseRoutesDsl('4:472:15 = DT x10 -> 1:1:1');
    expect(routes[0].sources).toEqual([tgt(4, 472, 15, TARGET_PLANET)]);
  });

  it('accepts a raw numeric ship id and the k count suffix', () => {
    const { routes } = parseRoutesDsl('1:2:3 = 202x25k -> 1:2:4');
    expect(routes[0].microFleet).toEqual({ shipId: SHIP_SMALL_CARGO, count: 25000 });
  });

  it('ignores blank lines and # comments', () => {
    const { routes, errors } = parseRoutesDsl('# header\n\n1:1:1 = PIO x100000 -> 1:1:2\n');
    expect(errors).toEqual([]);
    expect(routes).toHaveLength(1);
    expect(routes[0].microFleet.shipId).toBe(SHIP_PATHFINDER);
  });

  it('reports a malformed line but keeps the good ones', () => {
    const { routes, errors } = parseRoutesDsl('garbage line\n1:1:1 = DT x10 -> 1:1:2');
    expect(routes).toHaveLength(1);
    expect(routes[0].sources).toEqual([tgt(1, 1, 1, TARGET_PLANET)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
  });

  it('reports a bad ship, a bad target, and a bad source', () => {
    expect(parseRoutesDsl('1:1:1 = XYZ x10 -> 1:1:2').errors[0].message).toMatch(/micro-fleet/);
    expect(parseRoutesDsl('1:1:1 = DT x10 -> nope').errors[0].message).toMatch(/target/);
    expect(parseRoutesDsl('nope = DT x10 -> 1:1:2').errors[0].message).toMatch(/source/);
  });

  it('is null-safe on non-string input', () => {
    // @ts-expect-error intentional bad input
    expect(parseRoutesDsl(null)).toEqual({ routes: [], errors: [] });
  });
});

describe('formatRoutesDsl round-trip', () => {
  it('round-trips parse(format(parse(x))) to the same routes (incl. multi-source + moon sources)', () => {
    const text =
      '4:472:15m, 4:473:15m = DT x15000 -> 4:475:14, 4:480:8m\n1:2:3 = PIO x100000 -> 1:2:4';
    const once = parseRoutesDsl(text).routes;
    const reparsed = parseRoutesDsl(formatRoutesDsl(once)).routes;
    expect(reparsed).toEqual(once);
  });

  it('renders known ship ids as English aliases (SC/LC/PF) and moons with the m suffix', () => {
    const out = formatRoutesDsl([
      {
        sources: [tgt(4, 472, 15, TARGET_MOON)],
        targets: [tgt(4, 475, 14, TARGET_PLANET), tgt(4, 480, 8, TARGET_MOON)],
        microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
      },
    ]);
    expect(out).toBe('4:472:15m = LCx15000 -> 4:475:14, 4:480:8m');
  });

  it('is null-safe / empty on a non-array', () => {
    // @ts-expect-error intentional bad input
    expect(formatRoutesDsl({})).toBe('');
  });
});

describe('ship aliases — English canonical + legacy Polish input', () => {
  it('parses the canonical English codes SC / LC / PF (case-insensitive)', () => {
    expect(parseRoutesDsl('1:1:1 = SC x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_SMALL_CARGO);
    expect(parseRoutesDsl('1:1:1 = lc x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_LARGE_CARGO);
    expect(parseRoutesDsl('1:1:1 = PF x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_PATHFINDER);
  });

  it('still ACCEPTS the legacy Polish codes MT / DT / PIO on input', () => {
    expect(parseRoutesDsl('1:1:1 = MT x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_SMALL_CARGO);
    expect(parseRoutesDsl('1:1:1 = DT x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_LARGE_CARGO);
    expect(parseRoutesDsl('1:1:1 = PIO x10 -> 1:1:2').routes[0].microFleet.shipId).toBe(SHIP_PATHFINDER);
  });

  it('NORMALISES legacy input to the English alias on format', () => {
    // Parse a legacy-DT line, re-format → it comes back as LC (never DT).
    const { routes } = parseRoutesDsl('1:1:1 = DT x10 -> 1:1:2');
    expect(formatRoutesDsl(routes)).toBe('1:1:1 = LCx10 -> 1:1:2');
  });
});

describe('findRouteForBody', () => {
  const routes = [
    {
      sources: [tgt(4, 472, 15, TARGET_MOON), tgt(4, 473, 15, TARGET_MOON)],
      targets: [tgt(4, 475, 14, TARGET_PLANET)],
      microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 },
    },
    {
      sources: [tgt(5, 120, 6, TARGET_PLANET)],
      targets: [tgt(5, 120, 7, TARGET_PLANET)],
      microFleet: { shipId: SHIP_SMALL_CARGO, count: 1000 },
    },
  ];

  it('matches a body against any source (type-aware)', () => {
    expect(findRouteForBody(routes, tgt(4, 473, 15, TARGET_MOON))).toBe(routes[0]);
    expect(findRouteForBody(routes, tgt(5, 120, 6, TARGET_PLANET))).toBe(routes[1]);
  });

  it('does not match when the type differs (planet at a moon source slot)', () => {
    expect(findRouteForBody(routes, tgt(4, 472, 15, TARGET_PLANET))).toBeNull();
  });

  it('returns null for an unknown body / null body / non-array routes', () => {
    expect(findRouteForBody(routes, tgt(9, 9, 9, TARGET_PLANET))).toBeNull();
    expect(findRouteForBody(routes, null)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(findRouteForBody(null, tgt(1, 1, 1, 1))).toBeNull();
  });
});
