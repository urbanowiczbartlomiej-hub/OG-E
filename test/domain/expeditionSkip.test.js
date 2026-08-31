// Unit tests for the expedition skip list's stored format
// (`domain/expeditionSkip.js`) — the string both walks agree on.
//
// The point of this module is that the value survives round-trips through a
// plain localStorage string across versions and hand edits, so the cases below
// lean on the messy inputs (brackets, spaces, junk, duplicates) rather than
// only the happy path.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  parseSkipCoords,
  formatSkipCoords,
  toggleSkipCoords,
} from '../../src/domain/expeditionSkip.js';

describe('parseSkipCoords', () => {
  it('reads a comma-separated list into a lookup set', () => {
    const set = parseSkipCoords('1:301:4,1:301:12');
    expect(set.has('1:301:4')).toBe(true);
    expect(set.has('1:301:12')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('is empty for the unset / blank value', () => {
    expect(parseSkipCoords('').size).toBe(0);
    expect(parseSkipCoords(null).size).toBe(0);
    expect(parseSkipCoords(undefined).size).toBe(0);
  });

  it('normalises brackets and whitespace the way the game writes coords', () => {
    // A player pasting a coord out of the game gets `[1:234:5]`; the walks
    // compare against `denseCoords` output, so the stored form must match.
    const set = parseSkipCoords(' [1:234:5] , 1:240:9 ');
    expect([...set]).toEqual(['1:234:5', '1:240:9']);
  });

  it('drops anything that is not a g:s:p triple', () => {
    // A kept-but-unmatchable key would inflate the settings readout while
    // never affecting a walk — silently wrong. Better to drop it.
    const set = parseSkipCoords('1:234:5,,garbage,7,1:2,1:2:3:4');
    expect([...set]).toEqual(['1:234:5']);
  });
});

describe('formatSkipCoords', () => {
  it('sorts numerically in planet-list reading order', () => {
    // String sort would put 1:10:4 before 1:9:4 — the readout and the stored
    // value would then disagree with how the player reads their sidebar.
    expect(formatSkipCoords(['1:10:4', '2:1:1', '1:9:4'])).toBe(
      '1:9:4,1:10:4,2:1:1',
    );
  });

  it('dedupes, so the same selection always yields the same string', () => {
    expect(formatSkipCoords(['1:2:3', '1:2:3'])).toBe('1:2:3');
  });

  it('is empty for an empty selection', () => {
    expect(formatSkipCoords([])).toBe('');
  });
});

describe('toggleSkipCoords', () => {
  it('adds a body that is not yet excluded', () => {
    expect(toggleSkipCoords('', '1:234:5')).toBe('1:234:5');
    expect(toggleSkipCoords('1:234:5', '1:240:9')).toBe('1:234:5,1:240:9');
  });

  it('removes a body that already is', () => {
    expect(toggleSkipCoords('1:234:5,1:240:9', '1:234:5')).toBe('1:240:9');
  });

  it('round-trips back to the original value', () => {
    const once = toggleSkipCoords('1:2:3', '4:5:6');
    expect(toggleSkipCoords(once, '4:5:6')).toBe('1:2:3');
  });

  it('empties out when the last body is unticked — the "off" state', () => {
    expect(toggleSkipCoords('1:2:3', '1:2:3')).toBe('');
  });

  it('matches a bracketed coord against the stored dense form', () => {
    expect(toggleSkipCoords('1:234:5', '[1:234:5]')).toBe('');
  });
});
