// @vitest-environment happy-dom
//
// Unit tests for state/fsSendHints — the isolated-world READ side of the
// dispatch-time hints `bridges/fleetSaveSendHint.js` writes. A plain
// key-owner over safeLS; the read prunes expired/malformed entries without
// writing back.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import { readFsSendHints, FS_HINT_LINGER_SEC } from '../../src/state/fsSendHints.js';
import { FS_SEND_HINTS_KEY } from '../../src/lib/storageKeys.js';

const NOW = 100_000;

beforeEach(() => {
  localStorage.clear();
});

describe('readFsSendHints', () => {
  it('returns [] for an absent / corrupt / non-array key', () => {
    expect(readFsSendHints(NOW)).toEqual([]);
    localStorage.setItem(FS_SEND_HINTS_KEY, '{not json');
    expect(readFsSendHints(NOW)).toEqual([]);
    localStorage.setItem(FS_SEND_HINTS_KEY, JSON.stringify({ a: 1 }));
    expect(readFsSendHints(NOW)).toEqual([]);
  });

  it('returns live hints and drops expired ones (arrival + linger < now)', () => {
    const live = { landingKey: '1:2:3:1', arrivalAt: NOW + 600, flightSec: 3600 };
    const lingering = { landingKey: '4:5:6:1', arrivalAt: NOW - FS_HINT_LINGER_SEC, flightSec: 3600 };
    const expired = { landingKey: '7:8:9:1', arrivalAt: NOW - FS_HINT_LINGER_SEC - 1, flightSec: 3600 };
    localStorage.setItem(FS_SEND_HINTS_KEY, JSON.stringify([live, lingering, expired]));
    expect(readFsSendHints(NOW)).toEqual([live, lingering]);
  });

  it('drops malformed entries (missing/invalid fields)', () => {
    const ok = { landingKey: '1:2:3:1', arrivalAt: NOW, flightSec: 60 };
    localStorage.setItem(FS_SEND_HINTS_KEY, JSON.stringify([
      ok,
      { landingKey: '', arrivalAt: NOW, flightSec: 60 },
      { landingKey: '2:2:2:1', arrivalAt: 'soon', flightSec: 60 },
      { landingKey: '3:3:3:1', arrivalAt: NOW },
      null,
      42,
    ]));
    expect(readFsSendHints(NOW)).toEqual([ok]);
  });

  it('does not write back on read (the MAIN-world writer owns pruning)', () => {
    const expired = { landingKey: '7:8:9:1', arrivalAt: 1, flightSec: 60 };
    const raw = JSON.stringify([expired]);
    localStorage.setItem(FS_SEND_HINTS_KEY, raw);
    readFsSendHints(NOW);
    expect(localStorage.getItem(FS_SEND_HINTS_KEY)).toBe(raw);
  });
});
