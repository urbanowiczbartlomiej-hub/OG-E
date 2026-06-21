// @ts-check

// Unit tests for domain/colonizeDecisions — the pure per-coord colonization
// decision log: LWW merge with terminal-outcome pinning, monotonic apply,
// full-map union merge, age/expiry compaction, and the picker's blocking set.
// Pure node — no DOM/storage/clock; `now` is always passed in.

import { describe, it, expect } from 'vitest';
import {
  DEC_SENT,
  DEC_MINE,
  DEC_ABANDONED,
  DEC_TAKEN,
  DEC_RESERVED,
  SENT_GRACE_MS,
  RESERVE_HOLD_MS,
  TAKEN_TTL_MS,
  mergeDecision,
  withDecision,
  mergeColonizeDecisions,
  compactDecisions,
  blockingCoords,
} from '../../src/domain/colonizeDecisions.js';

/**
 * @param {1|2|3|4|5} s
 * @param {number} ts
 * @param {Partial<import('../../src/domain/colonizeDecisions.js').Decision>} [extra]
 * @returns {import('../../src/domain/colonizeDecisions.js').Decision}
 */
const dec = (s, ts, extra = {}) => ({ s, ts, ...extra });

describe('state constants', () => {
  it('uses the documented numeric codes', () => {
    expect([DEC_SENT, DEC_MINE, DEC_ABANDONED, DEC_TAKEN, DEC_RESERVED]).toEqual([1, 2, 3, 4, 5]);
  });

  it('uses the documented time windows', () => {
    expect(SENT_GRACE_MS).toBe(60 * 60 * 1000);
    expect(RESERVE_HOLD_MS).toBe(36 * 60 * 60 * 1000);
    expect(TAKEN_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe('mergeDecision', () => {
  it('returns the present side when the other is missing', () => {
    const a = dec(DEC_SENT, 100);
    expect(mergeDecision(undefined, a)).toBe(a);
    expect(mergeDecision(a, undefined)).toBe(a);
  });

  it('newest ts wins among non-terminal states', () => {
    const older = dec(DEC_SENT, 100, { aa: 1 });
    const newer = dec(DEC_RESERVED, 200, { aa: 2 });
    expect(mergeDecision(older, newer)).toBe(newer);
    expect(mergeDecision(newer, older)).toBe(newer);
  });

  it('ties resolve to the incoming side', () => {
    const existing = dec(DEC_SENT, 100);
    const incoming = dec(DEC_RESERVED, 100);
    expect(mergeDecision(existing, incoming)).toBe(incoming);
  });

  it('a terminal outcome never regresses to sent/reserved, even if older', () => {
    const mine = dec(DEC_MINE, 100); // older terminal
    const sent = dec(DEC_SENT, 999); // newer pending
    expect(mergeDecision(mine, sent)).toBe(mine);
    expect(mergeDecision(sent, mine)).toBe(mine);
  });

  it('a newer terminal replaces an older terminal by ts', () => {
    const mine = dec(DEC_MINE, 100);
    const abandoned = dec(DEC_ABANDONED, 200);
    expect(mergeDecision(mine, abandoned)).toBe(abandoned);
  });

  it('terminal vs terminal still obeys LWW (taken can be superseded by a newer mine)', () => {
    const taken = dec(DEC_TAKEN, 300);
    const mine = dec(DEC_MINE, 100);
    // both terminal → newest ts wins → taken.
    expect(mergeDecision(mine, taken)).toBe(taken);
  });
});

describe('withDecision', () => {
  it('adds a new coord, returning a new map', () => {
    /** @type {import('../../src/domain/colonizeDecisions.js').DecisionMap} */
    const map = {};
    const next = withDecision(map, '1:1:2', dec(DEC_SENT, 100, { aa: 50 }));
    expect(next).not.toBe(map);
    expect(next['1:1:2']).toEqual({ s: DEC_SENT, ts: 100, aa: 50 });
  });

  it('returns the SAME map reference when the merge changes nothing', () => {
    const existing = dec(DEC_MINE, 200);
    const map = { '1:1:2': existing };
    // A stale sent cannot beat a terminal → no change → identity.
    const next = withDecision(map, '1:1:2', dec(DEC_SENT, 999));
    expect(next).toBe(map);
  });

  it('replaces a coord when the incoming decision wins', () => {
    const map = { '1:1:2': dec(DEC_SENT, 100) };
    const next = withDecision(map, '1:1:2', dec(DEC_MINE, 150));
    expect(next).not.toBe(map);
    expect(next['1:1:2']).toEqual({ s: DEC_MINE, ts: 150 });
    expect(map['1:1:2'].s).toBe(DEC_SENT); // original untouched
  });
});

describe('mergeColonizeDecisions', () => {
  it('unions disjoint coords and reports changed', () => {
    const local = { '1:1:1': dec(DEC_MINE, 10) };
    const remote = { '2:2:2': dec(DEC_TAKEN, 20) };
    const { merged, changed } = mergeColonizeDecisions(local, remote);
    expect(changed).toBe(true);
    expect(merged).toEqual({ '1:1:1': dec(DEC_MINE, 10), '2:2:2': dec(DEC_TAKEN, 20) });
  });

  it('per-coord LWW + terminal pinning on overlap', () => {
    const local = { '1:1:1': dec(DEC_MINE, 100) };
    const remote = { '1:1:1': dec(DEC_SENT, 999) }; // newer but pending
    const { merged, changed } = mergeColonizeDecisions(local, remote);
    expect(changed).toBe(false);
    expect(merged['1:1:1'].s).toBe(DEC_MINE);
  });

  it('reports changed=false when remote contributes nothing new', () => {
    const local = { '1:1:1': dec(DEC_TAKEN, 200) };
    const remote = { '1:1:1': dec(DEC_TAKEN, 100) }; // older, same terminal
    const { changed } = mergeColonizeDecisions(local, remote);
    expect(changed).toBe(false);
  });

  it('does not mutate the local map', () => {
    const local = { '1:1:1': dec(DEC_SENT, 100) };
    mergeColonizeDecisions(local, { '1:1:1': dec(DEC_MINE, 200) });
    expect(local['1:1:1'].s).toBe(DEC_SENT);
  });
});

describe('compactDecisions', () => {
  const NOW = 10_000_000_000;

  it('drops a sent past arrival + grace (no-show)', () => {
    const map = { '1:1:1': dec(DEC_SENT, 1, { aa: NOW - SENT_GRACE_MS - 1 }) };
    const { map: out, changed } = compactDecisions(map, NOW);
    expect(changed).toBe(true);
    expect(out).toEqual({});
  });

  it('keeps a sent still within arrival + grace', () => {
    const within = dec(DEC_SENT, 1, { aa: NOW - 1 });
    const { map: out, changed } = compactDecisions({ '1:1:1': within }, NOW);
    expect(changed).toBe(false);
    expect(out['1:1:1']).toBe(within);
  });

  it('drops an expired reserved (aa < now)', () => {
    const map = { '1:1:1': dec(DEC_RESERVED, 1, { aa: NOW - 1 }) };
    const { map: out, changed } = compactDecisions(map, NOW);
    expect(changed).toBe(true);
    expect(out).toEqual({});
  });

  it('keeps a reserved whose hold has not yet elapsed', () => {
    const map = { '1:1:1': dec(DEC_RESERVED, 1, { aa: NOW + 1 }) };
    const { changed } = compactDecisions(map, NOW);
    expect(changed).toBe(false);
  });

  it('drops a taken older than TAKEN_TTL', () => {
    const map = { '1:1:1': dec(DEC_TAKEN, NOW - TAKEN_TTL_MS - 1) };
    const { map: out, changed } = compactDecisions(map, NOW);
    expect(changed).toBe(true);
    expect(out).toEqual({});
  });

  it('keeps mine and abandoned forever (they carry f)', () => {
    const map = {
      mine: dec(DEC_MINE, 1, { f: 200 }),
      ab: dec(DEC_ABANDONED, 1, { f: 40 }),
    };
    const { map: out, changed } = compactDecisions(map, NOW);
    expect(changed).toBe(false);
    expect(out).toEqual(map);
  });

  it('returns the SAME map reference when nothing is pruned', () => {
    const map = { '1:1:1': dec(DEC_MINE, 1) };
    expect(compactDecisions(map, NOW).map).toBe(map);
  });
});

describe('blockingCoords', () => {
  const NOW = 10_000_000_000;

  it('always blocks mine / abandoned / taken', () => {
    const map = {
      a: dec(DEC_MINE, 1),
      b: dec(DEC_ABANDONED, 1),
      c: dec(DEC_TAKEN, 1),
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('blocks a sent within arrival + grace, not one past it', () => {
    const map = {
      live: dec(DEC_SENT, 1, { aa: NOW - 1 }), // arrival just passed, grace open
      gone: dec(DEC_SENT, 1, { aa: NOW - SENT_GRACE_MS - 1 }), // grace closed
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['live']));
  });

  it('blocks a sent with no arrival stamp (cannot prove it is done)', () => {
    expect(blockingCoords({ x: dec(DEC_SENT, 1) }, NOW)).toEqual(new Set(['x']));
  });

  it('blocks a reserved still within its hold, not an expired one', () => {
    const map = {
      held: dec(DEC_RESERVED, 1, { aa: NOW + 1 }),
      expired: dec(DEC_RESERVED, 1, { aa: NOW - 1 }),
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['held']));
  });

  it('blocks a reserved with no expiry stamp', () => {
    expect(blockingCoords({ x: dec(DEC_RESERVED, 1) }, NOW)).toEqual(new Set(['x']));
  });

  it('returns an empty set for an empty map', () => {
    expect(blockingCoords({}, NOW)).toEqual(new Set());
  });
});
