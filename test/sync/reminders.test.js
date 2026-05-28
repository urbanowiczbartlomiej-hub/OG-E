// @ts-check

// Surface constants from `src/sync/reminders.js`. The gist-IO functions
// themselves are integration-level (need a real gist + token) and not
// exercised here; the reconcile pipeline they orchestrate is fully
// covered by `test/domain/waves.test.js` and the ntfy scheduling by
// `test/sync/ntfyScheduler.test.js`.

import { describe, it, expect } from 'vitest';
import {
  REMINDER_FILENAME,
  REMINDER_SCHEMA_VERSION,
  REMINDER_MIRROR_KEY,
  REMINDER_GIST_ID_KEY,
  REMINDER_TOKEN_KEY,
} from '../../src/sync/reminders.js';

describe('reminder file constants', () => {
  it('uses a stable filename inside the gist', () => {
    expect(REMINDER_FILENAME).toBe('oge-reminders.json');
  });

  it('is at schema version 2', () => {
    // v1.3.2 bumped to v2 with the switch to return-time-set overlap
    // identity. `Wave.returnAts` is now part of the persisted shape and
    // `Wave.id` is stamped at brand-new instead of derived from
    // `nextWaveAt`. v1 state is treated as absent on read (no migration).
    expect(REMINDER_SCHEMA_VERSION).toBe(2);
  });

  it('exposes distinct chrome.storage mirror keys for the dashboard preview', () => {
    const keys = [REMINDER_MIRROR_KEY, REMINDER_GIST_ID_KEY, REMINDER_TOKEN_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(typeof k).toBe('string');
  });
});
