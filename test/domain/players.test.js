// Unit tests for the pure player-metadata projection + merge.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { extractPlayerMeta, mergePlayerMeta } from '../../src/domain/players.js';

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
