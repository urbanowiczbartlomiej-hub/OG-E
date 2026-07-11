// Unit tests for domain/fleetLanding.js — the "a fleet just landed on that
// moon and the owner is away" candidate signal. The suite pins the signature
// (exactly ONE fresh body, a MOON, others quiet) and the two honesty gates:
// coverage (stale looks are `unknown`, never quiet) and the self-induced skip
// (our own probe's light is not a landing). Mirrors the six smoke cases the
// feature shipped against.
//
// Node env — pure, `nowMs` injected.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  FRESH_LOOK_MS,
  QUIET_COVERAGE_MS,
  detectFleetLanding,
  detectAllLandings,
  strikeMapOf,
} from '../../src/domain/fleetLanding.js';

const NOW = 1_700_000_000_000;
/** @param {number} ms */
const sec = (ms) => Math.floor(ms / 1000);

/** A ring whose newest look is a FRESH positive marker (activity just seen). */
const freshRing = () => [{ t: sec(NOW - 5 * 60_000), m: 0 }];
/** A ring whose newest look is a recent quiet "-1" (looked, saw nothing). */
const quietRing = (ageMs = 10 * 60_000) => [{ t: sec(NOW - ageMs), m: -1 }];

/** Player bodies: two planets, the first with a moon. */
const bodies = [
  { coord: '1:2:3', bodyType: /** @type {1} */ (1) },
  { coord: '1:2:3', bodyType: /** @type {3} */ (3) },
  { coord: '1:2:8', bodyType: /** @type {1} */ (1) },
];

describe('detectFleetLanding', () => {
  it('fires on the signature: one fresh MOON + the other bodies recently quiet', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': freshRing(),
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    }, NOW);
    expect(sig).toMatchObject({
      coord: '1:2:3',
      bodyType: 3,
      overrideKey: '1:2:3:3',
      quiet: 2,
      total: 2,
      confidence: 'strong', // 2/2 ≥ 0.7 coverage
    });
  });

  it('half coverage still fires, at medium confidence', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': freshRing(),
      '1:2:3:1': quietRing(),
      // 1:2:8 never looked at → unknown, lowers coverage
    }, NOW);
    expect(sig?.confidence).toBe('medium');
    expect(sig?.quiet).toBe(1);
    expect(sig?.total).toBe(2);
  });

  it('a fresh PLANET is not a landing (moons only)', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:8:1': freshRing(),
      '1:2:3:1': quietRing(),
      '1:2:3:3': quietRing(),
    }, NOW);
    expect(sig).toBeNull();
  });

  it('two fresh bodies = a human playing, not a landing', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': freshRing(),
      '1:2:8:1': freshRing(),
      '1:2:3:1': quietRing(),
    }, NOW);
    expect(sig).toBeNull();
  });

  it('needs at least one CONFIRMED-quiet other body (unknown is not quiet)', () => {
    // Other bodies' looks are older than the quiet-coverage window → unknown.
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': freshRing(),
      '1:2:3:1': quietRing(QUIET_COVERAGE_MS + 60_000),
      '1:2:8:1': quietRing(QUIET_COVERAGE_MS + 60_000),
    }, NOW);
    expect(sig).toBeNull();
  });

  it('skips a fresh moon we probed ourselves (self-induced light)', () => {
    const rings = {
      '1:2:3:3': freshRing(),
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    };
    expect(detectFleetLanding(bodies, rings, NOW, {
      sentMap: { '1:2:3:3': NOW - 10 * 60_000 },
    })).toBeNull();
    // The same send far enough in the past no longer discounts.
    expect(detectFleetLanding(bodies, rings, NOW, {
      sentMap: { '1:2:3:3': NOW - 2 * 60 * 60_000 },
    })).not.toBeNull();
  });

  it('a stale positive marker is unknown, not fresh (the reading reflects NOW)', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': [{ t: sec(NOW - FRESH_LOOK_MS - 60_000), m: 0 }],
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    }, NOW);
    expect(sig).toBeNull();
  });
});

describe('detectAllLandings / strikeMapOf', () => {
  it('expands universe rows (hasMoon) per watched player and maps the boost keys', () => {
    const universePlanets = [
      { coords: '1:2:3', player: 42, hasMoon: true },
      { coords: '1:2:8', player: 42 },
      { coords: '9:9:9', player: 7 }, // unwatched
    ];
    const signals = detectAllLandings(['42'], universePlanets, {
      42: {
        '1:2:3:3': freshRing(),
        '1:2:3:1': quietRing(),
        '1:2:8:1': quietRing(),
      },
    }, NOW);
    expect(Object.keys(signals)).toEqual(['42']);
    expect([...strikeMapOf(signals).keys()]).toEqual(['1:2:3:3']);
  });
});
