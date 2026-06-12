// @ts-check
//
// Pure ownership logic for the fleet1→fleet2 transition (T5): the expedition
// profile heuristic and the completion decision table.

import { describe, it, expect } from 'vitest';
import {
  EXPEDITION_POSITION,
  OWNER_EXP,
  OWNER_COL,
  OWNER_FS,
  isExpeditionCheckTarget,
  resolveFleet2Completion,
} from '../../src/domain/fleetOwnership.js';
import { SHIP_PATHFINDER, SHIP_LARGE_CARGO } from '../../src/domain/rules.js';

describe('isExpeditionCheckTarget', () => {
  it('matches position 16 with at least one Pathfinder', () => {
    expect(
      isExpeditionCheckTarget({
        position: EXPEDITION_POSITION,
        ships: { [SHIP_PATHFINDER]: 1 },
      }),
    ).toBe(true);
    expect(
      isExpeditionCheckTarget({
        position: EXPEDITION_POSITION,
        ships: { [SHIP_PATHFINDER]: 2, [SHIP_LARGE_CARGO]: 500 },
      }),
    ).toBe(true);
  });

  it('rejects any other position even with a Pathfinder aboard', () => {
    expect(
      isExpeditionCheckTarget({ position: 8, ships: { [SHIP_PATHFINDER]: 1 } }),
    ).toBe(false);
  });

  it('rejects position 16 without a Pathfinder (fails closed)', () => {
    expect(
      isExpeditionCheckTarget({
        position: EXPEDITION_POSITION,
        ships: { [SHIP_LARGE_CARGO]: 500 },
      }),
    ).toBe(false);
    expect(
      isExpeditionCheckTarget({ position: EXPEDITION_POSITION, ships: null }),
    ).toBe(false);
    expect(isExpeditionCheckTarget(null)).toBe(false);
  });
});

describe('resolveFleet2Completion', () => {
  const expCt = { position: EXPEDITION_POSITION, ships: { [SHIP_PATHFINDER]: 1 } };
  const transportCt = { position: 8, ships: { [SHIP_LARGE_CARGO]: 100 } };

  it('lets the session owner complete its own fleet2 (re-entry incl.)', () => {
    const session = { owner: OWNER_COL };
    expect(resolveFleet2Completion(session, null, OWNER_COL)).toEqual({
      allowed: true,
      holder: 'self',
    });
  });

  it('blocks every other button while a session is active, naming the holder', () => {
    const session = { owner: OWNER_FS };
    expect(resolveFleet2Completion(session, null, OWNER_COL)).toEqual({
      allowed: false,
      holder: OWNER_FS,
    });
    // Even the expedition button, even when the last checkTarget LOOKS like
    // an expedition — an explicit claim always beats the heuristic.
    expect(resolveFleet2Completion(session, expCt, OWNER_EXP)).toEqual({
      allowed: false,
      holder: OWNER_FS,
    });
  });

  it('session-less expedition profile is adoptable ONLY by the expedition button', () => {
    expect(resolveFleet2Completion(null, expCt, OWNER_EXP)).toEqual({
      allowed: true,
      holder: 'expedition',
    });
    expect(resolveFleet2Completion(null, expCt, OWNER_COL)).toEqual({
      allowed: false,
      holder: 'expedition',
    });
    expect(resolveFleet2Completion(null, expCt, OWNER_FS)).toEqual({
      allowed: false,
      holder: 'expedition',
    });
  });

  it('session-less non-expedition fleet2 is foreign to everyone (manual play)', () => {
    for (const claimant of [OWNER_EXP, OWNER_COL, OWNER_FS]) {
      expect(resolveFleet2Completion(null, transportCt, claimant)).toEqual({
        allowed: false,
        holder: 'unknown',
      });
      expect(resolveFleet2Completion(null, null, claimant)).toEqual({
        allowed: false,
        holder: 'unknown',
      });
    }
  });
});
