// @ts-check

// Pure classification + grouping for the planet mission badges. No DOM, no
// timers, no storage — plain functions over plain data, Node-testable.
//
// # The model (why this is simple)
//
// OGame's event list (`#eventContent`) is consistent about its two coord
// cells regardless of leg direction:
//
//   • `.coordsOrigin` is ALWAYS the fleet's launcher (its home body),
//   • `.destCoords`   is ALWAYS the mission TARGET,
//   • `data-return-flight` is the direction flag (false = flying out toward
//     the target, true = flying back home).
//
// So an incoming hostile attack on me has origin = the attacker's body and
// dest = MY body; one of my own attacks has origin = MY body and dest = the
// foreign target. We therefore classify a leg purely by which of its two
// endpoints I own — `myKeys` is the set of my body identities — and never by
// the noisy `.friendly`/`.hostile` class alone (an ally's ACS-defend fleet
// is `.friendly` yet its origin is NOT mine).
//
// # The three shapes a leg can take
//
//   1. origin mine, dest NOT mine  → my fleet flying into the unknown
//      (attack / spy / recycle / colonise / ACS / transport-to-foreign).
//      The outbound AND the return leg both carry origin = my home, so they
//      collapse onto ONE round-trip tile (`kind:'rt'`) keyed by (home, type).
//      This is the de-dup the user asked for: "lecę z P1 w nieznane i wracam
//      do P1 — pokaż jako 1".
//
//   2. both endpoints mine → internal movement (transport / deployment
//      between my own bodies). Shown on BOTH ends per the user's request:
//      an arriving tile (`kind:'in'`) on wherever the leg currently LANDS
//      and a departing tile (`kind:'out'`) on where it left. Landing flips
//      with the return flag (outbound lands at dest, return lands at origin).
//
//   3. origin NOT mine, dest mine → someone flying at me. Only the APPROACH
//      matters (`!isReturn`); the attacker's later return leg leaves my body
//      and is ignored. Coloured by hostility (`kind:'in'`, `hostile`).
//
// Expeditions (`missionType '15'`) are deliberately NOT handled here — their
// detection lives untouched in `index.js::collectActiveExpeditions` and is
// merged into the render as a round-trip tile. We skip type 15 so we never
// double-count it.

import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';
import { isFleetSaveLeg } from '../../domain/fleetSave.js';

/**
 * Background-position X of each mission's icon in the game's mission sprite,
 * expressed at the sprite's native 40px cell scale (the value you'd use with
 * `background-size: 440px`). The renderer scales these down to the badge tile
 * size. Columns are fixed per mission (the sprite's row encodes hover/selected
 * state, which we don't use). Derived from AGR's `.missionSelection
 * .missionIcon.missionN` rules — kept here as plain data so the position math
 * stays testable and a sprite-layout change is a one-table edit.
 *
 * @type {Record<string, number>}
 */
export const MISSION_SPRITE_X = {
  1: -320, // Attack
  2: -400, // ACS attack
  3: -200, // Transport
  4: -120, // Deployment / station
  5: -280, // ACS defend / hold
  6: -240, // Espionage
  7: -80, // Colonisation
  8: -160, // Recycle / harvest
  9: -360, // Moon destruction
  15: 0, // Expedition
};

/**
 * Human label per mission type, for the click/tap detail popover. English to
 * match the rest of the extension's UI strings.
 *
 * @type {Record<string, string>}
 */
export const MISSION_LABEL = {
  1: 'Attack',
  2: 'ACS attack',
  3: 'Transport',
  4: 'Deployment',
  5: 'ACS defend',
  6: 'Espionage',
  7: 'Colonisation',
  8: 'Recycle',
  9: 'Moon destruction',
  15: 'Expedition',
};

/**
 * Identity of a body for matching a leg endpoint against the player's own
 * bodies. A planet and its moon share `g:s:p`, so the `type` (1 planet /
 * 3 moon) is part of the key — byte-identical to `domain/bodies` identity.
 *
 * @param {string} coords Dense `g:s:p` coords (no brackets/whitespace).
 * @param {number} type   1 = planet, 3 = moon.
 * @returns {string}
 */
export const bodyKey = (coords, type) => `${coords}:${type}`;

/**
 * @typedef {object} BadgeEndpoint
 * @property {string} coords Dense `g:s:p`, or '' when unreadable.
 * @property {number} type   1 = planet, 3 = moon (best-effort; planet default).
 */

/**
 * One fleet leg read out of the event list, normalised to plain data.
 *
 * @typedef {object} BadgeLeg
 * @property {string} id           Row id (`eventRow-<n>`) — the de-dup key.
 * @property {string} missionType  `data-mission-type` value (string).
 * @property {boolean} isReturn    `data-return-flight === 'true'`.
 * @property {boolean} isHostile   Row carries the `.hostile` class.
 * @property {BadgeEndpoint} origin Launcher / home body.
 * @property {BadgeEndpoint} dest   Mission target body.
 * @property {number} arrivalAt    Epoch seconds, or NaN.
 * @property {number} shipCount    Total ships, or NaN.
 */

/**
 * One fleet's contribution to a tile's detail list (for the popover).
 *
 * @typedef {object} TileFleet
 * @property {string} origin    Launcher coords.
 * @property {string} dest      Target coords.
 * @property {boolean} isReturn Currently flying home.
 * @property {number} arrivalAt Epoch seconds, or NaN.
 * @property {number} shipCount Ships, or NaN.
 */

/**
 * A rendered badge: one mission type + direction on one body.
 *
 * @typedef {object} Tile
 * @property {string} coords      Anchor body coords.
 * @property {number} type        Anchor body type (1/3).
 * @property {string} missionType Mission type string.
 * @property {'rt'|'in'|'out'} kind Round-trip / arriving / departing.
 * @property {boolean} hostile    Incoming hostile (red).
 * @property {number} count       Number of distinct fleets aggregated.
 * @property {TileFleet[]} fleets Per-fleet detail for the popover.
 */

/**
 * Group fleet legs into per-body tiles. Returns a Map keyed by the anchor
 * body identity ({@link bodyKey}) → array of tiles on that body. Expedition
 * legs (type 15) are skipped — they are merged in by the caller from the
 * untouched expedition detector.
 *
 * Pure: no DOM, no clock. `arrivalAt` is carried through verbatim; the
 * renderer turns it into a countdown at paint time.
 *
 * @param {BadgeLeg[]} legs
 * @param {Set<string>} myKeys Set of {@link bodyKey} for the player's bodies.
 * @returns {Map<string, Tile[]>}
 */
export const groupTiles = (legs, myKeys) => {
  /** @type {Map<string, Tile>} */
  const tiles = new Map();
  /** @type {Map<string, Set<string>>} per-tile seen fleet ids (de-dup). */
  const seen = new Map();

  /**
   * @param {string} coords
   * @param {number} type
   * @param {string} missionType
   * @param {'rt'|'in'|'out'} kind
   * @param {boolean} hostile
   * @param {BadgeLeg} leg
   */
  const add = (coords, type, missionType, kind, hostile, leg) => {
    if (!coords) return;
    const key = `${coords}:${type}|${missionType}|${kind}|${hostile ? 1 : 0}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = { coords, type, missionType, kind, hostile, count: 0, fleets: [] };
      tiles.set(key, tile);
      seen.set(key, new Set());
    }
    const ids = /** @type {Set<string>} */ (seen.get(key));
    if (leg.id && ids.has(leg.id)) return;
    if (leg.id) ids.add(leg.id);
    tile.count += 1;
    tile.fleets.push({
      origin: leg.origin.coords,
      dest: leg.dest.coords,
      isReturn: leg.isReturn,
      arrivalAt: leg.arrivalAt,
      shipCount: leg.shipCount,
    });
  };

  for (const leg of legs) {
    if (leg.missionType === '15') continue; // expeditions: handled elsewhere
    const oMine = myKeys.has(bodyKey(leg.origin.coords, leg.origin.type));
    const dMine = myKeys.has(bodyKey(leg.dest.coords, leg.dest.type));

    if (oMine && dMine) {
      // Internal movement (transport / deployment between my bodies). A
      // round-trip mission lists its outbound AND return leg at once, so we
      // count each fleet exactly once via the same leg-pick the fleet-save
      // scanner uses, then mark the SOURCE (origin) departing and the TARGET
      // (dest) arriving. origin/dest are direction-stable in OGame's list
      // (origin = launcher, dest = target), so this reads right regardless of
      // which leg we counted — "i tu i tu", per the user's request.
      if (!isFleetSaveLeg(leg.missionType, leg.isReturn)) continue;
      add(leg.origin.coords, leg.origin.type, leg.missionType, 'out', false, leg);
      add(leg.dest.coords, leg.dest.type, leg.missionType, 'in', false, leg);
    } else if (oMine && !dMine) {
      // My fleet into the unknown — outbound + return collapse onto one home
      // tile. Count the fleet once (return leg of round-trips, the sole
      // outbound of one-way missions) so "5 attacks" reads ×5, not ×10.
      if (!isFleetSaveLeg(leg.missionType, leg.isReturn)) continue;
      add(leg.origin.coords, leg.origin.type, leg.missionType, 'rt', false, leg);
    } else if (!oMine && dMine) {
      // Someone flying at me — only the inbound APPROACH is relevant; their
      // later return leg leaves my body and is ignored.
      if (leg.isReturn) continue;
      add(leg.dest.coords, leg.dest.type, leg.missionType, 'in', leg.isHostile, leg);
    }
    // else: neither endpoint mine (e.g. an enemy's leg between two foreign
    // bodies that happens to appear) — not ours to badge.
  }

  /** @type {Map<string, Tile[]>} */
  const byAnchor = new Map();
  for (const tile of tiles.values()) {
    const k = bodyKey(tile.coords, tile.type);
    const arr = byAnchor.get(k);
    if (arr) arr.push(tile);
    else byAnchor.set(k, [tile]);
  }
  return byAnchor;
};

/**
 * Display priority of a tile within a body's column: threats first, then
 * other arrivals, round-trips, departures. Ties broken by mission type so
 * the order is stable across renders.
 *
 * @param {Tile} t
 * @returns {number}
 */
export const tileRank = (t) => {
  if (t.kind === 'in' && t.hostile) return 0;
  if (t.kind === 'in') return 1;
  if (t.kind === 'rt') return 2;
  return 3; // 'out'
};

/**
 * Stable sort of a body's tiles by {@link tileRank}. Returns a new array.
 *
 * @param {Tile[]} tiles
 * @returns {Tile[]}
 */
export const sortTiles = (tiles) =>
  [...tiles].sort(
    (a, b) => tileRank(a) - tileRank(b) || Number(a.missionType) - Number(b.missionType),
  );

// Re-exported so the renderer and tests share one definition of the two
// body-type constants without reaching into domain/rules directly.
export { TARGET_PLANET, TARGET_MOON };
