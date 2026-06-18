// @ts-check

import { describe, it, expect } from 'vitest';
import {
  parseAdhocOffsets,
  adhocFireTimes,
  reconcileAdhoc,
  pruneAdhocNotify,
} from '../../src/domain/adhoc.js';

/**
 * @param {Partial<import('../../src/domain/adhoc.js').AdhocReminder> & { id: string }} o
 * @returns {import('../../src/domain/adhoc.js').AdhocReminder}
 */
const entry = (o) => ({
  arrivalAt: 2000,
  label: 'Expedition → [4:467:16]',
  ...o,
});

describe('parseAdhocOffsets', () => {
  it('parses a signed offset list (before / at / after arrival)', () => {
    expect(parseAdhocOffsets('-1m, 0, +5m')).toEqual([-60, 0, 300]);
  });

  it('returns empty for garbage', () => {
    expect(parseAdhocOffsets('nonsense')).toEqual([]);
  });
});

describe('adhocFireTimes', () => {
  it('resolves offsets to absolute fire times against the arrival anchor', () => {
    expect(adhocFireTimes(2000, [-60, 0, 300])).toEqual([1940, 2000, 2300]);
  });

  it('returns an empty array for no offsets', () => {
    expect(adhocFireTimes(2000, [])).toEqual([]);
  });
});

describe('reconcileAdhoc', () => {
  it('keeps a present entry whose arrival is unchanged (same object)', () => {
    const a = entry({ id: 'eventRow-1' });
    const { entries, droppedIds } = reconcileAdhoc([a], [{ id: 'eventRow-1', arrivalAt: 2000 }]);
    expect(droppedIds).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(a); // unchanged → same reference
  });

  it('reschedules when the arrival time changed, preserving id/label (no fireAt)', () => {
    const a = entry({ id: 'eventRow-1', arrivalAt: 2000 });
    const { entries } = reconcileAdhoc([a], [{ id: 'eventRow-1', arrivalAt: 2500 }]);
    expect(entries[0]).toMatchObject({
      id: 'eventRow-1',
      arrivalAt: 2500,
      label: 'Expedition → [4:467:16]',
    });
    expect(entries[0]).not.toHaveProperty('fireAt');
    expect(a.arrivalAt).toBe(2000); // input not mutated
  });

  it('drops an entry whose row vanished from the event list', () => {
    const a = entry({ id: 'eventRow-1' });
    const { entries, droppedIds } = reconcileAdhoc([a], []);
    expect(entries).toEqual([]);
    expect(droppedIds).toEqual(['eventRow-1']);
  });

  it('handles a mix: keep one, reschedule one, drop one', () => {
    const keep = entry({ id: 'a', arrivalAt: 1000 });
    const move = entry({ id: 'b', arrivalAt: 2000 });
    const gone = entry({ id: 'c', arrivalAt: 3000 });
    const { entries, droppedIds } = reconcileAdhoc(
      [keep, move, gone],
      [{ id: 'a', arrivalAt: 1000 }, { id: 'b', arrivalAt: 2200 }],
    );
    expect(droppedIds).toEqual(['c']);
    expect(entries.find((e) => e.id === 'a')).toBe(keep);
    expect(entries.find((e) => e.id === 'b')).toMatchObject({ arrivalAt: 2200 });
  });

  it('drops everything when the live list is empty (nothing in flight)', () => {
    const { entries, droppedIds } = reconcileAdhoc(
      [entry({ id: 'a' }), entry({ id: 'b' })],
      [],
    );
    expect(entries).toEqual([]);
    expect(droppedIds).toEqual(['a', 'b']);
  });
});

describe('pruneAdhocNotify', () => {
  it('keeps only bookkeeping whose id is still live', () => {
    const notify = { a: { scheduledMessageIds: ['m1'] }, b: { scheduledMessageIds: ['m2'] } };
    const pruned = pruneAdhocNotify(notify, [entry({ id: 'a' })]);
    expect(pruned).toEqual({ a: { scheduledMessageIds: ['m1'] } });
  });
});
