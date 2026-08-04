// @ts-check
//
// Unit tests for the per-player danger model (domain/dangerScore.js). Pure
// function over plain feed data — node env, no DOM. We assert documented
// PROPERTIES (friendly → 0, 0 ships → 0, ships/spy bounds, provenance, the
// E4 stale-spy guard, bandit/predator/dispersion signals, labels) rather
// than hand-computed danger floats, so the tests pin behaviour, not arithmetic.

import { describe, it, expect } from 'vitest';
import {
  buildDangerProfiles, DANGER_LABELS, combatQuality, isMinerProfile,
} from '../../src/domain/dangerScore.js';

/**
 * Non-null get helper — the profile is always present for a fed id.
 * @param {ReturnType<typeof buildDangerProfiles>} map
 * @param {number} id
 */
const prof = (map, id) => {
  const p = map.get(id);
  if (!p) throw new Error(`no profile for ${id}`);
  return p;
};

describe('buildDangerProfiles — friendly exclusion', () => {
  it('own-alliance player (tag match) → danger 0, friendly, label friendly', () => {
    const p = prof(buildDangerProfiles({
      military: { '5': { score: 5_000_000, ships: 500 } },
      apiPlayers: { '5': { alliance: 'A1' } },
      ownAlliance: 'A1',
      ownMilitary: 1_000_000,
    }), 5);
    expect(p.friendly).toBe(true);
    expect(p.danger).toBe(0);
    expect(p.label).toBe('friendly');
    expect(p.provenance).toBe('prior');
    expect(p.mobileMil).toBe(0);
  });

  it('buddy flag → danger 0, friendly (whatever the military)', () => {
    const p = prof(buildDangerProfiles({
      military: { '6': { score: 9_000_000, ships: 9000 } },
      players: { 6: /** @type {any} */ ({ id: 6, name: 'B', flags: { buddy: true } }) },
      ownMilitary: 1_000_000,
    }), 6);
    expect(p.friendly).toBe(true);
    expect(p.danger).toBe(0);
  });
});

describe('buildDangerProfiles — the 0-ships hard floor', () => {
  it('0 ships → mobile 0, danger 0, turtle (a defensive whale cannot attack)', () => {
    const p = prof(buildDangerProfiles({
      military: { '7': { score: 8_000_000, ships: 0 } },
      ownMilitary: 1_000_000,
    }), 7);
    expect(p.ships).toBe(0);
    expect(p.mobileMil).toBe(0);
    expect(p.mobileLo).toBe(0);
    expect(p.mobileHi).toBe(0);
    expect(p.danger).toBe(0);
    expect(p.provenance).toBe('ships');
    expect(p.label).toBe('turtle');
  });

  it('0 ships + bandit rank → still danger 0, label declawed', () => {
    const p = prof(buildDangerProfiles({
      military: { '9': { score: 8_000_000, ships: 0 } },
      players: { 9: /** @type {any} */ ({ id: 9, name: 'X', rankClass: 'rank_bandit3' }) },
      ownMilitary: 1_000_000,
    }), 9);
    expect(p.banditTier).toBe(3);
    expect(p.danger).toBe(0);
    expect(p.label).toBe('declawed');
  });
});

describe('buildDangerProfiles — ships-bounded mobile military', () => {
  it('ships > 0, no spy → provenance ships, lo = ship floor, hi = military, mobile within', () => {
    const p = prof(buildDangerProfiles({
      military: { '10': { score: 2_000_000, ships: 5000 } },
      ownMilitary: 1_000_000,
    }), 10);
    expect(p.provenance).toBe('ships');
    expect(p.ships).toBe(5000);
    expect(p.mobileLo).toBe(5000);          // >= 1 pt/ship
    expect(p.mobileHi).toBe(2_000_000);     // = military (score > floor)
    expect(p.mobileMil).toBeGreaterThanOrEqual(p.mobileLo);
    expect(p.mobileMil).toBeLessThanOrEqual(p.mobileHi);
    expect(p.danger).toBeGreaterThan(0);
  });

  it('feed carries NO ships attribute → provenance prior, ships undefined', () => {
    const p = prof(buildDangerProfiles({
      military: { '40': { score: 2_000_000 } },
      ownMilitary: 1_000_000,
    }), 40);
    expect(p.provenance).toBe('prior');
    expect(p.ships).toBeUndefined();
    expect(p.mobileHi).toBe(2_000_000);
    expect(p.reasons.some((r) => /no ship count/.test(r))).toBe(true);
  });
});

describe('buildDangerProfiles — spy refinement', () => {
  it('complete + consistent spy → EXACT (mobile = military − defence), provenance spied', () => {
    const p = prof(buildDangerProfiles({
      military: { '11': { score: 1_000_000, ships: 2000 } },
      spied: { '11': { defensePts: 400_000, coverageComplete: true, spiedCount: 4, planetCount: 4 } },
      ownMilitary: 1_000_000,
    }), 11);
    expect(p.provenance).toBe('spied');
    expect(p.mobileMil).toBe(600_000);      // 1_000_000 − 400_000
    expect(p.mobileLo).toBe(600_000);
    expect(p.mobileHi).toBe(600_000);
    expect(p.reasons.some((r) => /exact fleet/.test(r))).toBe(true);
  });

  it('E4: complete-but-STALE spy implying LESS fleet than the ship floor stays provenance ships, not spied', () => {
    const p = prof(buildDangerProfiles({
      // 100k ships prove a live fleet; a stale complete spy says defence is
      // 480k of 500k → 20k mobile, BELOW the 100k ship floor. Trusting it
      // would read the fleeter as ~0 while claiming exactness — the unsafe lie.
      military: { '12': { score: 500_000, ships: 100_000 } },
      spied: { '12': { defensePts: 480_000, coverageComplete: true, spiedCount: 3, planetCount: 3 } },
      ownMilitary: 1_000_000,
    }), 12);
    expect(p.provenance).toBe('ships');     // NOT 'spied'
    expect(p.provenance).not.toBe('spied');
  });
});

describe('buildDangerProfiles — bandit / predator / dispersion signals', () => {
  it('bandit rank adds a danger bonus over an otherwise identical player, and labels raider', () => {
    const base = { military: { '13': { score: 3_000_000, ships: 8000 } }, ownMilitary: 1_000_000 };
    const plain = prof(buildDangerProfiles(base), 13);
    const bandit = prof(buildDangerProfiles({
      ...base,
      players: { 13: /** @type {any} */ ({ id: 13, name: 'R', rankClass: 'rank_bandit1' }) },
    }), 13);
    expect(bandit.banditTier).toBe(1);
    expect(bandit.danger).toBeGreaterThan(plain.danger);
    expect(bandit.label).toBe('raider');
  });

  it('bandit tier is synthesised from the honour highscore (no live player meta)', () => {
    const p = prof(buildDangerProfiles({
      military: { '50': { score: 3_000_000, ships: 6000 } },
      honor: { '50': { position: 995, score: -20_000 } }, // bottom-N + deep negative
      honorTotal: 1000,
      ownMilitary: 1_000_000,
    }), 50);
    expect(p.banditTier).toBe(3);
  });

  it('lifetime kills (top destroyed percentile) raise predator + danger vs an identical no-kills base', () => {
    /** @type {Record<string,{score:number,ships:number}>} */
    const military = {};
    for (let i = 1; i <= 10; i++) military[String(100 + i)] = { score: 1_000_000, ships: 3000 };
    military['200'] = { score: 1_000_000, ships: 3000 };
    const map = buildDangerProfiles({
      military,
      destroyed: { '200': { score: 5_000_000_000 }, '101': { score: 1000 }, '102': { score: 2000 } },
      ownMilitary: 1_000_000,
    });
    const hunter = prof(map, 200);
    const plain = prof(map, 101);
    expect(hunter.destroyed).toBe(5_000_000_000);
    expect(hunter.predator).toBeGreaterThan(0);
    expect(hunter.danger).toBeGreaterThan(plain.danger);
  });

  it('planet dispersion across galaxies lifts the mobility prior (scattered > clustered)', () => {
    const military = { '30': { score: 2_000_000, ships: 4000 } };
    const clustered = prof(buildDangerProfiles({
      military, ownMilitary: 1_000_000,
      universePlanets: [{ coords: '1:1:1', player: 30 }, { coords: '1:2:1', player: 30 }],
    }), 30);
    const scattered = prof(buildDangerProfiles({
      military, ownMilitary: 1_000_000,
      universePlanets: [
        { coords: '1:1:1', player: 30 }, { coords: '2:1:1', player: 30 },
        { coords: '3:1:1', player: 30 }, { coords: '4:1:1', player: 30 },
      ],
    }), 30);
    expect(scattered.mobileMil).toBeGreaterThan(clustered.mobileMil);
  });
});

describe('isMinerProfile — the huddled counter-signature', () => {
  const military = { '30': { score: 2_000_000, ships: 4000 } };

  it('flags an empire packed into one galaxy, and exposes the geometry it read', () => {
    const p = prof(buildDangerProfiles({
      military,
      ownMilitary: 1_000_000,
      universePlanets: [
        { coords: '1:100:4', player: 30 },
        { coords: '1:105:6', player: 30 },
        { coords: '1:110:8', player: 30 },
        { coords: '1:112:9', player: 30 },
      ],
    }), 30);
    expect(p.spread).toBe(0);
    expect(p.galaxies).toBe(1);
    expect(p.planetCount).toBe(4);
    expect(isMinerProfile(p)).toBe(true);
    expect(p.reasons.some((r) => r.includes('huddled empire'))).toBe(true);
  });

  it('does NOT flag the server-wide aggressor it is the mirror of', () => {
    const p = prof(buildDangerProfiles({
      military,
      ownMilitary: 1_000_000,
      universePlanets: [
        { coords: '1:1:1', player: 30 }, { coords: '2:200:1', player: 30 },
        { coords: '3:300:1', player: 30 }, { coords: '4:400:1', player: 30 },
      ],
    }), 30);
    expect(p.spread).toBe(1);
    expect(isMinerProfile(p)).toBe(false);
  });

  it('needs at least 3 planets — a two-planet start is not a "miner"', () => {
    const p = prof(buildDangerProfiles({
      military,
      ownMilitary: 1_000_000,
      universePlanets: [{ coords: '1:100:4', player: 30 }, { coords: '1:101:5', player: 30 }],
    }), 30);
    expect(p.planetCount).toBe(2);
    expect(isMinerProfile(p)).toBe(false);
  });

  it('rejects a dense pocket inside a wide footprint (more than 2 galaxies)', () => {
    expect(isMinerProfile({ spread: 0, galaxies: 3, planetCount: 9 })).toBe(false);
  });

  it('says false rather than guessing when the geometry is unknown', () => {
    expect(isMinerProfile(undefined)).toBe(false);
    expect(isMinerProfile({ galaxies: 1, planetCount: 9 })).toBe(false);
  });
});

describe('buildDangerProfiles — coverage of the id set', () => {
  it('an honour-only player (absent from the military feed) still gets a profile', () => {
    const map = buildDangerProfiles({
      military: { '50': { score: 1000, ships: 10 } },
      honor: { '60': { position: 5, score: 20_000 } },
      honorTotal: 100,
      ownMilitary: 1_000_000,
    });
    const p = prof(map, 60);
    expect(p.friendly).toBe(false);
    expect(p.mobileMil).toBe(0);
    expect(p.ships).toBeUndefined();
  });
});

describe('DANGER_LABELS', () => {
  it('maps every DangerLabel to a human string', () => {
    expect(Object.keys(DANGER_LABELS).sort()).toEqual(
      ['apex', 'cargo', 'declawed', 'eco', 'fleeter', 'fortress', 'friendly', 'raider', 'turtle', 'unknown'].sort(),
    );
    for (const v of Object.values(DANGER_LABELS)) expect(typeof v).toBe('string');
  });
});

describe('buildDangerProfiles — warrior-alliance tell from the highscore harvest', () => {
  /** Base feed: one active, un-spied player (id 20) in alliance 500921. */
  const base = () => ({
    military: { '20': { score: 5_000_000, ships: 500 } },
    apiPlayers: { '20': { alliance: '500921' } },
    ownMilitary: 1_000_000,
  });

  it('warrior class from the harvest lights the tell (no spy report needed)', () => {
    const p = prof(buildDangerProfiles({
      ...base(),
      allianceClasses: { '500921': 'warrior' },
    }), 20);
    expect(p.allianceId).toBe('500921');
    expect(p.allianceClass).toBe('warrior');
    expect(p.reasons).toContain('warrior-class alliance (combat bonuses)');
  });

  it('a harvested "none" is KNOWN-not-warrior — carried, tell dark, no warrior reason', () => {
    const p = prof(buildDangerProfiles({
      ...base(),
      allianceClasses: { '500921': 'none' },
    }), 20);
    expect(p.allianceClass).toBe('none');
    expect(p.reasons).not.toContain('warrior-class alliance (combat bonuses)');
  });

  it('never harvested → allianceClass undefined (drives the unknown-class hint), tell dark', () => {
    const p = prof(buildDangerProfiles({ ...base() }), 20);
    expect(p.allianceId).toBe('500921');
    expect(p.allianceClass).toBeUndefined();
    expect(p.reasons).not.toContain('warrior-class alliance (combat bonuses)');
  });

  it('falls back to a spy report\'s alliance class when the harvest lacks it', () => {
    const p = prof(buildDangerProfiles({
      ...base(),
      spied: { '20': { defensePts: 0, coverageComplete: false, spiedCount: 1, allianceClass: 'warrior' } },
    }), 20);
    expect(p.allianceClass).toBe('warrior');
    expect(p.reasons).toContain('warrior-class alliance (combat bonuses)');
  });

  it('the harvest wins over a stale spy report (harvested "none" beats spied "warrior")', () => {
    const p = prof(buildDangerProfiles({
      ...base(),
      allianceClasses: { '500921': 'none' },
      spied: { '20': { defensePts: 0, coverageComplete: false, spiedCount: 1, allianceClass: 'warrior' } },
    }), 20);
    expect(p.allianceClass).toBe('none');
    expect(p.reasons).not.toContain('warrior-class alliance (combat bonuses)');
  });
});

describe('combatQuality — res/ship → hull quality', () => {
  it('floors a cheap-hull swarm at 0.2 and peaks warships at 1.0', () => {
    expect(combatQuality(2_000)).toBe(0.2);
    expect(combatQuality(0)).toBe(0.2);
    expect(combatQuality(50_000)).toBe(1.0);
    expect(combatQuality(150_000)).toBe(1.0);
  });
  it('ramps monotonically up to the warship window', () => {
    expect(combatQuality(15_000)).toBeCloseTo(0.6, 6);
    expect(combatQuality(40_000)).toBe(1.0);
  });
  it('decays a defence / RIP-inflated res/ship back toward 0.6', () => {
    expect(combatQuality(500_000)).toBeCloseTo(0.6, 6);
    expect(combatQuality(1_000_000)).toBe(0.6);
  });
});
