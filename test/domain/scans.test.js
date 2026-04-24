// Unit tests for the scan-domain helpers.
//
// Pure logic, Node environment — no DOM, no timers, no fake `Date.now()`.
// `classifyPosition` is a one-shot projection so every case is a single
// input → expected-output comparison. `mergeScanResult` deals in three
// inputs (old snapshot, fresh scan, pending-fleet set) and one derived
// `systemKey`, so tests vary those axes independently.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { classifyPosition, mergeScanResult } from '../../src/domain/scans.js';

describe('classifyPosition', () => {
  it('returns empty status for a slot with no planets and no player', () => {
    // Truly empty slot — no planets array entries, no owner, no debris.
    // Must not attach a `player` or `flags` block (nothing to flag on).
    const result = classifyPosition({ position: 8, planets: [] }, 123);
    expect(result).toEqual({ status: 'empty' });
  });

  it('treats missing planets array as empty (defensive)', () => {
    // Some payload variants omit the `planets` key entirely rather
    // than sending `[]`. Both shapes must resolve identically.
    const result = classifyPosition({ position: 8 }, 123);
    expect(result).toEqual({ status: 'empty' });
  });

  it('classifies destroyed-only remnants as abandoned with the flag set', () => {
    // All planets destroyed → no live planet, but the remnant counts
    // as an observable scar → 'abandoned' (not plain 'empty') and the
    // hasAbandonedPlanet flag rides along so the target-picker knows
    // the slot isn't pristine.
    const result = classifyPosition(
      { position: 8, planets: [{ isDestroyed: true }] },
      123,
    );
    expect(result).toEqual({
      status: 'abandoned',
      flags: { hasAbandonedPlanet: true },
    });
  });

  it('returns mine (no player block) when the live colony is ours', () => {
    // Our own colony — status collapses to 'mine' and we deliberately
    // DO NOT echo our own player id/name back into the scan result.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 123, playerName: 'me' },
      },
      123,
    );
    expect(result).toEqual({ status: 'mine' });
  });

  it('classifies a plain other-player colony as occupied with player block', () => {
    // Vanilla occupied slot: live planet, active non-admin non-banned
    // non-vacation player. Player block MUST be present — downstream
    // UI shows the owner name next to the coord.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 99, playerName: 'Bob' },
      },
      123,
    );
    expect(result).toEqual({
      status: 'occupied',
      player: { id: 99, name: 'Bob' },
    });
  });

  it('tags a standalone isInactive player as inactive', () => {
    // `i` flag only — no long-inactive escalation. Player carried.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 99, playerName: 'Bob', isInactive: true },
      },
      123,
    );
    expect(result).toEqual({
      status: 'inactive',
      player: { id: 99, name: 'Bob' },
    });
  });

  it('prefers long_inactive over inactive when both flags are set', () => {
    // The game sets `isInactive=true` on every inactive account AND
    // ALSO sets `isLongInactive=true` on the stricter subset. Our
    // ordering must pick the stricter bucket first or we'd misreport
    // long-dormant colonies as plain inactive.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: {
          playerId: 99,
          playerName: 'Bob',
          isInactive: true,
          isLongInactive: true,
        },
      },
      123,
    );
    expect(result).toEqual({
      status: 'long_inactive',
      player: { id: 99, name: 'Bob' },
    });
  });

  it('classifies an on-vacation owner as vacation', () => {
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 99, playerName: 'Bob', isOnVacation: true },
      },
      123,
    );
    expect(result).toEqual({
      status: 'vacation',
      player: { id: 99, name: 'Bob' },
    });
  });

  it('classifies a banned owner as banned', () => {
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 99, playerName: 'Bob', isBanned: true },
      },
      123,
    );
    expect(result).toEqual({
      status: 'banned',
      player: { id: 99, name: 'Bob' },
    });
  });

  it('classifies an admin owner as admin', () => {
    // Admin wins over any other flag — they're never a real target.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{}],
        player: { playerId: 99, playerName: 'GM', isAdmin: true },
      },
      123,
    );
    expect(result).toEqual({
      status: 'admin',
      player: { id: 99, name: 'GM' },
    });
  });

  it('computes flags independently of status (moon + debris + ally + occupied)', () => {
    // Proves the flag block is assembled independently: status is
    // plain 'occupied', but the slot still carries three flags.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{ isMoon: true, debris: {} }],
        player: { playerId: 99, playerName: 'Bob', allyId: 42 },
      },
      123,
    );
    expect(result).toEqual({
      status: 'occupied',
      player: { id: 99, name: 'Bob' },
      flags: {
        hasMoon: true,
        hasDebris: true,
        inAlliance: true,
      },
    });
  });

  it('picks the live planet when destroyed remnants coexist with a live one', () => {
    // Mixed slot: one destroyed planet + one live planet. Live wins
    // for status ('occupied'), but hasAbandonedPlanet still flags the
    // remnant so the overlay can paint the d-marker.
    const result = classifyPosition(
      {
        position: 8,
        planets: [{ isDestroyed: true }, {}],
        player: { playerId: 99, playerName: 'Bob' },
      },
      123,
    );
    expect(result).toEqual({
      status: 'occupied',
      player: { id: 99, name: 'Bob' },
      flags: { hasAbandonedPlanet: true },
    });
  });
});

describe('mergeScanResult', () => {
  // Concise fixture builders — reading `S.occupied(99)` in a test body
  // is much easier to follow than an inline object literal. Each
  // helper returns a fresh object so test mutation (e.g. the
  // no-mutation case) can't contaminate a sibling test.
  const S = {
    /** @returns {import('../../src/domain/scans.js').Position} */
    empty: () => ({ status: 'empty' }),
    /** @returns {import('../../src/domain/scans.js').Position} */
    emptySent: () => ({ status: 'empty_sent' }),
    /** @returns {import('../../src/domain/scans.js').Position} */
    mine: () => ({ status: 'mine' }),
    /**
     * @param {number} id
     * @returns {import('../../src/domain/scans.js').Position}
     */
    occupied: (id) => ({
      status: 'occupied',
      player: { id, name: `p${id}` },
    }),
    /** @returns {import('../../src/domain/scans.js').Position} */
    abandoned: () => ({
      status: 'abandoned',
      flags: { hasAbandonedPlanet: true },
    }),
  };

  it('returns a copy of fresh when no existing snapshot is provided', () => {
    // First-scan fast path: undefined existingPositions → the merge
    // is a no-op and the output equals the fresh input (but is a new
    // object so later mutations don't bleed back to the caller's fresh).
    const fresh = { 1: S.empty(), 8: S.occupied(99) };
    const result = mergeScanResult(undefined, fresh, new Set(), '4:30');

    expect(result).toEqual(fresh);
    expect(result).not.toBe(fresh);
  });

  it('preserves empty_sent when fresh still shows empty and fleet is pending', () => {
    // Happy path for the carve-out: we stamped the slot, the game
    // doesn't see our fleet yet, and the registry confirms the fleet
    // is still en route → keep our marker, don't let 'empty' win.
    const existing = { 8: S.emptySent(), 9: S.empty() };
    const fresh = { 8: S.empty(), 9: S.empty() };
    const pending = new Set(['4:30:8']);

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result[8]).toEqual({ status: 'empty_sent' });
    expect(result[9]).toEqual({ status: 'empty' });
  });

  it('lets fresh empty win when the pending-fleet registry no longer lists the slot', () => {
    // Registry dropped the slot (fleet arrived, was recalled, or
    // cleanup ran). No longer our business to override the scan —
    // fresh 'empty' wins so the target-picker can re-consider it.
    const existing = { 8: S.emptySent() };
    const fresh = { 8: S.empty() };
    const pending = new Set(); // empty — no pending fleet here

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result[8]).toEqual({ status: 'empty' });
  });

  it('lets fresh mine overwrite an old empty_sent (fleet has landed)', () => {
    // Best-case outcome: our fleet landed, game now reports a colony
    // owned by us. The fresh 'mine' is authoritative even though the
    // registry might still list the slot (registry cleanup is async).
    const existing = { 8: S.emptySent() };
    const fresh = { 8: S.mine() };
    const pending = new Set(['4:30:8']);

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result[8]).toEqual({ status: 'mine' });
  });

  it('lets fresh occupied overwrite an old empty_sent (someone else colonized)', () => {
    // Bad-case outcome: a competitor beat us to the slot. Fresh
    // 'occupied' wins so the UI reflects reality; the registry
    // entry will age out via its own cleanup path.
    const existing = { 8: S.emptySent() };
    const fresh = { 8: S.occupied(77) };
    const pending = new Set(['4:30:8']);

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result[8]).toEqual({
      status: 'occupied',
      player: { id: 77, name: 'p77' },
    });
  });

  it('lets fresh empty overwrite an old occupied (owner abandoned the colony)', () => {
    // Observable change in-game: a previously-occupied slot is now
    // empty (owner deleted / got deleted). Fresh always wins for
    // observable state — no special handling needed.
    const existing = { 8: S.occupied(99) };
    const fresh = { 8: S.empty() };
    const pending = new Set();

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result[8]).toEqual({ status: 'empty' });
  });

  it('merges many positions at once with the carve-out only on the matching slot', () => {
    // Compound case exercising all three axes simultaneously:
    //   pos 8 — preserved (empty_sent + empty + pending)
    //   pos 9 — fresh wins (empty → empty, no preservation needed)
    //   pos 10 — fresh wins (occupied shifts owner)
    //   pos 11 — fresh wins (empty_sent but registry doesn't confirm)
    const existing = {
      8: S.emptySent(),
      9: S.empty(),
      10: S.occupied(11),
      11: S.emptySent(), // no pending entry for this one
    };
    const fresh = {
      8: S.empty(),
      9: S.empty(),
      10: S.occupied(22),
      11: S.empty(),
    };
    const pending = new Set(['4:30:8']); // only slot 8 is pending

    const result = mergeScanResult(existing, fresh, pending, '4:30');

    expect(result).toEqual({
      8: { status: 'empty_sent' },
      9: { status: 'empty' },
      10: { status: 'occupied', player: { id: 22, name: 'p22' } },
      11: { status: 'empty' },
    });
  });

  it('does not mutate existingPositions or freshPositions', () => {
    // Snapshot both inputs before calling, then deep-compare after.
    // The merge is shallow — we replace entries on a fresh copy —
    // so neither input must see any change. Regression guard against
    // a future "optimization" that writes into the inputs.
    const existing = { 8: S.emptySent(), 9: S.occupied(11) };
    const fresh = { 8: S.empty(), 9: S.empty() };
    const pending = new Set(['4:30:8']);

    const existingBefore = structuredClone(existing);
    const freshBefore = structuredClone(fresh);

    mergeScanResult(existing, fresh, pending, '4:30');

    expect(existing).toEqual(existingBefore);
    expect(fresh).toEqual(freshBefore);
  });
});
