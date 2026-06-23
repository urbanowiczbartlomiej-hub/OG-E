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

  it('nothing scheduled → "not scheduled"', () => {
    expect(alarmClockBadge({ scheduledCount: 0 })).toEqual({ text: 'not scheduled', cls: 'none' });
  });

  it('nothing scheduled but deferred beyond 3 days → "> 3 days out"', () => {
    expect(alarmClockBadge({ scheduledCount: 0, tooFar: true }))
      .toEqual({ text: '> 3 days out', cls: 'far' });
  });

  it('armed but ntfy queue unseen → "scheduled" (no false fired/queued)', () => {
    expect(alarmClockBadge({ scheduledCount: 4, hasNtfyData: false }))
      .toEqual({ text: 'scheduled', cls: 'scheduled' });
  });

  it('has pending pushes → "queued"', () => {
    expect(alarmClockBadge({ scheduledCount: 4, pendingCount: 2, hasNtfyData: true }))
      .toEqual({ text: 'queued', cls: 'queued' });
  });

  it('all pushes fired → "fired"', () => {
    expect(alarmClockBadge({ scheduledCount: 4, pendingCount: 0, hasNtfyData: true }))
      .toEqual({ text: 'fired', cls: 'fired' });
  });

  it('defaults (no args) read as "not scheduled"', () => {
    expect(alarmClockBadge()).toEqual({ text: 'not scheduled', cls: 'none' });
  });
});
