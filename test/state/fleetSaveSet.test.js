// @vitest-environment happy-dom
//
// Unit tests for state/fleetSaveSet — a plain JSON string-array of detected
// fleet-save row-ids over safeLS. happy-dom supplies a real localStorage, wiped
// between cases; tests drive the public read/write surface against the wire.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLEET_SAVE_SET_KEY,
  readFleetSaveIds,
  writeFleetSaveIds,
} from '../../src/state/fleetSaveSet.js';

beforeEach(() => {
  localStorage.clear();
});

describe('fleetSaveSet', () => {
  it('exposes the canonical key', () => {
    expect(FLEET_SAVE_SET_KEY).toBe('oge-fleetsave-set');
  });

  it('round-trips an array of string ids', () => {
    const ids = ['eventRow-1', 'eventRow-2', 'eventRow-9'];
    writeFleetSaveIds(ids);
    expect(readFleetSaveIds()).toEqual(ids);
  });

  it('returns [] when the key is absent', () => {
    expect(readFleetSaveIds()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem(FLEET_SAVE_SET_KEY, JSON.stringify({ not: 'an array' }));
    expect(readFleetSaveIds()).toEqual([]);
  });

  it('filters out non-string entries', () => {
    localStorage.setItem(
      FLEET_SAVE_SET_KEY,
      JSON.stringify(['eventRow-1', 42, null, { x: 1 }, 'eventRow-2', true]),
    );
    expect(readFleetSaveIds()).toEqual(['eventRow-1', 'eventRow-2']);
  });

  it('stores [] when writeFleetSaveIds gets a non-array argument', () => {
    // @ts-expect-error — exercising the runtime guard with a bad type.
    writeFleetSaveIds('eventRow-1');
    expect(readFleetSaveIds()).toEqual([]);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(FLEET_SAVE_SET_KEY)))).toEqual([]);
  });
});
