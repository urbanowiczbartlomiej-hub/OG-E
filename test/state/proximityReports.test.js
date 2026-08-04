// @ts-check

// Retention policy of the proximity log (state/proximityReports.trimProximityLog).
// Pure — `nowSec` is injected — so this is a plain node test.
//
// The regression it pins: the log used to be a 60-ENTRY window, which on a probed
// account is roughly one week. The "Who's spying on you" panel offers 1d/7d/1m/3m
// windows, so 1m and 3m had nothing older than 7d to show whatever the user
// picked. Retention is now the widest offered window, with the count cap demoted
// to a runaway guard.

import { describe, it, expect } from 'vitest';
import {
  PROXIMITY_CAP,
  PROXIMITY_MAX_AGE_S,
  trimProximityLog,
} from '../../src/state/proximityReports.js';

const NOW = 1_800_000_000;
/** @param {number} agoS @param {number} [id] */
const rep = (agoS, id = 1) => /** @type {any} */ ({
  byPlayerId: id, atCoords: '1:2:3', ts: NOW - agoS,
});

describe('trimProximityLog', () => {
  it('keeps everything inside the retention window', () => {
    const list = [rep(60), rep(86400 * 30), rep(PROXIMITY_MAX_AGE_S - 1)];
    expect(trimProximityLog(list, NOW)).toEqual(list);
  });

  it('drops alerts past the window', () => {
    const fresh = rep(60);
    const list = [fresh, rep(PROXIMITY_MAX_AGE_S + 1), rep(PROXIMITY_MAX_AGE_S * 2)];
    expect(trimProximityLog(list, NOW)).toEqual([fresh]);
  });

  it('covers the widest window the UI offers (3 months)', () => {
    // 3m of alerts must survive, or the 3m filter is a lie again.
    expect(trimProximityLog([rep(86400 * 90)], NOW)).toHaveLength(1);
  });

  it('keeps a ts-less alert — it cannot be aged, so it is not evidence of age', () => {
    const undated = /** @type {any} */ ({ byPlayerId: 7, atCoords: '4:4:4' });
    expect(trimProximityLog([undated], NOW)).toEqual([undated]);
  });

  it('still enforces the count cap as a runaway guard', () => {
    const list = Array.from({ length: PROXIMITY_CAP + 50 }, (_, i) => rep(i, i));
    const out = trimProximityLog(list, NOW);
    expect(out).toHaveLength(PROXIMITY_CAP);
    // Newest-first input → the newest are the ones kept.
    expect(out[0]).toEqual(list[0]);
  });

  it('is far above the old 60-entry window (the bug this fixed)', () => {
    expect(PROXIMITY_CAP).toBeGreaterThan(60);
  });
});
