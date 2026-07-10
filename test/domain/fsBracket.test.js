// Unit tests for domain/fsBracket.js — fleet-save WINDOW bracketing (IDEAS #1).
// The suite pins: the present→absent (and absent→present) pairing into
// departure/return arcs; the PLAYER-RELATIVE present-gate (peak-observed and
// API fleet-scale anchors, with the floor); and the five structural honesty
// gates — same-body pairing, sibling-relocation (none/possible/unchecked),
// fleet-section suppression, and the moon-gate downgrade. Narrowing by a lone
// activity marker and the newest-first cap round it out.
//
// Node env — pure, `nowMs` injected.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  FLEET_PRESENT_FLOOR,
  MAX_WINDOW_S,
  HORIZON_MS,
  MAX_ARCS,
  fleetObsOf,
  bracketFsArcs,
} from '../../src/domain/fsBracket.js';

const NOW = 1_700_000_000_000; // ms
/** @param {number} ms */
const sec = (ms) => Math.floor(ms / 1000);
/** N hours ago, epoch seconds. @param {number} h */
const hAgo = (h) => sec(NOW - h * 3600_000);

/**
 * A report entry ({latest, history}) from a list of fleet observations.
 * @param {Array<{ts: number, fleetValue?: number, activityMin?: number}>} obs
 */
const entry = (obs) => /** @type {any} */ ({
  latest: { timestamp: obs[obs.length - 1].ts },
  history: obs,
});

const BIG = 48_000_000; // a real capital fleet, in resource units
const GONE = 100_000; //   what's left after it saves (a recycler / some probes)

describe('fleetObsOf', () => {
  it('keeps only looks that REVEALED the fleet section, oldest→newest', () => {
    const e = entry([
      { ts: hAgo(6), fleetValue: BIG },
      { ts: hAgo(4) }, //           partial scan — fleet section hidden
      { ts: hAgo(2), fleetValue: GONE },
    ]);
    expect(fleetObsOf(e).map((o) => o.fleetValue)).toEqual([BIG, GONE]);
  });

  it('falls back to the lone latest report when there is no history', () => {
    const e = /** @type {any} */ ({ latest: { timestamp: hAgo(1), fleetValue: BIG }, history: [] });
    expect(fleetObsOf(e)).toEqual([{ ts: hAgo(1), fleetValue: BIG }]);
  });
});

describe('bracketFsArcs — pairing', () => {
  it('brackets a departure: present → absent on the same body', () => {
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toMatchObject({
      coord: '1:2:3', bodyType: 1, kind: 'departure',
      loSec: hAgo(5), hiSec: hAgo(3), valueBefore: BIG, valueAfter: GONE,
      relocation: 'none', moonGate: false, confidence: 'strong',
    });
  });

  it('brackets a return: absent → present', () => {
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: GONE }, { ts: hAgo(3), fleetValue: BIG }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toMatchObject({ kind: 'return', valueBefore: GONE, valueAfter: BIG });
  });

  it('no arc when the fleet barely moved (present → present)', () => {
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: BIG - 1_000_000 }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(0);
  });

  it('drops a window wider than the cap', () => {
    const wide = MAX_WINDOW_S / 3600 + 5; // hours, past the 48 h cap
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(wide), fleetValue: BIG }, { ts: hAgo(1), fleetValue: GONE }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(0);
  });

  it('drops an arc whose window closed before the 30-day horizon', () => {
    const old = HORIZON_MS / 3600_000 + 48; // hours ago, past the horizon
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(old + 2), fleetValue: BIG }, { ts: hAgo(old), fleetValue: GONE }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(0);
  });
});

describe('bracketFsArcs — player-relative present gate', () => {
  it("catches a small player's real fleet-save (gate rides the floor, not 100k)", () => {
    // Peak 90k → 10% = 9k, floored to 50k. 90k ≥ 50k and 5k ≤ 15% × 90k ⇒ arc.
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: 90_000 }, { ts: hAgo(3), fleetValue: 5_000 }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(1);
    expect(FLEET_PRESENT_FLOOR).toBe(50_000);
  });

  it("ignores a big player's recycler junk (below 10% of their peak)", () => {
    // Peak 48M elsewhere ⇒ gate = 4.8M; a 400k→50k blip on another body is noise.
    const arcs = bracketFsArcs(
      {
        '1:2:3:1': entry([{ ts: hAgo(20), fleetValue: BIG }, { ts: hAgo(18), fleetValue: BIG }]),
        '1:2:8:1': entry([{ ts: hAgo(5), fleetValue: 400_000 }, { ts: hAgo(3), fleetValue: 50_000 }]),
      },
      undefined, NOW,
    );
    expect(arcs.some((a) => a.coord === '1:2:8')).toBe(false);
  });

  it('the API fleet-scale anchor raises the gate above the peak we happened to see', () => {
    const bucket = {
      '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: 2_000_000 }, { ts: hAgo(3), fleetValue: GONE }]),
    };
    // Peak alone (2M) ⇒ gate 200k ⇒ this fires.
    expect(bracketFsArcs(bucket, undefined, NOW)).toHaveLength(1);
    // API says total mobile is 48M ⇒ gate 4.8M ⇒ a 2M "present" isn't a real fleet.
    expect(bracketFsArcs(bucket, undefined, NOW, { fleetScaleRes: BIG })).toHaveLength(0);
  });
});

describe('bracketFsArcs — honesty gates', () => {
  it('suppression: a hidden fleet-section is not read as "fleet gone"', () => {
    // present, then a partial scan that never revealed the fleet ⇒ one obs ⇒ no pair.
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3) /* hidden */ }]) },
      undefined, NOW,
    );
    expect(arcs).toHaveLength(0);
  });

  it('relocation=possible when a sibling body gained ~the dropped value in-window', () => {
    const arcs = bracketFsArcs(
      {
        '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]),
        '1:2:3:3': entry([{ ts: hAgo(6), fleetValue: 200_000 }, { ts: hAgo(2), fleetValue: BIG }]),
      },
      undefined, NOW, { totalBodies: 2 },
    );
    const dep = arcs.find((a) => a.coord === '1:2:3' && a.bodyType === 1 && a.kind === 'departure');
    expect(dep?.relocation).toBe('possible');
    expect(dep?.confidence).toBe('weak');
  });

  it("relocation=unchecked when the player has bodies we hold no fleet obs for", () => {
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]) },
      undefined, NOW, { totalBodies: 5 }, // 4 other bodies, none observed
    );
    expect(arcs[0].relocation).toBe('unchecked');
  });

  it('moon-gate: a moon departure with 2+ moons is downgraded (jump-gate doubt)', () => {
    const arcs = bracketFsArcs(
      { '1:2:3:3': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]) },
      undefined, NOW, { moonCount: 2, totalBodies: 3 },
    );
    expect(arcs[0]).toMatchObject({ bodyType: 3, moonGate: true, confidence: 'weak' });
  });
});

describe('bracketFsArcs — narrowing & cap', () => {
  it('narrows the window to a single activity marker inside it', () => {
    const rings = { '1:2:3:1': [{ t: hAgo(4), m: 0 }] }; // one positive look mid-window
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]) },
      rings, NOW,
    );
    expect(arcs[0].narrowed).not.toBeNull();
    expect(arcs[0].narrowed?.hi).toBeLessThanOrEqual(arcs[0].hiSec);
    expect(arcs[0].narrowed?.lo).toBeGreaterThanOrEqual(arcs[0].loSec);
  });

  it('does NOT narrow when two markers make the moment ambiguous', () => {
    const rings = { '1:2:3:1': [{ t: hAgo(4.5), m: 0 }, { t: hAgo(3.2), m: 0 }] };
    const arcs = bracketFsArcs(
      { '1:2:3:1': entry([{ ts: hAgo(5), fleetValue: BIG }, { ts: hAgo(3), fleetValue: GONE }]) },
      rings, NOW,
    );
    expect(arcs[0].narrowed).toBeNull();
  });

  it('caps at MAX_ARCS, newest window first', () => {
    /** @type {Array<{ts:number, fleetValue:number}>} */
    const obs = [];
    // 2 h saw/lost cycles over the last ~40 h → many arcs, all within cap.
    for (let i = 20; i >= 1; i--) {
      obs.push({ ts: hAgo(i * 2 + 0.5), fleetValue: BIG });
      obs.push({ ts: hAgo(i * 2), fleetValue: GONE });
    }
    const arcs = bracketFsArcs({ '1:2:3:1': entry(obs) }, undefined, NOW);
    expect(arcs.length).toBeLessThanOrEqual(MAX_ARCS);
    for (let i = 1; i < arcs.length; i++) {
      expect(arcs[i - 1].hiSec).toBeGreaterThanOrEqual(arcs[i].hiSec);
    }
  });

  it('returns [] for an empty bucket', () => {
    expect(bracketFsArcs({}, undefined, NOW)).toEqual([]);
    expect(bracketFsArcs(undefined, undefined, NOW)).toEqual([]);
  });
});
