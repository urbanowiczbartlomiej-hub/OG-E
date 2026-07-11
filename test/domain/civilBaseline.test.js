// @ts-check

// Unit tests for domain/civilBaseline — the pure economy→ships baseline model.
// Every case drives plain `economy` / `military` rank maps (id → {score,ships})
// and asserts the returned CivilProfile shape / bands / confidence. No DOM, no
// storage — pure node. Thresholds mirrored from the module: BASELINE_MAX 0.25,
// ELEVATED_MAX 0.6, MIN_SAMPLES 20, DECILES 10.

import { describe, it, expect } from 'vitest';
import { buildCivilBaseline } from '../../src/domain/civilBaseline.js';

/**
 * Build a synthetic pair of feeds where ships track economy linearly
 * (ships === score / 10), giving a clean, monotonic median curve. `count`
 * builder rows are laid down at economy 1000, 2000, … so every decile is a
 * flat baseline (combatRatio 0). Extra fleeters/probers are merged on top.
 *
 * @param {number} count
 * @returns {{ economy: Record<string, {score:number}>, military: Record<string, {score:number, ships:number}> }}
 */
const buildersFeed = (count) => {
  /** @type {Record<string, {score:number}>} */
  const economy = {};
  /** @type {Record<string, {score:number, ships:number}>} */
  const military = {};
  for (let i = 1; i <= count; i++) {
    const score = i * 1000;
    economy[String(i)] = { score };
    military[String(i)] = { score, ships: score / 10 }; // baseline: ships == expectedCivil
  }
  return { economy, military };
};

/**
 * A flat server: every builder owns the SAME civil fleet (`ships`), so every
 * decile median equals it and every builder scores an exact-baseline ratio of 0
 * regardless of how the deciles split. Economy still rises with id so the feed
 * is realistic.
 *
 * @param {number} count
 * @param {number} ships
 * @returns {{ economy: Record<string, {score:number}>, military: Record<string, {score:number, ships:number}> }}
 */
const flatFeed = (count, ships) => {
  /** @type {Record<string, {score:number}>} */
  const economy = {};
  /** @type {Record<string, {score:number, ships:number}>} */
  const military = {};
  for (let i = 1; i <= count; i++) {
    const score = i * 1000;
    economy[String(i)] = { score };
    military[String(i)] = { score, ships };
  }
  return { economy, military };
};

describe('buildCivilBaseline — degenerate inputs return an empty map', () => {
  it('returns empty Map with no arguments', () => {
    expect(buildCivilBaseline()).toEqual(new Map());
  });

  it('returns empty when the economy feed is missing', () => {
    const { military } = buildersFeed(30);
    expect(buildCivilBaseline({ military }).size).toBe(0);
  });

  it('returns empty when the military feed is missing', () => {
    const { economy } = buildersFeed(30);
    expect(buildCivilBaseline({ economy }).size).toBe(0);
  });

  it('returns empty when NO military row carries a ships attribute (pre-ships feed)', () => {
    const { economy } = buildersFeed(30);
    /** @type {Record<string, {score:number}>} */
    const military = {};
    for (const id of Object.keys(economy)) military[id] = { score: economy[id].score };
    expect(buildCivilBaseline({ economy, military }).size).toBe(0);
  });

  it('returns empty with too few overlapping samples (< MIN_SAMPLES 20)', () => {
    const { economy, military } = buildersFeed(19);
    expect(buildCivilBaseline({ economy, military }).size).toBe(0);
  });

  it('models the server once samples reach MIN_SAMPLES (20)', () => {
    const { economy, military } = buildersFeed(20);
    expect(buildCivilBaseline({ economy, military }).size).toBe(20);
  });
});

describe('buildCivilBaseline — the median curve on a crafted distribution', () => {
  it('scores a flat civil-fleet server at exact baseline (surplus 0, low confidence)', () => {
    // Every builder owns the same fleet → each decile median equals it →
    // ships === expectedCivil for everyone → zero surplus, baseline band.
    const out = buildCivilBaseline(flatFeed(30, 1000));

    expect(out.size).toBe(30);
    for (const [, p] of out) {
      expect(p.expectedCivil).toBe(1000);
      expect(p.combatShips).toBe(0);
      expect(p.combatRatio).toBe(0);
      expect(p.band).toBe('baseline');
      expect(p.confidence).toBe('low');
    }
  });

  it('expectedCivil tracks the player economy monotonically (top decile ≥ bottom)', () => {
    const { economy, military } = buildersFeed(30);
    const out = buildCivilBaseline({ economy, military });

    // Player 1 sits in the lowest decile, player 30 in the highest.
    const low = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(1));
    const high = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(30));
    expect(high.expectedCivil).toBeGreaterThan(low.expectedCivil);
    // Curve is non-decreasing across the whole economy range.
    let prev = -Infinity;
    for (const p of [...out.values()].sort((a, b) => a.economyScore - b.economyScore)) {
      expect(p.expectedCivil).toBeGreaterThanOrEqual(prev);
      prev = p.expectedCivil;
    }
  });
});

describe('buildCivilBaseline — surplus bands & confidence', () => {
  it('flags a player with ships FAR above baseline as a fleet-holder (high confidence)', () => {
    const { economy, military } = buildersFeed(30);
    // A modest economy (2000 → expectedCivil 200) but a huge combat fleet. Score is
    // set high enough that res/ship clears the cheap-swarm veto (this IS a real fleet;
    // the band tracks the ship-COUNT surplus, so score doesn't affect it).
    economy['500'] = { score: 2000 };
    military['500'] = { score: 300000, ships: 20000 }; // res/ship 15k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(500));

    expect(p.expectedCivil).toBe(200);
    expect(p.combatShips).toBe(20000 - 200);
    expect(p.combatRatio).toBeGreaterThan(0.6);
    expect(p.band).toBe('fleet-holder');
    // combatShips (19800) >> expectedCivil (200) → clear surplus → high.
    expect(p.confidence).toBe('high');
  });

  it('classes a moderate surplus as elevated / medium confidence', () => {
    const { economy, military } = buildersFeed(30);
    // expectedCivil 500 for economy 5000; ships chosen so ratio lands in [0.25,0.6).
    // ships 1000 → combat 500 → ratio 0.5.
    economy['600'] = { score: 5000 };
    military['600'] = { score: 20000, ships: 1000 }; // res/ship 20k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(600));

    expect(p.expectedCivil).toBe(500);
    expect(p.combatShips).toBe(500);
    expect(p.combatRatio).toBeCloseTo(0.5, 6);
    expect(p.band).toBe('elevated');
    expect(p.confidence).toBe('medium');
  });

  it('reads a player at/below baseline as an economy-explained builder', () => {
    const { economy, military } = buildersFeed(30);
    // Ships BELOW the decile median → combatShips clamps to 0. (The added row
    // shifts bin edges, so this economy's decile median is 400, not 500 — the
    // point is only that ships < expectedCivil.)
    economy['700'] = { score: 5000 };
    military['700'] = { score: 5000, ships: 100 };

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(700));

    expect(p.expectedCivil).toBe(400);
    expect(p.ships).toBeLessThan(p.expectedCivil);
    expect(p.combatShips).toBe(0);
    expect(p.combatRatio).toBe(0);
    expect(p.band).toBe('baseline');
    expect(p.confidence).toBe('low');
  });

  it('gives a fleet-holder whose surplus dwarfs the baseline high confidence', () => {
    const { economy, military } = buildersFeed(30);
    // expectedCivil 500, ships 5000 → combat 4500 → ratio 0.9. combatShips (4500)
    // is far above expectedCivil (500), which is the high-confidence gate.
    economy['800'] = { score: 5000 };
    military['800'] = { score: 100000, ships: 5000 }; // res/ship 20k > cheap-hull floor

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(800));
    expect(p.band).toBe('fleet-holder');
    expect(p.combatShips).toBeGreaterThan(p.expectedCivil);
    expect(p.confidence).toBe('high');
  });

  it('relabels a big COUNT surplus of CHEAP hulls as cheap-swarm (res/ship veto)', () => {
    const { economy, military } = buildersFeed(30);
    economy['501'] = { score: 2000 };
    military['501'] = { score: 2000, ships: 20000 }; // res/ship 100 → cheap swarm, not combat
    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(501));
    expect(p.band).toBe('cheap-swarm');
    expect(p.confidence).toBe('low');
    expect(p.resPerShip).toBeCloseTo(100, 6);
  });
});

describe('buildCivilBaseline — per-player edge handling', () => {
  it('treats a military row with no ships attribute as 0 ships (feed IS ships-aware)', () => {
    const { economy, military } = buildersFeed(30);
    economy['900'] = { score: 5000 };
    military['900'] = /** @type {any} */ ({ score: 5000 }); // ships absent → 0

    const out = buildCivilBaseline({ economy, military });
    const p = /** @type {import('../../src/domain/civilBaseline.js').CivilProfile} */ (out.get(900));
    expect(p.ships).toBe(0);
    expect(p.combatShips).toBe(0);
    expect(p.combatRatio).toBe(0);
    expect(p.band).toBe('baseline');
  });

  it('skips military players absent from the economy feed', () => {
    const { economy, military } = buildersFeed(30);
    military['1001'] = { score: 9999, ships: 9999 }; // no economy row

    const out = buildCivilBaseline({ economy, military });
    expect(out.has(1001)).toBe(false);
  });
});

// ── Spy calibration (IDEAS #1) — the identity-gated ceiling ─────────────────
//
// Report fixtures use exact unit costs (unitCosts.js): Small Cargo 202 =
// 4000 res (civil, @50% in military pts), Battleship 207 = 60000 res (combat),
// Rocket Launcher 401 = 2000 res (defence). One body with fleet {202:300,
// 207:50} + defense {401:100} is worth 60·50 + 2·300 + 2·100 = 3800 military
// points, so identities can be closed (or broken) to the point.

import { collectCivilCalibration } from '../../src/domain/civilBaseline.js';

/**
 * One standard verified body: 3800 military pts, 600 civil / 100 combat per 2 bodies.
 * @param {number} g @param {number} s @param {number} p @param {object} [extra]
 */
const stdBody = (g, s, p, extra = {}) => ({
  latest: {
    galaxy: g, system: s, position: p, planetType: 1, playerId: 0,
    fleet: { 202: 300, 207: 50 }, defense: { 401: 100 },
    fleetValue: 300 * 4000 + 50 * 60000, defenseValue: 100 * 2000,
    timestamp: 1_700_000_000,
    ...extra,
  },
  history: [],
});

/** A verified 2-body player: 7600 pts seen, 600 civil, 100 combat, 700 ships. */
const verifiedPlayer = () => ({
  '1:1:1:1': stdBody(1, 1, 1),
  '1:1:2:1': stdBody(1, 1, 2),
});

describe('collectCivilCalibration — the identity gate', () => {
  it('returns an inert calibration for missing inputs', () => {
    expect(collectCivilCalibration()).toEqual({ samples: 0, ratioCeil: 0, perPlayer: new Map() });
    expect(collectCivilCalibration({ reports: {} , military: {}, economy: {} }).samples).toBe(0);
  });

  it('verifies a player whose seen points close the CURRENT military score', () => {
    const cal = collectCivilCalibration({
      reports: { 42: verifiedPlayer() },
      military: { 42: { score: 7600, ships: 700 } },
      economy: { 42: { score: 24_000 } },
    });
    expect(cal.perPlayer.get(42)).toEqual({ civilSeen: 600, combatSeen: 100, shipsSeen: 700 });
    expect(cal.samples).toBe(1);
    expect(cal.ratioCeil).toBe(0); // 1 < MIN_CAL_SAMPLES — ceiling stays off
  });

  it('excludes a player whose identity is broken (unseen fleet elsewhere)', () => {
    const cal = collectCivilCalibration({
      reports: { 42: verifiedPlayer() },
      military: { 42: { score: 15_200 } }, // seen 7600 = only half the score
      economy: { 42: { score: 24_000 } },
    });
    expect(cal.perPlayer.size).toBe(0);
    expect(cal.samples).toBe(0);
  });

  it('closes within the ±10% tolerance band, not only exactly', () => {
    const cal = collectCivilCalibration({
      reports: { 42: verifiedPlayer() },
      military: { 42: { score: 8300 } }, // seen/score ≈ 0.916 — inside ±10%
      economy: { 42: { score: 24_000 } },
    });
    expect(cal.perPlayer.has(42)).toBe(true);
  });

  it('counts moon bodies toward the identity (a parking moon left unscanned breaks it)', () => {
    // Planet alone = 3800 pts of a 7600 score → identity fails; with the moon
    // report (another 3800) it closes.
    const planetOnly = { '1:1:1:1': stdBody(1, 1, 1) };
    const withMoon = { '1:1:1:1': stdBody(1, 1, 1), '1:1:1:3': stdBody(1, 1, 1, { planetType: 3 }) };
    const military = { 42: { score: 7600 } };
    const economy = { 42: { score: 24_000 } };
    expect(collectCivilCalibration({ reports: { 42: planetOnly }, military, economy }).perPlayer.size).toBe(0);
    expect(collectCivilCalibration({ reports: { 42: withMoon }, military, economy }).perPlayer.size).toBe(1);
  });

  it('tolerates the legacy bare-SpyReport entry shape (no {latest, history})', () => {
    const bare = {
      '1:1:1:1': stdBody(1, 1, 1).latest,
      '1:1:2:1': stdBody(1, 1, 2).latest,
    };
    const cal = collectCivilCalibration({
      reports: { 42: bare },
      military: { 42: { score: 7600 } },
      economy: { 42: { score: 24_000 } },
    });
    expect(cal.perPlayer.has(42)).toBe(true);
  });

  it('activates the ceiling at 3 samples, net of the spied lifeform points', () => {
    // 600 civil over (30k eco − 6k lifeform) = 0.025 civil ships per eco point.
    /** @param {number} [lf] */
    const mk = (lf) => ({
      '1:1:1:1': stdBody(1, 1, 1, lf ? { lifeformPoints: lf } : {}),
      '1:1:2:1': stdBody(1, 1, 2),
    });
    const cal = collectCivilCalibration({
      reports: { 1: mk(6000), 2: mk(6000), 3: mk(6000) },
      military: { 1: { score: 7600 }, 2: { score: 7600 }, 3: { score: 7600 } },
      economy: { 1: { score: 30_000 }, 2: { score: 30_000 }, 3: { score: 30_000 } },
    });
    expect(cal.samples).toBe(3);
    expect(cal.ratioCeil).toBeCloseTo(600 / 24_000, 9);
  });

  it('takes the p90 ratio, so one freak swarm sample cannot own the ceiling', () => {
    // 9 players at ratio 0.01 (eco 60k) + 1 at 0.10 (eco 6k) → sorted[ceil(.9·10)−1]
    // = sorted[8] = 0.01, NOT the 0.10 outlier.
    /** @type {any} */ const reports = {};
    /** @type {any} */ const military = {};
    /** @type {any} */ const economy = {};
    for (let i = 1; i <= 10; i++) {
      reports[i] = verifiedPlayer();
      military[i] = { score: 7600 };
      economy[i] = { score: i === 10 ? 6000 : 60_000 };
    }
    const cal = collectCivilCalibration({ reports, military, economy });
    expect(cal.samples).toBe(10);
    expect(cal.ratioCeil).toBeCloseTo(600 / 60_000, 9);
  });
});

describe('buildCivilBaseline — calibrated floor + verified overlay', () => {
  /** A 25-builder server whose fleets are economy-explained (rps kept ≥ 12k
   * so the cheap-swarm veto never fires in these cases). */
  const richFeed = () => {
    /** @type {Record<string, {score:number}>} */ const economy = {};
    /** @type {Record<string, {score:number, ships:number}>} */ const military = {};
    for (let i = 1; i <= 25; i++) {
      economy[String(i)] = { score: i * 1000 };
      military[String(i)] = { score: 50_000, ships: 1000 }; // rps 50k — combat-grade
    }
    return { economy, military };
  };

  it('leaves every calibrated field off without a live calibration', () => {
    const { economy, military } = richFeed();
    for (const [, p] of buildCivilBaseline({ economy, military })) {
      expect(p.combatFloor).toBeUndefined();
      expect(p.verified).toBeUndefined();
    }
    const under = { samples: 2, ratioCeil: 0.025, perPlayer: new Map() }; // < MIN_CAL_SAMPLES
    for (const [, p] of buildCivilBaseline({ economy, military, calibration: under })) {
      expect(p.combatFloor).toBeUndefined();
    }
  });

  it('computes combatFloor = ships − ratioCeil·economy and upgrades a baseline read', () => {
    const { economy, military } = richFeed();
    // Ceiling ~0 civil per eco point → the whole 1000-ship fleet is beyond it.
    const calibration = { samples: 3, ratioCeil: 1e-9, perPlayer: new Map() };
    const out = buildCivilBaseline({ economy, military, calibration });
    const p = /** @type {any} */ (out.get(10));
    expect(p.combatFloor).toBeCloseTo(1000, 3);
    expect(p.calibrationSamples).toBe(3);
    expect(p.band).toBe('elevated'); // flat curve said baseline; the floor disagrees
    expect(p.confidence).toBe('medium');
  });

  it('keeps a trivial floor (< 5% of the fleet) from upgrading the band', () => {
    const { economy, military } = richFeed();
    // Generous ceiling: floor = 1000 − 0.98·eco… pick eco so floor ≈ 2% of ships.
    const calibration = { samples: 3, ratioCeil: 0.098, perPlayer: new Map() };
    const out = buildCivilBaseline({ economy, military, calibration });
    const p = /** @type {any} */ (out.get(10)); // eco 10k → ceil 980 → floor 20 (2%)
    expect(p.combatFloor).toBeCloseTo(20, 6);
    expect(p.band).toBe('baseline');
  });

  it('marks a verified player and carries the seen composition', () => {
    const { economy, military } = richFeed();
    const calibration = {
      samples: 3,
      ratioCeil: 0.025,
      perPlayer: new Map([[10, { civilSeen: 600, combatSeen: 100, shipsSeen: 700 }]]),
    };
    const out = buildCivilBaseline({ economy, military, calibration });
    const p = /** @type {any} */ (out.get(10));
    expect(p.verified).toBe(true);
    expect(p.civilSeen).toBe(600);
    expect(p.combatSeen).toBe(100);
    expect(/** @type {any} */ (out.get(11)).verified).toBeUndefined();
  });

  it('lets the cheap-hull veto relabel even a floor-upgraded band (a swarm beats any ceiling)', () => {
    const { economy, military } = richFeed();
    military['10'] = { score: 5000, ships: 1000 }; // rps 5k — probe/cargo swarm
    const calibration = { samples: 3, ratioCeil: 1e-9, perPlayer: new Map() };
    const out = buildCivilBaseline({ economy, military, calibration });
    const p = /** @type {any} */ (out.get(10));
    expect(p.combatFloor).toBeCloseTo(1000, 3);
    expect(p.band).toBe('cheap-swarm');
    expect(p.confidence).toBe('low');
  });
});
