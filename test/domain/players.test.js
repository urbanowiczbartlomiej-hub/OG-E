// Unit tests for the pure player-metadata projection + merge.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { extractPlayerMeta, mergePlayerMeta, occupantStrength } from '../../src/domain/players.js';

// A realistic occupied-slot player block (the live fields we read; this is
// the HAR's slot-8 case: rank-11 starlord, active but on vacation).
const fullPlayer = {
  playerId: 119875,
  playerName: 'UP4DLY',
  allianceId: 500,
  allianceName: 'Klan',
  allianceTag: '2040',
  isAllianceMember: false,
  rank: { hasRank: true, rankTitle: 'x', rankClass: 'rank_starlord1' },
  highscorePositionPlayer: 11,
  highscorePositionAlliance: 4,
  isAdmin: false,
  isActive: true,
  isBanned: false,
  isOnVacation: true,
  isLongInactive: false,
  isInactive: false,
  isOutlaw: false,
  isNewbie: false,
  isStrong: false,
  isBuddy: false,
  isHonorableTarget: false,
};

describe('extractPlayerMeta', () => {
  it('returns null for the deep-space sentinel (id 99999)', () => {
    expect(extractPlayerMeta({ playerId: 99999, playerName: 'Bezgraniczna' })).toBeNull();
  });

  it('returns null for a missing / id-less player', () => {
    expect(extractPlayerMeta(null)).toBeNull();
    expect(extractPlayerMeta({ playerName: 'x' })).toBeNull();
  });

  it('projects id, name, rank, rankClass, alliance and only-true flags', () => {
    const m = /** @type {any} */ (extractPlayerMeta(fullPlayer));
    expect(m).toMatchObject({
      id: 119875,
      name: 'UP4DLY',
      rank: 11,
      rankClass: 'rank_starlord1',
      ally: { tag: '2040', name: 'Klan', id: 500, rank: 4 },
    });
    expect(m.flags).toEqual({ active: true, vacation: true });
  });

  it('omits rank/rankClass/ally/flags when the payload lacks them', () => {
    const m = extractPlayerMeta({
      playerId: 1,
      playerName: 'Bob',
      rank: { hasRank: false, rankClass: '' },
      highscorePositionPlayer: 0,
      allianceId: 0,
      allianceTag: '',
    });
    expect(m).toEqual({ id: 1, name: 'Bob' });
  });

  it('flags allianceMember when the player is in our alliance', () => {
    const m = /** @type {any} */ (
      extractPlayerMeta({ playerId: 2, playerName: 'Ally', isAllianceMember: true })
    );
    expect(m.flags).toEqual({ allianceMember: true });
  });

  it('captures bandit / outlaw / strong signals', () => {
    const m = /** @type {any} */ (extractPlayerMeta({
      playerId: 3,
      playerName: 'Raider',
      rank: { hasRank: true, rankClass: 'rank_bandit2' },
      isActive: true,
      isStrong: true,
      isOutlaw: true,
      isHonorableTarget: true,
    }));
    expect(m.rankClass).toBe('rank_bandit2');
    expect(m.flags).toEqual({ active: true, strong: true, outlaw: true, honorable: true });
  });
});

describe('mergePlayerMeta', () => {
  it('stamps seenAt when there is no existing record', () => {
    expect(mergePlayerMeta(undefined, { id: 1, name: 'A' }, 100)).toEqual({
      id: 1, name: 'A', seenAt: 100,
    });
  });

  it('replaces an older record (newest-wins)', () => {
    const old = { id: 1, name: 'A', seenAt: 100 };
    expect(mergePlayerMeta(old, { id: 1, name: 'A2' }, 200)).toEqual({
      id: 1, name: 'A2', seenAt: 200,
    });
  });

  it('keeps the existing record (by reference) when the sighting is stale', () => {
    const old = { id: 1, name: 'A', seenAt: 200 };
    expect(mergePlayerMeta(old, { id: 1, name: 'A2' }, 100)).toBe(old);
  });

  it('treats an equal timestamp as newest-wins', () => {
    const old = { id: 1, name: 'A', seenAt: 100 };
    expect(mergePlayerMeta(old, { id: 1, name: 'A2' }, 100)).toEqual({
      id: 1, name: 'A2', seenAt: 100,
    });
  });
});

describe('occupantStrength', () => {
  /** @param {object} flags @returns {any} */
  const withFlags = (flags) => ({ id: 1, name: 'X', flags });

  it('returns null without a record or without flags', () => {
    expect(occupantStrength(null)).toBeNull();
    expect(occupantStrength(undefined)).toBeNull();
    expect(occupantStrength(/** @type {any} */ ({ id: 1, name: 'X' }))).toBeNull();
    expect(occupantStrength(withFlags({}))).toBeNull();
    // An active occupant inside your bracket but unflagged stays unclassified.
    expect(occupantStrength(withFlags({ active: true, outlaw: true }))).toBeNull();
  });

  it('maps newbie → weak, honorable → honorable, strong → strong', () => {
    expect(occupantStrength(withFlags({ newbie: true }))).toBe('weak');
    expect(occupantStrength(withFlags({ honorable: true }))).toBe('honorable');
    expect(occupantStrength(withFlags({ strong: true }))).toBe('strong');
  });

  it('checks weakest-first, then strong before honorable', () => {
    // A newbie can never be strong/honorable, but if the game ever sets both,
    // the protected (weak) band wins.
    expect(occupantStrength(withFlags({ newbie: true, strong: true }))).toBe('weak');
    // A much-stronger player is often ALSO an honorable target — surface the
    // more cautionary "strong".
    expect(occupantStrength(withFlags({ strong: true, honorable: true }))).toBe('strong');
  });
});
