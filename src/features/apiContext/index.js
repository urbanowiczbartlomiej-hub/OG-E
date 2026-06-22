// @ts-check

// API context — per-device breadth layer for colonization.
//
// Fetches the current universe's public statistics API (`/api/*.xml`,
// same-origin via `lib/ogameApi.js`), parses it with the pure
// `domain/apiOccupancy.js`, caches the parsed feeds per-device
// (`state/apiCache.js`), and builds the server-wide occupancy index that later
// stages (Colony Scout + the colonize picker) subtract from to find genuinely
// free positions WITHOUT manual galaxy scanning.
//
// Freshness model: each feed has its own regeneration cadence, so we fetch a
// feed only when it is missing or past that cadence's TTL — everything else is
// served from the local cache, so a page navigation does NOT re-download the
// multi-MB `universe.xml`. universe.xml is weekly, so the index is the BREADTH
// layer; the live galaxy hook stays the FRESHNESS layer that confirms a slot is
// empty right now before a colony ship flies. (There is no documented ETag, so
// cadence TTL — not HTTP 304 — is the cache mechanism.)
//
// SCOPE: on every in-game load `installApiContext()` warms the cache and
// publishes the occupancy index (the silent build) so the in-game colonize
// picker + dashboard Scout have data; `getContext()` is the seam they read.
// The `oge_debugApi` flag swaps the silent build for an opt-in console probe
// that logs the parsed occupancy for verification in the browser.
//
// Verify in the browser:
//   localStorage.oge_debugApi = '1'               // opt into the fetch
//   localStorage.oge_debugLoggerEnabled = 'true'  // see logger output
//   reload a galaxy page → first load logs `fetched: [...]`; navigate again →
//   `fetched: 'all-from-cache'` (within TTLs) with the same occupancy.

import { logger } from '../../lib/logger.js';
import { safeLS } from '../../lib/storage.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { fetchApiText } from '../../lib/ogameApi.js';
import {
  parseUniverse,
  parsePlayers,
  parseHighscore,
  parseServerData,
  buildOccupancyIndex,
  emptyPositionsInSystem,
} from '../../domain/apiOccupancy.js';
import { readApiCache, writeApiCache } from '../../state/apiCache.js';
import { readOwnProfile } from '../../state/ownProfile.js';
import { setApiContext } from '../shared/apiContextStore.js';

/** localStorage flag (string `'1'`) that opts into the on-load probe fetch. */
const DEBUG_FLAG = 'oge_debugApi';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per-feed refresh TTLs, matched to each feed's documented regeneration cadence. */
const TTL = {
  universe: 7 * DAY, // weekly
  players: DAY, // daily
  highscore: HOUR, // hourly
  server: DAY, // daily
};

/**
 * The built context for the current universe.
 * @typedef {object} ApiContext
 * @property {import('../../domain/apiOccupancy.js').OccupancyIndex} index
 * @property {import('../../domain/apiOccupancy.js').ServerData} server
 * @property {{ ranks: Record<string, import('../../domain/apiOccupancy.js').ApiRank>, timestamp?: number }} military
 *   Military ranks (category 1, type 3) — kept for later threat scoring.
 * @property {number} builtAt
 * @property {string[]} fetched   Which feeds were hit over the network this call.
 */

/** Idempotency guard. */
let installed = false;

/**
 * Is a cached feed present and within its cadence TTL?
 * @param {{ fetchedAt?: number } | undefined} part
 * @param {number} ttl
 * @param {number} now
 * @returns {boolean}
 */
function isFresh(part, ttl, now) {
  return !!(part && typeof part.fetchedAt === 'number' && now - part.fetchedAt < ttl);
}

/**
 * Best-effort read of our own player id from the per-universe own-profile
 * (written by features/ownProfile on each page load). Absent on the very first
 * load before that async write lands — then own-colony flagging is simply
 * skipped (harmless; own colonies are occupied either way).
 * @returns {Promise<number | undefined>}
 */
async function resolveOwnPlayerId() {
  try {
    const id = typeof location !== 'undefined' ? parseUniverseId(location.host) : '';
    const profile = await readOwnProfile(id);
    return typeof profile.id === 'number' ? profile.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure the local API cache is fresh: fetch only feeds that are missing or
 * past their cadence TTL, write back if anything changed. Does NOT build the
 * occupancy index (that's `getContext`) — this is the cheap path run in-game on
 * every page load so the cache is warm for the dashboard Scout (which can't
 * fetch cross-origin) and the colonize picker. After the first load the only
 * cost is one chrome.storage read until a feed's cadence elapses.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]   Re-fetch every feed regardless of TTL.
 * @returns {Promise<{ cache: import('../../state/apiCache.js').ApiCache, fetched: string[] }>}
 */
export async function refreshCache(opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  const cache = await readApiCache();
  /** @type {string[]} */
  const fetched = [];
  let changed = false;

  if (force || !isFresh(cache.universe, TTL.universe, now)) {
    const u = parseUniverse(await fetchApiText('universe'));
    cache.universe = { planets: u.planets, timestamp: u.timestamp, fetchedAt: now };
    fetched.push('universe');
    changed = true;
  }
  if (force || !isFresh(cache.players, TTL.players, now)) {
    const p = parsePlayers(await fetchApiText('players'));
    cache.players = { players: p.players, timestamp: p.timestamp, fetchedAt: now };
    fetched.push('players');
    changed = true;
  }
  if (force || !isFresh(cache.total, TTL.highscore, now)) {
    const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '0' }));
    cache.total = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    fetched.push('total');
    changed = true;
  }
  if (force || !isFresh(cache.military, TTL.highscore, now)) {
    const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '3' }));
    cache.military = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    fetched.push('military');
    changed = true;
  }
  if (force || !isFresh(cache.server, TTL.server, now)) {
    cache.server = { data: parseServerData(await fetchApiText('serverData')), fetchedAt: now };
    fetched.push('server');
    changed = true;
  }

  if (changed) await writeApiCache(cache);
  return { cache, fetched };
}

/**
 * Get the current universe's occupancy context: refresh the cache, then build
 * the joined occupancy index. The built context is published to the shared
 * handoff (`features/shared/apiContextStore.js`) so the colonize picker can
 * read it synchronously (a feature→feature import would be forbidden).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]   Re-fetch every feed regardless of TTL.
 * @returns {Promise<ApiContext>}
 */
export async function getContext(opts = {}) {
  const { cache, fetched } = await refreshCache(opts);
  const ownPlayerId = await resolveOwnPlayerId();
  const index = buildOccupancyIndex({
    universe: {
      planets: cache.universe ? cache.universe.planets : [],
      timestamp: cache.universe ? cache.universe.timestamp : undefined,
    },
    players: { players: cache.players ? cache.players.players : {} },
    highscore: { ranks: cache.total ? cache.total.ranks : {} },
    ownPlayerId,
  });

  /** @type {ApiContext} */
  const ctx = {
    index,
    server: cache.server ? cache.server.data : {},
    military: {
      ranks: cache.military ? cache.military.ranks : {},
      timestamp: cache.military ? cache.military.timestamp : undefined,
    },
    builtAt: Date.now(),
    fetched,
  };
  setApiContext(ctx);
  return ctx;
}

/**
 * Read galaxy/system from the in-game URL, if present.
 * @returns {{ galaxy: number, system: number } | null}
 */
function currentGalaxySystem() {
  try {
    const q = new URLSearchParams(location.search);
    const galaxy = Number(q.get('galaxy'));
    const system = Number(q.get('system'));
    if (Number.isFinite(galaxy) && galaxy > 0 && Number.isFinite(system) && system > 0) {
      return { galaxy, system };
    }
  } catch {
    /* malformed URL — nothing to report */
  }
  return null;
}

/**
 * Build the context and log a summary. Opt-in (debug flag) — used in place of
 * the silent cache-warm so the data path can be inspected in the console.
 * @returns {void}
 */
function probe() {
  getContext()
    .then((ctx) => {
      logger.log('apiContext: occupancy built', {
        occupied: ctx.index.occupied.size,
        ownColonies: ctx.index.ownColonies.size,
        universeTs: ctx.index.timestamp ? new Date(ctx.index.timestamp).toISOString() : undefined,
        galaxies: ctx.server.galaxies,
        systems: ctx.server.systems,
        fetched: ctx.fetched.length ? ctx.fetched : 'all-from-cache',
      });
      const here = currentGalaxySystem();
      if (here) {
        logger.log(
          `apiContext: empty positions in ${here.galaxy}:${here.system}`,
          emptyPositionsInSystem(ctx.index, here.galaxy, here.system),
        );
      }
    })
    .catch((err) => logger.warn('apiContext: getContext failed', err));
}

/**
 * Install the API-context feature. Idempotent. On every in-game load it warms
 * the local cache (cache-gated — the multi-MB universe.xml is fetched at most
 * weekly) so the dashboard Scout (which can't fetch cross-origin) and the
 * colonize picker have data. With the `oge_debugApi` flag it instead builds the
 * full index and logs a console summary. Top-frame gating is the caller's
 * responsibility (see content.js).
 *
 * @returns {void}
 */
export function installApiContext() {
  if (installed) return;
  installed = true;
  if (typeof location === 'undefined') return;
  if (safeLS.get(DEBUG_FLAG) === '1') {
    probe();
  } else {
    // Silent build — warm the cache AND publish the occupancy index to the
    // shared handoff so the in-game colonize picker can offer whole-server
    // candidates. Cache-gated, so the multi-MB universe.xml is fetched at most
    // weekly; the rest is a cheap rebuild from cache.
    getContext().catch(() => {
      /* offline / API hiccup — picker falls back to live-scan-only */
    });
  }
}

/**
 * Test-only: reset the idempotency gate + session cache.
 * @returns {void}
 */
export function _resetApiContextForTest() {
  installed = false;
  setApiContext(null);
}
