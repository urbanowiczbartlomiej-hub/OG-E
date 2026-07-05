// @ts-check

// Unit tests for domain/civilBaseline — the pure economy→ships baseline model.
// Every case drives plain `economy` / `military` rank maps (id → {score,ships})
// and asserts the returned CivilProfile shape / bands / confidence. No DOM, no
// storage — pure node. Thresholds mirrored from the module: BASELINE_MAX 0.25,
// ELEVATED_MAX 0.6, MIN_SAMPLES 20, DECILES 10.

import { describe, it, expect } from 'vitest';
import { buildCivilBaseline } from '../../src/domain/civilBaseline.js';

/**
 * Build a synthetic pair of feeds where ships track economy linearly
 * (ships === score / 10), giving a clean, monotonic median curve. `count`
 * builder rows are laid down at economy 1000, 2000, … so every decile is a
 * flat baseline (combatRatio 0). Extra fleeters/probers are merged on top.
 *
 * @param {number} count
 * @returns {{ economy: Record<string, {score:number}>, military: Record<string, {score:number, ships:number}> }}
 */
const buildersFeed = (count) => {
  /** @type {Record<string, {score:number}>} */
  const economy = {};
  /** @type {Record<string, {score:number, ships:number}>} */
  const military = {};
  for (let i = 1; i <= count; i++) {
    const score = i * 1000;
    economy[String(i)] = { score };
    military[String(i)] = { score, ships: score / 10 }; // baseline: ships == expectedCivil
  }
  return { economy, military };
};

/**
 * A flat server: every builder owns the SAME civil fleet (`ships`), so every
 * decile median equals it and every builder scores an exact-baseline ratio of 0
 * regardless of how the deciles split. Economy still rises with id so the feed
 * is realistic.
 *
 * @param {number} count
 * @param {number} ships
 * @returns {{ economy: Record<string, {score:number}>, military: Record<string, {score:number, ships:number}> }}
 */
const flatFeed = (count, ships) => {
  /** @type {Record<string, {score:number}>} */
  const economy = {};
  /** @type {Record<string, {score:number, ships:number}>} */
  const military = {};
  for (let i = 1; i <= count; i++) {
    const score = i * 1000;
    economy[String(i)] = { score };
    military[String(i)] = { score, ships };
  }
  return { economy, military };
};

describe('buildCivilBaseline — degenerate inputs return an empty map', () => {
  it('returns empty Map with no arguments', () => {
    expect(buildCivilBaseline()).toEqual(new Map());
  });

  it('returns empty when the economy feed is missing', () => {
    const { military } = buildersFeed(30);
    expect(buildCivilBaseline({ military }).size).toBe(0);
  });

  it('returns empty when the military feed is missing', () => {
    const { economy } = buildersFeed(30);
    expect(buildCivilBaseline({ economy }).size).toBe(0);
  });

  it('returns empty when NO military row carries a ships attribute (pre-ships feed)', () => {
    const { economy } = buildersFeed(30);
    /** @type {Record<string, {score:number}>} */
    const military = {};
    for (const id of Object.keys(economy)) military[id] = { score: economy[id].score };
    expect(buildCivilBaseline({ economy, military }).size).toBe(0);
  });

  it('returns empty with too few overlapping samples (< MIN_SAMPLES 20)', () => {
    const { economy, military } = buildersFeed(19);
    expect(buildCivilBaseline({ economy, military }).size).toBe(0);
  });

  it('models the server once samples reach MIN_SAMPLES (20)', () => {
    const { economy, military } = buildersFeed(20);
    expect(buildCivilBaseline({ economy, military }).size).toBe(20);
  });
});

describe('buildCivilBaseline — the median curve on a crafted distribution', () => {
  it('scores a flat civil-fleet server at exact baseline (surplus 0, low confidence)', () => {
    // Every builder owns the same fleet → each decile median equals it →
    // ships === expectedCivil for everyone → zero surplus, baseline band.
    const out = buildCivilBaseline(flatFeed(30, 1000));

    expect(out.size).toBe(30);
    for (const [, p] of out) {
      expect(p.expectedCivil).toBe(1000);
      expect(p.combatShips).toBe(0);
      expect(p.combatRatio).toBe(0);
      expect(p.band).toBe('baseline');
      expect(p.confidence).toBe('low');
    }
  });

  it('expectedCivil tracks the player economy monotonically (top decile ≥ bottom)', () => {
    const { economy, military } = buildersFeed(30);
    const out = buildCivilBaseline({ economy, military });

    // Player 1 sits in the lowest decile, player 30 in the highest.
    const low = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(1));
    const high = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(30));
    expect(high.expectedCivil).toBeGreaterThan(low.expectedCivil);
    // Curve is non-decreasing across the whole economy range.
    let prev = -Infinity;
    for (const p of [...out.values()].sort((a, b) => a.economyScore - b.economyScore)) {
      expect(p.expectedCivil).toBeGreaterThanOrEqual(prev);
      prev = p.expectedCivil;
    }
  });
});

describe('buildCivilBaseline — surplus bands & confidence', () => {
  it('flags a player with ships FAR above baseline as a fleet-holder (high confidence)', () => {
    const { economy, military } = buildersFeed(30);
    // A modest economy (2000 → expectedCivil 200) but a huge combat fleet. Score is
    // set high enough that res/ship clears the cheap-swarm veto (this IS a real fleet;
    // the band tracks the ship-COUNT surplus, so score doesn't affect it).
    economy['500'] = { score: 2000 };
    military['500'] = { score: 300000, ships: 20000 }; // res/ship 15k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(500));

    expect(p.expectedCivil).toBe(200);
    expect(p.combatShips).toBe(20000 - 200);
    expect(p.combatRatio).toBeGreaterThan(0.6);
    expect(p.band).toBe('fleet-holder');
    // combatShips (19800) >> expectedCivil (200) → clear surplus → high.
    expect(p.confidence).toBe('high');
  });

  it('classes a moderate surplus as elevated / medium confidence', () => {
    const { economy, military } = buildersFeed(30);
    // expectedCivil 500 for economy 5000; ships chosen so ratio lands in [0.25,0.6).
    // ships 1000 → combat 500 → ratio 0.5.
    economy['600'] = { score: 5000 };
    military['600'] = { score: 20000, ships: 1000 }; // res/ship 20k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(600));

    expect(p.expectedCivil).toBe(500);
    expect(p.combatShips).toBe(500);
    expect(p.combatRatio).toBeCloseTo(0.5, 6);
    expect(p.band).toBe('elevated');
    expect(p.confidence).toBe('medium');
  });

  it('reads a player at/below baseline as an economy-explained builder', () => {
    const { economy, military } = buildersFeed(30);
    // Ships BELOW the decile median → combatShips clamps to 0. (The added row
    // shifts bin edges, so this economy's decile median is 400, not 500 — the
    // point is only that ships < expectedCivil.)
    economy['700'] = { score: 5000 };
    military['700'] = { score: 5000, ships: 100 };

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(700));

    expect(p.expectedCivil).toBe(400);
    expect(p.ships).toBeLessThan(p.expectedCivil);
    expect(p.combatShips).toBe(0);
    expect(p.combatRatio).toBe(0);
    expect(p.band).toBe('baseline');
    expect(p.confidence).toBe('low');
  });

  it('gives a fleet-holder whose surplus dwarfs the baseline high confidence', () => {
    const { economy, military } = buildersFeed(30);
    // expectedCivil 500, ships 5000 → combat 4500 → ratio 0.9. combatShips (4500)
    // is far above expectedCivil (500), which is the high-confidence gate.
    economy['800'] = { score: 5000 };
    military['800'] = { score: 100000, ships: 5000 }; // res/ship 20k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(800));
    expect(p.band).toBe('fleet-holder');
    expect(p.combatShips).toBeGreaterThan(p.expectedCivil);
    expect(p.confidence).toBe('high');
  });

  it('relabels a big COUNT surplus of CHEAP hulls as cheap-swarm (res/ship veto)', () => {
    const { economy, military } = buildersFeed(30);
    economy['501'] = { score: 2000 };
    military['501'] = { score: 2000, ships: 20000 }; // res/ship 100 → cheap swarm, not combat
    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(501));
    expect(p.band).toBe('cheap-swarm');
    expect(p.confidence).toBe('low');
    expect(p.resPerShip).toBeCloseTo(100, 6);
  });
});

describe('buildCivilBaseline — per-player edge handling', () => {
  it('treats a military row with no ships attribute as 0 ships (feed IS ships-aware)', () => {
    const { economy, military } = buildersFeed(30);
    economy['900'] = { score: 5000 };
    military['900'] = /** @type {any} */ ({ score: 5000 }); // ships absent → 0

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(900));
    expect(p.ships).toBe(0);
    expect(p.combatShips).toBe(0);
    expect(p.combatRatio).toBe(0);
    expect(p.band).toBe('baseline');
  });

  it('skips military players absent from the economy feed', () => {
    const { economy, military } = buildersFeed(30);
    military['1001'] = { score: 9999, ships: 9999 }; // no economy row

    const out = buildCivilBaseline({ economy, military });
    expect(out.has(1001)).toBe(false);
  });
});
