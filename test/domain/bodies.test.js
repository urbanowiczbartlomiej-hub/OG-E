// Unit tests for the pure body-inventory helpers in `domain/bodies.js`.
// Node env — no DOM, no storage: plain functions over plain data.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  parseKoords,
  sortBodies,
  dedupeBodies,
  isCompleteBody,
} from '../../src/domain/bodies.js';

/** @typedef {import('../../src/domain/bodies.js').Body} Body */

describe('parseKoords', () => {
  it('parses the bracketed game form "[g:s:p]"', () => {
    expect(parseKoords('[4:467:15]')).toEqual({ galaxy: 4, system: 467, position: 15 });
  });

  it('parses a bare "g:s:p" string', () => {
    expect(parseKoords('5:172:8')).toEqual({ galaxy: 5, system: 172, position: 8 });
  });

  it('tolerates surrounding whitespace / text', () => {
    expect(parseKoords('  [6:100:1]  ')).toEqual({ galaxy: 6, system: 100, position: 1 });
  });

  it('returns null for empty / nullish / non-coordinate input', () => {
    expect(parseKoords('')).toBeNull();
    expect(parseKoords(null)).toBeNull();
    expect(parseKoords(undefined)).toBeNull();
    expect(parseKoords('not coords')).toBeNull();
  });
});

describe('sortBodies', () => {
  it('orders by galaxy, system, position, then type (planet before moon)', () => {
    /** @type {Body[]} */
    const input = [
      { cp: 3, name: 'K', galaxy: 4, system: 467, position: 15, type: 3 },
      { cp: 1, name: 'P', galaxy: 4, system: 467, position: 15, type: 1 },
      { cp: 2, name: 'W', galaxy: 1, system: 1, position: 1, type: 1 },
    ];
    expect(sortBodies(input).map((b) => b.cp)).toEqual([2, 1, 3]);
  });

  it('returns a new array and does not mutate the input', () => {
    /** @type {Body[]} */
    const input = [
      { cp: 2, name: 'b', galaxy: 2, system: 1, position: 1, type: 1 },
      { cp: 1, name: 'a', galaxy: 1, system: 1, position: 1, type: 1 },
    ];
    const out = sortBodies(input);
    expect(out).not.toBe(input);
    expect(input.map((b) => b.cp)).toEqual([2, 1]); // input untouched
    expect(out.map((b) => b.cp)).toEqual([1, 2]);
  });
});

describe('dedupeBodies', () => {
  it('drops later entries sharing a coordTypeKey, keeping the first', () => {
    /** @type {Body[]} */
    const input = [
      { cp: 1, name: 'first', galaxy: 4, system: 467, position: 15, type: 1 },
      { cp: 9, name: 'dup', galaxy: 4, system: 467, position: 15, type: 1 },
      { cp: 2, name: 'moon', galaxy: 4, system: 467, position: 15, type: 3 },
    ];
    const out = dedupeBodies(input);
    expect(out.map((b) => b.cp)).toEqual([1, 2]); // planet + its moon kept, dup dropped
  });
});

describe('isCompleteBody', () => {
  it('accepts a fully-formed planet and moon', () => {
    expect(isCompleteBody({ cp: 1, name: 'P', galaxy: 4, system: 467, position: 15, type: 1 })).toBe(true);
    expect(isCompleteBody({ cp: 2, name: 'K', galaxy: 4, system: 467, position: 15, type: 3 })).toBe(true);
  });

  it('rejects missing / non-positive cp', () => {
    expect(isCompleteBody({ name: 'x', galaxy: 4, system: 467, position: 15, type: 1 })).toBe(false);
    expect(isCompleteBody({ cp: 0, name: 'x', galaxy: 4, system: 467, position: 15, type: 1 })).toBe(false);
    expect(isCompleteBody({ cp: NaN, name: 'x', galaxy: 4, system: 467, position: 15, type: 1 })).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(isCompleteBody({ cp: 1, name: 'x', galaxy: NaN, system: 467, position: 15, type: 1 })).toBe(false);
  });

  it('rejects an unrecognised type', () => {
    expect(isCompleteBody({ cp: 1, name: 'x', galaxy: 4, system: 467, position: 15, type: 2 })).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isCompleteBody(null)).toBe(false);
    expect(isCompleteBody(undefined)).toBe(false);
  });
});
