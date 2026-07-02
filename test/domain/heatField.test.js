// Unit tests for the two-channel threat/farm field builder in
// domain/heatField.js. Small dims (few galaxies, small `systems`) keep
// fixtures readable; the algorithm is scale-agnostic. `cols` is usually set
// to `systems` (per-system resolution) so sample math is easy to reason
// about, except in the dedicated resolution/binning tests.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { buildThreatFarmField, sampleField } from '../../src/domain/heatField.js';

/** An active occupant slot ("threat" bucket once classified). @param {number} id @param {number} [militaryScore] */
const active = (id, militaryScore) => ({
  status: 'occupied',
  player: { id, name: 'P' + id, militaryScore },
});
/** An inactive (farmable) slot with account points. @param {number} id @param {number} score */
const inactive = (id, score) => ({
  status: 'inactive',
  player: { id, name: 'P' + id, score },
});

/**
 * Build a GalaxyScans fixture from `{ "g:s": { slot: Position } }` shorthand.
 * @param {Record<string, Record<number, any>>} spec
 */
const scansOf = (spec) => {
  /** @type {any} */
  const out = {};
  for (const [key, positions] of Object.entries(spec)) {
    out[key] = { scannedAt: 1, positions };
  }
  return out;
};

const DIMS = { galaxies: 2, systems: 50 };

describe('buildThreatFarmField', () => {
  it('produces an all-void field for an empty scan map, without throwing', () => {
    const field = buildThreatFarmField({}, DIMS, { cols: 50 });
    expect(field.galaxies).toBe(2);
    expect(field.cols).toBe(50);
    for (let g = 1; g <= 2; g++) {
      for (let s = 1; s <= 50; s++) {
        const cell = sampleField(field, g, s);
        expect(cell.threat).toBe(0);
        expect(cell.farm).toBe(0);
      }
    }
  });

  it('a single active occupant produces threat near its system that decays with distance', () => {
    const scans = scansOf({ '1:25': { 3: active(1, 5000) } });
    const field = buildThreatFarmField(scans, DIMS, { cols: 50, ownMilitary: 5000 });
    const near = sampleField(field, 1, 25).threat;
    const far = sampleField(field, 1, 1).threat;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
  });

  it('a single inactive occupant produces farm near its system that decays with distance', () => {
    const scans = scansOf({ '1:25': { 3: inactive(1, 10000) } });
    const field = buildThreatFarmField(scans, DIMS, { cols: 50, farmReach: 30 });
    const near = sampleField(field, 1, 25).farm;
    const far = sampleField(field, 1, 1).farm;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
  });

  it('threat and farm channels stay within [0,1] (p95-relative normalisation)', () => {
    const scans = scansOf({
      '1:10': { 3: active(1, 50000) },
      '1:15': { 4: active(2, 5) },
      '1:40': { 5: inactive(3, 999999) },
      '2:1': { 6: inactive(4, 10) },
    });
    const field = buildThreatFarmField(scans, DIMS, { cols: 50, ownMilitary: 5000 });
    for (let g = 1; g <= 2; g++) {
      for (let s = 1; s <= 50; s++) {
        const cell = sampleField(field, g, s);
        expect(cell.threat).toBeGreaterThanOrEqual(0);
        expect(cell.threat).toBeLessThanOrEqual(1);
        expect(cell.farm).toBeGreaterThanOrEqual(0);
        expect(cell.farm).toBeLessThanOrEqual(1);
      }
    }
  });

  it('donutSystem wraps a source near the high boundary onto low systems on the other side', () => {
    const dims = { galaxies: 1, systems: 499, donutSystem: true };
    const scans = scansOf({ '1:499': { 3: active(1, 50000) } });

    const wrapped = buildThreatFarmField(scans, dims, { cols: 499, ownMilitary: 5000 });
    const noWrap = buildThreatFarmField(
      scans,
      { galaxies: 1, systems: 499, donutSystem: false },
      { cols: 499, ownMilitary: 5000 },
    );

    const wrappedRead = sampleField(wrapped, 1, 1).threat;
    const noWrapRead = sampleField(noWrap, 1, 1).threat;
    expect(wrappedRead).toBeGreaterThan(0);
    expect(noWrapRead).toBe(0);
  });

  it('donutGalaxy wraps a source near the last galaxy onto galaxy 1 (farm channel)', () => {
    // Threat can NEVER cross a galaxy boundary regardless of donutGalaxy — a
    // galaxy hop is ~24.7h flight, past the 1.5×windowH threat fade-out (see
    // the module doc comment) — so this must be exercised on the FARM
    // channel, whose reach is a flat system-radius that DOES cross galaxies.
    const dims = { galaxies: 3, systems: 50, donutGalaxy: true };
    const scans = scansOf({ '3:25': { 3: inactive(1, 50000) } });

    const wrapped = buildThreatFarmField(scans, dims, { cols: 50, farmReach: 300 });
    const noWrap = buildThreatFarmField(
      scans,
      { galaxies: 3, systems: 50, donutGalaxy: false },
      { cols: 50, farmReach: 300 },
    );

    // Galaxy hops only reach the immediate neighbour (±1) in the convolution,
    // so read galaxy 1 (neighbour of wrapped galaxy 3) at the same system.
    const wrappedRead = sampleField(wrapped, 1, 25).farm;
    const noWrapRead = sampleField(noWrap, 1, 25).farm;
    expect(wrappedRead).toBeGreaterThan(0);
    expect(noWrapRead).toBe(0);
  });

  it('ownMilitary anchors threat intensity — a low anchor reads hotter than a high anchor', () => {
    // militaryScore 20000: with ownMilitary 20000, mil/(anchor*2) = 0.5 (below
    // the saturation point of 1, so it actually raises intensity above the
    // 0.3 base); with ownMilitary 200000, mil/(anchor*2) = 0.05 (below base,
    // so intensity falls back to the flat 0.3 "active at all" floor).
    //
    // A LONE source always p95-normalises its own raw pressure to a fixed
    // constant (p95 of one value == that value), erasing any intensity
    // difference — so this fixture also carries a huge, distant, INDEPENDENT
    // anchor source in another galaxy. Threat never crosses a galaxy
    // boundary (see the module doc comment), so the anchor contributes zero
    // pressure at the subject's system, but it DOES dominate the field-wide
    // p95 identically in both builds, pinning both fields to the same
    // normalisation scale and making the subject's reads directly comparable.
    const anchor = { '2:25': { 9: active(999, 999_999_999) } };
    const scans = scansOf({ ...anchor, '1:25': { 3: active(1, 20000) } });
    const lowAnchor = buildThreatFarmField(scans, DIMS, { cols: 50, ownMilitary: 20000 });
    const highAnchor = buildThreatFarmField(scans, DIMS, { cols: 50, ownMilitary: 200000 });

    expect(lowAnchor.threatScale).toBeCloseTo(highAnchor.threatScale, 6); // scale pinned by the shared anchor
    const lowRead = sampleField(lowAnchor, 1, 25).threat;
    const highRead = sampleField(highAnchor, 1, 25).threat;
    expect(lowRead).toBeGreaterThan(highRead);
  });

  it('cols controls the field resolution', () => {
    const field16 = buildThreatFarmField({}, DIMS, { cols: 16 });
    const field50 = buildThreatFarmField({}, DIMS, { cols: 50 });
    expect(field16.cols).toBe(16);
    expect(field50.cols).toBe(50);
  });

  it('multiple inactive planets owned by the same player are NOT counted additively per planet', () => {
    // Same owner (id 1), two planets of 10000 pts each, on DIFFERENT systems
    // so a naive (non-deduped) build would source 10000 from EACH planet's
    // own bin; with the per-account dedup, each bin instead sources only
    // score/planetCount = 5000.
    //
    // A field with only these two (equal) sources always p95-normalises its
    // own peak to 1.0 regardless of the dedup — comparing such a field
    // against a differently-scored reference field is meaningless (both
    // fields' peaks read 1.0 no matter the underlying magnitude). So this
    // fixture also carries a fixed, distant, huge "anchor" source that
    // dominates the p95 in BOTH builds identically — that pins the
    // normalisation scale to the same value across builds, making the
    // (otherwise-relative) farm reads near the subject sources directly
    // comparable in absolute terms.
    const anchor = { '2:25': { 9: inactive(999, 1_000_000) } };

    const sameOwnerSpec = {
      ...anchor,
      '1:20': { 3: inactive(1, 10000) },
      '1:30': { 4: inactive(1, 10000) },
    };
    // Identical geometry/scores, but DIFFERENT owners → dedup does not apply,
    // so each bin genuinely sources the full 10000 (a true additive double).
    const diffOwnersSpec = {
      ...anchor,
      '1:20': { 3: inactive(2, 10000) },
      '1:30': { 4: inactive(3, 10000) },
    };

    const fieldSameOwner = buildThreatFarmField(scansOf(sameOwnerSpec), DIMS, { cols: 50, farmReach: 30 });
    const fieldDiffOwners = buildThreatFarmField(scansOf(diffOwnersSpec), DIMS, { cols: 50, farmReach: 30 });

    const sameOwnerRead = sampleField(fieldSameOwner, 1, 20).farm;
    const diffOwnersRead = sampleField(fieldDiffOwners, 1, 20).farm;

    expect(sameOwnerRead).toBeGreaterThan(0);
    // Undeduped (different owners) reads exactly double the deduped
    // same-owner read at the identical geometry — proving the per-account
    // split, not a naive per-planet sum.
    expect(diffOwnersRead).toBeCloseTo(sameOwnerRead * 2, 6);
  });
});

describe('sampleField', () => {
  it('returns {threat:0, farm:0} for a galaxy row that does not exist in the field', () => {
    const field = buildThreatFarmField({}, DIMS, { cols: 50 });
    expect(sampleField(field, 99, 1)).toEqual({ threat: 0, farm: 0 });
  });

  it('sampling the same system twice returns the same value (stable mapping)', () => {
    const scans = scansOf({ '1:25': { 3: active(1, 20000) } });
    const field = buildThreatFarmField(scans, DIMS, { cols: 50, ownMilitary: 5000 });
    const a = sampleField(field, 1, 25);
    const b = sampleField(field, 1, 25);
    expect(a).toEqual(b);
  });

  it('adjacent systems in a coarse field can share the same bin', () => {
    const field = buildThreatFarmField({}, { galaxies: 1, systems: 50 }, { cols: 5 });
    // binWidth = 10, so systems 1 and 2 both floor to bin 0.
    const a = sampleField(field, 1, 1);
    const b = sampleField(field, 1, 2);
    expect(a).toEqual(b);
  });
});
