// Unit tests for lib/dangerColor — the single source of truth for "danger →
// colour" on every dashboard surface.
//
// `dangerColor` takes the 0..100 score the tables round to; `dangerColor01`
// takes the 0..1 FRACTION the danger model actually carries. The second exists
// because handing the raw fraction to the first painted D 0.91 the same safe
// green as D 0.02 — every row coloured by Danger looked harmless. These tests
// pin that scaling, and the deliberate distinction between "no danger" and "no
// profile at all".

import { describe, it, expect } from 'vitest';
import { dangerColor, dangerColor01 } from '../../src/lib/dangerColor.js';

describe('dangerColor (0..100)', () => {
  it('runs green → amber → red across the two thresholds', () => {
    expect(dangerColor(0)).toBe(dangerColor(15)); // green band, inclusive
    expect(dangerColor(16)).toBe(dangerColor(45)); // amber band, inclusive
    expect(dangerColor(0)).not.toBe(dangerColor(16));
    expect(dangerColor(45)).not.toBe(dangerColor(46));
  });

  it('never throws on a non-finite score — it falls through to amber', () => {
    expect(dangerColor(NaN)).toBe(dangerColor(30));
    expect(dangerColor(Infinity)).toBe(dangerColor(30));
  });
});

describe('dangerColor01 (0..1 fraction)', () => {
  it('scales the fraction, so a high danger is NOT painted safe', () => {
    // The whole point: 0.91 is a red account, 0.02 is a green one. Before the
    // scaling both landed in the green band (0.91 rounds to 1 on a 0..100 scale).
    expect(dangerColor01(0.91)).toBe(dangerColor(91));
    expect(dangerColor01(0.02)).toBe(dangerColor(2));
    expect(dangerColor01(0.91)).not.toBe(dangerColor01(0.02));
  });

  it('agrees with dangerColor on the band edges', () => {
    expect(dangerColor01(0.15)).toBe(dangerColor(15));
    expect(dangerColor01(0.46)).toBe(dangerColor(46));
  });

  it('uses the UNKNOWN colour when we hold no profile — not a zero danger', () => {
    const unknown = dangerColor01(undefined);
    expect(unknown).not.toBe(dangerColor01(0));
    expect(dangerColor01(null)).toBe(unknown);
    expect(dangerColor01(undefined, '#abcdef')).toBe('#abcdef');
  });
});
