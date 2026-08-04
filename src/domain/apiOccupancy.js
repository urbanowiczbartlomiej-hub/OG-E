// @ts-check

// Pure parsing + occupancy modelling for the OGame public *statistics* API
// (the `/api/*.xml` files: universe / players / highscore / serverData).
//
// # Why this lives in domain/ and parses XML by hand
//
// domain/ must stay pure (no DOM, no fetch, no timers — enforced by ESLint).
// `DOMParser` is a DOM API, so we cannot use it here. The statistics XML is
// machine-generated and FLAT — every row is a single self-describing element
// with attributes only (`<planet coords="1:1:2" player="103"/>`,
// `<player id="103" status="i"/>`) — so a targeted attribute regex is a
// robust, dependency-free parse that keeps the whole module pure and
// hermetically unit-testable with plain string fixtures. (The feature layer
// does the side-effectful `fetch`; see `lib/ogameApi.js` +
// `features/apiContext`.)
//
// # The one fact that makes this valuable
//
// `universe.xml` lists EVERY occupied planet on the server. So the set of
// empty (colonizable) positions is the full coordinate grid
// (`serverData.galaxies × systems × positions 1..15`) MINUS the coords that
// appear here. That is the whole-server empty-slot map without scanning the
// galaxy view by hand. Caveat baked into every caller: `universe.xml`
// refreshes only weekly, so this is *candidate* data — the live galaxy hook
// stays the freshness/confirm layer before a colony ship flies.
//
// External contract (verified field names — keep verbatim, a game rename is a
// one-line fix here):
//   universe.xml : <universe timestamp serverId> <planet id name coords player>[<moon id name size>]
//   players.xml  : <players timestamp serverId>  <player id name alliance status>   (status '' = active)
//   alliances.xml: <alliances timestamp serverId> <alliance id name tag>[<player id/>…]
//   highscore.xml: <highscore timestamp category type> <player position id score>
//   serverData.xml: <serverData timestamp> with child ELEMENTS galaxies/systems/donut*/domain/...
//   All roots carry timestamp = Unix epoch SECONDS. positions 1..15 (16 = expedition, not colonizable).

/**
 * One occupied planet row from universe.xml.
 * @typedef {object} ApiPlanet
 * @property {string} coords          `"g:s:p"` (position 1..15).
 * @property {number} [player]        Owner player id (join key to players/highscore).
 * @property {number} [id]            The game's planet id. Ids are handed out in
 *   CREATION order server-wide, which is the only thing universe.xml lets us
 *   infer the homeworld from — a player's lowest planet id is the planet they
 *   registered with (`targets.playerPlanets` marks it `main`). Occupancy itself
 *   never reads this.
 * @property {boolean} [hasMoon]      Planet carries a `<moon>` child — a SECOND
 *   spiable body of the same owner, so it counts toward the hidden-fleet coverage
 *   denominator (SPYGLASS-REDESIGN.md §9bis). Occupancy consumers ignore it
 *   (a moon shares its planet's slot, it is not a separate occupancy cell).
 */

/**
 * Parsed universe.xml.
 * @typedef {object} UniverseData
 * @property {number} [timestamp]     Root data timestamp, ms epoch.
 * @property {ApiPlanet[]} planets    Every occupied planet on the server.
 */

/**
 * One player row from players.xml.
 * @typedef {object} ApiPlayerMeta
 * @property {string} name
 * @property {string} status          Concatenated flag letters; `''` = active.
 *   `v`=vacation, `i`=inactive, `I`=long-inactive, `o`=outlaw, `b`=banned, `a`=admin.
 * @property {string} [alliance]      Alliance id (absent/empty = none).
 */

/**
 * Parsed players.xml.
 * @typedef {object} PlayersData
 * @property {number} [timestamp]
 * @property {Record<string, ApiPlayerMeta>} players   Keyed by player id (string).
 */

/**
 * One alliance row from alliances.xml — just the two things a human searches
 * by. Members are NOT kept: players.xml already carries each player's
 * `alliance` id, so the membership join is free and storing it twice would
 * double a multi-thousand-row feed in the device cache.
 *
 * @typedef {object} ApiAlliance
 * @property {string} name            Full alliance name.
 * @property {string} tag             Short tag as shown in the galaxy view.
 */

/**
 * Parsed alliances.xml.
 * @typedef {object} AlliancesData
 * @property {number} [timestamp]
 * @property {Record<string, ApiAlliance>} alliances   Keyed by alliance id (string).
 */

/**
 * One ranking row from highscore.xml.
 * @typedef {object} ApiRank
 * @property {number} [position]      Rank (1 = top).
 * @property {number} [score]
 * @property {number} [ships]         Ship COUNT — military highscore (type 3)
 *   rows only. The server OMITS the attribute when the player owns 0 ships
 *   (verified on s163-pl: no `ships="0"` rows exist), so consumers must read
 *   "row present, attribute absent" as 0 — a pure-defense account, not
 *   missing data.
 */

/**
 * Parsed highscore.xml for one (category,type) pair.
 * @typedef {object} HighscoreData
 * @property {number} [timestamp]
 * @property {number} [category]
 * @property {number} [type]
 * @property {Record<string, ApiRank>} ranks   Keyed by player id (string).
 */

/**
 * Parsed serverData.xml (the bits we use).
 * @typedef {object} ServerData
 * @property {number} [timestamp]
 * @property {number} [galaxies]
 * @property {number} [systems]
 * @property {boolean} [donutGalaxy]
 * @property {boolean} [donutSystem]
 * @property {string} [domain]
 * @property {string} [name]
 */

/**
 * One occupied slot in the built index (player metadata joined in).
 * @typedef {object} OccupiedSlot
 * @property {number} [player]
 * @property {string} [name]
 * @property {string} status          `''` = active (see ApiPlayerMeta.status).
 * @property {string} [alliance]
 * @property {number} [rank]          Total-highscore position, when known.
 * @property {number} [score]         Total-highscore POINTS, when known. Retained
 *   (not just rank) so the points-temperature map can average account strength.
 * @property {number} [militaryScore] Military-highscore POINTS, when known.
 * @property {string} [rankClass]     Synthesised honour-rank class from the honour
 *   highscore (see {@link honorClass}) — e.g. `"rank_bandit3"`. Lets the
 *   bandit/honoured machinery work from the API, no live scan needed.
 */

/**
 * The per-device occupancy index built from a universe+players+highscore set.
 * @typedef {object} OccupancyIndex
 * @property {Map<string, OccupiedSlot>} occupied   coordKey `"g:s:p"` → slot.
 * @property {Set<string>} ownColonies              Our own colony coords.
 * @property {Record<number, number>} occupiedByPosition  position (1..15) →
 *   how many planets the universe snapshot has at that position, server-wide.
 *   Precomputed here so a whole-universe free-slot count is O(positions), not a
 *   ~67k-cell grid scan, on the colonize button's 1 Hz repaint.
 * @property {number} [timestamp]                   universe.xml data timestamp (ms).
 */

/** Colonizable positions in a system (16 is the expedition slot — excluded). */
export const ALL_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/**
 * The one free-slot cell every empty position in the synthesised scan map points
 * at, and the whole-system record every fully-empty system shares. Frozen
 * because they ARE shared: a consumer that wrote through one of these would
 * edit every empty slot on the server at once. Nothing writes to a scan cell
 * today (the map is rebuilt from the API blob on every change), and the freeze
 * is what keeps that true.
 */
const EMPTY_CELL = Object.freeze({ status: 'empty' });
const ALL_EMPTY_POSITIONS = Object.freeze(
  Object.fromEntries(ALL_POSITIONS.map((p) => [p, EMPTY_CELL])),
);

// --- low-level attribute/element extractors (precompiled, reused) ----------

const PLANET_TAG_RE = /<planet\b([^>]*)>/g;
const PLAYER_TAG_RE = /<player\b([^>]*)>/g;
/** `<alliance …>` opening tags only — its `<player …>` children are skipped. */
const ALLIANCE_TAG_RE = /<alliance\b([^>]*)>/g;

const A_ID = /\bid="([^"]*)"/;
const A_NAME = /\bname="([^"]*)"/;
const A_TAG = /\btag="([^"]*)"/;
const A_COORDS = /\bcoords="([^"]*)"/;
const A_PLAYER = /\bplayer="([^"]*)"/;
const A_STATUS = /\bstatus="([^"]*)"/;
const A_ALLIANCE = /\balliance="([^"]*)"/;
const A_POSITION = /\bposition="([^"]*)"/;
const A_SCORE = /\bscore="([^"]*)"/;
const A_SHIPS = /\bships="([^"]*)"/;
const A_CATEGORY = /\bcategory="([^"]*)"/;
const A_TYPE = /\btype="([^"]*)"/;
const ROOT_TS_RE = /\btimestamp="(\d+)"/;
const ENTITY_RE = /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g;

/**
 * Decode the five predefined XML entities + numeric character references.
 * Player names are the only attribute values that can carry them.
 * @param {string} s
 * @returns {string}
 */
function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (whole, ent) => {
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    // numeric reference: &#123; or &#x1F;
    const cp =
      ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
  });
}

/**
 * Read the root `timestamp` attribute (epoch seconds) and return it as ms.
 * Only the document root carries `timestamp`, so the first match wins.
 * @param {string} xml
 * @returns {number | undefined}
 */
function rootTimestampMs(xml) {
  const m = xml.match(ROOT_TS_RE);
  return m ? Number(m[1]) * 1000 : undefined;
}

/**
 * Read a single child element's text, e.g. `<galaxies>9</galaxies>`.
 * @param {string} xml
 * @param {string} tag
 * @returns {string | undefined}
 */
function elementText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : undefined;
}

// --- parsers ---------------------------------------------------------------

/**
 * Parse universe.xml into the flat occupied-planet list + data timestamp.
 * @param {string} xml
 * @returns {UniverseData}
 */
export function parseUniverse(xml) {
  /** @type {ApiPlanet[]} */
  const planets = [];
  if (typeof xml !== 'string' || xml === '') return { timestamp: undefined, planets };
  PLANET_TAG_RE.lastIndex = 0;
  let m;
  while ((m = PLANET_TAG_RE.exec(xml)) !== null) {
    const attrs = m[1];
    const cm = attrs.match(A_COORDS);
    if (!cm) continue;
    const pm = attrs.match(A_PLAYER);
    // A planet carries AT MOST one <moon> child (`<planet ...>[<moon .../>]`).
    // Detect it by scanning only THIS planet's own content — from just past its
    // opening `>` up to the next `<planet` (or end of xml) — so a later planet's
    // moon can't be misattributed. The moon is a second spiable body → it counts
    // toward the hidden-fleet coverage denominator (§9bis). O(n) overall: the
    // slice is one planet's ~small content, not the tail of the document.
    const contentStart = PLANET_TAG_RE.lastIndex;
    const nextPlanet = xml.indexOf('<planet', contentStart);
    const boundary = nextPlanet === -1 ? xml.length : nextPlanet;
    /** @type {ApiPlanet} */
    const planet = { coords: cm[1], player: pm ? Number(pm[1]) : undefined };
    // Planet id — kept for ONE reason: ids are minted in creation order, so the
    // lowest id a player owns is their homeworld (see targets.playerPlanets).
    const im = attrs.match(A_ID);
    if (im) {
      const id = Number(im[1]);
      if (Number.isFinite(id)) planet.id = id;
    }
    if (xml.slice(contentStart, boundary).includes('<moon')) planet.hasMoon = true;
    planets.push(planet);
  }
  return { timestamp: rootTimestampMs(xml), planets };
}

/**
 * Parse players.xml into an id → metadata map.
 * @param {string} xml
 * @returns {PlayersData}
 */
export function parsePlayers(xml) {
  /** @type {Record<string, ApiPlayerMeta>} */
  const players = {};
  if (typeof xml !== 'string' || xml === '') return { timestamp: undefined, players };
  PLAYER_TAG_RE.lastIndex = 0;
  let m;
  while ((m = PLAYER_TAG_RE.exec(xml)) !== null) {
    const attrs = m[1];
    const idm = attrs.match(A_ID);
    if (!idm) continue;
    const nm = attrs.match(A_NAME);
    const sm = attrs.match(A_STATUS);
    const am = attrs.match(A_ALLIANCE);
    players[idm[1]] = {
      name: nm ? decodeXml(nm[1]) : '',
      status: sm ? sm[1] : '',
      alliance: am && am[1] ? am[1] : undefined,
    };
  }
  return { timestamp: rootTimestampMs(xml), players };
}

/**
 * Parse alliances.xml into an id → {name, tag} map.
 *
 * The feed nests `<player …/>` members inside each `<alliance …>`, so we match
 * the alliance opening tags ONLY — the member rows are the players.xml join we
 * already have. An alliance with no tag keeps `''` (the game allows it), which
 * simply never matches a tag search.
 *
 * @param {string} xml
 * @returns {AlliancesData}
 */
export function parseAlliances(xml) {
  /** @type {Record<string, ApiAlliance>} */
  const alliances = {};
  if (typeof xml !== 'string' || xml === '') return { timestamp: undefined, alliances };
  ALLIANCE_TAG_RE.lastIndex = 0;
  let m;
  while ((m = ALLIANCE_TAG_RE.exec(xml)) !== null) {
    const attrs = m[1];
    const idm = attrs.match(A_ID);
    if (!idm) continue;
    const nm = attrs.match(A_NAME);
    const tm = attrs.match(A_TAG);
    alliances[idm[1]] = {
      name: nm ? decodeXml(nm[1]) : '',
      tag: tm ? decodeXml(tm[1]) : '',
    };
  }
  return { timestamp: rootTimestampMs(xml), alliances };
}

/**
 * Parse highscore.xml (one category/type) into an id → rank map.
 * @param {string} xml
 * @returns {HighscoreData}
 */
export function parseHighscore(xml) {
  /** @type {Record<string, ApiRank>} */
  const ranks = {};
  if (typeof xml !== 'string' || xml === '') {
    return { timestamp: undefined, category: undefined, type: undefined, ranks };
  }
  PLAYER_TAG_RE.lastIndex = 0;
  let m;
  while ((m = PLAYER_TAG_RE.exec(xml)) !== null) {
    const attrs = m[1];
    const idm = attrs.match(A_ID);
    if (!idm) continue;
    const posm = attrs.match(A_POSITION);
    const scm = attrs.match(A_SCORE);
    const shm = attrs.match(A_SHIPS);
    ranks[idm[1]] = {
      position: posm ? Number(posm[1]) : undefined,
      score: scm ? Number(scm[1]) : undefined,
      // Only the military feed carries it; keep undefined elsewhere so the
      // "absent attribute on a present row = 0 ships" rule stays type-scoped.
      ...(shm ? { ships: Number(shm[1]) } : {}),
    };
  }
  // category/type are attributes on the <highscore …> root (first match).
  const catm = xml.match(A_CATEGORY);
  const tym = xml.match(A_TYPE);
  return {
    timestamp: rootTimestampMs(xml),
    category: catm ? Number(catm[1]) : undefined,
    type: tym ? Number(tym[1]) : undefined,
    ranks,
  };
}

/**
 * Parse the serverData.xml fields we use (grid bounds + donut wrap + host).
 * @param {string} xml
 * @returns {ServerData}
 */
export function parseServerData(xml) {
  if (typeof xml !== 'string' || xml === '') return {};
  const galaxies = elementText(xml, 'galaxies');
  const systems = elementText(xml, 'systems');
  return {
    timestamp: rootTimestampMs(xml),
    galaxies: galaxies !== undefined ? Number(galaxies) : undefined,
    systems: systems !== undefined ? Number(systems) : undefined,
    donutGalaxy: elementText(xml, 'donutGalaxy') === '1',
    donutSystem: elementText(xml, 'donutSystem') === '1',
    domain: elementText(xml, 'domain'),
    name: elementText(xml, 'name'),
  };
}

// --- index ----------------------------------------------------------------

/**
 * Join the parsed feeds into one occupancy index: every occupied coord mapped
 * to its owner's status/rank, plus the set of our own colonies. Empty slots
 * are computed on demand (a coord absent from `occupied`), never materialized
 * — a full grid is ~67k entries and pure waste to store.
 *
 * @param {object} feeds
 * @param {UniverseData} [feeds.universe]
 * @param {PlayersData} [feeds.players]
 * @param {HighscoreData} [feeds.highscore]   Total-score ranks (category 1, type 0).
 * @param {HighscoreData} [feeds.military]    Military-score ranks (category 1, type 3),
 *   retained as per-player POINTS for the aggressor lens of the points-temperature map.
 * @param {HighscoreData} [feeds.honor]       Honour-score ranks (category 1, type 7) —
 *   negative score = bandit; drives the synthesised `rankClass`.
 * @param {number} [feeds.ownPlayerId]        Our player id, to flag own colonies.
 * @returns {OccupancyIndex}
 */
export function buildOccupancyIndex(feeds = {}) {
  const { universe, players, highscore, military, honor, ownPlayerId } = feeds;
  /** @type {Map<string, OccupiedSlot>} */
  const occupied = new Map();
  /** @type {Set<string>} */
  const ownColonies = new Set();
  /** @type {Record<number, number>} position (1..15) → server-wide planet count. */
  const occupiedByPosition = {};
  const pmap = players && players.players ? players.players : {};
  const rmap = highscore && highscore.ranks ? highscore.ranks : {};
  const mmap = military && military.ranks ? military.ranks : {};
  const hmap = honor && honor.ranks ? honor.ranks : {};
  const honorTotal = Object.keys(hmap).length; // ranked-player count → "bottom N" cutoffs
  const planets = universe && universe.planets ? universe.planets : [];
  for (const pl of planets) {
    if (!pl || !pl.coords) continue;
    if (occupied.has(pl.coords)) continue; // dedup so the per-position tally can't double-count.
    const pid = pl.player;
    const meta = pid != null ? pmap[String(pid)] : undefined;
    const rank = pid != null ? rmap[String(pid)] : undefined;
    const milRow = pid != null ? mmap[String(pid)] : undefined;
    const honorRow = pid != null ? hmap[String(pid)] : undefined;
    occupied.set(pl.coords, {
      player: pid,
      name: meta ? meta.name : undefined,
      status: meta ? meta.status : '',
      alliance: meta ? meta.alliance : undefined,
      rank: rank ? rank.position : undefined,
      score: rank ? rank.score : undefined,
      militaryScore: milRow ? milRow.score : undefined,
      rankClass: honorClass(honorRow, honorTotal),
    });
    // Tally the position (last `:`-segment of "g:s:p") for the whole-universe
    // free-slot count.
    const colon = pl.coords.lastIndexOf(':');
    const pos = colon >= 0 ? parseInt(pl.coords.slice(colon + 1), 10) : NaN;
    if (Number.isFinite(pos)) occupiedByPosition[pos] = (occupiedByPosition[pos] || 0) + 1;
    if (ownPlayerId != null && pid === ownPlayerId) ownColonies.add(pl.coords);
  }
  return {
    occupied,
    ownColonies,
    occupiedByPosition,
    timestamp: universe ? universe.timestamp : undefined,
  };
}

/**
 * Is the given `"g:s:p"` coordinate occupied per the index?
 * @param {OccupancyIndex} index
 * @param {string} coordKey
 * @returns {boolean}
 */
export function isOccupied(index, coordKey) {
  return !!(index && index.occupied && index.occupied.has(coordKey));
}

/**
 * The empty (colonizable) positions of one system per the index. NOTE: this
 * is API-derived candidacy only — a slot here is "empty as of the weekly
 * universe snapshot", to be confirmed live and intersected with the local
 * decision log before it is offered as a colony target.
 *
 * @param {OccupancyIndex} index
 * @param {number} galaxy
 * @param {number} system
 * @param {number[]} [positions]   Defaults to all 15 colonizable slots.
 * @returns {number[]}
 */
export function emptyPositionsInSystem(index, galaxy, system, positions = ALL_POSITIONS) {
  const occ = index && index.occupied ? index.occupied : new Map();
  return positions.filter((p) => !occ.has(`${galaxy}:${system}:${p}`));
}

/**
 * Count colonizable target slots still FREE across the WHOLE universe per the
 * API occupancy snapshot: `galaxies × systems` slots exist at each target
 * position, minus the ones the snapshot already shows occupied
 * (`occupiedByPosition`). API-breadth only (weekly universe.xml) — it does NOT
 * subtract our just-sent / in-flight colonies (a rounding error against a
 * server-wide total, and not yet reflected in the weekly feed anyway).
 *
 * Returns `null` when the index or the server grid dimensions are unknown (so
 * the caller can hide the stat rather than show a bogus zero), and `0` only when
 * the target list is genuinely empty.
 *
 * @param {OccupancyIndex | null | undefined} index
 * @param {{ galaxies?: number, systems?: number } | null | undefined} dims
 *   Server grid bounds (serverData.galaxies / .systems).
 * @param {number[]} targets   user's parsed target positions.
 * @returns {number | null}
 */
export function countFreeTargetSlots(index, dims, targets) {
  if (!index || !dims) return null;
  const galaxies = Number(dims.galaxies);
  const systems = Number(dims.systems);
  if (!Number.isFinite(galaxies) || !Number.isFinite(systems) || galaxies <= 0 || systems <= 0) {
    return null;
  }
  if (!targets || targets.length === 0) return 0;
  const perPos = index.occupiedByPosition || {};
  const slotsPerPosition = galaxies * systems;
  let free = 0;
  for (const p of targets) {
    free += Math.max(0, slotsPerPosition - (perPos[p] || 0));
  }
  return free;
}

// --- synthetic scan map (lets domain/regions.js reason over whole-server) ---

/**
 * Map an API `player@status` letter-soup to one of our PositionStatus values,
 * mirroring `domain/scans.js classifyPosition`'s ladder
 * (admin > banned > vacation > long_inactive > inactive > occupied). Outlaw
 * (`o`) is a flag, not a status — an outlaw is otherwise an active occupant.
 *
 * @param {string} status   Concatenated flag letters; `''` = active.
 * @returns {'admin'|'banned'|'vacation'|'long_inactive'|'inactive'|'occupied'}
 */
function apiStatusToPosition(status) {
  if (status.includes('a')) return 'admin';
  if (status.includes('b')) return 'banned';
  if (status.includes('v')) return 'vacation';
  if (status.includes('I')) return 'long_inactive';
  if (status.includes('i')) return 'inactive';
  return 'occupied';
}

/**
 * Classify a player's HONOUR rank from their honour-highscore row (position +
 * score) into a synthesised `rankClass`, so the whole downstream pipeline —
 * `scoreRegion`'s bandit/honoured tallies, `domain/players.honorRank`, the Scout
 * honour chip — works UNCHANGED from the public API, no live scan needed.
 *
 * OGame awards a rank on BOTH a ranking POSITION and an honour-point floor: the
 * higher tier needs you near the top/bottom of the honour highscore AND past the
 * HP threshold; you keep the best tier you qualify for:
 *
 *   honoured: top 10 & ≥15000 → 3, top 100 & ≥2500 → 2, top 250 & ≥500 → 1
 *             (Cesarz / Imperator / Władca)
 *   bandit:   bottom 10 & ≤-15000 → 3, bottom 100 & ≤-2500 → 2, bottom 250 & ≤-500 → 1
 *             (Król Bandytów / Lord Bandytów / Bandyta)
 *
 * `total` is the ranked-player count (the honour highscore length) so "bottom N"
 * = the last N positions. The synthesised class names are internal; only the
 * `rank_bandit` prefix and the trailing tier digit are read downstream.
 *
 * @param {{ position?: number, score?: number } | undefined} row  Honour highscore entry.
 * @param {number} total  Ranked-player count (honour highscore length).
 * @returns {string | undefined}
 */
export function honorClass(row, total) {
  if (!row) return undefined;
  const pos = row.position;
  const score = row.score;
  if (typeof pos !== 'number' || typeof score !== 'number') return undefined;
  if (pos <= 10 && score >= 15000) return 'rank_honored3';
  if (pos <= 100 && score >= 2500) return 'rank_honored2';
  if (pos <= 250 && score >= 500) return 'rank_honored1';
  const n = typeof total === 'number' && total > 0 ? total : 0;
  if (pos > n - 10 && score <= -15000) return 'rank_bandit3';
  if (pos > n - 100 && score <= -2500) return 'rank_bandit2';
  if (pos > n - 250 && score <= -500) return 'rank_bandit1';
  return undefined;
}

/**
 * Build a synthetic `GalaxyScans`-shaped map from the occupancy index so the
 * EXISTING pure region finder/scorer (`domain/regions.js`) can reason over
 * WHOLE-SERVER data with no rewrite. Every grid system gets an entry: occupied
 * slots carry their joined owner (status + name + rank + alliance id), our own
 * colonies are marked `mine`, and EVERY other colonizable slot is filled
 * `empty` — so a fully-free system is a region match, exactly as a live scan of
 * it would be.
 *
 * Why every slot and not just the analyzer's target list (as this did until
 * 1.56): the map is the whole-server OCCUPANCY TRUTH, and truth must not depend
 * on what the user typed into the Slots box. While only the requested slots
 * carried an `empty` cell, a free slot 14 was literally invisible whenever the
 * box said "15" — which silently moved the free-room channel of EVERY spot
 * candidate (and the strip colours) when the box changed, and reshuffled a list
 * of areas that had not changed at all. Which slots you can settle is now a
 * question the FINDER asks of this map, not a question baked into it.
 *
 * Fidelity caveat: bandit/honoured `rankClass` is now SYNTHESISED from the
 * honour highscore (category 1, type 7) via {@link honorClass} — so
 * bandit/honoured scoring works whole-server, not just on visited systems. Only
 * alliance TAGS remain galaxy-DOM only (alliance counting uses the alliance id).
 *
 * Pure: no DOM/fetch/clock. The caller overlays live scans and casts the result
 * to `GalaxyScans`.
 *
 * @param {OccupancyIndex} index
 * @param {object} opts
 * @param {number} opts.galaxies   Grid galaxy bound (serverData.galaxies).
 * @param {number} opts.systems    Grid system bound (serverData.systems).
 * @returns {Record<string, { scannedAt: number, positions: Record<number, { status: string, player?: { id: number, name?: string, rank?: number, score?: number, militaryScore?: number, ally?: string, rankClass?: string } }> }>}
 */
export function buildScanMapFromIndex(index, opts) {
  /** @type {Record<string, { scannedAt: number, positions: Record<number, any> }>} */
  const map = {};
  if (!index || !index.occupied) return map;
  const { galaxies, systems } = opts;
  const ts = index.timestamp ?? 0;

  // Group occupied coords by their "g:s" system.
  /** @type {Map<string, Array<{ pos: number, coord: string, slot: OccupiedSlot }>>} */
  const bySystem = new Map();
  for (const [coord, slot] of index.occupied) {
    const i1 = coord.indexOf(':');
    const i2 = coord.indexOf(':', i1 + 1);
    if (i1 <= 0 || i2 <= 0) continue;
    const sysKey = coord.slice(0, i2);
    const pos = Number(coord.slice(i2 + 1));
    let arr = bySystem.get(sysKey);
    if (!arr) {
      arr = [];
      bySystem.set(sysKey, arr);
    }
    arr.push({ pos, coord, slot });
  }

  // Occupied systems → real occupants + free target slots.
  for (const [sysKey, slots] of bySystem) {
    /** @type {Record<number, any>} */
    const positions = {};
    for (const { pos, coord, slot } of slots) {
      if (index.ownColonies.has(coord)) {
        positions[pos] = { status: 'mine' };
      } else if (slot.player != null) {
        positions[pos] = {
          status: apiStatusToPosition(slot.status || ''),
          player: {
            id: slot.player,
            name: slot.name,
            rank: slot.rank,
            score: slot.score,
            militaryScore: slot.militaryScore,
            ally: slot.alliance,
            rankClass: slot.rankClass,
          },
        };
      } else {
        positions[pos] = { status: 'occupied' };
      }
    }
    for (const t of ALL_POSITIONS) {
      if (positions[t] === undefined) positions[t] = EMPTY_CELL;
    }
    map[sysKey] = { scannedAt: ts, positions };
  }

  // Fully-empty systems across the grid → every slot empty (so a contiguous
  // free stretch is found, not just systems that happen to have a neighbour).
  // They all share ONE frozen record: a ~4.5k-system grid would otherwise mint
  // ~67k identical cells for nothing.
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const sysKey = `${g}:${s}`;
      if (map[sysKey]) continue;
      map[sysKey] = { scannedAt: ts, positions: ALL_EMPTY_POSITIONS };
    }
  }

  return map;
}
