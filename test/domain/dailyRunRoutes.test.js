// Unit tests for `domain/dailyRunRoutes.reconcileRoutes` — pruning route endpoints
// against the captured body inventory. Node env — pure functions only.
// (findRouteForBody is covered via the dailyRun pure suite; parseDailyRunRoutes
// — incl. the microFleet→fleet migration — via the dailyRunRoutes state suite.)
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { reconcileRoutes } from '../../src/domain/dailyRunRoutes.js';
import { TARGET_PLANET, TARGET_MOON } from '../../src/domain/rules.js';

/** @param {number} g @param {number} s @param {number} p @param {number} t */
const c = (g, s, p, t) => ({ galaxy: g, system: s, position: p, type: t });

// A small owned-body inventory: planet+moon at 4:467:15, planet at 5:172:8.
const BODIES = [
  c(4, 467, 15, TARGET_PLANET),
  c(4, 467, 15, TARGET_MOON),
  c(5, 172, 8, TARGET_PLANET),
];

// reconcileRoutes ignores the fleet field; a canonical-shape placeholder.
const FLEET = [{ shipId: 203, count: 15000 }];

describe('reconcileRoutes', () => {
  it('keeps a fully-valid route unchanged (same reference, no removals)', () => {
    const route = { sources: [c(4, 467, 15, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_PLANET)], fleet: FLEET };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(removed).toEqual([]);
    expect(routes[0]).toBe(route); // identity preserved → caller skips write
  });

  it('drops a dead TARGET but keeps the route (with the survivors)', () => {
    const route = {
      sources: [c(4, 467, 15, TARGET_MOON)],
      targets: [c(5, 172, 8, TARGET_PLANET), c(9, 9, 9, TARGET_PLANET)],
      fleet: FLEET,
    };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes).toHaveLength(1);
    expect(routes[0].targets).toEqual([c(5, 172, 8, TARGET_PLANET)]);
    expect(routes[0]).not.toBe(route); // rebuilt because it changed
    expect(removed).toEqual([{ coord: c(9, 9, 9, TARGET_PLANET), role: 'target' }]);
  });

  it('drops a dead SOURCE but keeps the route when others survive', () => {
    const route = {
      sources: [c(4, 467, 15, TARGET_MOON), c(6, 6, 6, TARGET_MOON)],
      targets: [c(5, 172, 8, TARGET_PLANET)],
      fleet: FLEET,
    };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes[0].sources).toEqual([c(4, 467, 15, TARGET_MOON)]);
    expect(removed).toEqual([{ coord: c(6, 6, 6, TARGET_MOON), role: 'source' }]);
  });

  it('removes a route entirely when it loses ALL sources', () => {
    const route = { sources: [c(6, 6, 6, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_PLANET)], fleet: FLEET };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes).toEqual([]);
    expect(removed).toEqual([{ coord: c(6, 6, 6, TARGET_MOON), role: 'source' }]);
  });

  it('removes a route entirely when it loses ALL targets', () => {
    const route = { sources: [c(4, 467, 15, TARGET_MOON)], targets: [c(9, 9, 9, TARGET_PLANET)], fleet: FLEET };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes).toEqual([]);
    expect(removed).toEqual([{ coord: c(9, 9, 9, TARGET_PLANET), role: 'target' }]);
  });

  it('never prunes a custom (external) target, even with no matching body', () => {
    const route = {
      sources: [c(4, 467, 15, TARGET_MOON)],
      targets: [
        c(5, 172, 8, TARGET_PLANET),
        { galaxy: 1, system: 99, position: 4, type: TARGET_PLANET, custom: true },
      ],
      fleet: FLEET,
    };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    // The own-body target is valid; the custom one is exempt → nothing pruned.
    expect(routes[0]).toBe(route); // identity preserved
    expect(removed).toEqual([]);
  });

  it('keeps a route whose ONLY target is a custom external coord', () => {
    const route = {
      sources: [c(4, 467, 15, TARGET_MOON)],
      targets: [{ galaxy: 1, system: 99, position: 4, type: TARGET_PLANET, custom: true }],
      fleet: FLEET,
    };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it('is type-aware: a planet endpoint at a moon-only slot is dead', () => {
    // 5:172:8 exists as a PLANET only; a route targeting the MOON there is dead.
    const route = { sources: [c(4, 467, 15, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_MOON)], fleet: FLEET };
    const { routes, removed } = reconcileRoutes([route], BODIES);
    expect(routes).toEqual([]);
    expect(removed).toEqual([{ coord: c(5, 172, 8, TARGET_MOON), role: 'target' }]);
  });

  it('is a NO-OP against an empty inventory (never wipes routes)', () => {
    const route = { sources: [c(4, 467, 15, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_PLANET)], fleet: FLEET };
    const input = [route];
    const { routes, removed } = reconcileRoutes(input, []);
    expect(routes).toBe(input); // identity preserved
    expect(removed).toEqual([]);
  });

  it('handles non-array routes defensively', () => {
    // @ts-expect-error intentional bad input
    expect(reconcileRoutes(null, BODIES)).toEqual({ routes: [], removed: [] });
  });

  it('reconciles several routes and reports every dead endpoint', () => {
    const r1 = { sources: [c(4, 467, 15, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_PLANET)], fleet: FLEET }; // ok
    const r2 = { sources: [c(6, 6, 6, TARGET_MOON)], targets: [c(5, 172, 8, TARGET_PLANET)], fleet: FLEET }; // dead source
    const r3 = { sources: [c(4, 467, 15, TARGET_PLANET)], targets: [c(7, 7, 7, TARGET_PLANET)], fleet: FLEET }; // dead target
    const { routes, removed } = reconcileRoutes([r1, r2, r3], BODIES);
    expect(routes).toEqual([r1]);
    expect(removed).toEqual([
      { coord: c(6, 6, 6, TARGET_MOON), role: 'source' },
      { coord: c(7, 7, 7, TARGET_PLANET), role: 'target' },
    ]);
  });
});
