// Unit tests for domain/resolveReminderConfig — the per-server whole-group
// override resolution for the global reminder config. Node env — pure data.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { resolveReminderConfig } from '../../src/domain/resolveReminderConfig.js';
import { normalizeReminderGlobalConfig } from '../../src/domain/reminderGlobalConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';

const global = normalizeReminderGlobalConfig({
  reminderEnabled: true,
  reminderSchedule: '0m, 30m',
  adhocOffsetSec: 60,
  templates: {
    wave: { body: 'GLOBAL wave' },
    adhoc: { body: 'GLOBAL adhoc' },
    fleetSave: { body: 'GLOBAL fs' },
  },
});

describe('resolveReminderConfig', () => {
  it('returns the global config verbatim when no override is set', () => {
    expect(resolveReminderConfig(global, defaultGalaxyScanConfig())).toBe(global);
  });

  it('returns the global config when perServer is missing', () => {
    // @ts-expect-error — defending against a null perServer at the boundary.
    expect(resolveReminderConfig(global, null)).toBe(global);
  });

  it('uses the override wave/ad-hoc fields + templates when enabled', () => {
    const perServer = {
      reminderOverrideEnabled: true,
      reminderOverride: normalizeReminderGlobalConfig({
        reminderEnabled: false,
        reminderSchedule: '5m, 15m',
        adhocOffsetSec: 120,
        templates: {
          wave: { body: 'SERVER wave', priority: 1 },
          adhoc: { body: 'SERVER adhoc' },
          fleetSave: { body: 'SERVER fs (ignored)' },
        },
      }),
    };
    const eff = resolveReminderConfig(global, perServer);
    expect(eff.reminderEnabled).toBe(false);
    expect(eff.reminderSchedule).toBe('5m, 15m');
    expect(eff.adhocOffsetSec).toBe(120);
    expect(eff.templates.wave.body).toBe('SERVER wave');
    expect(eff.templates.wave.priority).toBe(1);
    expect(eff.templates.adhoc.body).toBe('SERVER adhoc');
    // Fleet-save presentation is NEVER overridden — it stays global.
    expect(eff.templates.fleetSave.body).toBe('GLOBAL fs');
  });

  it('ignores the override snapshot while the gate is off', () => {
    const perServer = {
      reminderOverrideEnabled: false,
      reminderOverride: normalizeReminderGlobalConfig({ reminderSchedule: 'NOPE' }),
    };
    expect(resolveReminderConfig(global, perServer)).toBe(global);
  });
});
