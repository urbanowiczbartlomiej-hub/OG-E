// @ts-check

import { describe, it, expect } from 'vitest';
import { parseFsOffsets, computeFleetSaves, pruneFsNotify } from '../../src/domain/fleetSave.js';

/**
 * @param {Partial<import('../../src/domain/fleetSave.js').FleetSaveCandidate> & { id: string }} o
 * @returns {import('../../src/domain/fleetSave.js').FleetSaveCandidate}
 */
const cand = (o) => ({
  arrivalAt: 2000,
  shipCount: 150000,
  label: 'Deployment → [4:478:14]',
  ...o,
});

describe('parseFsOffsets', () => {
  it('parses a comma list, de-dupes, sorts ascending', () => {
    expect(parseFsOffsets('-600,0,600')).toEqual([-600, 0, 600]);
    expect(parseFsOffsets('600, 0, -600')).toEqual([-600, 0, 600]);
    expect(parseFsOffsets('0,0,600,600')).toEqual([0, 600]);
  });

  it('tolerates spaces, a leading +, and a trailing comma', () => {
    expect(parseFsOffsets('  -600 , +300 , 0 ,')).toEqual([-600, 0, 300]);
  });

  it('drops non-integer / garbage tokens', () => {
    expect(parseFsOffsets('600,abc,12.5,,90')).toEqual([90, 600]);
    expect(parseFsOffsets('')).toEqual([]);
    expect(parseFsOffsets(/** @type {any} */ (undefined))).toEqual([]);
  });
});

describe('computeFleetSaves', () => {
  it('keeps only candidates at or above the threshold', () => {
    const out = computeFleetSaves(
      [cand({ id: 'a', shipCount: 100000 }), cand({ id: 'b', shipCount: 99999 })],
      { threshold: 100000, offsetsSec: [0] },
    );
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('expands offsets to absolute fire times anchored at arrival', () => {
    const [e] = computeFleetSaves([cand({ id: 'a', arrivalAt: 2000 })], {
      threshold: 100000,
      offsetsSec: [-600, 0, 600],
    });
    expect(e).toMatchObject({
      id: 'a',
      arrivalAt: 2000,
      shipCount: 150000,
      label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600],
      fireAts: [1400, 2000, 2600],
    });
  });

  it('skips candidates with a non-finite arrival or ship count', () => {
    const out = computeFleetSaves(
      [cand({ id: 'a', arrivalAt: NaN }), cand({ id: 'b', shipCount: NaN })],
      { threshold: 1, offsetsSec: [0] },
    );
    expect(out).toEqual([]);
  });

  it('returns an empty set when there are no candidates', () => {
    expect(computeFleetSaves([], { threshold: 100000, offsetsSec: [0] })).toEqual([]);
  });
});

describe('pruneFsNotify', () => {
  it('keeps only bookkeeping whose id is still live', () => {
    const notify = { a: { scheduledMessageIds: ['m1'] }, b: { scheduledMessageIds: ['m2'] } };
    const [live] = computeFleetSaves([cand({ id: 'a' })], { threshold: 1, offsetsSec: [0] });
    const pruned = pruneFsNotify(notify, [live]);
    expect(pruned).toEqual({ a: { scheduledMessageIds: ['m1'] } });
  });
});
