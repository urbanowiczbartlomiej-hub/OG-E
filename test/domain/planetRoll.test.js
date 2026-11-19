// Unit tests for the planet-size roll model (`domain/planetRoll.js`).
// Node env — pure functions over plain data. The game rules behind the
// numbers are in docs/ogame-fleet-mechanics.md → Colonization.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  POSITION_FIELD_RANGE,
  sizeBonusPercent,
  fieldMultiplier,
  rollCdf,
  rollTail,
  entryMultiplier,
  naturalFields,
  expectedCurve,
  sampleSpread,
  ROLL_KURTOSIS,
} from '../../src/domain/planetRoll.js';

describe('POSITION_FIELD_RANGE', () => {
  it('has all 15 positions, P8 the widest at 156–252', () => {
    expect(Object.keys(POSITION_FIELD_RANGE)).toHaveLength(15);
    expect(POSITION_FIELD_RANGE[8]).toEqual([156, 252]);
    expect(POSITION_FIELD_RANGE[1]).toEqual([96, 172]);
  });
});

describe('sizeBonusPercent / fieldMultiplier', () => {
  it('folds class bonuses and the Discoverer Enhancement into one diameter %', () => {
    expect(sizeBonusPercent({ e: 0.5369, discoverer: true, researcher: true })).toBe(20.37);
    expect(sizeBonusPercent({ e: 0.5369, discoverer: true, researcher: false })).toBe(15.37);
    expect(sizeBonusPercent({ e: 0, discoverer: false, researcher: true })).toBe(5);
    expect(sizeBonusPercent({ e: 0.9, discoverer: false, researcher: false })).toBe(0);
  });

  it('squares the diameter bonus: +20.37 % diameter is ×1.4489 fields', () => {
    expect(fieldMultiplier(20.37)).toBeCloseTo(1.44889, 4);
    expect(fieldMultiplier(0)).toBe(1);
  });
});

describe('rollCdf / rollTail (sum of three uniforms on [min, max + 1))', () => {
  it('is 0 below the range, 1 above it, ½ in the middle', () => {
    expect(rollCdf(150, 156, 252)).toBe(0);
    expect(rollCdf(260, 156, 252)).toBe(1);
    expect(rollCdf(204.5, 156, 252)).toBeCloseTo(0.5, 10);
  });

  it('has the cubic top tail (253 − x)³ / 202 816 on P8', () => {
    for (const x of [230, 247, 250, 252]) {
      // 202 816 is (2/9)·97³ rounded; use the exact constant here.
      expect(rollTail(x, 156, 252)).toBeCloseTo((253 - x) ** 3 / ((2 / 9) * 97 ** 3), 12);
    }
  });

  it('is continuous across the piece boundaries', () => {
    const w = 97 / 3;
    for (const u of [1, 2]) {
      const x = 156 + u * w;
      expect(rollCdf(x - 1e-9, 156, 252)).toBeCloseTo(rollCdf(x + 1e-9, 156, 252), 6);
    }
  });
});

describe('entryMultiplier / naturalFields', () => {
  it('uses only the colony\'s own stamped bonus', () => {
    expect(entryMultiplier({})).toBeNull();
    expect(entryMultiplier({ b: 20.37 })).toBeCloseTo(1.44889, 4);
    expect(naturalFields({ fields: 380 }, 30)).toBeNull();
  });

  it('back-solves the natural roll from shown fields', () => {
    // 247 natural at +20.37 % → floor(247.5 × 1.44889) + 30 = 388 shown
    expect(naturalFields({ fields: 388, b: 20.37 }, 30)).toBe(247);
    expect(naturalFields({ fields: 282, b: 0 }, 30)).toBe(252);
  });
});

describe('expectedCurve', () => {
  it('a 1-field bar holds ≈ n × P(bar) in natural mode', () => {
    const n = 1000;
    const pts = expectedCurve({ lo: 156, bars: 97, w: 1, min: 156, max: 252, n, samplesPerBar: 1 });
    // centre of bar 48 (field 204) — the mode of the distribution
    const mid = pts.find((p) => Math.abs(p.x - 48.5) < 1e-9) ?? pts[48];
    const exact = n * (rollCdf(204.5 + 0.5, 156, 252) - rollCdf(204.5 - 0.5, 156, 252));
    expect(mid.y).toBeGreaterThan(0);
    expect(Math.abs(mid.y - exact)).toBeLessThan(exact * 0.05);
  });

  it('shown mode with one multiplier is the natural curve stretched by it', () => {
    const k = fieldMultiplier(20.37);
    const shown = expectedCurve({
      lo: 255, bars: 140, w: 1, min: 156, max: 252, n: 0,
      multipliers: new Map([[k, 500]]), serverBonus: 30,
    });
    const total = shown.reduce((s, p) => s + p.y, 0) / 4; // 4 samples per bar
    expect(total).toBeGreaterThan(450);
    expect(total).toBeLessThan(550);
  });
});

describe('sampleSpread', () => {
  it('returns NaN below two values', () => {
    expect(Number.isNaN(sampleSpread([5]).sd)).toBe(true);
  });

  it('a large uniform-sum sample has the model kurtosis', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const xs = Array.from({ length: 30000 }, () => rnd() + rnd() + rnd());
    const { kurtosis } = sampleSpread(xs);
    expect(kurtosis).toBeCloseTo(ROLL_KURTOSIS, 1);
  });
});
