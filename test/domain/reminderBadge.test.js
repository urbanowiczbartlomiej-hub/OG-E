// @ts-check

// Unit tests for the unified reminder-card badge (Dashboard ▸ Reminders).
// Pins the state ladder so all three kinds (waves / ad-hoc / fleet-save) read
// the same ntfy-queue vocabulary.

import { describe, it, expect } from 'vitest';
import { reminderBadge } from '../../src/domain/reminderBadge.js';

describe('reminderBadge', () => {
  it('cancelled wins over everything', () => {
    expect(reminderBadge({ cancelled: true, scheduledCount: 3, pendingCount: 2, hasNtfyData: true }))
      .toEqual({ text: 'cancelled', cls: 'cancelled' });
  });

  it('nothing scheduled → "not scheduled"', () => {
    expect(reminderBadge({ scheduledCount: 0 })).toEqual({ text: 'not scheduled', cls: 'none' });
  });

  it('nothing scheduled but deferred beyond 3 days → "> 3 days out"', () => {
    expect(reminderBadge({ scheduledCount: 0, tooFar: true }))
      .toEqual({ text: '> 3 days out', cls: 'far' });
  });

  it('armed but ntfy queue unseen → "scheduled" (no false fired/queued)', () => {
    expect(reminderBadge({ scheduledCount: 4, hasNtfyData: false }))
      .toEqual({ text: 'scheduled', cls: 'scheduled' });
  });

  it('has pending pushes → "queued"', () => {
    expect(reminderBadge({ scheduledCount: 4, pendingCount: 2, hasNtfyData: true }))
      .toEqual({ text: 'queued', cls: 'queued' });
  });

  it('all pushes fired → "fired"', () => {
    expect(reminderBadge({ scheduledCount: 4, pendingCount: 0, hasNtfyData: true }))
      .toEqual({ text: 'fired', cls: 'fired' });
  });

  it('defaults (no args) read as "not scheduled"', () => {
    expect(reminderBadge()).toEqual({ text: 'not scheduled', cls: 'none' });
  });
});
