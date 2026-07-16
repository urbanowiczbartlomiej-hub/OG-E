// @ts-check

// Surface constants + the per-universe filename helper from
// `src/sync/alarmClock.js`. The gist-IO functions themselves are
// integration-level (need a real gist + token) and not exercised here;
// the reconcile pipeline they orchestrate is fully covered by
// `test/domain/waves.test.js` and the ntfy scheduling by
// `test/sync/ntfyReconciler.test.js`.

import { describe, it, expect } from 'vitest';
import {
  ALARM_CLOCK_FILENAME_PREFIX,
  ALARM_CLOCK_FILENAME_RE,
  alarmClockFilenameFor,
  ALARM_CLOCK_SCHEMA_VERSION,
  ALARM_CLOCK_MIRROR_KEY,
  ALARM_CLOCK_GIST_ID_KEY,
  ALARM_CLOCK_TOKEN_KEY,
  isValidNtfyToken,
} from '../../src/sync/alarmClock.js';

describe('alarmClock file constants', () => {
  it('uses a stable filename prefix inside the gist', () => {
    expect(ALARM_CLOCK_FILENAME_PREFIX).toBe('oge-alarmClock-');
  });

  it('builds per-universe filenames', () => {
    expect(alarmClockFilenameFor('s163-pl')).toBe('oge-alarmClock-s163-pl.json');
    expect(alarmClockFilenameFor('s201-pl')).toBe('oge-alarmClock-s201-pl.json');
  });

  it('ALARM_CLOCK_FILENAME_RE captures the universeId', () => {
    const m = ALARM_CLOCK_FILENAME_RE.exec('oge-alarmClock-s163-pl.json');
    expect(m?.[1]).toBe('s163-pl');
  });

  it('ALARM_CLOCK_FILENAME_RE rejects the v2 single-file name', () => {
    // Pre-1.5 used `oge-alarmClock.json` (no universeId). We must not
    // accidentally read v2 leftovers as a phantom universe.
    expect(ALARM_CLOCK_FILENAME_RE.exec('oge-alarmClock.json')).toBeNull();
  });

  it('ALARM_CLOCK_FILENAME_RE rejects unrelated gist files', () => {
    expect(ALARM_CLOCK_FILENAME_RE.exec('oge-data.json.gz.b64')).toBeNull();
    expect(ALARM_CLOCK_FILENAME_RE.exec('README.md')).toBeNull();
  });

  it('is at schema version 7', () => {
    // v1.5.0 bumped to v3 (per-universe files). v1.8.0 bumped to v4,
    // adding the ad-hoc alarmClock blocks. v1.9.0 bumped to v5, adding the
    // fleet-save blocks. v1.29.0 bumped to v6, adding the `landedFleetSave`
    // block. v1.51.2 bumped to v7, DROPPING it again — the durable exposed
    // state moved to the synced fleet-reminder store (state/fleetReminders);
    // v3–v6 are read forward (v6's field simply ignored), older versions
    // treated as absent.
    expect(ALARM_CLOCK_SCHEMA_VERSION).toBe(7);
  });

  it('exposes distinct chrome.storage mirror keys for the dashboard preview', () => {
    const keys = [ALARM_CLOCK_MIRROR_KEY, ALARM_CLOCK_GIST_ID_KEY, ALARM_CLOCK_TOKEN_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(typeof k).toBe('string');
  });
});

describe('isValidNtfyToken', () => {
  it('accepts a realistic ntfy access token (tk_ + 30 chars)', () => {
    expect(isValidNtfyToken('tk_tbqdljrkz4ivlgagxwewjz17k26gw')).toBe(true);
  });

  it('accepts tokens with mixed case + digits past the 20-char minimum', () => {
    expect(isValidNtfyToken('tk_AbCdEfGhIjKlMnOpQrStUvWxYz0123')).toBe(true);
  });

  it('rejects empty / missing / non-string values', () => {
    expect(isValidNtfyToken('')).toBe(false);
    expect(isValidNtfyToken(undefined)).toBe(false);
    expect(isValidNtfyToken(null)).toBe(false);
    expect(isValidNtfyToken(42)).toBe(false);
  });

  it('rejects values without the tk_ prefix', () => {
    expect(isValidNtfyToken('abcdefghijklmnopqrstuvwxyz12')).toBe(false);
  });

  it('rejects values too short after the prefix', () => {
    expect(isValidNtfyToken('tk_short')).toBe(false);
  });

  it('rejects multi-line / whitespace-containing garbage (the dashboard-paste bug)', () => {
    // The real-world failure mode: user pasted the entire dashboard
    // preview text into the Settings field. Multi-line, spaces,
    // punctuation. Must not be treated as a valid token.
    expect(isValidNtfyToken(':Currently queued live · 20:36:42 · 0 messages')).toBe(false);
    expect(isValidNtfyToken('tk_with spaces here')).toBe(false);
    expect(isValidNtfyToken('tk_x\ny')).toBe(false);
  });
});
