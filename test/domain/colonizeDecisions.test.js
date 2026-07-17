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
  SENT_UNCONFIRMED_TTL_MS,
  ABANDON_MIN_HOLD_MS,
  ABANDON_CLEANUP_HOUR,
  RESERVE_HOLD_MS,
  TAKEN_TTL_MS,
  mergeDecision,
  withDecision,
  mergeColonizeDecisions,
  compactDecisions,
  blockingCoords,
  freedCoords,
  clearFreedAbandoned,
  abandonRecolonizableAt,
  sentExpiresAt,
} from '../../src/domain/colonizeDecisions.js';

/** Epoch-ms of a recent, still-blocking moment relative to a `now`. */
const HOUR = 60 * 60 * 1000;

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
    expect(SENT_UNCONFIRMED_TTL_MS).toBe(4 * 60 * 60 * 1000);
    expect(ABANDON_MIN_HOLD_MS).toBe(24 * 60 * 60 * 1000);
    expect(ABANDON_CLEANUP_HOUR).toBe(3);
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

  it('keeps a past-expiry sent (freed override, not pruned)', () => {
    // Compaction no longer drops a no-show sent — freedCoords surfaces it as a
    // "free again" override of the sticky empty_sent scan remnant, so pruning
    // it would silently re-hide the freed slot.
    const gone = dec(DEC_SENT, 1, { aa: NOW - SENT_GRACE_MS - 1 });
    const { map: out, changed } = compactDecisions({ '1:1:1': gone }, NOW);
    expect(changed).toBe(false);
    expect(out['1:1:1']).toBe(gone);
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

  it('always blocks mine / taken', () => {
    const map = { a: dec(DEC_MINE, 1), c: dec(DEC_TAKEN, 1) };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['a', 'c']));
  });

  it('blocks an abandoned only within its re-colonization window', () => {
    const map = {
      held: dec(DEC_ABANDONED, NOW), // just given up → still held
      freed: dec(DEC_ABANDONED, 1), // ancient → game has long since freed it
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['held']));
  });

  it('blocks a sent within arrival + grace, not one past both windows', () => {
    const map = {
      live: dec(DEC_SENT, NOW, { aa: NOW - 1 }), // arrival passed, grace + 4h floor open
      gone: dec(DEC_SENT, 1, { aa: NOW - SENT_GRACE_MS - 1 }), // grace + 4h floor closed
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['live']));
  });

  it('blocks a no-arrival-stamp sent within the dispatch floor, not past it', () => {
    const map = {
      recent: dec(DEC_SENT, NOW - HOUR), // dispatched 1h ago, < 4h floor → still blocks
      stale: dec(DEC_SENT, NOW - SENT_UNCONFIRMED_TTL_MS - 1), // past 4h floor → freed
    };
    expect(blockingCoords(map, NOW)).toEqual(new Set(['recent']));
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

describe('abandonRecolonizableAt', () => {
  it('is at least 24h after give-up and lands on the 03:00 cleanup', () => {
    // Local-clock based (like the game's day boundary): assert the invariants
    // that hold in ANY timezone — ≥ ts + 24h, and a 03:00 local wall time.
    const ts = new Date(2026, 5, 10, 13, 0, 0).getTime(); // 13:00 local
    const at = abandonRecolonizableAt(ts);
    expect(at).toBeGreaterThanOrEqual(ts + ABANDON_MIN_HOLD_MS);
    expect(new Date(at).getHours()).toBe(ABANDON_CLEANUP_HOUR);
    expect(new Date(at).getMinutes()).toBe(0);
    // Never more than 24h + a full day past give-up (the next-day roll cap).
    expect(at).toBeLessThan(ts + ABANDON_MIN_HOLD_MS + 24 * HOUR);
  });

  it('rolls to the next day when +24h lands after 03:00', () => {
    const early = new Date(2026, 5, 10, 1, 0, 0).getTime(); // 01:00 → +24h = 01:00, 03:00 same day
    const late = new Date(2026, 5, 10, 5, 0, 0).getTime(); // 05:00 → +24h = 05:00, 03:00 rolls a day
    expect(abandonRecolonizableAt(late) - abandonRecolonizableAt(early)).toBe(24 * HOUR);
  });
});

describe('sentExpiresAt', () => {
  it('takes the LATER of arrival+grace and dispatch+floor', () => {
    // Near target: dispatch floor dominates.
    const near = dec(DEC_SENT, 1000, { aa: 1000 + 10 * 60 * 1000 }); // arrival 10 min out
    expect(sentExpiresAt(near)).toBe(1000 + SENT_UNCONFIRMED_TTL_MS);
    // Distant target: arrival+grace dominates (never free a still-inbound fleet).
    const far = dec(DEC_SENT, 1000, { aa: 1000 + 6 * HOUR });
    expect(sentExpiresAt(far)).toBe(1000 + 6 * HOUR + SENT_GRACE_MS);
  });

  it('falls back to the dispatch floor when arrival is unknown', () => {
    expect(sentExpiresAt(dec(DEC_SENT, 5000))).toBe(5000 + SENT_UNCONFIRMED_TTL_MS);
  });
});

describe('freedCoords', () => {
  const NOW = 10_000_000_000;

  it('surfaces past-window abandons and past-expiry sends, nothing else', () => {
    const map = {
      abFreed: dec(DEC_ABANDONED, 1), // ancient → freed
      abHeld: dec(DEC_ABANDONED, NOW), // just given up → still held
      sentFreed: dec(DEC_SENT, 1, { aa: 2 }), // long past both windows
      sentLive: dec(DEC_SENT, NOW, { aa: NOW + HOUR }), // inbound
      mine: dec(DEC_MINE, 1),
      taken: dec(DEC_TAKEN, 1),
    };
    expect(freedCoords(map, NOW)).toEqual(new Set(['abFreed', 'sentFreed']));
  });

  it('is empty for an empty map', () => {
    expect(freedCoords({}, NOW)).toEqual(new Set());
  });
});

describe('clearFreedAbandoned', () => {
  const NOW = 10_000_000_000;

  it('drops a past-window abandoned entry so a fresh send can land', () => {
    const map = { '1:1:1': dec(DEC_ABANDONED, 1, { f: 40 }) };
    expect(clearFreedAbandoned(map, '1:1:1', NOW)).toEqual({});
  });

  it('is a no-op (same ref) for a still-held abandoned', () => {
    const map = { '1:1:1': dec(DEC_ABANDONED, NOW) };
    expect(clearFreedAbandoned(map, '1:1:1', NOW)).toBe(map);
  });

  it('is a no-op for a non-abandoned decision or a missing coord', () => {
    const map = { '1:1:1': dec(DEC_MINE, 1) };
    expect(clearFreedAbandoned(map, '1:1:1', NOW)).toBe(map);
    expect(clearFreedAbandoned(map, '9:9:9', NOW)).toBe(map);
  });
});
