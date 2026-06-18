// Unit tests for domain/reminderConfig — the pure shape + defaults +
// normalisation of the per-universe reminder config (wave enable/schedule,
// ad-hoc lead time, message templates). Node env — pure data, no DOM.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  defaultReminderConfig,
  normalizeReminderConfig,
} from '../../src/domain/reminderConfig.js';
import { defaultReminderTemplates } from '../../src/domain/reminderTemplates.js';

describe('defaultReminderConfig', () => {
  it('matches the values the knobs carried as settings.js defaults', () => {
    expect(defaultReminderConfig()).toEqual({
      reminderEnabled: false,
      reminderSchedule: '0m, 10m, 30m, 60m',
      adhocSchedule: '-1m',
      templates: defaultReminderTemplates(),
    });
  });

  it('returns a fresh object each call (no shared mutable literal)', () => {
    const a = defaultReminderConfig();
    const b = defaultReminderConfig();
    expect(a).not.toBe(b);
  });
});

describe('normalizeReminderConfig', () => {
  it('fills every field from defaults for null / non-object input', () => {
    const d = defaultReminderConfig();
    expect(normalizeReminderConfig(null)).toEqual(d);
    expect(normalizeReminderConfig(undefined)).toEqual(d);
    expect(normalizeReminderConfig('nope')).toEqual(d);
    expect(normalizeReminderConfig(42)).toEqual(d);
  });

  it('preserves valid fields and fills the missing ones', () => {
    const cfg = normalizeReminderConfig({ reminderEnabled: true });
    expect(cfg.reminderEnabled).toBe(true);
    expect(cfg.reminderSchedule).toBe('0m, 10m, 30m, 60m'); // default
    expect(cfg.adhocSchedule).toBe('-1m'); // default
  });

  it('keeps an explicitly-set custom schedule string and ad-hoc schedule', () => {
    const cfg = normalizeReminderConfig({
      reminderEnabled: true,
      reminderSchedule: '5m, 15m',
      adhocSchedule: '-10m, 0m, +5m',
    });
    expect(cfg).toEqual({
      reminderEnabled: true,
      reminderSchedule: '5m, 15m',
      adhocSchedule: '-10m, 0m, +5m',
      templates: defaultReminderTemplates(),
    });
  });

  it('accepts an explicit empty schedule string (a deliberate "no wave pings")', () => {
    expect(normalizeReminderConfig({ reminderSchedule: '' }).reminderSchedule).toBe('');
  });

  it('migrates a legacy adhocOffsetSec to a signed adhocSchedule string', () => {
    // 60s before arrival ⇒ "-1m".
    expect(normalizeReminderConfig({ adhocOffsetSec: 60 }).adhocSchedule).toBe('-1m');
    // 120s ⇒ "-2m".
    expect(normalizeReminderConfig({ adhocOffsetSec: 120 }).adhocSchedule).toBe('-2m');
  });

  it('falls back to the default ad-hoc schedule for garbage / no legacy value', () => {
    expect(normalizeReminderConfig({ adhocOffsetSec: 'soon' }).adhocSchedule).toBe('-1m');
    expect(normalizeReminderConfig({ adhocOffsetSec: -5 }).adhocSchedule).toBe('-1m');
    expect(normalizeReminderConfig({}).adhocSchedule).toBe('-1m');
  });

  it('keeps a present adhocSchedule string over any legacy adhocOffsetSec', () => {
    const cfg = normalizeReminderConfig({ adhocSchedule: '-30m', adhocOffsetSec: 60 });
    expect(cfg.adhocSchedule).toBe('-30m');
  });

  it('coerces a non-boolean enable / non-string schedule back to defaults', () => {
    const cfg = normalizeReminderConfig({ reminderEnabled: 'yes', reminderSchedule: 123 });
    expect(cfg.reminderEnabled).toBe(false);
    expect(cfg.reminderSchedule).toBe('0m, 10m, 30m, 60m');
  });

  it('fills templates with defaults when absent, and deep-normalises a partial one', () => {
    // Absent → full default map.
    expect(normalizeReminderConfig({}).templates).toEqual(defaultReminderTemplates());
    // A partial wave body is kept; its sibling fields + the other kinds fill.
    const cfg = normalizeReminderConfig({ templates: { wave: { body: 'Back!' } } });
    expect(cfg.templates.wave.body).toBe('Back!');
    expect(cfg.templates.wave.priority).toBe(3); // default
    expect(cfg.templates.adhoc).toEqual(defaultReminderTemplates().adhoc);
  });
});
