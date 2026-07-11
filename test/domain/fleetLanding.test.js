// Unit tests for domain/fleetLanding.js — the "a fleet just landed on that
// moon and the owner is away" candidate signal. The suite pins the mode
// LADDER (off / lone / newest / any — each rung's claim and what blocks it),
// the multi-moon co-candidate rule, the honesty gates — coverage (stale
// looks are `unknown`, never quiet), the self-induced skip (our own probe's
// light is not a landing), kept-looking (silence-since needs a later look) —
// and the ambiguous-moon re-look window (detectLandingRecheck).
//
// Node env — pure, `nowMs` injected.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  FRESH_LOOK_MS,
  QUIET_COVERAGE_MS,
  AFTERGLOW_HORIZON_MS,
  detectFleetLanding,
  detectLandingRecheck,
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
      tier: 'lone',
      concurrent: false,
      coMoons: 0,
    });
  });

  it("mode 'off' never fires, even on the perfect signature", () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': freshRing(),
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    }, NOW, { mode: 'off' });
    expect(sig).toBeNull();
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

  it('moon + planet fresh in the SAME fuzzy band = ambiguous at newest; only "any" flags it (weak)', () => {
    const rings = {
      '1:2:3:3': freshRing(),
      '1:2:8:1': freshRing(),
      '1:2:3:1': quietRing(),
    };
    // Default ('newest'): overlapping planet mark → cannot claim the moon.
    expect(detectFleetLanding(bodies, rings, NOW)).toBeNull();
    // 'any' concedes the owner may be around: weak + concurrent.
    const any = detectFleetLanding(bodies, rings, NOW, { mode: 'any' });
    expect(any).toMatchObject({
      coord: '1:2:3', tier: 'any', confidence: 'weak', concurrent: true,
    });
  });

  it("newest: the moon's strictly-newer mark wins over older (still fresh-class) planet activity", () => {
    // Planet interacted ~20 min ago (exact-minute marker, still inside the
    // fresh window), moon just now — unambiguously newer. Lone can't fire
    // (two fresh bodies); newest claims the moon, the older planet
    // corroborates, and `concurrent` says a planet was lit alongside.
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': [{ t: sec(NOW), m: 0 }],
      '1:2:8:1': [{ t: sec(NOW), m: 20 }],
      '1:2:3:1': quietRing(),
    }, NOW);
    expect(sig).toMatchObject({
      coord: '1:2:3', tier: 'newest', quiet: 2, total: 2, concurrent: true,
    });
  });

  it('newest: a co-lit MOON does not demote the claim — it counts into coMoons', () => {
    const twoMoons = [
      { coord: '1:2:3', bodyType: /** @type {1} */ (1) },
      { coord: '1:2:3', bodyType: /** @type {3} */ (3) },
      { coord: '1:2:8', bodyType: /** @type {1} */ (1) },
      { coord: '1:2:8', bodyType: /** @type {3} */ (3) },
    ];
    const sig = detectFleetLanding(twoMoons, {
      '1:2:3:3': freshRing(),
      '1:2:8:3': freshRing(), // same band → unorderable, but it's a MOON
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    }, NOW);
    expect(sig).toMatchObject({ tier: 'newest', coMoons: 1 });
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

  it("a stale positive marker is not 'lit NOW' — lone stays silent, newest claims the afterglow", () => {
    const rings = {
      '1:2:3:3': [{ t: sec(NOW - FRESH_LOOK_MS - 60_000), m: 0 }],
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    };
    // 'lone' claims "lit NOW" — a 31-min-old interaction isn't that.
    expect(detectFleetLanding(bodies, rings, NOW, { mode: 'lone' })).toBeNull();
    // Default ('newest'): the account's newest trace sits on the moon and the
    // later quiet looks corroborate the silence — the parked-fleet afterglow.
    const sig = detectFleetLanding(bodies, rings, NOW);
    expect(sig).toMatchObject({ coord: '1:2:3', tier: 'newest', quiet: 2 });
    expect(sig && sig.freshAgeMs).toBeGreaterThan(FRESH_LOOK_MS);
  });

  it("freshness is keyed on the INTERACTION age: a 40-idle-minutes marker seen just now isn't fresh", () => {
    // The false-strike class from the field: our probes lit the planets
    // (discounted → invisible) while the moon carried an old exact-minute
    // marker. lone/any must not read that as "lit NOW".
    const rings = {
      '1:2:3:3': [{ t: sec(NOW - 60_000), m: 40 }],
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    };
    expect(detectFleetLanding(bodies, rings, NOW, { mode: 'lone' })).toBeNull();
    // 'newest' still reports it — honestly, with its age.
    const sig = detectFleetLanding(bodies, rings, NOW, { mode: 'newest' });
    expect(sig?.tier).toBe('newest');
  });

  it('afterglow is bounded by the horizon', () => {
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': [{ t: sec(NOW - AFTERGLOW_HORIZON_MS - 60_000), m: 0 }],
      '1:2:3:1': quietRing(),
      '1:2:8:1': quietRing(),
    }, NOW);
    expect(sig).toBeNull();
  });

  it('kept-looking: a faded moon mark with NO later look anywhere cannot claim "quiet since"', () => {
    // The moon's own stale positive is the newest observation overall — we
    // never looked again, so silence-since is unfounded. The other bodies'
    // quiet looks predate it (still recent enough to corroborate in shape,
    // but they cannot testify about "since").
    const moonLookMs = NOW - FRESH_LOOK_MS - 60_000;
    const sig = detectFleetLanding(bodies, {
      '1:2:3:3': [{ t: sec(moonLookMs), m: 0 }],
      '1:2:3:1': [{ t: sec(moonLookMs - 5 * 60_000), m: -1 }],
      '1:2:8:1': [{ t: sec(moonLookMs - 5 * 60_000), m: -1 }],
    }, NOW);
    expect(sig).toBeNull();
  });
});

describe('detectLandingRecheck', () => {
  const ambiguousRings = () => ({
    '1:2:3:3': freshRing(),
    '1:2:8:1': freshRing(), // planet in the SAME fuzzy band → unorderable
    '1:2:3:1': quietRing(),
  });

  it('flags the moon-vs-planet fuzzy overlap with a ready→expires window', () => {
    const r = detectLandingRecheck(bodies, ambiguousRings(), NOW);
    expect(r).toMatchObject({ coord: '1:2:3', bodyType: 3 });
    // Ready once both marks have left the <15 band (τ_hi + band + slack)…
    expect(r && r.readyAtMs).toBeGreaterThan(NOW);
    // …and gone once the earliest mark dies (60 min after its τ_lo).
    expect(r && r.expiresAtMs).toBeGreaterThan(r ? r.readyAtMs : 0);
  });

  it('no overlap (strictly older planet) → nothing to recheck', () => {
    const r = detectLandingRecheck(bodies, {
      '1:2:3:3': [{ t: sec(NOW), m: 0 }],
      '1:2:8:1': [{ t: sec(NOW), m: 20 }],
      '1:2:3:1': quietRing(),
    }, NOW);
    expect(r).toBeNull();
  });

  it("modes 'off'/'lone' never recheck (nothing to upgrade)", () => {
    expect(detectLandingRecheck(bodies, ambiguousRings(), NOW, { mode: 'lone' })).toBeNull();
    expect(detectLandingRecheck(bodies, ambiguousRings(), NOW, { mode: 'off' })).toBeNull();
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
