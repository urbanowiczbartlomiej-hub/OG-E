// @ts-check

// Pure compute core of features/sendSpy/index.js — the espionage-scan FAB
// button. Mirrors features/sendColony/pure.js's split: this file owns the pure
// `deriveSpy(env)` → `renderSpy(ctx)` pipeline + the colour constants; index.js
// owns DOM paint, the courier-driven click handler, lifecycle, and the impure
// env capture.
//
// # What it computes
//
// The button walks the user's WATCH-LIST (players starred in the dashboard
// Targets sub-tab) and proposes the next planet that needs a scan — one whose
// owner has no spy report on file, or whose newest report is stale (> 7 days,
// since defenses/fleet drift). One tap sends one espionage fleet to that planet
// (via the shared fleetCourier — TOS: 1 click → 1 server action), then the
// button advances to the next. When nothing is left to scan it offers a "read
// reports" jump to the messages component (the user's PS request).
//
// No DOM, no timers, no storage, no `location` — the index.js orchestrator
// feeds everything through `env` and reads `location` at the call sites.

import { playerPlanets } from '../../domain/targets.js';
import { scanStatus, needsScan, rescanAtFor, SPY_STALE_MS } from '../../domain/spyScan.js';

export { SPY_STALE_MS } from '../../domain/spyScan.js';

// Zone background colours (OG-E's own palette — not a game contract). The
// button's outer glow is driven by the zone colour (`--rim` in buttonChrome),
// so every state stays in the spy button's indigo family: muted indigo idle, a
// lit slate-blue when armed-ready (NOT the colonize green — that glow clashed
// with the indigo identity), red on error, steel-blue for the "all scanned →
// read reports" end state.
export const BG_SPY_IDLE = '#3b3559';
export const BG_SPY_READY = '#6a5acd';
export const BG_SPY_ERROR = '#7a2f2f';
export const BG_SPY_DONE = '#34506b';

/**
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 * @typedef {Coords & { playerId: string }} SpyTarget
 * @typedef {import('../sendColony/pure.js').Paint} Paint
 */

/**
 * @typedef {object} SpyEnv
 * @property {string[]} players                Watched player ids (scan order).
 * @property {Array<{coords: string, player?: number}>} universePlanets
 *   universe.xml occupancy rows (source of each player's planet coords).
 * @property {Record<string, Record<string, number>>} spiedByPlayer
 *   playerId → ("g:s:p" coord → newest report ts, epoch SECONDS).
 * @property {Set<string>} [sentCoords]        "g:s:p" coords sent this session (skip).
 * @property {Record<string, number>} [rescan]  player id / "g:s:p" coord → re-scan-requested ts (ms).
 * @property {number} nowMs                    Clock for staleness.
 * @property {number} [staleMs]                Stale threshold (default SPY_STALE_MS).
 */

/**
 * @typedef {object} SpyContext
 * @property {SpyTarget | null} candidate   Next planet to scan, or null when done.
 * @property {number} remaining             Planets still needing a scan.
 * @property {boolean} hasWatched           Any players are on the watch-list.
 */

/**
 * Pure `env → SpyContext`: the next planet needing a scan (no report, stale, or
 * re-scan-flagged — see `domain/spyScan.scanStatus`) across the watched players
 * (in watch-list order, planets galaxy→system→position via {@link playerPlanets})
 * plus how many remain. Coords already sent this session are skipped so the
 * button advances instead of re-proposing them while a probe is in flight.
 *
 * @param {SpyEnv} env
 * @returns {SpyContext}
 */
export function deriveSpy(env) {
  const players = env.players || [];
  const staleMs = env.staleMs ?? SPY_STALE_MS;
  /** @type {SpyTarget | null} */
  let candidate = null;
  let remaining = 0;
  for (const pid of players) {
    const coordTs = env.spiedByPlayer ? env.spiedByPlayer[pid] : undefined;
    for (const p of playerPlanets(env.universePlanets, pid)) {
      const coord = `${p.galaxy}:${p.system}:${p.position}`;
      if (env.sentCoords && env.sentCoords.has(coord)) continue;
      const status = scanStatus({
        reportTsSec: coordTs ? coordTs[coord] : undefined,
        nowMs: env.nowMs,
        rescanAtMs: rescanAtFor(env.rescan, pid, coord),
        staleMs,
      });
      if (needsScan(status)) {
        remaining += 1;
        if (!candidate) candidate = { ...p, playerId: pid };
      }
    }
  }
  return { candidate, remaining, hasWatched: players.length > 0 };
}

/**
 * Pure `SpyContext → Paint` for the idle / candidate / done states. The armed
 * "Send!" state is painted by the orchestrator (it owns the courier step), the
 * same split sendColony uses.
 *
 * @param {SpyContext} ctx
 * @returns {Paint}
 */
export function renderSpy(ctx) {
  if (!ctx.hasWatched) {
    return { text: 'Spy', subtext: 'no targets', bg: BG_SPY_IDLE, dim: true };
  }
  if (!ctx.candidate) {
    return { text: 'Reports', subtext: 'all scanned ✓', bg: BG_SPY_DONE };
  }
  const c = ctx.candidate;
  return {
    text: 'Spy',
    subtext: `[${c.galaxy}:${c.system}:${c.position}] ·${ctx.remaining}`,
    bg: BG_SPY_IDLE,
  };
}
