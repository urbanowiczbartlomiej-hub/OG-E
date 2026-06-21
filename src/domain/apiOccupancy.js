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
//   highscore.xml: <highscore timestamp category type> <player position id score>
//   serverData.xml: <serverData timestamp> with child ELEMENTS galaxies/systems/donut*/domain/...
//   All roots carry timestamp = Unix epoch SECONDS. positions 1..15 (16 = expedition, not colonizable).

/**
 * One occupied planet row from universe.xml.
 * @typedef {object} ApiPlanet
 * @property {string} coords          `"g:s:p"` (position 1..15).
 * @property {number} [player]        Owner player id (join key to players/highscore).
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
 * One ranking row from highscore.xml.
 * @typedef {object} ApiRank
 * @property {number} [position]      Rank (1 = top).
 * @property {number} [score]
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
 */

/**
 * The per-device occupancy index built from a universe+players+highscore set.
 * @typedef {object} OccupancyIndex
 * @property {Map<string, OccupiedSlot>} occupied   coordKey `"g:s:p"` → slot.
 * @property {Set<string>} ownColonies              Our own colony coords.
 * @property {number} [timestamp]                   universe.xml data timestamp (ms).
 */

/** Colonizable positions in a system (16 is the expedition slot — excluded). */
export const ALL_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// --- low-level attribute/element extractors (precompiled, reused) ----------

const PLANET_TAG_RE = /<planet\b([^>]*)>/g;
const PLAYER_TAG_RE = /<player\b([^>]*)>/g;

const A_ID = /\bid="([^"]*)"/;
const A_NAME = /\bname="([^"]*)"/;
const A_COORDS = /\bcoords="([^"]*)"/;
const A_PLAYER = /\bplayer="([^"]*)"/;
const A_STATUS = /\bstatus="([^"]*)"/;
const A_ALLIANCE = /\balliance="([^"]*)"/;
const A_POSITION = /\bposition="([^"]*)"/;
const A_SCORE = /\bscore="([^"]*)"/;
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
    planets.push({ coords: cm[1], player: pm ? Number(pm[1]) : undefined });
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
    ranks[idm[1]] = {
      position: posm ? Number(posm[1]) : undefined,
      score: scm ? Number(scm[1]) : undefined,
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
 * @param {number} [feeds.ownPlayerId]        Our player id, to flag own colonies.
 * @returns {OccupancyIndex}
 */
export function buildOccupancyIndex(feeds = {}) {
  const { universe, players, highscore, ownPlayerId } = feeds;
  /** @type {Map<string, OccupiedSlot>} */
  const occupied = new Map();
  /** @type {Set<string>} */
  const ownColonies = new Set();
  const pmap = players && players.players ? players.players : {};
  const rmap = highscore && highscore.ranks ? highscore.ranks : {};
  const planets = universe && universe.planets ? universe.planets : [];
  for (const pl of planets) {
    if (!pl || !pl.coords) continue;
    const pid = pl.player;
    const meta = pid != null ? pmap[String(pid)] : undefined;
    const rank = pid != null ? rmap[String(pid)] : undefined;
    occupied.set(pl.coords, {
      player: pid,
      name: meta ? meta.name : undefined,
      status: meta ? meta.status : '',
      alliance: meta ? meta.alliance : undefined,
      rank: rank ? rank.position : undefined,
    });
    if (ownPlayerId != null && pid === ownPlayerId) ownColonies.add(pl.coords);
  }
  return { occupied, ownColonies, timestamp: universe ? universe.timestamp : undefined };
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
 * Build a synthetic `GalaxyScans`-shaped map from the occupancy index so the
 * EXISTING pure region finder/scorer (`domain/regions.js`) can reason over
 * WHOLE-SERVER data with no rewrite. Every grid system gets an entry: occupied
 * slots carry their joined owner (status + name + rank + alliance id), our own
 * colonies are marked `mine`, and the requested target slots are filled `empty`
 * where not occupied — so a fully-free system is a region match, exactly as a
 * live scan of it would be.
 *
 * Fidelity caveat: the API has highscore rank but NOT honor `rankClass` or
 * alliance TAGS (galaxy-DOM only), so bandit/honored scoring is absent here and
 * alliance counting uses the alliance id. Live scans (merged on top by the
 * caller, live-wins) restore full fidelity for systems actually visited.
 *
 * Pure: no DOM/fetch/clock. The caller overlays live scans and casts the result
 * to `GalaxyScans`.
 *
 * @param {OccupancyIndex} index
 * @param {object} opts
 * @param {number} opts.galaxies   Grid galaxy bound (serverData.galaxies).
 * @param {number} opts.systems    Grid system bound (serverData.systems).
 * @param {number[]} opts.targets  Positions to surface as `empty` when free.
 * @returns {Record<string, { scannedAt: number, positions: Record<number, { status: string, player?: { id: number, name?: string, rank?: number, ally?: string, rankClass?: string } }> }>}
 */
export function buildScanMapFromIndex(index, opts) {
  /** @type {Record<string, { scannedAt: number, positions: Record<number, any> }>} */
  const map = {};
  if (!index || !index.occupied) return map;
  const { galaxies, systems, targets } = opts;
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
            ally: slot.alliance,
            rankClass: undefined,
          },
        };
      } else {
        positions[pos] = { status: 'occupied' };
      }
    }
    for (const t of targets) {
      if (positions[t] === undefined) positions[t] = { status: 'empty' };
    }
    map[sysKey] = { scannedAt: ts, positions };
  }

  // Fully-empty systems across the grid → target slots empty (so a contiguous
  // free stretch is found, not just systems that happen to have a neighbour).
  for (let g = 1; g <= galaxies; g++) {
    for (let s = 1; s <= systems; s++) {
      const sysKey = `${g}:${s}`;
      if (map[sysKey]) continue;
      /** @type {Record<number, any>} */
      const positions = {};
      for (const t of targets) positions[t] = { status: 'empty' };
      map[sysKey] = { scannedAt: ts, positions };
    }
  }

  return map;
}
