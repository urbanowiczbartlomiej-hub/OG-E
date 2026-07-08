// Unit tests for domain/scanMode.js — the binary probe-scan choice ('on'/'off')
// and its key shapes. The resolution ladder (player-'off' dominates → body
// override → player default → 'on') is what keeps the dossier toggle, the FAB
// plan and the dashboard glyph in agreement, so it's pinned here.
//
// Node env — pure key-shaping over plain data.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  ringKeyFor,
  overrideKeyFor,
  effectiveScan,
  aggregatePlayerScan,
} from '../../src/domain/scanMode.js';

describe('key shapes', () => {
  it('ring keys carry the explicit body type for BOTH bodies', () => {
    expect(ringKeyFor('1:2:3', 1)).toBe('1:2:3:1');
    expect(ringKeyFor('1:2:3', 3)).toBe('1:2:3:3');
  });

  it('override keys: bare coord for a planet, ":3" suffix for a moon', () => {
    expect(overrideKeyFor('1:2:3', 1)).toBe('1:2:3');
    expect(overrideKeyFor('1:2:3', 3)).toBe('1:2:3:3');
  });
});

describe('effectiveScan — resolution ladder', () => {
  it('absent map behaves as "scan everything" (the pre-feature default)', () => {
    expect(effectiveScan(undefined, '42', '1:2:3')).toBe('on');
    expect(effectiveScan({}, '42', '1:2:3')).toBe('on');
  });

  it('a whole-player off DOMINATES a stale per-body on override', () => {
    expect(effectiveScan({ 42: 'off', '1:2:3': 'on' }, '42', '1:2:3')).toBe('off');
  });

  it('with the player on (default), the body override wins', () => {
    expect(effectiveScan({ '1:2:3': 'off' }, '42', '1:2:3')).toBe('off');
    expect(effectiveScan({ '1:2:3:3': 'off' }, '42', '1:2:3:3')).toBe('off');
    // A sibling body's override never leaks onto this one.
    expect(effectiveScan({ '1:2:3:3': 'off' }, '42', '1:2:3')).toBe('on');
  });

  it('an explicit body "on" under an absent player default stays on', () => {
    expect(effectiveScan({ '1:2:3': 'on' }, '42', '1:2:3')).toBe('on');
  });
});

describe('aggregatePlayerScan — the table glyph summary', () => {
  it('no bodies in scope → the whole-player value, or null when unset', () => {
    expect(aggregatePlayerScan({ 42: 'off' }, '42', [])).toBe('off');
    expect(aggregatePlayerScan({}, '42', [])).toBeNull();
  });

  it('uniform resolution → that mode; divergent bodies → "mixed"', () => {
    expect(aggregatePlayerScan({}, '42', ['1:2:3', '1:2:4'])).toBe('on');
    expect(aggregatePlayerScan({ 42: 'off' }, '42', ['1:2:3', '1:2:4'])).toBe('off');
    expect(aggregatePlayerScan({ '1:2:3': 'off' }, '42', ['1:2:3', '1:2:4'])).toBe('mixed');
  });
});
