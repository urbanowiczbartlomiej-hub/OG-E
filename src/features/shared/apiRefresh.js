// @ts-check

// API-cache refresh — the single source of truth for turning the OGame public
// statistics feeds into the per-universe `state/apiCache` snapshot.
//
// Lives in `features/shared` (not `features/apiContext`) because BOTH callers
// need it and a feature may not import another feature (CLAUDE.md invariant):
//   • in-game — `features/apiContext.refreshCache` delegates here with no
//     origin/universeId, so it fetches SAME-ORIGIN and keys the cache off
//     `location.host`, exactly as before.
//   • dashboard — runs on the EXTENSION origin, so its manual "refresh" passes
//     the selected universe's `origin` + `universeId`, fetching cross-origin
//     (allowed by the manifest's existing `host_permissions`) and writing that
//     universe's cache slice.
//
// Freshness model: each feed has its own regeneration cadence, so a feed is
// fetched only when missing or past its TTL — everything else is served from the
// local cache, so a page navigation does NOT re-download the multi-MB
// `universe.xml`. `force: true` re-fetches every feed regardless of TTL (the
// dashboard refresh button and the opt-in in-game probe use it).

import { logger } from '../../lib/logger.js';
import { fetchApiText } from '../../lib/ogameApi.js';
import {
  parseUniverse,
  parsePlayers,
  parseHighscore,
  parseServerData,
} from '../../domain/apiOccupancy.js';
import {
  readApiCache,
  writeApiCache,
  readApiCacheFor,
  writeApiCacheFor,
} from '../../state/apiCache.js';

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
 * Ensure the local API cache is fresh: fetch only feeds that are missing or past
 * their cadence TTL, write back if anything changed. Does NOT build the
 * occupancy index (that's `features/apiContext.getContext`) — this is the cheap
 * path run in-game on every page load so the cache is warm for the dashboard,
 * and the path the dashboard's manual refresh drives directly.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]        Re-fetch every feed regardless of TTL.
 * @param {string} [opts.origin]        Absolute origin to fetch from
 *   (e.g. `https://s163-pl.ogame.gameforge.com`). Default: same-origin.
 * @param {string} [opts.universeId]    Which universe's cache slice to read/write.
 *   Default: the current universe (keyed off `location.host`).
 * @returns {Promise<{ cache: import('../../state/apiCache.js').ApiCache, fetched: string[] }>}
 */
export async function refreshApiCache(opts = {}) {
  const force = !!opts.force;
  const origin = opts.origin;
  const universeId = opts.universeId;
  const now = Date.now();
  const cache = universeId ? await readApiCacheFor(universeId) : await readApiCache();
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
      logger.warn(`apiRefresh: '${label}' refresh failed — keeping cached data`, err);
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
      const u = parseUniverse(await fetchApiText('universe', undefined, origin));
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
      const p = parsePlayers(await fetchApiText('players', undefined, origin));
      // No root timestamp ⇒ degenerate/truncated body; don't overwrite good data
      // with an empty map + fresh fetchedAt (see the universe feed for the rule).
      if (p.timestamp == null) throw new Error('degenerate players parse (no timestamp)');
      cache.players = { players: p.players, timestamp: p.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.total, TTL.highscore, now)) {
    await feed('total', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '0' }, origin));
      if (hs.timestamp == null) throw new Error('degenerate total highscore parse (no timestamp)');
      cache.total = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.military, TTL.highscore, now)) {
    await feed('military', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '3' }, origin));
      if (hs.timestamp == null) throw new Error('degenerate military highscore parse (no timestamp)');
      cache.military = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.honor, TTL.highscore, now)) {
    await feed('honor', async () => {
      // Honour highscore (type 7): score = honour points, negative = bandit. Joined
      // by id in buildOccupancyIndex → synthesised rankClass → bandit/honoured scoring.
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '7' }, origin));
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
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '1' }, origin));
      if (hs.timestamp == null) throw new Error('degenerate economy highscore parse (no timestamp)');
      cache.economy = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.destroyed, TTL.lifetime, now)) {
    await feed('destroyed', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '5' }, origin));
      if (hs.timestamp == null) throw new Error('degenerate destroyed highscore parse (no timestamp)');
      cache.destroyed = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.lost, TTL.lifetime, now)) {
    await feed('lost', async () => {
      const hs = parseHighscore(await fetchApiText('highscore', { category: '1', type: '6' }, origin));
      if (hs.timestamp == null) throw new Error('degenerate lost highscore parse (no timestamp)');
      cache.lost = { ranks: hs.ranks, timestamp: hs.timestamp, fetchedAt: now };
    });
  }
  if (force || !isFresh(cache.server, TTL.server, now)) {
    await feed('server', async () => {
      cache.server = { data: parseServerData(await fetchApiText('serverData', undefined, origin)), fetchedAt: now };
    });
  }

  if (changed) {
    if (universeId) await writeApiCacheFor(universeId, cache);
    else await writeApiCache(cache);
  }
  return { cache, fetched };
}
