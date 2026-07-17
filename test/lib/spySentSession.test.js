// @vitest-environment happy-dom
// @ts-check

import { beforeEach, describe, it, expect } from 'vitest';
import {
  SPY_SENT_KEY,
  readSpySentMap,
  markSpySent,
  unmarkSpySent,
} from '../../src/lib/spySentSession.js';

beforeEach(() => window.sessionStorage.clear());

describe('spySentSession', () => {
  it('returns {} on empty storage', () => {
    expect(readSpySentMap()).toEqual({});
  });

  it('reads the legacy plain-array format as time-unknown (0)', () => {
    window.sessionStorage.setItem(
      SPY_SENT_KEY,
      JSON.stringify(['1:2:3', '4:5:6']),
    );
    expect(readSpySentMap()).toEqual({ '1:2:3': 0, '4:5:6': 0 });
  });

  it('round-trips the new object format via markSpySent', () => {
    markSpySent('1:2:3', 1700000000000);
    expect(readSpySentMap()).toEqual({ '1:2:3': 1700000000000 });
  });

  it('overwrites the send time on the same coord (last write wins)', () => {
    markSpySent('1:2:3', 1700000000000);
    markSpySent('1:2:3', 1800000000000);
    markSpySent('4:5:6', 1650000000000);
    expect(readSpySentMap()).toEqual({
      '1:2:3': 1800000000000,
      '4:5:6': 1650000000000,
    });
  });

  it('coerces garbage / negative / zero values to 0', () => {
    window.sessionStorage.setItem(
      SPY_SENT_KEY,
      JSON.stringify({ '1:2:3': -5, '4:5:6': 'x' }),
    );
    expect(readSpySentMap()).toEqual({ '1:2:3': 0, '4:5:6': 0 });
  });

  it('returns {} on corrupt JSON without throwing', () => {
    window.sessionStorage.setItem(SPY_SENT_KEY, '{not json');
    expect(readSpySentMap()).toEqual({});
  });

  it('unmarkSpySent removes one coord, leaving the rest (rollback path)', () => {
    markSpySent('1:2:3', 1700000000000);
    markSpySent('4:5:6:3', 1700000000001);
    unmarkSpySent('1:2:3');
    expect(readSpySentMap()).toEqual({ '4:5:6:3': 1700000000001 });
  });

  it('unmarkSpySent is a no-op for a coord that was never marked', () => {
    markSpySent('1:2:3', 1700000000000);
    unmarkSpySent('9:9:9');
    expect(readSpySentMap()).toEqual({ '1:2:3': 1700000000000 });
  });
});
