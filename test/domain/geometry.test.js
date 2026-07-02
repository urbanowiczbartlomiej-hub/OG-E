// Unit tests for domain/geometry.js — the shared server coordinate/distance
// primitives (flight distance, donut wrap, NISZCZ flight time, threat reach).
// Verified-mechanics constants are exercised at known reference points rather
// than re-derived. Pure; no DOM/timers.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  GALAXY_STEP,
  SYSTEM_BASE,
  SYSTEM_STEP,
  SAME_SYSTEM_D,
  clamp01,
  axisDelta,
  flightDistance,
  niszczHours,
  reachThreat,
} from '../../src/domain/geometry.js';

describe('clamp01', () => {
  it('clamps below 0 to 0, above 1 to 1, and passes values inside untouched', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(4)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('axisDelta', () => {
  it('is the plain absolute difference when donut is false, even across the wrap seam', () => {
    expect(axisDelta(1, 499, 499, false)).toBe(498);
    expect(axisDelta(10, 3, 499, false)).toBe(7);
  });

  it('wraps to the shorter arc when donut is true', () => {
    expect(axisDelta(1, 499, 499, true)).toBe(1); // wrap-around is 1 step, not 498
    expect(axisDelta(10, 3, 499, true)).toBe(7); // shorter already; unaffected
  });

  it('is symmetric and zero for equal coordinates', () => {
    expect(axisDelta(5, 5, 499, true)).toBe(0);
    expect(axisDelta(4, 490, 499, true)).toBe(axisDelta(490, 4, 499, true));
  });
});

describe('flightDistance', () => {
  it('a galaxy hop dominates and scales linearly by GALAXY_STEP regardless of system delta', () => {
    expect(flightDistance(1, 0)).toBe(GALAXY_STEP);
    expect(flightDistance(2, 400)).toBe(GALAXY_STEP * 2); // system delta ignored once galaxies differ
  });

  it('same system (0 galaxy, 0 system delta) is the fixed same-vicinity distance', () => {
    expect(flightDistance(0, 0)).toBe(SAME_SYSTEM_D);
  });

  it('same galaxy, different system uses the linear system-base + step formula', () => {
    expect(flightDistance(0, 1)).toBe(SYSTEM_BASE + SYSTEM_STEP * 1);
    expect(flightDistance(0, 10)).toBe(SYSTEM_BASE + SYSTEM_STEP * 10);
  });

  it('a full galaxy hop in system-equivalent terms is close to GALAXY_IN_SYSTEMS systems', () => {
    // Sanity-checks the GALAXY_IN_SYSTEMS constant's own doc claim: 20000 ≈ 2700 + 95·183.
    expect(SYSTEM_BASE + SYSTEM_STEP * 183).toBeCloseTo(GALAXY_STEP, -3);
  });
});

describe('niszczHours', () => {
  it('grows with distance and is always positive', () => {
    const near = niszczHours(SAME_SYSTEM_D);
    const far = niszczHours(GALAXY_STEP * 5);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('matches the documented formula t = (3500·√(d/31) + 10) / 3600', () => {
    const d = 20000;
    expect(niszczHours(d)).toBeCloseTo((3500 * Math.sqrt(d / 31) + 10) / 3600, 10);
  });

  it('is ~10s (the flat term) at zero distance', () => {
    expect(niszczHours(0)).toBeCloseTo(10 / 3600, 10);
  });
});

describe('reachThreat', () => {
  it('is 1 (max) when the RIP arrives well inside the offline window', () => {
    // niszczHours(SAME_SYSTEM_D) is well under an 8h window.
    expect(reachThreat(SAME_SYSTEM_D, 8)).toBe(1);
  });

  it('fades to 0 by 1.5x the window and never goes negative beyond it', () => {
    const windowH = 8;
    // Pick a distance whose flight time is exactly 1.5x the window (formula: 3 - 2*(t/w) = 0 → t = 1.5w).
    const t15 = 1.5 * windowH;
    const dAtEdge = 31 * ((t15 * 3600 - 10) / 3500) ** 2;
    expect(reachThreat(dAtEdge, windowH)).toBeCloseTo(0, 5);
    // Well beyond 1.5x the window clamps at 0, not negative.
    expect(reachThreat(dAtEdge * 10, windowH)).toBe(0);
  });

  it('is monotonically non-increasing in distance for a fixed window', () => {
    const windowH = 8;
    const near = reachThreat(SAME_SYSTEM_D, windowH);
    const mid = reachThreat(GALAXY_STEP, windowH);
    const far = reachThreat(GALAXY_STEP * 10, windowH);
    expect(near).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThanOrEqual(far);
  });

  it('a wider window reaches further at the same distance', () => {
    // 50 systems away (~15h RIP flight): outside an 8h window, inside a 16h one.
    const d = SYSTEM_BASE + SYSTEM_STEP * 50;
    expect(reachThreat(d, 16)).toBeGreaterThan(reachThreat(d, 8));
  });
});
