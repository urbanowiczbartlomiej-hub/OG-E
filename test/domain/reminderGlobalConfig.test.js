// Unit tests for domain/reminderGlobalConfig — the pure shape + defaults +
// normalisation of the GLOBAL reminder config (wave enable/schedule, ad-hoc
// lead time). Node env — pure data, no DOM.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  defaultReminderGlobalConfig,
  normalizeReminderGlobalConfig,
} from '../../src/domain/reminderGlobalConfig.js';

describe('defaultReminderGlobalConfig', () => {
  it('matches the values the knobs carried as settings.js defaults', () => {
    expect(defaultReminderGlobalConfig()).toEqual({
      reminderEnabled: false,
      reminderSchedule: '0m, 10m, 30m, 60m',
      adhocOffsetSec: 60,
    });
  });

  it('returns a fresh object each call (no shared mutable literal)', () => {
    const a = defaultReminderGlobalConfig();
    const b = defaultReminderGlobalConfig();
    expect(a).not.toBe(b);
  });
});

describe('normalizeReminderGlobalConfig', () => {
  it('fills every field from defaults for null / non-object input', () => {
    const d = defaultReminderGlobalConfig();
    expect(normalizeReminderGlobalConfig(null)).toEqual(d);
    expect(normalizeReminderGlobalConfig(undefined)).toEqual(d);
    expect(normalizeReminderGlobalConfig('nope')).toEqual(d);
    expect(normalizeReminderGlobalConfig(42)).toEqual(d);
  });

  it('preserves valid fields and fills the missing ones', () => {
    const cfg = normalizeReminderGlobalConfig({ reminderEnabled: true });
    expect(cfg.reminderEnabled).toBe(true);
    expect(cfg.reminderSchedule).toBe('0m, 10m, 30m, 60m'); // default
    expect(cfg.adhocOffsetSec).toBe(60); // default
  });

  it('keeps an explicitly-set custom schedule string and lead time', () => {
    const cfg = normalizeReminderGlobalConfig({
      reminderEnabled: true,
      reminderSchedule: '5m, 15m',
      adhocOffsetSec: 120,
    });
    expect(cfg).toEqual({
      reminderEnabled: true,
      reminderSchedule: '5m, 15m',
      adhocOffsetSec: 120,
    });
  });

  it('accepts an explicit empty schedule string (a deliberate "no wave pings")', () => {
    expect(normalizeReminderGlobalConfig({ reminderSchedule: '' }).reminderSchedule).toBe('');
  });

  it('coerces a garbage / negative lead time back to the default', () => {
    expect(normalizeReminderGlobalConfig({ adhocOffsetSec: 'soon' }).adhocOffsetSec).toBe(60);
    expect(normalizeReminderGlobalConfig({ adhocOffsetSec: -5 }).adhocOffsetSec).toBe(60);
    // A finite non-negative value floors to a whole second.
    expect(normalizeReminderGlobalConfig({ adhocOffsetSec: 90.7 }).adhocOffsetSec).toBe(90);
  });

  it('coerces a non-boolean enable / non-string schedule back to defaults', () => {
    const cfg = normalizeReminderGlobalConfig({ reminderEnabled: 'yes', reminderSchedule: 123 });
    expect(cfg.reminderEnabled).toBe(false);
    expect(cfg.reminderSchedule).toBe('0m, 10m, 30m, 60m');
  });
});
