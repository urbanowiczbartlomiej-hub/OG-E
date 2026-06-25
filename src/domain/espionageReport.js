// @ts-check

// Pure normaliser for an espionage report. The MAIN-world message bridge
// (added later) reads the report DOM and hands us the `data-raw-*` attributes
// as a flat string bag; this module validates/coerces them into a typed
// `SpyReport`. Keeping it here (domain/) means it's DOM-free and unit-testable
// with a plain object fixture taken straight from a real report.
//
// The raw bag keys are the report's `data-raw-*` attribute names WITHOUT the
// `data-raw-` prefix — and ALWAYS LOWERCASED. The reader pulls these from the
// live DOM (`element.dataset`), and the HTML parser lowercases every attribute
// name, so the source's `data-raw-playerName` arrives as `playername`,
// `data-raw-targetPlayerId` as `targetplayerid`, etc. We therefore read every
// field lowercase here. Verified field names from a live <div class="rawMessageData">
// (shown lowercased — keep verbatim, a game rename is a one-line fix here):
//   coordinates='4:470:15'  targetplanettype='1'(planet)/'3'(moon)
//   targetplayerid='115886' playername='Macstyle'
//   defensevalue='2768761000' fleetvalue='78093000'   (resources, game-summed)
//   highscoremilitary='47974257' highscoretotal='4566812884' ranking='88'
//   fleet='{"203":5000,...}'  defense='{"401":453493,...}'  (id→count JSON)
//   playerstatus='["honorableTarget"]'  timestamp='1782405308' (epoch SECONDS)
//   activity='25' (minutes; '*' = active <15 min). `sourceplayerid` is present
//   ONLY on proximity "spotted near you" alerts — see isEspionageReportBag.

import { sumResourceValue } from './unitCosts.js';

/**
 * Raw `data-raw-*` bag handed over by the DOM reader. Keys are the attribute
 * names without the `data-raw-` prefix, LOWERCASED by the HTML parser (so
 * `playerName` in the source is `playername` here). Every value is the original
 * attribute string (or absent). Only the fields we consume are typed.
 * @typedef {object} RawEspionageData
 * @property {string} [coordinates]
 * @property {string} [targetplanettype]
 * @property {string} [targetplayerid]
 * @property {string} [sourceplayerid]
 * @property {string} [playername]
 * @property {string} [defensevalue]
 * @property {string} [fleetvalue]
 * @property {string} [highscoremilitary]
 * @property {string} [highscoretotal]
 * @property {string} [ranking]
 * @property {string} [fleet]
 * @property {string} [defense]
 * @property {string} [playerstatus]
 * @property {string} [timestamp]
 * @property {string} [activity]
 */

/**
 * A normalised espionage report. Values are numbers/objects; resource amounts
 * are in resources (divide by 1000 for points — see `unitCosts.pointsOf`).
 * @typedef {object} SpyReport
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {number} planetType        1 = planet, 3 = moon.
 * @property {number} playerId
 * @property {string} [playerName]
 * @property {number} defenseValue       Defense resource value on this body.
 * @property {number} fleetValue         Visible (parked) fleet resource value.
 * @property {number} [militaryPoints]   Player TOTAL military score (highscore).
 * @property {number} [totalPoints]      Player total score.
 * @property {number} [ranking]          Player total rank.
 * @property {Record<number, number>} [fleet]    id→count.
 * @property {Record<number, number>} [defense]  id→count.
 * @property {string[]} [playerStatus]
 * @property {number} [timestamp]        Report time, ms epoch.
 * @property {number} [activityMin]      Minutes since last activity (0 = '*').
 */

/**
 * Parse a decimal attribute to a finite number, else undefined.
 * @param {string|undefined} s
 * @returns {number|undefined}
 */
function toNum(s) {
  if (s == null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a JSON-object attribute (`{"401":453493}`) into a numeric-keyed map.
 * @param {string|undefined} s
 * @returns {Record<number, number>|undefined}
 */
function toCountMap(s) {
  if (!s) return undefined;
  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== 'object') return undefined;
    /** @type {Record<number, number>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[Number(k)] = n;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Parse the `playerStatus` JSON array (`["honorableTarget"]`) to string[].
 * @param {string|undefined} s
 * @returns {string[]|undefined}
 */
function toStringArray(s) {
  if (!s) return undefined;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise a raw `data-raw-*` bag into a `SpyReport`. Returns null when the
 * report lacks the two fields we can't do without — coordinates and the owner
 * player id. Resource values prefer the game-summed attribute and fall back to
 * recomputing from the `{id:count}` JSON via the base-cost table.
 * @param {RawEspionageData} raw
 * @returns {SpyReport | null}
 */
export function normalizeSpyReport(raw) {
  if (!raw || !raw.coordinates) return null;
  const parts = raw.coordinates.split(':');
  if (parts.length !== 3) return null;
  const galaxy = toNum(parts[0]);
  const system = toNum(parts[1]);
  const position = toNum(parts[2]);
  const playerId = toNum(raw.targetplayerid);
  if (galaxy == null || system == null || position == null || playerId == null) {
    return null;
  }

  const fleet = toCountMap(raw.fleet);
  const defense = toCountMap(raw.defense);

  const defenseValue = toNum(raw.defensevalue) ?? sumResourceValue(defense);
  const fleetValue = toNum(raw.fleetvalue) ?? sumResourceValue(fleet);

  const planetType = toNum(raw.targetplanettype) ?? 1;
  const tsSec = toNum(raw.timestamp);
  const activityMin = raw.activity === '*' ? 0 : toNum(raw.activity);

  return {
    galaxy,
    system,
    position,
    planetType,
    playerId,
    playerName: raw.playername || undefined,
    defenseValue,
    fleetValue,
    militaryPoints: toNum(raw.highscoremilitary),
    totalPoints: toNum(raw.highscoretotal),
    ranking: toNum(raw.ranking),
    fleet,
    defense,
    playerStatus: toStringArray(raw.playerstatus),
    timestamp: tsSec != null ? tsSec * 1000 : undefined,
    activityMin,
  };
}

/**
 * Stable key for one spied body (planet vs moon share coords, differ by type).
 * @param {Pick<SpyReport, 'galaxy'|'system'|'position'|'planetType'>} r
 * @returns {string}
 */
export function bodyKey(r) {
  return `${r.galaxy}:${r.system}:${r.position}:${r.planetType}`;
}

/**
 * Is this raw `data-raw-*` bag a usable ESPIONAGE report of a TARGET? The
 * espionage message tab also carries "obca flota dostrzeżona w pobliżu Twojej
 * planety" PROXIMITY alerts, which share the rawMessageData shape but describe
 * OUR OWN planet: they carry a `sourcePlayerId` (the scout) + `targetPlayerId` =
 * us, and `defenseValue='-'`. A genuine planet scan has a numeric `defenseValue`
 * (even '0') and no source. We also keep planets only (skip moons, type 3),
 * matching the coverage denominator from universe.xml.
 * @param {Record<string, string|undefined> | null | undefined} bag
 * @returns {boolean}
 */
export function isEspionageReportBag(bag) {
  if (!bag || !bag.coordinates || !bag.targetplayerid) return false;
  if (bag.sourceplayerid) return false;
  if (bag.targetplanettype === '3') return false;
  const dv = bag.defensevalue;
  return typeof dv === 'string' && dv !== '' && dv !== '-';
}
