// @vitest-environment happy-dom
//
// Unit tests for the pure core of the dashboard "Sync" view. No DOM / chrome /
// timers — buildSyncInventory + classifySyncFreshness (with an injected `now`)
// + formatBytes are deterministic, so they're tested with plain data.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  buildSyncInventory,
  classifySyncFreshness,
  formatBytes,
  SYNC_STATUS_BASE,
} from '../../../src/features/dashboard/syncInventory.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('SYNC_STATUS_BASE', () => {
  it('is the status-mirror base suffix', () => {
    expect(SYNC_STATUS_BASE).toBe('oge_syncStatus');
  });
});

describe('buildSyncInventory', () => {
  it('groups a flat snapshot per universe, splitting on the first colon', () => {
    const inv = buildSyncInventory({
      's1-en:oge_players': { a: 1, b: 2 },
      's2-pl:oge_players': [1, 2, 3],
    });
    expect(inv.map((u) => u.universeId)).toEqual(['s1-en', 's2-pl']);
  });

  it('ignores keys with no colon or a non-oge_ suffix', () => {
    const inv = buildSyncInventory({
      noColon: 1,
      'something:notoge': 2,
      's1-en:oge_players': { a: 1 },
    });
    expect(inv).toHaveLength(1);
    expect(inv[0].universeId).toBe('s1-en');
    expect(inv[0].categories.map((c) => c.base)).toEqual(['oge_players']);
  });

  it('populates .status from the status mirror and does not list it as a category', () => {
    const status = { up: '2024-01-01T00:00:00Z', down: null, err: null };
    const inv = buildSyncInventory({
      [`s1-en:${SYNC_STATUS_BASE}`]: status,
      's1-en:oge_players': { a: 1 },
    });
    expect(inv[0].status).toEqual(status);
    expect(inv[0].categories.map((c) => c.base)).toEqual(['oge_players']);
  });

  it('surfaces a universe that has ONLY a status mirror (no data)', () => {
    const inv = buildSyncInventory({
      [`s9-en:${SYNC_STATUS_BASE}`]: { up: '2024-01-01T00:00:00Z' },
    });
    expect(inv).toHaveLength(1);
    expect(inv[0].universeId).toBe('s9-en');
    expect(inv[0].categories).toEqual([]);
    expect(inv[0].totalBytes).toBe(0);
    expect(inv[0].status).toEqual({ up: '2024-01-01T00:00:00Z' });
  });

  it('treats a non-object status mirror value as null', () => {
    const inv = buildSyncInventory({ 's1-en:oge_syncStatus': 'oops' });
    expect(inv[0].status).toBeNull();
  });

  it('excludes plumbing bases: …Ts, oge_syncRequestAt, oge_resetGalaxyAt', () => {
    const inv = buildSyncInventory({
      's1-en:oge_playersTs': 123,
      's1-en:oge_syncRequestAt': 456,
      's1-en:oge_resetGalaxyAt': 789,
      's1-en:oge_players': { a: 1 },
    });
    expect(inv[0].categories.map((c) => c.base)).toEqual(['oge_players']);
  });

  it('computes count as array length, object key count, or null for scalars', () => {
    const inv = buildSyncInventory({
      's1-en:oge_galaxyScans': [1, 2, 3],
      's1-en:oge_players': { a: 1, b: 2 },
      's1-en:oge_bodies': 42,
    });
    const by = Object.fromEntries(inv[0].categories.map((c) => [c.base, c.count]));
    expect(by.oge_galaxyScans).toBe(3);
    expect(by.oge_players).toBe(2);
    expect(by.oge_bodies).toBeNull();
  });

  it('reports bytes ≈ JSON length and totalBytes sums the categories', () => {
    const players = { a: 1 };
    const scans = [1, 2];
    const inv = buildSyncInventory({
      's1-en:oge_players': players,
      's1-en:oge_galaxyScans': scans,
    });
    const pBytes = JSON.stringify(players).length;
    const sBytes = JSON.stringify(scans).length;
    const by = Object.fromEntries(inv[0].categories.map((c) => [c.base, c.bytes]));
    expect(by.oge_players).toBe(pBytes);
    expect(by.oge_galaxyScans).toBe(sBytes);
    expect(inv[0].totalBytes).toBe(pBytes + sBytes);
  });

  it('sorts categories by label and universes by id', () => {
    const inv = buildSyncInventory({
      's2-en:oge_players': { a: 1 },
      's1-en:oge_galaxyScans': [1],
      's1-en:oge_colonyHistory': [1],
    });
    expect(inv.map((u) => u.universeId)).toEqual(['s1-en', 's2-en']);
    // s1-en: 'Colony history' < 'Galaxy scans' alphabetically.
    expect(inv[0].categories.map((c) => c.label)).toEqual(['Colony history', 'Galaxy scans']);
  });

  it('maps known bases to friendly labels and falls back to the raw base for unknowns', () => {
    const inv = buildSyncInventory({
      's1-en:oge_players': { a: 1 },
      's1-en:oge_brandNewThing': [1],
    });
    const by = Object.fromEntries(inv[0].categories.map((c) => [c.base, c.label]));
    expect(by.oge_players).toBe('Player cache');
    expect(by.oge_brandNewThing).toBe('oge_brandNewThing');
  });
});

describe('classifySyncFreshness', () => {
  const now = 1_700_000_000_000;

  it('null status → never', () => {
    expect(classifySyncFreshness(null, now)).toEqual({ tone: 'never', label: 'never synced' });
  });

  it('active backoff → backoff with minutes in the label', () => {
    const r = classifySyncFreshness({ backoffUntil: now + 5 * 60 * 1000 }, now);
    expect(r.tone).toBe('backoff');
    expect(r.label).toMatch(/5 min/);
  });

  it('an expired backoff is ignored', () => {
    const r = classifySyncFreshness(
      { backoffUntil: now - 1000, up: new Date(now).toISOString() },
      now,
    );
    expect(r.tone).toBe('ok');
  });

  it('error set → error', () => {
    const r = classifySyncFreshness({ err: 'boom', up: new Date(now).toISOString() }, now);
    expect(r).toEqual({ tone: 'error', label: 'last sync failed' });
  });

  it('priority: backoff beats error', () => {
    const r = classifySyncFreshness({ backoffUntil: now + 60_000, err: 'boom' }, now);
    expect(r.tone).toBe('backoff');
  });

  it('priority: error beats recency', () => {
    const r = classifySyncFreshness({ err: 'boom', down: new Date(now).toISOString() }, now);
    expect(r.tone).toBe('error');
  });

  it('recent up/down (≤24h) → ok with a relative age', () => {
    const r = classifySyncFreshness({ up: new Date(now - 5 * 60 * 1000).toISOString() }, now);
    expect(r.tone).toBe('ok');
    expect(r.label).toBe('5m ago');
  });

  it('uses the newer of up/down for recency', () => {
    const r = classifySyncFreshness(
      { up: new Date(now - 10 * HOUR).toISOString(), down: new Date(now - 2 * HOUR).toISOString() },
      now,
    );
    expect(r.tone).toBe('ok');
    expect(r.label).toBe('2h ago');
  });

  it('"just now" under a minute', () => {
    const r = classifySyncFreshness({ down: new Date(now - 5000).toISOString() }, now);
    expect(r.label).toBe('just now');
  });

  it('older than 24h → stale with a day-based age', () => {
    const r = classifySyncFreshness({ up: new Date(now - 3 * DAY).toISOString() }, now);
    expect(r.tone).toBe('stale');
    expect(r.label).toBe('3d ago');
  });

  it('no parseable up/down → never', () => {
    expect(classifySyncFreshness({ up: null, down: null }, now)).toEqual({
      tone: 'never',
      label: 'never synced',
    });
    expect(classifySyncFreshness({ up: 'not-a-date' }, now).tone).toBe('never');
  });
});

describe('formatBytes', () => {
  it('< 1024 → N B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('< 1 MB → X.X KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
  it('≥ 1 MB → X.X MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(Math.round(2.5 * 1024 * 1024))).toBe('2.5 MB');
  });
});
