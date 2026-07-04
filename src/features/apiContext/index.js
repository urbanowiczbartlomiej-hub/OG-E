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
import { playersStore } from '../../state/players.js';
import { targetReportsStore } from '../../state/targets.js';
import { joinDangerProfiles } from '../../domain/dangerJoin.js';
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
  // Lifetime-cumulative feeds (destroyed / lost / economy) move slowly —
  // daily is plenty and keeps the hourly page-load path at 4 fetches max.
  lifetime: DAY,
  server: DAY, // daily
};

/**
 * universe.xml regeneration watch: the `fetchedAt` TTL alone lets two 7-day
 * windows ADD UP — we may download a file that is already ~7 days old
 * server-side and then serve it for 7 more, so a daily player can see a
 * ~14-day-old snapshot. When the file's OWN `timestamp` says a server-side
 * regeneration is due, refetch even though our download is recent — with a
 * cooldown so a late regen on OGame's side doesn't make every page load
 * re-download the multi-MB file.
 */
const UNIVERSE_REGEN_DUE = 7 * DAY + 6 * HOUR;
const UNIVERSE_RETRY_COOLDOWN = 6 * HOUR;

/**
 * The built context for the current universe.
 * @typedef {object} ApiContext
 * @property {import('../../domain/apiOccupancy.js').OccupancyIndex} index
 * @property {import('../../domain/apiOccupancy.js').ServerData} server
 * @property {import('../../domain/apiOccupancy.js').ApiPlanet[]} universePlanets
 *   Raw occupied-planet rows (coords + owner id) — the scan FAB's per-player coords.
 * @property {{ ranks: Record<string, import('../../domain/apiOccupancy.js').ApiRank>, timestamp?: number }} military
 *   Military ranks (category 1, type 3) — kept for later threat scoring.
 * @property {Map<number, import('../../domain/dangerScore.js').DangerProfile>} danger
 *   Per-player danger profiles, built by the SAME `domain/dangerJoin.js` recipe
 *   the dashboard uses — the scan planner's D input (the FAB must rank targets
 *   exactly like the dashboard's plan strip).
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

  // Resilience: refresh each feed INDEPENDENTLY so one feed's network failure
  // (a 500 on economy, a dropped connection mid-sequence) can't abort the whole
  // refresh and strand even the feeds that already succeeded. A failed feed
  // keeps its stale cache entry — its `fetchedAt` stays old, so the next page
  // load retries it — and is logged, never thrown. getContext then builds with
  // whatever is available (a missing feed degrades gracefully).
  /** @param {string} label @param {() => Promise<void>} run */
  const feed = async (label, run) => {
    try {
      await run();
      fetched.push(label);
      changed = true;
    } catch (err) {
      logger.warn(`apiContext: '${label}' refresh failed — keeping cached data`, err);
    }
  };

  // Second staleness trigger for universe.xml: the snapshot's self-declared
  // regeneration time (see UNIVERSE_REGEN_DUE). Without it, the dashboard's
  // freshness stamp can honestly read "10+ days old" while the fetchedAt TTL
  // still says the cache is fine. `regenProbeTs` is the disarm: when a
  // regen-due probe comes back with the SAME self-timestamp, the server-side
  // regeneration is late/frozen (closing servers stop regenerating) — stop
  // re-downloading the multi-MB file every cooldown and let the weekly
  // fetchedAt TTL be the backstop until the timestamp actually rolls over.
  const universeRegenDue = !!(cache.universe
    && typeof cache.universe.timestamp === 'number'
    && now - cache.universe.timestamp > UNIVERSE_REGEN_DUE
    && now - cache.universe.fetchedAt > UNIVERSE_RETRY_COOLDOWN
    && cache.universe.regenProbeTs !== cache.universe.timestamp);
  if (force || universeRegenDue || !isFresh(cache.universe, TTL.universe, now)) {
    await feed('universe', async () => {
      const prevTs = cache.universe ? cache.universe.timestamp : undefined;
      const u = parseUniverse(await fetchApiText('universe'));
      // A degenerate 200 (truncated body / interstitial page / API format change)
      // parses to zero planets and/or no root timestamp. Storing that with a fresh
      // fetchedAt would blank the occupancy index (every slot "free") for the whole
      // 7-day universe TTL. Treat it as a failed fetch — throw so `feed` keeps the
      // previous snapshot, leaves fetchedAt stale, and retries on the next load.
      if (u.timestamp == null || u.planets.length === 0) {
        throw new Error('degenerate universe parse (0 planets / no timestamp)');
      }
      cache.universe = {
        planets: u.planets,
        timestamp: u.timestamp,
        fetchedAt: now,
        ...(universeRegenDue && u.timestamp != null && u.timestamp === prevTs
          ? { regenProbeTs: u.timestamp }
          : {}),
      };
    });
  }
  if (force || !isFresh(cache.players, TTL.players, now)) {
    await feed('players', async () => {
      const p = parsePlayers(await fetchApiText('players'));
      // No root timestamp ⇒ degenerate/truncated body; don't overwrite good data
      // with an empty map + fresh fetchedAt (see the universe feed for the rule).
      if (p.timestamp == null) throw new Error('degenerate players parse (no timestamp)');
      cache.players = { players: p.players, timestamp: p.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.total, TTL.highscore, now)) {
    await feed('total', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '0' }));
      if (hs.timestamp == null) throw new Error('degenerate total highscore parse (no timestamp)');
      cache.total = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.military, TTL.highscore, now)) {
    await feed('military', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '3' }));
      if (hs.timestamp == null) throw new Error('degenerate military highscore parse (no timestamp)');
      cache.military = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.honor, TTL.highscore, now)) {
    await feed('honor', async () => {
      // Honour highscore (type 7): score = honour points, negative = bandit. Joined
      // by id in buildOccupancyIndex → synthesised rankClass → bandit/honoured scoring.
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '7' }));
      if (hs.timestamp == null) throw new Error('degenerate honor highscore parse (no timestamp)');
      cache.honor = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  // Lifetime-cumulative behaviour feeds for the danger model + Spyglass:
  // economy (type 1) — the civil baseline; military destroyed (type 5) — the
  // kill history only combat can move; military lost (type 6) — war
  // involvement / crash recency.
  if (force || !isFresh(cache.economy, TTL.lifetime, now)) {
    await feed('economy', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '1' }));
      if (hs.timestamp == null) throw new Error('degenerate economy highscore parse (no timestamp)');
      cache.economy = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.destroyed, TTL.lifetime, now)) {
    await feed('destroyed', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '5' }));
      if (hs.timestamp == null) throw new Error('degenerate destroyed highscore parse (no timestamp)');
      cache.destroyed = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.lost, TTL.lifetime, now)) {
    await feed('lost', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '6' }));
      if (hs.timestamp == null) throw new Error('degenerate lost highscore parse (no timestamp)');
      cache.lost = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.server, TTL.server, now)) {
    await feed('server', async () => {
      cache.server = { data: parseServerData(await fetchApiText('serverData')), fetchedAt: now };
    });
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
    military: { ranks: cache.military ? cache.military.ranks : {} },
    honor: { ranks: cache.honor ? cache.honor.ranks : {} },
    ownPlayerId,
  });

  // Danger profiles for the in-game scan planner (§6.7) — the SAME join the
  // dashboard's loadAll runs, over the same cache + live caches, so the Spy
  // FAB proposes exactly what the dashboard's plan strip lists first. Cheap
  // relative to the fetch/parse work above and computed once per context build.
  const danger = joinDangerProfiles({
    apiCache: cache,
    livePlayers: playersStore.get(),
    targetReports: targetReportsStore.get(),
    ownId: ownPlayerId,
  }).dangerProfiles;

  /** @type {ApiContext} */
  const ctx = {
    index,
    server: cache.server ? cache.server.data : {},
    // Raw occupied-planet rows — the in-game scan FAB maps watched player ids to
    // their planet coords through `domain/targets.playerPlanets` over this.
    universePlanets: cache.universe ? cache.universe.planets : [],
    military: {
      ranks: cache.military ? cache.military.ranks : {},
      timestamp: cache.military ? cache.military.timestamp : undefined,
    },
    danger,
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
