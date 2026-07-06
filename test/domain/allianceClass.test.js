// @ts-check
//
// Unit tests for the pure alliance-class helpers (domain/allianceClass.js).
// Plain functions over CSS tokens / row ids — node env, no DOM. We pin the
// verbatim game vocabulary (warrior / trader / explorer / none) and the row-id
// shape, so a game rename fails HERE rather than silently dark-ing the tell.

import { describe, it, expect } from 'vitest';
import {
  allianceClassFromTokens,
  allianceIdFromPositionId,
  isWarriorAlliance,
  ALLIANCE_CLASS_SLUGS,
} from '../../src/domain/allianceClass.js';

describe('allianceClassFromTokens', () => {
  it('returns the class slug present among the span tokens', () => {
    expect(allianceClassFromTokens(['alliance_class', 'small', 'warrior'])).toBe('warrior');
    expect(allianceClassFromTokens(['alliance_class', 'small', 'trader'])).toBe('trader');
    // Researcher alliance's slug is `explorer`, NOT `researcher` (verified live).
    expect(allianceClassFromTokens(['alliance_class', 'small', 'explorer'])).toBe('explorer');
  });

  it('returns "none" for a classless alliance (KNOWN, not undefined)', () => {
    expect(allianceClassFromTokens(['alliance_class', 'small', 'none'])).toBe('none');
  });

  it('returns undefined when no class token is present (unexpected markup)', () => {
    expect(allianceClassFromTokens(['alliance_class', 'small'])).toBeUndefined();
    expect(allianceClassFromTokens([])).toBeUndefined();
  });

  it('accepts any iterable (e.g. a DOMTokenList-like)', () => {
    expect(allianceClassFromTokens(new Set(['small', 'warrior']))).toBe('warrior');
  });

  it('never treats "researcher" as a class (guards the explorer↔researcher trap)', () => {
    expect(allianceClassFromTokens(['alliance_class', 'small', 'researcher'])).toBeUndefined();
  });
});

describe('allianceIdFromPositionId', () => {
  it('extracts the numeric id from a highscore row id', () => {
    expect(allianceIdFromPositionId('position500921')).toBe('500921');
  });

  it('returns undefined for anything that is not position<digits>', () => {
    expect(allianceIdFromPositionId('ranks')).toBeUndefined();
    expect(allianceIdFromPositionId('position')).toBeUndefined();
    expect(allianceIdFromPositionId('positionABC')).toBeUndefined();
    expect(allianceIdFromPositionId('')).toBeUndefined();
    expect(allianceIdFromPositionId(undefined)).toBeUndefined();
    expect(allianceIdFromPositionId(null)).toBeUndefined();
  });
});

describe('isWarriorAlliance', () => {
  it('is true ONLY for the warrior slug', () => {
    expect(isWarriorAlliance('warrior')).toBe(true);
    expect(isWarriorAlliance('trader')).toBe(false);
    expect(isWarriorAlliance('explorer')).toBe(false);
    expect(isWarriorAlliance('none')).toBe(false);
    expect(isWarriorAlliance(undefined)).toBe(false);
  });
});

describe('ALLIANCE_CLASS_SLUGS', () => {
  it('lists the three real classes (none is the absence, not a class)', () => {
    expect([...ALLIANCE_CLASS_SLUGS]).toEqual(['warrior', 'trader', 'explorer']);
  });
});
