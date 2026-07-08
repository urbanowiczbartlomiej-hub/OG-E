// @ts-check

// liveOverlay — the live-scan layer of the API composite. Two contracts:
// (1) lf-only entries (empty `positions`) never clobber the API occupancy;
// (2) with server bounds known, entries OUTSIDE the real grid are dropped —
//     stale junk keys in the persisted blob (an old import / another server's
//     leftovers) otherwise resurrect phantom galaxies whose systems read
//     "fully free" and top every colonization ranking (the "worth colonizing
//     in galaxy 8/9 on a 7-galaxy server" bug).

import { describe, it, expect } from 'vitest';
import { liveOverlay } from '../../../src/features/dashboard/mapPrimitives.js';

/** One observed system entry (a single occupied position is enough). */
const sys = () => ({ positions: { 8: { status: 'inactive' } } });

describe('liveOverlay', () => {
  it('keeps observed systems and drops lf-only (empty positions) entries', () => {
    const out = liveOverlay(/** @type {any} */ ({
      '1:42': sys(),
      '2:7': { positions: {} },
    }));
    expect(Object.keys(out)).toEqual(['1:42']);
  });

  it('without bounds keeps every observed entry (legacy behaviour)', () => {
    const out = liveOverlay(/** @type {any} */ ({ '9:400': sys(), '1:1': sys() }));
    expect(Object.keys(out).sort()).toEqual(['1:1', '9:400']);
  });

  it('with bounds drops entries beyond the server grid (galaxy AND system)', () => {
    const out = liveOverlay(/** @type {any} */ ({
      '1:1': sys(),
      '7:499': sys(),   // last real slot on a 7×499 server — stays
      '8:100': sys(),   // phantom galaxy — dropped
      '9:400': sys(),   // phantom galaxy — dropped
      '3:500': sys(),   // beyond the system bound — dropped
    }), { galaxies: 7, systems: 499 });
    expect(Object.keys(out).sort()).toEqual(['1:1', '7:499']);
  });

  it('partial bounds clamp only the known axis', () => {
    const out = liveOverlay(/** @type {any} */ ({ '8:100': sys(), '3:500': sys() }), { galaxies: 7 });
    expect(Object.keys(out)).toEqual(['3:500']);
  });
});
