// @vitest-environment happy-dom
//
// Unit tests for state/fleetReminders — the unified per-body fleet-reminder
// store (auto landing arms + manual chip marks), a plain JSON slot over safeLS
// with per-body event-time LWW and `on:false` tombstones. happy-dom supplies a
// real localStorage, wiped between cases; tests drive the public surface
// against the wire.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLEET_REMINDERS_KEY,
  FR_TOMBSTONE_TTL_SEC,
  readFleetReminderSlot,
  writeFleetReminderSlot,
  readFleetReminders,
  hasFleetReminder,
  armFleetReminder,
  removeFleetReminder,
  toggleFleetReminder,
} from '../../src/state/fleetReminders.js';

beforeEach(() => {
  localStorage.clear();
});

describe('fleetReminders — key + slot round-trip', () => {
  it('exposes the canonical key', () => {
    expect(FLEET_REMINDERS_KEY).toBe('oge-fleet-reminders');
  });

  it('round-trips a slot through the raw helpers', () => {
    writeFleetReminderSlot({ marks: { '1:2:3:1': { on: true, ts: 100, landedAt: 100 } } });
    expect(readFleetReminderSlot()).toEqual({
      marks: { '1:2:3:1': { on: true, ts: 100, landedAt: 100 } },
    });
  });

  it('reads an absent / corrupt / legacy-shaped key as an empty slot', () => {
    expect(readFleetReminderSlot()).toEqual({ marks: {} });
    localStorage.setItem(FLEET_REMINDERS_KEY, '{not json');
    expect(readFleetReminderSlot()).toEqual({ marks: {} });
    // The pre-1.51.2 manual-marks shape (an array) is deliberately not migrated.
    localStorage.setItem(FLEET_REMINDERS_KEY, JSON.stringify([{ bodyKey: '1:1:1:1' }]));
    expect(readFleetReminderSlot()).toEqual({ marks: {} });
  });

  it('drops malformed entries (non-finite ts) on read', () => {
    localStorage.setItem(FLEET_REMINDERS_KEY, JSON.stringify({
      marks: {
        '1:2:3:1': { on: true, ts: 100 },
        '4:5:6:3': { on: true, ts: 'soon' },
        '7:8:9:1': null,
      },
    }));
    expect(Object.keys(readFleetReminderSlot().marks)).toEqual(['1:2:3:1']);
  });
});

describe('fleetReminders — arm / remove (event-time LWW)', () => {
  it('arms a body and surfaces it via readFleetReminders/hasFleetReminder', () => {
    expect(armFleetReminder('1:2:3:1', 100)).toBe(true);
    expect(hasFleetReminder('1:2:3:1')).toBe(true);
    expect(readFleetReminders()).toEqual([{ bodyKey: '1:2:3:1', landedAt: 100 }]);
  });

  it('re-arming the SAME landing (same ts) is a no-op — returns false', () => {
    armFleetReminder('1:2:3:1', 100);
    expect(armFleetReminder('1:2:3:1', 100)).toBe(false);
  });

  it('a dismiss stamped after the landing wins, and the OLD landing cannot resurrect it', () => {
    armFleetReminder('1:2:3:1', 100);
    expect(removeFleetReminder('1:2:3:1', 150)).toBe(true);
    expect(hasFleetReminder('1:2:3:1')).toBe(false);
    // Re-detection of the same landing (ts=100 < tombstone ts=150) loses.
    expect(armFleetReminder('1:2:3:1', 100)).toBe(false);
    expect(hasFleetReminder('1:2:3:1')).toBe(false);
  });

  it('a NEWER landing on the same body re-arms past a dismiss', () => {
    armFleetReminder('1:2:3:1', 100);
    removeFleetReminder('1:2:3:1', 150);
    expect(armFleetReminder('1:2:3:1', 200)).toBe(true);
    expect(readFleetReminders()).toEqual([{ bodyKey: '1:2:3:1', landedAt: 200 }]);
  });

  it('keeps landedAt separate from the LWW clock when passed explicitly', () => {
    armFleetReminder('1:2:3:1', 500, 480);
    expect(readFleetReminders()).toEqual([{ bodyKey: '1:2:3:1', landedAt: 480 }]);
  });

  it('removing an absent body still writes a tombstone (removal propagates)', () => {
    expect(removeFleetReminder('9:9:9:1', 100)).toBe(true);
    expect(readFleetReminderSlot().marks['9:9:9:1']).toEqual({ on: false, ts: 100 });
    expect(readFleetReminders()).toEqual([]);
  });

  it('GCs tombstones older than FR_TOMBSTONE_TTL_SEC on write', () => {
    removeFleetReminder('old:1:1:1', 100);
    armFleetReminder('1:2:3:1', 100 + FR_TOMBSTONE_TTL_SEC + 1);
    expect(readFleetReminderSlot().marks['old:1:1:1']).toBeUndefined();
    expect(hasFleetReminder('1:2:3:1')).toBe(true);
  });
});

describe('toggleFleetReminder (the fleet1 chip)', () => {
  it('arms an absent body (returns true) and clears an armed one (returns false)', () => {
    expect(toggleFleetReminder('1:2:3:1', 100)).toBe(true);
    expect(hasFleetReminder('1:2:3:1')).toBe(true);
    expect(toggleFleetReminder('1:2:3:1', 100)).toBe(false); // same-second toggle works
    expect(hasFleetReminder('1:2:3:1')).toBe(false);
  });

  it('round-trips arm → clear → arm and leaves other bodies untouched', () => {
    armFleetReminder('keep:me:1:1', 10);
    expect(toggleFleetReminder('7:8:9:3', 20)).toBe(true);
    expect(toggleFleetReminder('7:8:9:3', 21)).toBe(false);
    expect(toggleFleetReminder('7:8:9:3', 22)).toBe(true);
    expect(readFleetReminders()).toEqual([
      { bodyKey: 'keep:me:1:1', landedAt: 10 },
      { bodyKey: '7:8:9:3', landedAt: 22 },
    ]);
  });

  it('planet vs moon of the same coords are distinct bodies', () => {
    toggleFleetReminder('1:2:3:1', 5);
    expect(hasFleetReminder('1:2:3:3')).toBe(false);
  });
});
