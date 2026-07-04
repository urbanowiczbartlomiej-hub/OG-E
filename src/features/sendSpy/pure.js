// @ts-check

// Pure compute core of features/sendSpy/index.js — the espionage-scan FAB
// button. Mirrors features/sendColony/pure.js's split: this file owns the pure
// `deriveSpy(env)` → `renderSpy(ctx)` pipeline + the colour constants; index.js
// owns DOM paint, the courier-driven click handler, lifecycle, and the impure
// env capture.
//
// # What it computes
//
// The button proposes the TOP entry of the shared scan plan
// (`domain/scanPriority.buildScanPlan`): every watched player's planet that
// needs a scan — no report on file, report stale (per-player cadence: hot
// targets go stale sooner), or an explicit re-scan flag — ranked by
// danger × staleness × activity-window bonus. The dashboard's "suggested scan
// order" strip runs the SAME ranking, so both surfaces always agree on what's
// next. One tap sends one espionage fleet to that planet (via the shared
// fleetCourier — TOS: 1 click → 1 server action), then the button advances to
// the next. When nothing is left to scan it offers a "read reports" jump to
// the messages component (the user's PS request).
//
// No DOM, no timers, no storage, no `location` — the index.js orchestrator
// feeds everything through `env` and reads `location` at the call sites.

import { buildScanPlan } from '../../domain/scanPriority.js';

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
 * @typedef {import('../../domain/scanPriority.js').ScanPlanEnv} SpyEnv
 *   The planner env (see domain/scanPriority.js): watched players, universe
 *   planet rows, per-coord report freshness, rescan flags, session sent-coords,
 *   the clock, and — when the API context has them — per-player danger (D) and
 *   activity summaries for the priority ranking.
 */

/**
 * @typedef {object} SpyContext
 * @property {SpyTarget | null} candidate   Next planet to scan, or null when done.
 * @property {number} remaining             Planets still needing a scan.
 * @property {boolean} hasWatched           Any players are on the watch-list.
 * @property {string} [why]                 The candidate's wording-safe reason line.
 */

/**
 * Pure `env → SpyContext`: the TOP entry of the shared scan plan (see
 * `domain/scanPriority.buildScanPlan` — danger × staleness × window bonus,
 * deterministic tiebreak) plus how many planets still need a scan. Coords
 * already sent this session are skipped so the button advances instead of
 * re-proposing them while a probe is in flight.
 *
 * @param {SpyEnv} env
 * @returns {SpyContext}
 */
export function deriveSpy(env) {
  const { entries } = buildScanPlan(env);
  const top = entries.length ? entries[0] : null;
  return {
    candidate: top
      ? {
        galaxy: top.galaxy, system: top.system, position: top.position, playerId: top.playerId,
      }
      : null,
    remaining: entries.length,
    hasWatched: (env.players || []).length > 0,
    ...(top ? { why: top.why } : {}),
  };
}

/**
 * Pure `(SpyContext, preflight?) → Paint` for the idle / candidate / done
 * states. The armed "Send!" state is painted by the orchestrator (it owns the
 * courier step), the same split sendColony uses.
 *
 * `preflight` is the probe-availability readout (from the fleetdispatch
 * snapshot, when on that page): painting the shortage BEFORE the tap replaces
 * the old flow of discovering it via a failed select().
 *
 * @param {SpyContext} ctx
 * @param {{ have: number, need: number } | null} [preflight]
 * @returns {Paint}
 */
export function renderSpy(ctx, preflight) {
  if (!ctx.hasWatched) {
    return { text: 'Spy', subtext: 'no targets', bg: BG_SPY_IDLE, dim: true };
  }
  if (!ctx.candidate) {
    return { text: 'Reports', subtext: 'all scanned ✓', bg: BG_SPY_DONE };
  }
  const c = ctx.candidate;
  const coords = `[${c.galaxy}:${c.system}:${c.position}]`;
  if (preflight && preflight.have < preflight.need) {
    // Not enough probes on THIS planet for the armed order — say so up front.
    if (preflight.have <= 0) {
      return { text: 'No probes!', subtext: coords, bg: BG_SPY_ERROR };
    }
    return {
      text: 'Spy',
      subtext: `${coords} ·${ctx.remaining}`,
      hint: `${preflight.have}/${preflight.need} probes`,
      bg: BG_SPY_IDLE,
    };
  }
  return {
    text: 'Spy',
    subtext: `${coords} ·${ctx.remaining}`,
    bg: BG_SPY_IDLE,
  };
}
