// @vitest-environment happy-dom
//
// Unit tests for state/manualLandedFs — a plain JSON array of the user's manual
// landed-FS marks (`{ bodyKey, markedAt }`) over safeLS, with NO reactive store
// (same key-owner pattern as state/fleetSaveSet.js). happy-dom supplies a real
// localStorage, wiped between cases; tests drive the public read/write/toggle
// surface against the wire.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MANUAL_LANDED_FS_KEY,
  readManualLandedFs,
  writeManualLandedFs,
  hasManualLandedFs,
  removeManualLandedFs,
  toggleManualLandedFs,
} from '../../src/state/manualLandedFs.js';

beforeEach(() => {
  localStorage.clear();
});

describe('manualLandedFs — key + round-trip', () => {
  it('exposes the canonical key', () => {
    expect(MANUAL_LANDED_FS_KEY).toBe('oge-fleetsave-manual');
  });

  it('round-trips an array of { bodyKey, markedAt } entries', () => {
    const entries = [
      { bodyKey: '1:2:3:1', markedAt: 1000 },
      { bodyKey: '4:5:6:3', markedAt: 2000 },
    ];
    writeManualLandedFs(entries);
    expect(readManualLandedFs()).toEqual(entries);
  });

  it('persists under the canonical key as JSON', () => {
    writeManualLandedFs([{ bodyKey: '1:1:1:1', markedAt: 42 }]);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(MANUAL_LANDED_FS_KEY)))).toEqual([
      { bodyKey: '1:1:1:1', markedAt: 42 },
    ]);
  });
});

describe('manualLandedFs — read edge cases', () => {
  it('returns [] when the key is absent', () => {
    expect(readManualLandedFs()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem(MANUAL_LANDED_FS_KEY, JSON.stringify({ not: 'an array' }));
    expect(readManualLandedFs()).toEqual([]);
  });

  it('returns [] when the stored value is corrupt JSON', () => {
    localStorage.setItem(MANUAL_LANDED_FS_KEY, '{not json');
    expect(readManualLandedFs()).toEqual([]);
  });

  it('filters out entries without a string bodyKey', () => {
    localStorage.setItem(
      MANUAL_LANDED_FS_KEY,
      JSON.stringify([
        { bodyKey: '1:2:3:1', markedAt: 1 },
        { bodyKey: 99, markedAt: 2 }, // bodyKey not a string
        null,
        42,
        { markedAt: 3 }, // missing bodyKey
        { bodyKey: '4:5:6:3', markedAt: 4 },
      ]),
    );
    expect(readManualLandedFs()).toEqual([
      { bodyKey: '1:2:3:1', markedAt: 1 },
      { bodyKey: '4:5:6:3', markedAt: 4 },
    ]);
  });
});

describe('manualLandedFs — write guard', () => {
  it('stores [] when writeManualLandedFs gets a non-array argument', () => {
    // @ts-expect-error — exercising the runtime guard with a bad type.
    writeManualLandedFs('1:2:3:1');
    expect(readManualLandedFs()).toEqual([]);
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem(MANUAL_LANDED_FS_KEY)))).toEqual(
      [],
    );
  });
});

describe('hasManualLandedFs', () => {
  it('is false on empty storage', () => {
    expect(hasManualLandedFs('1:2:3:1')).toBe(false);
  });

  it('matches only the exact bodyKey (planet vs moon are distinct)', () => {
    writeManualLandedFs([{ bodyKey: '1:2:3:1', markedAt: 1 }]);
    expect(hasManualLandedFs('1:2:3:1')).toBe(true);
    expect(hasManualLandedFs('1:2:3:3')).toBe(false); // moon of the same coords
    expect(hasManualLandedFs('9:9:9:1')).toBe(false);
  });
});

describe('removeManualLandedFs', () => {
  it('removes one body, leaving the others', () => {
    writeManualLandedFs([
      { bodyKey: '1:2:3:1', markedAt: 1 },
      { bodyKey: '4:5:6:3', markedAt: 2 },
    ]);
    removeManualLandedFs('1:2:3:1');
    expect(readManualLandedFs()).toEqual([{ bodyKey: '4:5:6:3', markedAt: 2 }]);
  });

  it('is idempotent — removing an absent body is a no-op', () => {
    writeManualLandedFs([{ bodyKey: '1:2:3:1', markedAt: 1 }]);
    removeManualLandedFs('9:9:9:9');
    expect(readManualLandedFs()).toEqual([{ bodyKey: '1:2:3:1', markedAt: 1 }]);
  });
});

describe('toggleManualLandedFs', () => {
  it('marks an absent body (returns true) and stamps the passed markedAt', () => {
    expect(toggleManualLandedFs('1:2:3:1', 555)).toBe(true);
    expect(readManualLandedFs()).toEqual([{ bodyKey: '1:2:3:1', markedAt: 555 }]);
  });

  it('unmarks an already-marked body (returns false)', () => {
    toggleManualLandedFs('1:2:3:1', 100);
    expect(toggleManualLandedFs('1:2:3:1', 200)).toBe(false);
    expect(readManualLandedFs()).toEqual([]);
  });

  it('round-trips mark → unmark → mark', () => {
    expect(toggleManualLandedFs('7:8:9:3', 1)).toBe(true);
    expect(toggleManualLandedFs('7:8:9:3', 2)).toBe(false);
    expect(toggleManualLandedFs('7:8:9:3', 3)).toBe(true);
    expect(hasManualLandedFs('7:8:9:3')).toBe(true);
  });

  it('toggling one body leaves other marks untouched', () => {
    writeManualLandedFs([{ bodyKey: 'keep:me:1:1', markedAt: 10 }]);
    toggleManualLandedFs('1:2:3:1', 20);
    expect(readManualLandedFs()).toEqual([
      { bodyKey: 'keep:me:1:1', markedAt: 10 },
      { bodyKey: '1:2:3:1', markedAt: 20 },
    ]);
  });
});
