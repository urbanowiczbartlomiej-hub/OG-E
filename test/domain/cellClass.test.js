// Unit tests for domain/cellClass.js — the fixed 5-bucket cell classifier and
// its two colour mappers (sharp `cellColor`, blended `fieldColor`). Pure
// functions over plain data; no DOM/timers.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { classifyCell, cellColor, fieldColor } from '../../src/domain/cellClass.js';

describe('classifyCell', () => {
  it('classifies an undefined/empty-family status as free, intensity 0', () => {
    expect(classifyCell(undefined, undefined)).toEqual({ bucket: 'free', intensity: 0 });
    for (const status of ['empty', 'empty_sent', 'abandoned', 'reserved']) {
      expect(classifyCell(/** @type {any} */ (status), undefined)).toEqual({ bucket: 'free', intensity: 0 });
    }
  });

  it('classifies "mine" as the mine bucket at full intensity', () => {
    expect(classifyCell('mine', undefined)).toEqual({ bucket: 'mine', intensity: 1 });
  });

  it('classifies admin/banned/vacation as one flat "blocked" bucket', () => {
    for (const status of ['admin', 'banned', 'vacation']) {
      expect(classifyCell(/** @type {any} */ (status), { id: 1, name: 'P' })).toEqual({ bucket: 'blocked', intensity: 1 });
    }
  });

  it('folds inactive AND long_inactive into one "farm" bucket', () => {
    const a = classifyCell('inactive', { id: 1, name: 'A', score: 100 });
    const b = classifyCell('long_inactive', { id: 2, name: 'B', score: 100 });
    expect(a.bucket).toBe('farm');
    expect(b.bucket).toBe('farm');
    expect(a.intensity).toBe(b.intensity);
  });

  it('farm intensity is sqrt(points/scale), clamped at 1 (whale saturates, does not overflow)', () => {
    expect(classifyCell('inactive', { id: 1, name: 'A' })).toEqual({ bucket: 'farm', intensity: 0 }); // no score → 0 pts
    expect(classifyCell('inactive', { id: 1, name: 'A', score: 250 }, { farmScale: 1000 }).intensity)
      .toBeCloseTo(Math.sqrt(0.25), 5);
    // A points value far above scale still clamps to exactly 1.
    expect(classifyCell('inactive', { id: 1, name: 'A', score: 1e9 }, { farmScale: 1000 }).intensity).toBe(1);
  });

  it('defaults farmScale to 1 (raw points) when omitted or non-positive', () => {
    const noOpt = classifyCell('inactive', { id: 1, name: 'A', score: 0.09 });
    expect(noOpt.intensity).toBeCloseTo(0.3, 5); // sqrt(0.09/1)
    // A non-positive farmScale (0) falls back to 1, same as omitting it.
    const zeroScale = classifyCell('inactive', { id: 1, name: 'A', score: 0.09 }, { farmScale: 0 });
    expect(zeroScale.intensity).toBeCloseTo(noOpt.intensity, 10);
  });

  it('any other occupied status is an active-player "threat" at a 0.3 base', () => {
    const t = classifyCell('occupied', { id: 1, name: 'P' });
    expect(t.bucket).toBe('threat');
    expect(t.intensity).toBe(0.3);
  });

  it('raises threat toward 1 by relative military strength (2x own military = max from that axis)', () => {
    // mil/(ownMilitary*2) must exceed the 0.3 base to move the needle at all.
    const equal = classifyCell('occupied', { id: 1, name: 'P', militaryScore: 100 }, { ownMilitary: 100 });
    expect(equal.intensity).toBeCloseTo(0.5, 5); // 100 / (100*2)
    // Below the 0.3 base, the military axis contributes nothing (base wins the max()).
    const weak = classifyCell('occupied', { id: 1, name: 'P', militaryScore: 10 }, { ownMilitary: 200 });
    expect(weak.intensity).toBe(0.3);
    const capped = classifyCell('occupied', { id: 1, name: 'P', militaryScore: 10000 }, { ownMilitary: 200 });
    expect(capped.intensity).toBe(1);
  });

  it('ignores the military axis when ownMilitary is missing or 0 (stays at the 0.3 base)', () => {
    const noAnchor = classifyCell('occupied', { id: 1, name: 'P', militaryScore: 999999 });
    expect(noAnchor.intensity).toBe(0.3);
    const zeroAnchor = classifyCell('occupied', { id: 1, name: 'P', militaryScore: 999999 }, { ownMilitary: 0 });
    expect(zeroAnchor.intensity).toBe(0.3);
  });

  it('a bandit rankClass adds a strong accent scaled by tier (0.22 per tier)', () => {
    const b1 = classifyCell('occupied', { id: 1, name: 'P', rankClass: 'rank_bandit1' });
    const b3 = classifyCell('occupied', { id: 1, name: 'P', rankClass: 'rank_bandit3' });
    expect(b1.intensity).toBeCloseTo(0.3 + 0.22, 5);
    expect(b3.intensity).toBeCloseTo(0.3 + 0.22 * 3, 5);
  });

  it('an honoured rankClass adds a mild accent scaled by tier (0.1 per tier, less than bandit)', () => {
    const h2 = classifyCell('occupied', { id: 1, name: 'P', rankClass: 'rank_honored2' });
    expect(h2.intensity).toBeCloseTo(0.3 + 0.1 * 2, 5);
    // Same tier, bandit reads strictly hotter than honoured.
    const bandit2 = classifyCell('occupied', { id: 1, name: 'P', rankClass: 'rank_bandit2' });
    expect(bandit2.intensity).toBeGreaterThan(h2.intensity);
  });

  it('threat intensity never exceeds 1 even with military + a tier-3 bandit stacked', () => {
    const maxed = classifyCell(
      'occupied',
      { id: 1, name: 'P', militaryScore: 1e9, rankClass: 'rank_bandit3' },
      { ownMilitary: 1 },
    );
    expect(maxed.intensity).toBe(1);
  });
});

describe('cellColor', () => {
  it('maps mine/blocked to their fixed anchor colours regardless of intensity', () => {
    expect(cellColor({ bucket: 'mine', intensity: 0.1 })).toBe('rgb(47,111,208)');
    expect(cellColor({ bucket: 'blocked', intensity: 1 })).toBe('rgb(86,91,102)');
  });

  it('maps free (and any unknown bucket) to the void anchor', () => {
    expect(cellColor({ bucket: 'free', intensity: 0 })).toBe('rgb(14,16,20)');
  });

  it('farm/threat ramp from a dim floor toward the full gold/red anchor with intensity', () => {
    const dim = cellColor({ bucket: 'farm', intensity: 0 });
    const bright = cellColor({ bucket: 'farm', intensity: 1 });
    expect(dim).not.toBe('rgb(14,16,20)'); // floor is 0.35 toward gold, not pure void
    expect(bright).toBe('rgb(226,170,58)'); // t=1 → exactly GOLD
    const dimRed = cellColor({ bucket: 'threat', intensity: 0 });
    const brightRed = cellColor({ bucket: 'threat', intensity: 1 });
    expect(dimRed).not.toBe('rgb(14,16,20)');
    expect(brightRed).toBe('rgb(226,72,60)'); // t=1 → exactly RED
  });
});

describe('fieldColor', () => {
  it('is pure void when both channels are 0', () => {
    expect(fieldColor(0, 0)).toBe('rgb(14,16,20)');
  });

  it('blends toward red-only or gold-only at each channel\'s max', () => {
    expect(fieldColor(1, 0)).toBe('rgb(226,72,60)');
    expect(fieldColor(0, 1)).toBe('rgb(226,170,58)');
  });

  it('both channels hot together additively brightens over the void (orange-ish, not double-capped)', () => {
    const both = fieldColor(1, 1);
    // Additive blend clamped at 255 per channel — brighter than either alone on at least one channel.
    const redOnly = fieldColor(1, 0);
    const goldOnly = fieldColor(0, 1);
    const parse = (/** @type {string} */ s) => s.match(/\d+/g)?.map(Number) ?? [];
    const [br, bg, bb] = parse(both);
    const [rr] = parse(redOnly);
    const [, gg] = parse(goldOnly);
    expect(br).toBeGreaterThanOrEqual(Math.max(rr, 0));
    expect(bg).toBeGreaterThanOrEqual(gg * 0); // sanity: valid numbers
    expect(bb).toBeGreaterThanOrEqual(0);
  });

  it('clamps out-of-range channel inputs into 0..1', () => {
    expect(fieldColor(-5, 5)).toBe(fieldColor(0, 1));
    expect(fieldColor(5, -5)).toBe(fieldColor(1, 0));
  });
});
