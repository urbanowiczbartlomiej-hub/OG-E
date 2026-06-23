// Unit tests for domain/alarmClockConfig — the pure shape + defaults +
// normalisation of the per-universe alarmClock config (wave enable/schedule,
// ad-hoc lead time, message templates). Node env — pure data, no DOM.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  defaultAlarmClockConfig,
  normalizeAlarmClockConfig,
} from '../../src/domain/alarmClockConfig.js';
import { defaultAlarmClockTemplates } from '../../src/domain/alarmClockTemplates.js';

describe('defaultAlarmClockConfig', () => {
  it('matches the values the knobs carried as settings.js defaults', () => {
    expect(defaultAlarmClockConfig()).toEqual({
      alarmClockEnabled: false,
      alarmClockSchedule: '0m, 10m, 30m, 60m',
      adhocSchedule: '-1m',
      templates: defaultAlarmClockTemplates(),
    });
  });

  it('returns a fresh object each call (no shared mutable literal)', () => {
    const a = defaultAlarmClockConfig();
    const b = defaultAlarmClockConfig();
    expect(a).not.toBe(b);
  });
});

describe('normalizeAlarmClockConfig', () => {
  it('fills every field from defaults for null / non-object input', () => {
    const d = defaultAlarmClockConfig();
    expect(normalizeAlarmClockConfig(null)).toEqual(d);
    expect(normalizeAlarmClockConfig(undefined)).toEqual(d);
    expect(normalizeAlarmClockConfig('nope')).toEqual(d);
    expect(normalizeAlarmClockConfig(42)).toEqual(d);
  });

  it('preserves valid fields and fills the missing ones', () => {
    const cfg = normalizeAlarmClockConfig({ alarmClockEnabled: true });
    expect(cfg.alarmClockEnabled).toBe(true);
    expect(cfg.alarmClockSchedule).toBe('0m, 10m, 30m, 60m'); // default
    expect(cfg.adhocSchedule).toBe('-1m'); // default
  });

  it('keeps an explicitly-set custom schedule string and ad-hoc schedule', () => {
    const cfg = normalizeAlarmClockConfig({
      alarmClockEnabled: true,
      alarmClockSchedule: '5m, 15m',
      adhocSchedule: '-10m, 0m, +5m',
    });
    expect(cfg).toEqual({
      alarmClockEnabled: true,
      alarmClockSchedule: '5m, 15m',
      adhocSchedule: '-10m, 0m, +5m',
      templates: defaultAlarmClockTemplates(),
    });
  });

  it('accepts an explicit empty schedule string (a deliberate "no wave pings")', () => {
    expect(normalizeAlarmClockConfig({ alarmClockSchedule: '' }).alarmClockSchedule).toBe('');
  });

  it('migrates a legacy adhocOffsetSec to a signed adhocSchedule string', () => {
    // 60s before arrival ⇒ "-1m".
    expect(normalizeAlarmClockConfig({ adhocOffsetSec: 60 }).adhocSchedule).toBe('-1m');
    // 120s ⇒ "-2m".
    expect(normalizeAlarmClockConfig({ adhocOffsetSec: 120 }).adhocSchedule).toBe('-2m');
  });

  it('falls back to the default ad-hoc schedule for garbage / no legacy value', () => {
    expect(normalizeAlarmClockConfig({ adhocOffsetSec: 'soon' }).adhocSchedule).toBe('-1m');
    expect(normalizeAlarmClockConfig({ adhocOffsetSec: -5 }).adhocSchedule).toBe('-1m');
    expect(normalizeAlarmClockConfig({}).adhocSchedule).toBe('-1m');
  });

  it('keeps a present adhocSchedule string over any legacy adhocOffsetSec', () => {
    const cfg = normalizeAlarmClockConfig({ adhocSchedule: '-30m', adhocOffsetSec: 60 });
    expect(cfg.adhocSchedule).toBe('-30m');
  });

  it('coerces a non-boolean enable / non-string schedule back to defaults', () => {
    const cfg = normalizeAlarmClockConfig({ alarmClockEnabled: 'yes', alarmClockSchedule: 123 });
    expect(cfg.alarmClockEnabled).toBe(false);
    expect(cfg.alarmClockSchedule).toBe('0m, 10m, 30m, 60m');
  });

  it('fills templates with defaults when absent, and deep-normalises a partial one', () => {
    // Absent → full default map.
    expect(normalizeAlarmClockConfig({}).templates).toEqual(defaultAlarmClockTemplates());
    // A partial wave body is kept; its sibling fields + the other kinds fill.
    const cfg = normalizeAlarmClockConfig({ templates: { wave: { body: 'Back!' } } });
    expect(cfg.templates.wave.body).toBe('Back!');
    expect(cfg.templates.wave.priority).toBe(3); // default
    expect(cfg.templates.adhoc).toEqual(defaultAlarmClockTemplates().adhoc);
  });
});
