// @ts-check

// Unit tests for domain/apiOccupancy — the pure, dependency-free parsing +
// occupancy modelling for the OGame public statistics API. Every case drives a
// plain XML string fixture (the module parses by attribute regex, no DOMParser)
// and asserts the parsed shape / built index. No DOM, no fetch — pure node.

import { describe, it, expect } from 'vitest';
import {
  ALL_POSITIONS,
  parseUniverse,
  parsePlayers,
  parseHighscore,
  parseServerData,
  buildOccupancyIndex,
  isOccupied,
  emptyPositionsInSystem,
  countFreeTargetSlots,
  buildScanMapFromIndex,
  honorClass,
} from '../../src/domain/apiOccupancy.js';

describe('ALL_POSITIONS', () => {
  it('is the 15 colonizable slots (16 = expedition, excluded)', () => {
    expect(ALL_POSITIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe('parseUniverse', () => {
  it('extracts coords + player from each <planet> row and the root timestamp (s→ms)', () => {
    const xml =
      '<universe timestamp="1700000000" serverId="163">' +
      '<planet id="1" name="Homeworld" coords="1:1:2" player="103">' +
      '<moon id="2" name="Moon" size="8500"/></planet>' +
      '<planet id="3" name="Colony" coords="1:1:8" player="207"/>' +
      '</universe>';
    expect(parseUniverse(xml)).toEqual({
      timestamp: 1700000000 * 1000,
      planets: [
        { coords: '1:1:2', player: 103 },
        { coords: '1:1:8', player: 207 },
      ],
    });
  });

  it('leaves player undefined when the attribute is absent', () => {
    const u = parseUniverse('<universe timestamp="1"><planet coords="2:3:4"/></universe>');
    expect(u.planets).toEqual([{ coords: '2:3:4', player: undefined }]);
  });

  it('skips a <planet> with no coords attribute', () => {
    const u = parseUniverse('<universe><planet player="5"/><planet coords="1:2:3" player="5"/></universe>');
    expect(u.planets).toEqual([{ coords: '1:2:3', player: 5 }]);
  });

  it('returns an empty list + undefined timestamp for empty / non-string input', () => {
    expect(parseUniverse('')).toEqual({ timestamp: undefined, planets: [] });
    // @ts-expect-error — exercising the runtime type guard.
    expect(parseUniverse(null)).toEqual({ timestamp: undefined, planets: [] });
  });
});

describe('parsePlayers', () => {
  it('maps id → { name, status, alliance } and decodes XML entities in names', () => {
    const xml =
      '<players timestamp="1700000000">' +
      '<player id="103" name="A&amp;B" status="" alliance="42"/>' +
      '<player id="207" name="Bob" status="i"/>' +
      '</players>';
    expect(parsePlayers(xml)).toEqual({
      timestamp: 1700000000 * 1000,
      players: {
        103: { name: 'A&B', status: '', alliance: '42' },
        207: { name: 'Bob', status: 'i', alliance: undefined },
      },
    });
  });

  it('decodes numeric character references in a name', () => {
    const p = parsePlayers('<players><player id="1" name="x&#33;&#x21;"/></players>');
    expect(p.players['1'].name).toBe('x!!');
  });

  it('treats an empty alliance attribute as none (undefined)', () => {
    const p = parsePlayers('<players><player id="1" name="Z" alliance=""/></players>');
    expect(p.players['1'].alliance).toBeUndefined();
  });

  it('defaults name to "" and status to "" when absent, and skips rows with no id', () => {
    const p = parsePlayers('<players><player name="noid"/><player id="9"/></players>');
    expect(Object.keys(p.players)).toEqual(['9']);
    expect(p.players['9']).toEqual({ name: '', status: '', alliance: undefined });
  });

  it('returns empty map + undefined timestamp for empty input', () => {
    expect(parsePlayers('')).toEqual({ timestamp: undefined, players: {} });
  });
});

describe('parseHighscore', () => {
  it('maps id → { position, score } and reads category/type from the root', () => {
    const xml =
      '<highscore timestamp="1700000000" category="1" type="0">' +
      '<player id="103" position="1" score="123456"/>' +
      '<player id="207" position="2" score="9999"/>' +
      '</highscore>';
    expect(parseHighscore(xml)).toEqual({
      timestamp: 1700000000 * 1000,
      category: 1,
      type: 0,
      ranks: {
        103: { position: 1, score: 123456 },
        207: { position: 2, score: 9999 },
      },
    });
  });

  it('returns the empty envelope for empty input', () => {
    expect(parseHighscore('')).toEqual({
      timestamp: undefined,
      category: undefined,
      type: undefined,
      ranks: {},
    });
  });
});

describe('parseServerData', () => {
  it('reads grid bounds, donut flags and host fields from child elements', () => {
    const xml =
      '<serverData timestamp="1700000000">' +
      '<name>Banaan</name>' +
      '<galaxies>9</galaxies>' +
      '<systems>499</systems>' +
      '<donutGalaxy>1</donutGalaxy>' +
      '<donutSystem>0</donutSystem>' +
      '<domain>s163-pl.ogame.gameforge.com</domain>' +
      '</serverData>';
    expect(parseServerData(xml)).toEqual({
      timestamp: 1700000000 * 1000,
      galaxies: 9,
      systems: 499,
      donutGalaxy: true,
      donutSystem: false,
      domain: 's163-pl.ogame.gameforge.com',
      name: 'Banaan',
    });
  });

  it('returns {} for empty / non-string input', () => {
    expect(parseServerData('')).toEqual({});
    // @ts-expect-error — runtime guard.
    expect(parseServerData(undefined)).toEqual({});
  });

  it('leaves galaxies/systems undefined when the elements are absent', () => {
    const s = parseServerData('<serverData timestamp="1"><name>X</name></serverData>');
    expect(s.galaxies).toBeUndefined();
    expect(s.systems).toBeUndefined();
    expect(s.donutGalaxy).toBe(false);
  });
});

describe('honorClass', () => {
  it('needs BOTH a top ranking position and an HP floor (honoured tiers)', () => {
    expect(honorClass({ position: 1, score: 15000 }, 1000)).toBe('rank_honored3');
    // ≥15000 HP but outside the top 10 → capped at the tier the position allows.
    expect(honorClass({ position: 50, score: 15000 }, 1000)).toBe('rank_honored2');
    expect(honorClass({ position: 200, score: 600 }, 1000)).toBe('rank_honored1');
    // Top 10 but below the 500 HP floor → no rank.
    expect(honorClass({ position: 5, score: 400 }, 1000)).toBeUndefined();
  });

  it('classifies bandits by BOTTOM positions + negative HP (keeps worst tier earned)', () => {
    // total 1000 → bottom 10 = positions 991..1000.
    expect(honorClass({ position: 1000, score: -20000 }, 1000)).toBe('rank_bandit3');
    // ≤-15000 HP but NOT in the bottom 10 → capped at Lord (bottom 100).
    expect(honorClass({ position: 950, score: -20000 }, 1000)).toBe('rank_bandit2');
    expect(honorClass({ position: 800, score: -600 }, 1000)).toBe('rank_bandit1');
    // Bottom 250 by position but milder than -500 HP → not a bandit.
    expect(honorClass({ position: 800, score: -100 }, 1000)).toBeUndefined();
  });

  it('returns undefined without a row / position / score', () => {
    expect(honorClass(undefined, 1000)).toBeUndefined();
    expect(honorClass({ score: -20000 }, 1000)).toBeUndefined(); // no position
    expect(honorClass({ position: 1000 }, 1000)).toBeUndefined(); // no score
  });
});

describe('buildOccupancyIndex', () => {
  /** A small, reused set of feeds. */
  const feeds = () => ({
    universe: {
      timestamp: 5000,
      planets: [
        { coords: '1:1:2', player: 103 },
        { coords: '1:1:8', player: 207 },
        { coords: '2:5:3', player: 103 },
      ],
    },
    players: {
      players: {
        103: { name: 'Me', status: '', alliance: '42' },
        207: { name: 'Foe', status: 'i', alliance: undefined },
      },
    },
    highscore: { ranks: { 103: { position: 11 }, 207: { position: 9001 } } },
    ownPlayerId: 103,
  });

  it('joins player metadata + rank onto each occupied coord', () => {
    const idx = buildOccupancyIndex(feeds());
    expect(idx.occupied.get('1:1:2')).toEqual({
      player: 103,
      name: 'Me',
      status: '',
      alliance: '42',
      rank: 11,
    });
    expect(idx.occupied.get('1:1:8')).toEqual({
      player: 207,
      name: 'Foe',
      status: 'i',
      alliance: undefined,
      rank: 9001,
    });
  });

  it('retains highscore POINTS (total + military) when the feeds carry them', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '1:1:8', player: 207 }] },
      highscore: { ranks: { 207: { position: 9001, score: 123456 } } },
      military: { ranks: { 207: { position: 40, score: 7890 } } },
    });
    expect(idx.occupied.get('1:1:8')).toMatchObject({ rank: 9001, score: 123456, militaryScore: 7890 });
  });

  it('leaves points undefined when the feeds omit them (rank-only highscore)', () => {
    const idx = buildOccupancyIndex(feeds());
    expect(idx.occupied.get('1:1:8')?.score).toBeUndefined();
    expect(idx.occupied.get('1:1:8')?.militaryScore).toBeUndefined();
  });

  it('synthesises rankClass from the honour highscore (bottom position + negative score = bandit)', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '1:1:2', player: 103 }, { coords: '1:1:8', player: 207 }] },
      // total 2 → 103 at the bottom with ≤-15000 = Król; 207 at the top with ≥2500 = honoured2.
      honor: { ranks: { 103: { position: 2, score: -20000 }, 207: { position: 1, score: 3000 } } },
    });
    expect(idx.occupied.get('1:1:2')?.rankClass).toBe('rank_bandit3');
    expect(idx.occupied.get('1:1:8')?.rankClass).toBe('rank_honored2');
  });

  it('leaves rankClass undefined for a neutral honour standing', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '1:1:2', player: 103 }] },
      honor: { ranks: { 103: { position: 500, score: 0 } } },
    });
    expect(idx.occupied.get('1:1:2')?.rankClass).toBeUndefined();
  });

  it('flags our own colonies and carries the universe timestamp', () => {
    const idx = buildOccupancyIndex(feeds());
    expect([...idx.ownColonies].sort()).toEqual(['1:1:2', '2:5:3']);
    expect(idx.timestamp).toBe(5000);
  });

  it('tallies occupiedByPosition from the last coord segment', () => {
    const idx = buildOccupancyIndex(feeds());
    // positions 2, 8, 3 each occupied once.
    expect(idx.occupiedByPosition).toEqual({ 2: 1, 8: 1, 3: 1 });
  });

  it('dedups a repeated coord so the per-position tally cannot double-count', () => {
    const idx = buildOccupancyIndex({
      universe: { timestamp: 1, planets: [
        { coords: '1:1:5', player: 1 },
        { coords: '1:1:5', player: 2 }, // duplicate coord — ignored.
      ] },
    });
    expect(idx.occupied.size).toBe(1);
    expect(idx.occupied.get('1:1:5')?.player).toBe(1);
    expect(idx.occupiedByPosition).toEqual({ 5: 1 });
  });

  it('defaults status to "" for an occupant with no players-feed entry', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '3:3:3', player: 555 }] },
    });
    expect(idx.occupied.get('3:3:3')).toEqual({
      player: 555,
      name: undefined,
      status: '',
      alliance: undefined,
      rank: undefined,
    });
  });

  it('returns empty structures for no feeds', () => {
    const idx = buildOccupancyIndex();
    expect(idx.occupied.size).toBe(0);
    expect(idx.ownColonies.size).toBe(0);
    expect(idx.occupiedByPosition).toEqual({});
    expect(idx.timestamp).toBeUndefined();
  });
});

describe('isOccupied', () => {
  const idx = buildOccupancyIndex({ universe: { planets: [{ coords: '1:1:1', player: 1 }] } });

  it('is true for a coord in the index, false otherwise', () => {
    expect(isOccupied(idx, '1:1:1')).toBe(true);
    expect(isOccupied(idx, '1:1:2')).toBe(false);
  });

  it('is false for a null/garbage index', () => {
    expect(isOccupied(/** @type {any} */ (null), '1:1:1')).toBe(false);
    expect(isOccupied(/** @type {any} */ ({}), '1:1:1')).toBe(false);
  });
});

describe('emptyPositionsInSystem', () => {
  const idx = buildOccupancyIndex({
    universe: { planets: [
      { coords: '4:30:2', player: 1 },
      { coords: '4:30:8', player: 2 },
    ] },
  });

  it('returns the colonizable positions of a system not in the occupied set', () => {
    expect(emptyPositionsInSystem(idx, 4, 30)).toEqual(
      [1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15],
    );
  });

  it('returns ALL_POSITIONS for a fully-empty system', () => {
    expect(emptyPositionsInSystem(idx, 7, 99)).toEqual(ALL_POSITIONS);
  });

  it('honours a caller-supplied position subset', () => {
    expect(emptyPositionsInSystem(idx, 4, 30, [2, 4, 8])).toEqual([4]);
  });
});

describe('countFreeTargetSlots', () => {
  const idx = buildOccupancyIndex({
    universe: { planets: [
      { coords: '1:1:4', player: 1 },
      { coords: '2:2:4', player: 1 },
      { coords: '3:3:8', player: 1 },
    ] },
  });
  const dims = { galaxies: 4, systems: 10 }; // 40 slots per position.

  it('returns galaxies×systems per target minus the occupied count', () => {
    // pos 4 occupied twice → 38 free; pos 8 occupied once → 39 free.
    expect(countFreeTargetSlots(idx, dims, [4, 8])).toBe(38 + 39);
  });

  it('uses the full slots-per-position for a target with no occupancy', () => {
    expect(countFreeTargetSlots(idx, dims, [15])).toBe(40);
  });

  it('returns null when the index is absent', () => {
    expect(countFreeTargetSlots(null, dims, [4])).toBeNull();
  });

  it('returns null when grid dims are missing or non-positive', () => {
    expect(countFreeTargetSlots(idx, null, [4])).toBeNull();
    expect(countFreeTargetSlots(idx, { galaxies: 0, systems: 10 }, [4])).toBeNull();
    expect(countFreeTargetSlots(idx, { galaxies: 4 }, [4])).toBeNull();
  });

  it('returns 0 (not null) when the target list is empty', () => {
    expect(countFreeTargetSlots(idx, dims, [])).toBe(0);
  });

  it('never returns a negative count (clamps at 0)', () => {
    // A tiny grid with more occupied at a position than slots can't happen in
    // reality, but the Math.max(0, …) guard must hold: 1×1 grid, pos 4 has 2.
    expect(countFreeTargetSlots(idx, { galaxies: 1, systems: 1 }, [4])).toBe(0);
  });
});

describe('buildScanMapFromIndex', () => {
  const index = buildOccupancyIndex({
    universe: {
      timestamp: 7777,
      planets: [
        { coords: '1:1:2', player: 103 }, // mine
        { coords: '1:1:8', player: 207 }, // inactive foe
        { coords: '1:1:5', player: undefined }, // occupant, no player id
      ],
    },
    players: {
      players: {
        103: { name: 'Me', status: '', alliance: '42' },
        207: { name: 'Foe', status: 'i', alliance: '7' },
      },
    },
    highscore: { ranks: { 207: { position: 50 } } },
    ownPlayerId: 103,
  });

  it('marks our own colony as status "mine"', () => {
    const map = buildScanMapFromIndex(index, { galaxies: 1, systems: 1, targets: [4] });
    expect(map['1:1'].positions[2]).toEqual({ status: 'mine' });
    expect(map['1:1'].scannedAt).toBe(7777);
  });

  it('maps a foreign occupant to its status + joined player payload', () => {
    const map = buildScanMapFromIndex(index, { galaxies: 1, systems: 1, targets: [4] });
    expect(map['1:1'].positions[8]).toEqual({
      status: 'inactive',
      player: { id: 207, name: 'Foe', rank: 50, ally: '7', rankClass: undefined },
    });
  });

  it('carries the synthesised bandit rankClass onto the player payload', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '1:1:8', player: 207 }] },
      players: { players: { 207: { name: 'Foe', status: '' } } },
      honor: { ranks: { 207: { position: 1, score: -3000 } } },
    });
    const map = buildScanMapFromIndex(idx, { galaxies: 1, systems: 1, targets: [4] });
    expect(map['1:1'].positions[8].player?.rankClass).toBe('rank_bandit2');
  });

  it('carries highscore points (total + military) onto the player payload', () => {
    const idx = buildOccupancyIndex({
      universe: { planets: [{ coords: '1:1:8', player: 207 }] },
      players: { players: { 207: { name: 'Foe', status: 'i' } } },
      highscore: { ranks: { 207: { position: 50, score: 200000 } } },
      military: { ranks: { 207: { position: 60, score: 66000 } } },
    });
    const map = buildScanMapFromIndex(idx, { galaxies: 1, systems: 1, targets: [] });
    expect(map['1:1'].positions[8].player).toMatchObject({ score: 200000, militaryScore: 66000 });
  });

  it('maps an occupant with no player id to plain "occupied"', () => {
    const map = buildScanMapFromIndex(index, { galaxies: 1, systems: 1, targets: [4] });
    expect(map['1:1'].positions[5]).toEqual({ status: 'occupied' });
  });

  it('fills requested target slots as "empty" where not occupied', () => {
    const map = buildScanMapFromIndex(index, { galaxies: 1, systems: 1, targets: [4, 8] });
    // 4 is free → empty; 8 is occupied → stays occupied (not overwritten).
    expect(map['1:1'].positions[4]).toEqual({ status: 'empty' });
    expect(map['1:1'].positions[8].status).toBe('inactive');
  });

  it('emits a fully-empty system entry for every untouched grid cell', () => {
    const map = buildScanMapFromIndex(index, { galaxies: 1, systems: 2, targets: [4] });
    // System 1:2 has no occupants → all-empty target slots.
    expect(map['1:2']).toEqual({ scannedAt: 7777, positions: { 4: { status: 'empty' } } });
  });

  it('uses scannedAt 0 when the index has no timestamp', () => {
    const idx = buildOccupancyIndex({ universe: { planets: [{ coords: '1:1:1', player: 5 }] } });
    const map = buildScanMapFromIndex(idx, { galaxies: 1, systems: 1, targets: [] });
    expect(map['1:1'].scannedAt).toBe(0);
  });

  it('returns {} for a null/garbage index', () => {
    expect(buildScanMapFromIndex(/** @type {any} */ (null), { galaxies: 1, systems: 1, targets: [] })).toEqual({});
  });

  describe('apiStatusToPosition ladder (via the scan map)', () => {
    /**
     * Build a one-planet index whose owner carries `status`.
     * @param {string} status
     */
    const withStatus = (status) =>
      buildScanMapFromIndex(
        buildOccupancyIndex({
          universe: { planets: [{ coords: '5:5:5', player: 1 }] },
          players: { players: { 1: { name: 'X', status } } },
        }),
        { galaxies: 0, systems: 0, targets: [] },
      )['5:5'].positions[5].status;

    it('admin > banned > vacation > long_inactive > inactive > occupied', () => {
      expect(withStatus('a')).toBe('admin');
      expect(withStatus('b')).toBe('banned');
      expect(withStatus('v')).toBe('vacation');
      expect(withStatus('I')).toBe('long_inactive');
      expect(withStatus('i')).toBe('inactive');
      expect(withStatus('')).toBe('occupied');
    });

    it('treats outlaw (o) as an active occupant (flag, not status)', () => {
      expect(withStatus('o')).toBe('occupied');
    });

    it('honours precedence when flags combine (banned beats inactive)', () => {
      expect(withStatus('ib')).toBe('banned');
    });
  });
});
