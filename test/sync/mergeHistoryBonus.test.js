// mergeHistory's one enrichment rule: a colony recorded before its planet
// size bonus was known (`b` absent) adopts the bonus a peer or a back-filled
// import carries — and never has an existing value overwritten.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { mergeHistory } from '../../src/sync/merge.js';

/** @param {number} cp @param {number} [b] */
const entry = (cp, b) => ({
  cp, fields: 300, coords: '[1:1:8]', position: 8, timestamp: cp,
  ...(b != null ? { b } : {}),
});

describe('mergeHistory — size bonus enrichment', () => {
  it('adopts a remote bonus for a local colony that has none', () => {
    const { merged, changed } = mergeHistory([entry(1)], [entry(1, 19.7)]);
    expect(changed).toBe(true);
    expect(merged).toEqual([entry(1, 19.7)]);
  });

  it('never overwrites a bonus the local colony already has', () => {
    const { merged, changed } = mergeHistory([entry(1, 20.37)], [entry(1, 19.7)]);
    expect(changed).toBe(false);
    expect(merged[0].b).toBe(20.37);
  });

  it('a remote colony without a bonus changes nothing', () => {
    const { changed } = mergeHistory([entry(1)], [entry(1)]);
    expect(changed).toBe(false);
  });

  it('still adds colonies the local side has never seen', () => {
    const { merged } = mergeHistory([entry(1)], [entry(2, 20.37)]);
    expect(merged.map((e) => e.cp)).toEqual([1, 2]);
  });
});
