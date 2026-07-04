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
//   highscoreeconomy='426371206' highscoreresearch='581634692'
//   highscorelifeforms='564362413'  (report-time all-axis scores)
//   fleet='{"203":5000,...}'  defense='{"401":453493,...}'  (id→count JSON)
//   buildings='{"1":50,...}'  research='{"113":24,...}'
//   lfbuildings / lfresearch (id→level JSON)
//   characterclass='{"id":1,"icon":"miner","name":"Zbieracz"}'  (player class)
//   resources='414286783' metal / crystal / deuterium / population / food
//   loot='75' (plunder %)  counterespionagechance='2'
//   playerstatus='["honorableTarget"]'  timestamp='1782405308' (epoch SECONDS)
//   activity='25' (minutes since last activity on THIS body; '*' = active <15 min;
//     '-1' = none / >60 min — NOT "1 minute ago"). See parseActivityMin.
// PARTIAL reports: a low-probe / high-counter-espionage scan reveals only SOME
// sections. Then fleetvalue/defensevalue are '-', the fleet/defense/buildings/
// research keys are absent, and per-section `hidden*` flags are '1' (a FULL report
// carries them as ''): hiddenships / hiddendef / hiddenbuildings / hiddenresearch.
// A resources-only report still carries resources+scores+class — see `revealed`.
//   `sourceplayerid` is present ONLY on proximity "spotted near you" alerts —
//   see isEspionageReportBag.

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
 * @property {string} [highscoreeconomy]
 * @property {string} [highscoreresearch]
 * @property {string} [highscorelifeforms]
 * @property {string} [ranking]
 * @property {string} [fleet]
 * @property {string} [defense]
 * @property {string} [buildings]
 * @property {string} [research]
 * @property {string} [lfbuildings]
 * @property {string} [lfresearch]
 * @property {string} [characterclass]
 * @property {string} [resources]
 * @property {string} [metal]
 * @property {string} [crystal]
 * @property {string} [deuterium]
 * @property {string} [population]
 * @property {string} [food]
 * @property {string} [loot]
 * @property {string} [counterespionagechance]
 * @property {string} [hiddenships]
 * @property {string} [hiddendef]
 * @property {string} [hiddenbuildings]
 * @property {string} [hiddenresearch]
 * @property {string} [playerstatus]
 * @property {string} [timestamp]
 * @property {string} [activity]
 */

/**
 * Which sections a report actually revealed. A low-probe / high-counter-espionage
 * scan can withhold fleet/defense/buildings/research (each `hidden*` flag = '1')
 * while still showing resources. Consumers MUST gate on this: e.g. hidden-fleet
 * math counts a body's defence only when `revealed.defense` is true, so an
 * unrevealed section is never read as zero (see SPYGLASS-REDESIGN.md §9bis).
 * @typedef {object} Revealed
 * @property {boolean} resources   Resources/loot section shown (the base reveal).
 * @property {boolean} fleet       Ship counts shown (`hiddenships` !== '1').
 * @property {boolean} defense     Defense counts shown (`hiddendef` !== '1').
 * @property {boolean} buildings   Building levels shown (`hiddenbuildings` !== '1').
 * @property {boolean} research    Research levels shown (`hiddenresearch` !== '1').
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
 * @property {number} [economyPoints]    Player economy score (report-time).
 * @property {number} [researchPoints]   Player research score (report-time).
 * @property {number} [lifeformPoints]   Player lifeform score — inflates economy
 *   without civil ships; used to de-bias the civil-fleet baseline.
 * @property {number} [ranking]          Player total rank.
 * @property {Record<number, number>} [fleet]    id→count.
 * @property {Record<number, number>} [defense]  id→count.
 * @property {Record<number, number>} [buildings]   id→level.
 * @property {Record<number, number>} [research]    id→level (mine levels → loot rate).
 * @property {Record<number, number>} [lfBuildings] id→level.
 * @property {Record<number, number>} [lfResearch]  id→level.
 * @property {string} [characterClass]   Player class icon ('miner' | 'warrior' |
 *   'explorer' | 'general' | 'collector'): builder-vs-fleeter prior.
 * @property {number} [resources]        Total on-planet resources (loot base).
 * @property {number} [metal]
 * @property {number} [crystal]
 * @property {number} [deuterium]
 * @property {number} [lootPct]          Plunder fraction as a percent (e.g. 75).
 * @property {number} [counterEspionage] Probe-loss chance percent at scan time.
 * @property {string[]} [playerStatus]
 * @property {Revealed} [revealed]       Which sections this report actually showed.
 * @property {number} [timestamp]        Report time, epoch SECONDS — the unit
 *   every consumer speaks (`scanStatus`'s `reportTsSec`, the dashboard's
 *   `ageMs`). Reports persisted before the unit fix stored MILLISECONDS; see
 *   {@link normalizeReportTimestamps}.
 * @property {number} [activityMin]      Minutes since last activity on this body:
 *   0 = active (<15 min, '*'); a positive number = that many minutes; undefined =
 *   none (>60 min, '-1', or not shown). See {@link parseActivityMin}.
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
 * Normalise the per-body activity marker to "minutes since last activity".
 * The game encodes: '*' = active <15 min (→ 0), '-1' = none / >60 min (→ undefined
 * — NOT "1 minute ago"), any other value = that minute count. '-'/'' = not shown.
 * @param {string|undefined} s
 * @returns {number|undefined}
 */
function parseActivityMin(s) {
  if (s == null || s === '' || s === '-') return undefined;
  if (s === '*') return 0;
  const n = toNum(s);
  if (n == null || n < 0) return undefined; // '-1' (or any negative) = none
  return n;
}

/**
 * Pull the player-class icon ('miner' | 'warrior' | 'explorer' | …) out of the
 * `characterclass` attribute, which is a `{"id":1,"icon":"miner","name":…}` JSON
 * (or '-' when absent). Returns the icon string, else undefined.
 * @param {string|undefined} s
 * @returns {string|undefined}
 */
function parseCharacterClass(s) {
  if (!s || s === '-') return undefined;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj.icon === 'string' ? obj.icon : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which sections did this report reveal? A FULL report carries every `hidden*`
 * flag as '' (revealed); a partial scan sets the withheld ones to '1'. Resources
 * are the base reveal (present whenever the report exists at all).
 * @param {RawEspionageData} raw
 * @returns {Revealed}
 */
function computeRevealed(raw) {
  const shown = (/** @type {string|undefined} */ flag) => flag !== '1';
  return {
    resources: raw.resources != null && raw.resources !== '-',
    fleet: shown(raw.hiddenships),
    defense: shown(raw.hiddendef),
    buildings: shown(raw.hiddenbuildings),
    research: shown(raw.hiddenresearch),
  };
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
  const activityMin = parseActivityMin(raw.activity);

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
    economyPoints: toNum(raw.highscoreeconomy),
    researchPoints: toNum(raw.highscoreresearch),
    lifeformPoints: toNum(raw.highscorelifeforms),
    ranking: toNum(raw.ranking),
    fleet,
    defense,
    buildings: toCountMap(raw.buildings),
    research: toCountMap(raw.research),
    lfBuildings: toCountMap(raw.lfbuildings),
    lfResearch: toCountMap(raw.lfresearch),
    characterClass: parseCharacterClass(raw.characterclass),
    resources: toNum(raw.resources),
    metal: toNum(raw.metal),
    crystal: toNum(raw.crystal),
    deuterium: toNum(raw.deuterium),
    lootPct: toNum(raw.loot),
    counterEspionage: toNum(raw.counterespionagechance),
    playerStatus: toStringArray(raw.playerstatus),
    revealed: computeRevealed(raw),
    // Epoch SECONDS, straight from the game attribute — the whole freshness
    // pipeline (scanStatus reportTsSec, ageMs) multiplies by 1000 itself. The
    // old `* 1000` here made every stored report read as perpetually fresh.
    timestamp: tsSec != null ? tsSec : undefined,
    activityMin,
  };
}

/**
 * One-time unit repair for persisted report maps: reports recorded before the
 * timestamp fix stored `timestamp` in MILLISECONDS while every consumer
 * expects SECONDS — so their age/staleness always read as fresh. Any value
 * above 1e11 (year ~5138 as seconds) can only be milliseconds — convert it.
 * Pure; returns the input object untouched when nothing needs fixing.
 *
 * @param {Record<string, Record<string, SpyReport>>} reports
 * @returns {Record<string, Record<string, SpyReport>>}
 */
export function normalizeReportTimestamps(reports) {
  let changed = false;
  /** @type {Record<string, Record<string, SpyReport>>} */
  const out = {};
  for (const pid of Object.keys(reports)) {
    const bucket = reports[pid];
    // Pass a malformed bucket THROUGH untouched — returning `out` on `changed`
    // must never silently drop an entry we didn't rewrite (data-preserving).
    if (!bucket || typeof bucket !== 'object') { out[pid] = bucket; continue; }
    /** @type {Record<string, SpyReport>} */
    let fixedBucket = bucket;
    for (const key of Object.keys(bucket)) {
      const r = bucket[key];
      if (r && typeof r.timestamp === 'number' && r.timestamp > 1e11) {
        if (fixedBucket === bucket) fixedBucket = { ...bucket };
        fixedBucket[key] = { ...r, timestamp: Math.round(r.timestamp / 1000) };
        changed = true;
      }
    }
    out[pid] = fixedBucket;
  }
  return changed ? out : reports;
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
