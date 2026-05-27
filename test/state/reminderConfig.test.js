// @ts-check

// Unit tests for the pure parts of the reminder-config store:
// default-building, tolerant normalization, and topic generation.
// The chrome.storage wiring (initReminderConfig) is integration-level
// and not exercised here.

import { describe, it, expect } from 'vitest';
import {
  buildDefaultConfig,
  normalizeConfig,
  generateNtfyTopic,
} from '../../src/state/reminderConfig.js';

describe('buildDefaultConfig', () => {
  it('is opt-out by default with an empty topic (nothing dispatched until setup)', () => {
    const c = buildDefaultConfig();
    expect(c.enabled).toBe(false);
    expect(c.ntfyTopic).toBe('');
  });

  it('ships sane scheduling defaults', () => {
    const c = buildDefaultConfig();
    expect(c.reminderEveryMinutes).toBe(10);
    expect(c.maxNotificationsPerWave).toBe(30);
    expect(c.gapSeconds).toBe(300);
    expect(c.allowedHours).toEqual({ start: '08:00', end: '23:00' });
  });
});

describe('normalizeConfig', () => {
  it('returns defaults for non-object input', () => {
    expect(normalizeConfig(null)).toEqual(buildDefaultConfig());
    expect(normalizeConfig('nope')).toEqual(buildDefaultConfig());
  });

  it('fills missing fields from defaults (forward-compat during upgrade)', () => {
    const partial = { enabled: true, ntfyTopic: 'oge-abc' };
    const c = normalizeConfig(partial);
    expect(c.enabled).toBe(true);
    expect(c.ntfyTopic).toBe('oge-abc');
    expect(c.reminderEveryMinutes).toBe(10); // from defaults
  });

  it('rejects non-positive numeric fields back to defaults', () => {
    const c = normalizeConfig({ reminderEveryMinutes: 0, maxNotificationsPerWave: -5, gapSeconds: 'x' });
    expect(c.reminderEveryMinutes).toBe(10);
    expect(c.maxNotificationsPerWave).toBe(30);
    expect(c.gapSeconds).toBe(300);
  });

  it('keeps a partial allowedHours and backfills the missing side', () => {
    const c = normalizeConfig({ allowedHours: { start: '09:30' } });
    expect(c.allowedHours.start).toBe('09:30');
    expect(c.allowedHours.end).toBe('23:00'); // default
  });
});

describe('generateNtfyTopic', () => {
  it('produces an oge-prefixed topic of stable length', () => {
    const t = generateNtfyTopic();
    expect(t).toMatch(/^oge-[a-z0-9]{20}$/);
  });

  it('is practically unique across calls', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateNtfyTopic()));
    expect(set.size).toBe(50);
  });
});
