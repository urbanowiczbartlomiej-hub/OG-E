// mergeHistory's enrichment rule for the diameter: a colony recorded before
// OG-E kept diameters (`d` absent) adopts the one a peer or an import carries
// — never overwriting a value, and independently of the size bonus `b`.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { mergeHistory } from '../../src/sync/merge.js';

/** @param {number} cp @param {{ b?: number, d?: number }} [extra] */
const entry = (cp, extra = {}) => ({
  cp, fields: 300, coords: '[1:1:8]', position: 8, timestamp: cp, ...extra,
});

describe('mergeHistory — diameter enrichment', () => {
  it('adopts a remote diameter for a local colony that has none', () => {
    const { merged, changed } = mergeHistory([entry(1)], [entry(1, { d: 17000 })]);
    expect(changed).toBe(true);
    expect(merged).toEqual([entry(1, { d: 17000 })]);
  });

  it('never overwrites a diameter the local colony already has', () => {
    const { merged, changed } = mergeHistory([entry(1, { d: 17000 })], [entry(1, { d: 16000 })]);
    expect(changed).toBe(false);
    expect(merged[0].d).toBe(17000);
  });

  it('ignores a non-positive remote diameter', () => {
    const { changed } = mergeHistory([entry(1)], [entry(1, { d: 0 })]);
    expect(changed).toBe(false);
  });

  it('adopts b and d together, each only where missing', () => {
    const { merged } = mergeHistory([entry(1, { b: 20.37 })], [entry(1, { b: 19.7, d: 17000 })]);
    expect(merged[0]).toEqual(entry(1, { b: 20.37, d: 17000 }));
  });
});
