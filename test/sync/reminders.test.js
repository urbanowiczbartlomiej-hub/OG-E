// @ts-check

// Surface constants + the per-universe filename helper from
// `src/sync/reminders.js`. The gist-IO functions themselves are
// integration-level (need a real gist + token) and not exercised here;
// the reconcile pipeline they orchestrate is fully covered by
// `test/domain/waves.test.js` and the ntfy scheduling by
// `test/sync/ntfyScheduler.test.js`.

import { describe, it, expect } from 'vitest';
import {
  REMINDER_FILENAME_PREFIX,
  REMINDER_FILENAME_RE,
  reminderFilenameFor,
  REMINDER_SCHEMA_VERSION,
  REMINDER_MIRROR_KEY,
  REMINDER_GIST_ID_KEY,
  REMINDER_TOKEN_KEY,
} from '../../src/sync/reminders.js';

describe('reminder file constants', () => {
  it('uses a stable filename prefix inside the gist', () => {
    expect(REMINDER_FILENAME_PREFIX).toBe('oge-reminders-');
  });

  it('builds per-universe filenames', () => {
    expect(reminderFilenameFor('s163-pl')).toBe('oge-reminders-s163-pl.json');
    expect(reminderFilenameFor('s201-pl')).toBe('oge-reminders-s201-pl.json');
  });

  it('REMINDER_FILENAME_RE captures the universeId', () => {
    const m = REMINDER_FILENAME_RE.exec('oge-reminders-s163-pl.json');
    expect(m?.[1]).toBe('s163-pl');
  });

  it('REMINDER_FILENAME_RE rejects the v2 single-file name', () => {
    // Pre-1.5 used `oge-reminders.json` (no universeId). We must not
    // accidentally read v2 leftovers as a phantom universe.
    expect(REMINDER_FILENAME_RE.exec('oge-reminders.json')).toBeNull();
  });

  it('REMINDER_FILENAME_RE rejects unrelated gist files', () => {
    expect(REMINDER_FILENAME_RE.exec('oge-data.json.gz.b64')).toBeNull();
    expect(REMINDER_FILENAME_RE.exec('README.md')).toBeNull();
  });

  it('is at schema version 3', () => {
    // v1.5.0 bumped to v3 with per-universe gist files. v2 state is
    // treated as absent on read; the orphan sweep cancels v2-era ntfy
    // messages still queued.
    expect(REMINDER_SCHEMA_VERSION).toBe(3);
  });

  it('exposes distinct chrome.storage mirror keys for the dashboard preview', () => {
    const keys = [REMINDER_MIRROR_KEY, REMINDER_GIST_ID_KEY, REMINDER_TOKEN_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(typeof k).toBe('string');
  });
});
