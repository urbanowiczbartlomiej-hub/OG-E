// @ts-check

// Unit tests for the `scheduling` pure-domain module.
//
// Node env, no DOM, no fake timers — we pass `now` explicitly rather
// than mocking `Date.now()`, because the module accepts an injected
// time argument for exactly this purpose. Two things under test:
// the structural shape of RESCAN_AFTER (stability of the thresholds
// other modules rely on) and the decision table of isSystemStale.

import { describe, it, expect } from 'vitest';
import { RESCAN_AFTER, isSystemStale } from '../../src/domain/scheduling.js';

const H = 3600 * 1000;          // 1 hour in ms
const D = 24 * H;               // 1 day in ms
const NOW = 1_700_000_000_000;  // stable reference time, used throughout

describe('RESCAN_AFTER', () => {
  it('maps `empty_sent` to 4 hours', () => {
    expect(RESCAN_AFTER.empty_sent).toBe(4 * H);
  });

  it('does NOT map `abandoned` (uses `abandonedCleanupDeadline` instead, 4.9.6 parity)', () => {
    // `abandoned` is absent from RESCAN_AFTER by design — the game's
    // cleanup sweep runs at 3 AM server time, so we compare against
    // an absolute deadline (`abandonedCleanupDeadline`) rather than
    // a flat age threshold. See `isSystemStale` for the branch.
    expect(RESCAN_AFTER.abandoned).toBeUndefined();
  });

  it('maps `inactive` to 5 days', () => {
    expect(RESCAN_AFTER.inactive).toBe(5 * D);
  });

  it('maps `long_inactive` to 5 days', () => {
    expect(RESCAN_AFTER.long_inactive).toBe(5 * D);
  });

  it('maps `vacation` to 30 days', () => {
    expect(RESCAN_AFTER.vacation).toBe(30 * D);
  });

  it('maps `banned` to 30 days', () => {
    expect(RESCAN_AFTER.banned).toBe(30 * D);
  });

  it('maps `occupied` to 30 days', () => {
    expect(RESCAN_AFTER.occupied).toBe(30 * D);
  });

  it('does NOT list the stable statuses (empty / mine / admin)', () => {
    // These statuses must stay absent — presence of any threshold here
    // would (incorrectly) start prompting rescans of stable slots.
    expect(/** @type {any} */ (RESCAN_AFTER).empty).toBeUndefined();
    expect(/** @type {any} */ (RESCAN_AFTER).mine).toBeUndefined();
    expect(/** @type {any} */ (RESCAN_AFTER).admin).toBeUndefined();
  });
});

describe('isSystemStale', () => {
  it('treats null as stale (no data at all)', () => {
    expect(isSystemStale(null, NOW)).toBe(true);
  });

  it('treats undefined as stale (no data at all)', () => {
    expect(isSystemStale(undefined, NOW)).toBe(true);
  });

  it('treats an empty positions map as stale', () => {
    expect(isSystemStale({ scannedAt: NOW, positions: {} }, NOW)).toBe(true);
  });

  it('treats a missing scannedAt as stale', () => {
    expect(
      isSystemStale({ positions: { 8: { status: 'empty' } } }, NOW),
    ).toBe(true);
  });

  it('reports fresh when empty_sent is newer than its 4h threshold', () => {
    expect(
      isSystemStale(
        { scannedAt: NOW - H, positions: { 8: { status: 'empty_sent' } } },
        NOW,
      ),
    ).toBe(false);
  });

  it('reports stale when empty_sent is older than its 4h threshold', () => {
    expect(
      isSystemStale(
        { scannedAt: NOW - 5 * H, positions: { 8: { status: 'empty_sent' } } },
        NOW,
      ),
    ).toBe(true);
  });

  it('treats empty as always-fresh no matter how old', () => {
    expect(
      isSystemStale(
        { scannedAt: NOW - 1000 * D, positions: { 8: { status: 'empty' } } },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats mine as always-fresh no matter how old', () => {
    expect(
      isSystemStale(
        { scannedAt: NOW - 1000 * D, positions: { 8: { status: 'mine' } } },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats admin as always-fresh no matter how old', () => {
    expect(
      isSystemStale(
        { scannedAt: NOW - 1000 * D, positions: { 8: { status: 'admin' } } },
        NOW,
      ),
    ).toBe(false);
  });

  it('reports stale when ANY position is past its threshold, even alongside stable ones', () => {
    // `empty` would read as fresh forever, but `inactive`'s 5d window
    // is blown out at 6d — that single slot forces a rescan.
    // (abandoned moved to a dynamic 3-AM deadline in 4.9.6; use
    // `inactive` here for a flat-threshold mixed-slot test.)
    expect(
      isSystemStale(
        {
          scannedAt: NOW - 6 * 24 * H,
          positions: {
            8: { status: 'empty' },
            9: { status: 'inactive' },
          },
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('uses strict `>` at the exact threshold boundary', () => {
    // Exactly 4h old with empty_sent: age === threshold, so age > threshold
    // is FALSE → not stale yet. One more tick and we'd flip.
    expect(
      isSystemStale(
        { scannedAt: NOW - 4 * H, positions: { 8: { status: 'empty_sent' } } },
        NOW,
      ),
    ).toBe(false);
  });

  it('defaults `now` to Date.now() when omitted', () => {
    // A scan that was taken a year before "now" will always be stale
    // for any thresholded status, regardless of what the real wall clock
    // currently says — so we can safely omit the second argument here
    // and still assert determinism.
    const scan = {
      scannedAt: Date.now() - 365 * D,
      positions: { 8: { status: /** @type {const} */ ('empty_sent') } },
    };
    expect(isSystemStale(scan)).toBe(true);
  });
});
