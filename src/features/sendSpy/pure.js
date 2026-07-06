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
// button's outer glow AND the brand-node's glyph ring are both driven by this
// colour (`--rim` / `--mod` in buttonChrome, mixed with transparent), so it has
// to be BRIGHT enough to actually cast a glow — the old `#3b3559` was so dark /
// desaturated that both halos vanished (the button only "lit up" once it armed
// to the brighter ready colour). A vivid indigo keeps the spy identity while
// glowing like the other FABs (expedition #4aa8ff, colonize #12b3c2, daily
// #34d96e, lifeform #a78bfa). Ready stays the liked lit slate-blue, error red,
// steel-blue for the "all scanned → read reports" end state.
export const BG_SPY_IDLE = '#6355e6';
export const BG_SPY_READY = '#6a5acd';
export const BG_SPY_ERROR = '#7a2f2f';
export const BG_SPY_DONE = '#34506b';

/**
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 * @typedef {Coords & { playerId: string, bodyType?: 1|3, name?: string }} SpyTarget
 *   A body to scan: coords + owner id, the body type (1 planet / 3 moon — the
 *   FAB targets the right one), and the owner's resolved display name (for the
 *   button label; absent until the apiContext players map has it).
 * @typedef {import('../sendColony/pure.js').Paint} Paint
 */

/**
 * @typedef {import('../../domain/scanPriority.js').ScanPlanEnv
 *   & { playerNames?: Record<string, { name?: string }> }} SpyEnv
 *   The planner env (see domain/scanPriority.js): watched players, universe
 *   planet rows, per-coord report freshness (planets AND moons), rescan flags,
 *   session sent-coords, the clock, the planet/moon scan filter, and — when the
 *   API context has them — per-player danger (D), activity summaries, and the
 *   player-id → name map for the label.
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
  const name = top && env.playerNames ? env.playerNames[top.playerId]?.name : undefined;
  return {
    candidate: top
      ? {
        galaxy: top.galaxy,
        system: top.system,
        position: top.position,
        playerId: top.playerId,
        bodyType: top.bodyType,
        ...(name ? { name } : {}),
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
  // Line 2 is WHO we're about to scan (the player), not the raw coords — the
  // user reads the target by name; the coords still show on the armed "Send!"
  // confirmation (painted by the orchestrator). Falls back to coords when the
  // name isn't resolved yet. A 🌙 marks a moon body.
  const who = (c.name || `[${c.galaxy}:${c.system}:${c.position}]`) + (c.bodyType === 3 ? ' 🌙' : '');
  if (preflight && preflight.have < preflight.need) {
    // Not enough probes on THIS planet for the armed order — say so up front.
    if (preflight.have <= 0) {
      return { text: 'No probes!', subtext: who, bg: BG_SPY_ERROR };
    }
    return {
      text: 'Spy',
      subtext: who,
      hint: `${preflight.have}/${preflight.need} probes`,
      bg: BG_SPY_IDLE,
    };
  }
  // Line 3 is the remaining count — "N left" (planets + moons still to scan).
  return {
    text: 'Spy',
    subtext: who,
    hint: `${ctx.remaining} left`,
    bg: BG_SPY_IDLE,
  };
}
