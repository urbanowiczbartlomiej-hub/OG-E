// Unit tests for the attack-alarm pure core (no DOM).
//
// @ts-check

import { describe, it, expect } from 'vitest';

import {
  ATTACK_MISSION_TYPES,
  isUnderAttack,
  summarizeAttacks,
  attackFingerprint,
  formatEta,
} from '../../src/features/threatHighlight/pure.js';

/**
 * @param {Partial<import('../../src/features/threatHighlight/pure.js').HostileLeg>} [over]
 * @returns {import('../../src/features/threatHighlight/pure.js').HostileLeg}
 */
const leg = (over = {}) => ({
  missionType: '1',
  isReturn: false,
  isHostile: true,
  arrivalAt: 100,
  target: '[1:2:3]',
  ...over,
});

describe('threatHighlight/pure — isUnderAttack', () => {
  it('treats a missing flag (null/undefined) as NOT under attack', () => {
    expect(isUnderAttack(null)).toBe(false);
    expect(isUnderAttack(undefined)).toBe(false);
  });

  it('is NOT under attack while the noAttack token is present', () => {
    expect(isUnderAttack('tooltip noAttack')).toBe(false);
    expect(isUnderAttack('noAttack')).toBe(false);
    expect(isUnderAttack('  tooltip   noAttack  ')).toBe(false);
  });

  it('IS under attack once the noAttack token is gone', () => {
    expect(isUnderAttack('tooltip')).toBe(true);
    expect(isUnderAttack('')).toBe(true);
    expect(isUnderAttack('tooltip soon')).toBe(true);
  });

  it('matches noAttack as a whole token, not a substring', () => {
    // A class that merely CONTAINS the substring must not read as all-clear.
    expect(isUnderAttack('noAttackPending')).toBe(true);
  });
});

describe('threatHighlight/pure — summarizeAttacks', () => {
  it('returns the empty summary for no legs', () => {
    expect(summarizeAttacks([])).toEqual({ count: 0, soonestArrivalAt: 0, targets: [] });
  });

  it('counts only inbound hostile attacks, sorted earliest-first', () => {
    const s = summarizeAttacks([
      leg({ arrivalAt: 200, target: '[1:2:3]' }),
      leg({ arrivalAt: 100, target: '[1:2:3]' }),
      leg({ missionType: '2', arrivalAt: 150, target: '[4:5:6]' }),
    ]);
    expect(s.count).toBe(3);
    expect(s.soonestArrivalAt).toBe(100);
    // Unique, earliest-arrival first; the duplicate [1:2:3] collapses.
    expect(s.targets).toEqual(['[1:2:3]', '[4:5:6]']);
  });

  it('excludes espionage, friendly, and return legs', () => {
    const s = summarizeAttacks([
      leg({ missionType: '6', arrivalAt: 50 }), // espionage
      leg({ isHostile: false, arrivalAt: 60 }), // friendly / own
      leg({ isReturn: true, arrivalAt: 70 }), // return flight
      leg({ arrivalAt: 80, target: '[9:9:9]' }), // the only real attack
    ]);
    expect(s.count).toBe(1);
    expect(s.soonestArrivalAt).toBe(80);
    expect(s.targets).toEqual(['[9:9:9]']);
  });

  it('only the attack mission types (1, 2, 9) qualify', () => {
    expect([...ATTACK_MISSION_TYPES].sort()).toEqual(['1', '2', '9']);
    const s = summarizeAttacks([leg({ missionType: '9', arrivalAt: 42 })]);
    expect(s.count).toBe(1);
  });

  it('falls back to soonestArrivalAt 0 when no leg carries a finite arrival', () => {
    const s = summarizeAttacks([leg({ arrivalAt: NaN }), leg({ arrivalAt: NaN })]);
    expect(s.count).toBe(2);
    expect(s.soonestArrivalAt).toBe(0);
  });

  it('skips a target with empty coords but still counts the leg', () => {
    const s = summarizeAttacks([leg({ target: '' }), leg({ arrivalAt: 90, target: '[5:5:5]' })]);
    expect(s.count).toBe(2);
    expect(s.targets).toEqual(['[5:5:5]']);
  });
});

describe('threatHighlight/pure — attackFingerprint', () => {
  it('combines count and soonest arrival into a stable string', () => {
    expect(attackFingerprint({ count: 3, soonestArrivalAt: 100, targets: [] })).toBe('3|100');
    expect(attackFingerprint({ count: 0, soonestArrivalAt: 0, targets: [] })).toBe('0|0');
  });

  it('changes when a faster fleet replaces a slower one at the same count', () => {
    const a = attackFingerprint({ count: 2, soonestArrivalAt: 300, targets: [] });
    const b = attackFingerprint({ count: 2, soonestArrivalAt: 120, targets: [] });
    expect(a).not.toBe(b);
  });
});

describe('threatHighlight/pure — formatEta', () => {
  it('collapses non-positive / non-finite to a dash', () => {
    expect(formatEta(0)).toBe('—');
    expect(formatEta(-10)).toBe('—');
    expect(formatEta(NaN)).toBe('—');
    expect(formatEta(Infinity)).toBe('—');
  });

  it('formats sub-hour as m:ss', () => {
    expect(formatEta(5)).toBe('0:05');
    expect(formatEta(65)).toBe('1:05');
    expect(formatEta(599)).toBe('9:59');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatEta(3725)).toBe('1:02:05');
    expect(formatEta(3600)).toBe('1:00:00');
  });
});
