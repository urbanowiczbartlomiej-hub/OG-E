// @ts-check

import { describe, it, expect } from 'vitest';

import { parseTraderCountdown } from '../../src/domain/traderCountdown.js';

describe('parseTraderCountdown', () => {
  it('parses the Polish "Xmin. Ysek." form', () => {
    expect(parseTraderCountdown('18min. 20sek.')).toBe(18 * 60 + 20);
  });

  it('parses a seconds-only Polish form', () => {
    expect(parseTraderCountdown('45sek.')).toBe(45);
  });

  it('parses hours via the Polish "g" unit', () => {
    expect(parseTraderCountdown('1g. 5min. 0sek.')).toBe(3600 + 5 * 60);
  });

  it('parses English h/m/s units', () => {
    expect(parseTraderCountdown('2h 3m 4s')).toBe(2 * 3600 + 3 * 60 + 4);
  });

  it('parses German Std/Min/Sek (Std before Sek)', () => {
    expect(parseTraderCountdown('1Std. 2Min. 3Sek.')).toBe(3600 + 2 * 60 + 3);
  });

  it('falls back to M:SS colon notation', () => {
    expect(parseTraderCountdown('5:30')).toBe(5 * 60 + 30);
  });

  it('falls back to H:MM:SS colon notation', () => {
    expect(parseTraderCountdown('1:02:03')).toBe(3600 + 2 * 60 + 3);
  });

  it('ignores surrounding label text, summing only the units', () => {
    expect(parseTraderCountdown('Następna aukcja za: 2min. 5sek.')).toBe(125);
  });

  it('returns null for a bare number with no unit', () => {
    expect(parseTraderCountdown('42')).toBeNull();
  });

  it.each([['', null], ['   ', null], ['soon', null]])(
    'returns null for non-time text %j',
    (input, expected) => {
      expect(parseTraderCountdown(input)).toBe(expected);
    },
  );

  it('returns null for non-string input', () => {
    expect(parseTraderCountdown(null)).toBeNull();
    expect(parseTraderCountdown(120)).toBeNull();
  });
});
