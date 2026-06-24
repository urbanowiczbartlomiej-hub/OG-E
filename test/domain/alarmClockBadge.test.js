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
