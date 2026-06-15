// Unit tests for the pure shared-settings shape: defaults + normalisation.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  SHARED_SETTINGS_SCHEMA,
  defaultSharedSettings,
  normalizeSharedSettings,
} from '../../src/domain/sharedSettings.js';

describe('sharedSettings — defaults', () => {
  it('builds a complete object at the schema defaults', () => {
    const d = defaultSharedSettings();
    expect(d).toEqual({
      colonyMinGap: 15,
      colonyMinFields: 320,
      colonyPassword: '',
      reminderEnabled: false,
      reminderSchedule: '0m, 10m, 30m, 60m',
      adhocOffsetSec: 60,
      fsEnabled: false,
      fsThreshold: 100000,
      fsOffsets: '-10m, 0m, 10m',
      fsMinFlightSec: 600,
    });
  });

  it('has a default for every schema field and nothing extra', () => {
    expect(Object.keys(defaultSharedSettings()).sort()).toEqual(
      Object.keys(SHARED_SETTINGS_SCHEMA).sort(),
    );
  });
});

describe('sharedSettings — normalise', () => {
  it('fills missing keys from defaults', () => {
    const out = normalizeSharedSettings({ colonyMinGap: 30 });
    expect(out.colonyMinGap).toBe(30);
    expect(out.colonyMinFields).toBe(320); // default
    expect(out.reminderSchedule).toBe('0m, 10m, 30m, 60m'); // default
  });

  it('coerces stringly-typed values (localStorage round-trip shape)', () => {
    const out = normalizeSharedSettings({
      colonyMinGap: '45',
      fsEnabled: 'true',
      reminderEnabled: 'false',
      colonyPassword: 'hunter2',
    });
    expect(out.colonyMinGap).toBe(45);
    expect(out.fsEnabled).toBe(true);
    expect(out.reminderEnabled).toBe(false);
    expect(out.colonyPassword).toBe('hunter2');
  });

  it('falls back to defaults for unparseable ints and drops extra keys', () => {
    const out = normalizeSharedSettings({ colonyMinGap: 'abc', bogus: 1 });
    expect(out.colonyMinGap).toBe(15); // default
    expect(/** @type {any} */ (out).bogus).toBeUndefined();
  });

  it('returns defaults for null / non-object input', () => {
    expect(normalizeSharedSettings(null)).toEqual(defaultSharedSettings());
    expect(normalizeSharedSettings('nope')).toEqual(defaultSharedSettings());
  });
});
