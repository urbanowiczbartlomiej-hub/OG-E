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

  it('is at schema version 1', () => {
    // v1.3.1 stayed on v1: the X-Delay scheduling pivot only mutated
    // optional fields of `notifyState`, no breaking shape change.
    expect(REMINDER_SCHEMA_VERSION).toBe(1);
  });

  it('exposes distinct chrome.storage mirror keys for the dashboard preview', () => {
    const keys = [REMINDER_MIRROR_KEY, REMINDER_GIST_ID_KEY, REMINDER_TOKEN_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(typeof k).toBe('string');
  });
});
