// @vitest-environment happy-dom
//
// Unit tests for state/expStartPlanet — the one-`cp` "expedition cycle
// anchor" cache over safeLS. Mirrors coloArrival.test.js: happy-dom gives a
// real localStorage; we wipe it between cases and drive the public surface.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EXP_START_CP_KEY,
  readExpStartCp,
  writeExpStartCp,
} from '../../src/state/expStartPlanet.js';

beforeEach(() => {
  localStorage.clear();
});

describe('expStartPlanet', () => {
  it('exposes the canonical key', () => {
    expect(EXP_START_CP_KEY).toBe('oge-exp-start-cp');
  });

  it('round-trips a positive cp', () => {
    writeExpStartCp(12345);
    expect(readExpStartCp()).toBe(12345);
  });

  it('returns 0 when the key is absent', () => {
    expect(readExpStartCp()).toBe(0);
  });

  it('writeExpStartCp(0) removes the key', () => {
    writeExpStartCp(12345);
    expect(localStorage.getItem(EXP_START_CP_KEY)).not.toBeNull();
    writeExpStartCp(0);
    expect(localStorage.getItem(EXP_START_CP_KEY)).toBeNull();
    expect(readExpStartCp()).toBe(0);
  });

  it('a negative value clears rather than stores', () => {
    writeExpStartCp(-5);
    expect(localStorage.getItem(EXP_START_CP_KEY)).toBeNull();
    expect(readExpStartCp()).toBe(0);
  });

  it('reads 0 for a stored non-positive / garbage value', () => {
    localStorage.setItem(EXP_START_CP_KEY, '0');
    expect(readExpStartCp()).toBe(0);
    localStorage.setItem(EXP_START_CP_KEY, 'not-a-number');
    expect(readExpStartCp()).toBe(0);
  });
});
