// @ts-check

// Unit tests for the unified alarmClock-card badge (Dashboard ▸ AlarmClock).
// Pins the state ladder so all three kinds (waves / ad-hoc / fleet-save) read
// the same ntfy-queue vocabulary.

import { describe, it, expect } from 'vitest';
import { alarmClockBadge } from '../../src/domain/alarmClockBadge.js';

describe('alarmClockBadge', () => {
  it('cancelled wins over everything', () => {
    expect(alarmClockBadge({ cancelled: true, scheduledCount: 3, pendingCount: 2, hasNtfyData: true }))
      .toEqual({ text: 'cancelled', cls: 'cancelled' });
  });

  it('nothing set → "not set"', () => {
    expect(alarmClockBadge({ scheduledCount: 0 })).toEqual({ text: 'not set', cls: 'none' });
  });

  it('nothing set and the KIND is switched off → "reminders off"', () => {
    expect(alarmClockBadge({ scheduledCount: 0, kindOff: true }))
      .toEqual({ text: 'reminders off', cls: 'off' });
  });

  it('"reminders off" outranks "> 3 days out" — the switch is the real reason', () => {
    expect(alarmClockBadge({ scheduledCount: 0, kindOff: true, tooFar: true }))
      .toEqual({ text: 'reminders off', cls: 'off' });
  });

  it('cancelled still wins over a switched-off kind', () => {
    expect(alarmClockBadge({ cancelled: true, scheduledCount: 0, kindOff: true }))
      .toEqual({ text: 'cancelled', cls: 'cancelled' });
  });

  it('a reminder ALREADY set stays "set" even once its kind is switched off', () => {
    // Switching the kind off does not un-post what ntfy already holds — the
    // reminder will still ring, and claiming otherwise would be the one lie
    // that matters here.
    expect(alarmClockBadge({ scheduledCount: 3, pendingCount: 2, hasNtfyData: true, kindOff: true }))
      .toEqual({ text: 'set', cls: 'queued' });
  });

  it('nothing set but deferred beyond 3 days → "> 3 days out"', () => {
    expect(alarmClockBadge({ scheduledCount: 0, tooFar: true }))
      .toEqual({ text: '> 3 days out', cls: 'far' });
  });

  it('armed but ntfy queue unseen → "armed" (no false rang/set)', () => {
    expect(alarmClockBadge({ scheduledCount: 4, hasNtfyData: false }))
      .toEqual({ text: 'armed', cls: 'scheduled' });
  });

  it('has pending pushes → "set"', () => {
    expect(alarmClockBadge({ scheduledCount: 4, pendingCount: 2, hasNtfyData: true }))
      .toEqual({ text: 'set', cls: 'queued' });
  });

  it('all pushes rang → "rang"', () => {
    expect(alarmClockBadge({ scheduledCount: 4, pendingCount: 0, hasNtfyData: true }))
      .toEqual({ text: 'rang', cls: 'fired' });
  });

  it('defaults (no args) read as "not set"', () => {
    expect(alarmClockBadge()).toEqual({ text: 'not set', cls: 'none' });
  });
});
