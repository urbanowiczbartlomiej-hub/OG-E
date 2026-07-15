// @vitest-environment happy-dom
//
// Unit tests for state/coloArrival — the one-number "nearest upcoming
// colonization arrival" cache (epoch seconds) over safeLS. happy-dom gives a
// real localStorage; we wipe it between cases and drive the public surface.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  COLO_ARRIVAL_KEY,
  readColoArrival,
  writeColoArrival,
} from '../../src/state/coloArrival.js';

beforeEach(() => {
  localStorage.clear();
});

describe('coloArrival', () => {
  it('exposes the canonical key', () => {
    expect(COLO_ARRIVAL_KEY).toBe('oge-colo-arrival');
  });

  it('round-trips a positive arrival (epoch seconds)', () => {
    writeColoArrival(1_784_000_123);
    expect(readColoArrival()).toBe(1_784_000_123);
  });

  it('returns 0 when the key is absent', () => {
    expect(readColoArrival()).toBe(0);
  });

  it('writeColoArrival(0) removes the key', () => {
    writeColoArrival(1_784_000_123);
    expect(localStorage.getItem(COLO_ARRIVAL_KEY)).not.toBeNull();
    writeColoArrival(0);
    expect(localStorage.getItem(COLO_ARRIVAL_KEY)).toBeNull();
    expect(readColoArrival()).toBe(0);
  });

  it('a negative value clears rather than stores', () => {
    writeColoArrival(-5);
    expect(localStorage.getItem(COLO_ARRIVAL_KEY)).toBeNull();
    expect(readColoArrival()).toBe(0);
  });

  it('reads 0 for a stored non-positive / non-number value', () => {
    localStorage.setItem(COLO_ARRIVAL_KEY, JSON.stringify(0));
    expect(readColoArrival()).toBe(0);
    localStorage.setItem(COLO_ARRIVAL_KEY, JSON.stringify('soon'));
    expect(readColoArrival()).toBe(0);
  });
});
