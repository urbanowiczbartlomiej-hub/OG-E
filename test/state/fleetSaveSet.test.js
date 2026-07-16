// @vitest-environment happy-dom
//
// Unit tests for state/fleetSaveSet — a plain JSON array of detected
// fleet-save ENTRIES (full FleetSaveAlarmClock objects since 1.51.2; ids are
// derived) over safeLS. happy-dom supplies a real localStorage, wiped between
// cases; tests drive the public read/write surface against the wire.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLEET_SAVE_SET_KEY,
  readFleetSaveEntries,
  writeFleetSaveEntries,
  readFleetSaveIds,
} from '../../src/state/fleetSaveSet.js';

/** Minimal well-formed entry. @param {string} id @param {number} arrivalAt */
const entry = (id, arrivalAt = 1000) => ({
  id, arrivalAt, shipCount: 500, label: 'Deployment → [1:2:3]',
  offsetsSec: [-600, 0], fireAts: [arrivalAt - 600, arrivalAt],
});

beforeEach(() => {
  localStorage.clear();
});

describe('fleetSaveSet — entries', () => {
  it('exposes the canonical key', () => {
    expect(FLEET_SAVE_SET_KEY).toBe('oge-fleetsave-set');
  });

  it('round-trips an array of entries', () => {
    const entries = [entry('eventRow-1'), entry('eventRow-2', 2000)];
    writeFleetSaveEntries(entries);
    expect(readFleetSaveEntries()).toEqual(entries);
  });

  it('returns [] when the key is absent', () => {
    expect(readFleetSaveEntries()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem(FLEET_SAVE_SET_KEY, JSON.stringify({ not: 'an array' }));
    expect(readFleetSaveEntries()).toEqual([]);
  });

  it('reads the legacy bare-id-array shape as empty (deliberately not migrated)', () => {
    localStorage.setItem(FLEET_SAVE_SET_KEY, JSON.stringify(['eventRow-1', 'eventRow-2']));
    expect(readFleetSaveEntries()).toEqual([]);
    expect(readFleetSaveIds()).toEqual([]);
  });

  it('filters out malformed entries (no string id)', () => {
    localStorage.setItem(
      FLEET_SAVE_SET_KEY,
      JSON.stringify([entry('eventRow-1'), { arrivalAt: 5 }, null, 42, entry('eventRow-2')]),
    );
    expect(readFleetSaveIds()).toEqual(['eventRow-1', 'eventRow-2']);
  });

  it('stores [] when writeFleetSaveEntries gets a non-array argument', () => {
    // @ts-expect-error — exercising the runtime guard with a bad type.
    writeFleetSaveEntries('eventRow-1');
    expect(readFleetSaveEntries()).toEqual([]);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(FLEET_SAVE_SET_KEY)))).toEqual([]);
  });

  it('derives readFleetSaveIds from the stored entries', () => {
    writeFleetSaveEntries([entry('eventRow-7'), entry('eventRow-9')]);
    expect(readFleetSaveIds()).toEqual(['eventRow-7', 'eventRow-9']);
  });
});
