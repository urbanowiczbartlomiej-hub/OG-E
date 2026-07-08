// Unit tests for the pure player-metadata projection + merge.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  extractPlayerMeta,
  mergePlayerMeta,
  occupantStrength,
  honorRank,
  sweepStalePlayers,
  PLAYER_SWEEP_AFTER_MS,
} from '../../src/domain/players.js';

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

  it('returns null ONLY when the player is not in the cache (never live-scanned)', () => {
    expect(occupantStrength(null)).toBeNull();
    expect(occupantStrength(undefined)).toBeNull();
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

  it('classifies a live-scanned occupant with no special standing as "normal" (white)', () => {
    expect(occupantStrength(/** @type {any} */ ({ id: 1, name: 'X' }))).toBe('normal'); // no flags object
    expect(occupantStrength(withFlags({}))).toBe('normal');
    expect(occupantStrength(withFlags({ active: true }))).toBe('normal');
    // Active + outlaw but none of the three bands → still a plain attackable target.
    expect(occupantStrength(withFlags({ active: true, outlaw: true }))).toBe('normal');
  });

  it('excludes friends and your own alliance from "normal" (→ null, not a target)', () => {
    expect(occupantStrength(withFlags({ buddy: true }))).toBeNull();
    expect(occupantStrength(withFlags({ allianceMember: true }))).toBeNull();
  });
});

describe('honorRank', () => {
  it('returns null without a rank class', () => {
    expect(honorRank(undefined)).toBeNull();
    expect(honorRank(null)).toBeNull();
    expect(honorRank('')).toBeNull();
  });

  it('parses bandit tiers 1–3 (Bandit / Bandit Lord / Bandit King)', () => {
    expect(honorRank('rank_bandit1')).toEqual({ kind: 'bandit', tier: 1 });
    expect(honorRank('rank_bandit2')).toEqual({ kind: 'bandit', tier: 2 });
    expect(honorRank('rank_bandit3')).toEqual({ kind: 'bandit', tier: 3 });
  });

  it('treats any other rank_* as honoured with its tier', () => {
    expect(honorRank('rank_starlord1')).toEqual({ kind: 'honored', tier: 1 });
    expect(honorRank('rank_general3')).toEqual({ kind: 'honored', tier: 3 });
  });

  it('falls back to tier 1 for an unknown variant', () => {
    expect(honorRank('rank_bandit')).toEqual({ kind: 'bandit', tier: 1 });
  });
});

describe('sweepStalePlayers — hydrate-time retention', () => {
  const NOW = 1_700_000_000_000;
  /** @param {number} id @param {number | null} seenAgoMs */
  const meta = (id, seenAgoMs) => ({
    id,
    name: `P${id}`,
    ...(seenAgoMs !== null ? { seenAt: NOW - seenAgoMs } : {}),
  });

  it('drops records older than the horizon, keeps fresh ones', () => {
    const cache = {
      1: meta(1, 1000), // fresh
      2: meta(2, PLAYER_SWEEP_AFTER_MS + 1000), // stale
    };
    const out = sweepStalePlayers(cache, NOW, []);
    expect(Object.keys(out)).toEqual(['1']);
  });

  it('watched players survive regardless of age (dossiers read them forever)', () => {
    const cache = { 2: meta(2, PLAYER_SWEEP_AFTER_MS + 1000) };
    const out = sweepStalePlayers(cache, NOW, ['2']);
    expect(out[2]).toBe(cache[2]);
    // Numeric watched ids are tolerated (watchList keeps strings).
    expect(sweepStalePlayers(cache, NOW, [2])[2]).toBe(cache[2]);
  });

  it('a record with no seenAt has no age to defend itself with → dropped', () => {
    const out = sweepStalePlayers({ 3: meta(3, null) }, NOW, []);
    expect(out).toEqual({});
  });

  it('returns the input BY REFERENCE when nothing was dropped', () => {
    const cache = { 1: meta(1, 1000) };
    expect(sweepStalePlayers(cache, NOW, [])).toBe(cache);
  });
});
