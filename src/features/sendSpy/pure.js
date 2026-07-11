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
// needs a scan — no report on file, report older than the user's re-scan
// cadence, or an explicit re-scan flag — ranked by
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
import { buildGalaxyPlan, galaxyStaleMs } from '../../domain/galaxyWatch.js';

export { SPY_STALE_MS } from '../../domain/spyScan.js';

// Zone background colours (OG-E's own palette — not a game contract). The
// button's outer glow AND the brand-node's glyph ring are both driven by this
// colour (`--rim` / `--mod` in buttonChrome, mixed with transparent), so it has
// to be BRIGHT enough to actually cast a glow — the old `#3b3559` was so dark /
// desaturated that both halos vanished.
//
// ONE GOLD FAMILY. The first palette gave every state its own hue (indigo idle,
// slate-violet ready, azure Look, steel done, maroon error) — so the button
// changed identity per state, the glow hopped hues with it, and the oczko
// (always `--mod` = IDLE) matched the button in only one state. Now the spy
// identity is GOLD — a hue no other module wears (expedition #4aa8ff, colonize
// #12b3c2, daily #34d96e, lifeform #a78bfa) and the colour of OG-E's own brand
// lens — and every normal state is a shade of it, exactly how the other FABs
// speak (colony: teal idle → lit-teal ready): oczko, rim and glow stay one
// colour through idle/loading/Look/ready/done. The family sits on the PALE
// champagne side of gold on purpose: the Fleet-reminder button is a saturated
// orange (guardian RIM #f5851a), and a deeper gold read as its sibling. Only
// the two semantic states leave the family: error borrows the SHARED FAB error
// red, strike stays the hot "act now" orange-red (deliberately loud).
export const BG_SPY_IDLE = '#e6c054';
/** Armed "Send!" — the same gold, lit (the colony idle→ready treatment). */
export const BG_SPY_READY = '#f7dc66';
/** The shared FAB error red (sendExpedition/sendColony/sendLifeform). */
export const BG_SPY_ERROR = '#fb7185';
/** "All scanned → read reports" end state — the gold, muted. */
export const BG_SPY_DONE = '#a68d4a';
/** The galaxy-LOOK proposal — even paler champagne; the label carries the verb. */
export const BG_SPY_LOOK = '#eed27f';
/** STRIKE — a fresh fleet-landing candidate. Hot orange-red: "act now". */
export const BG_SPY_STRIKE = '#d1571f';

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
 *   & { playerNames?: Record<string, { name?: string }>,
 *       rings?: Record<string, Record<string, import('../../domain/activityObs.js').ActivityObs[]>>,
 *       galaxyMode?: Record<string, import('../../domain/scanMode.js').ScanMode>,
 *       rechecks?: Record<string, import('../../domain/fleetLanding.js').LandingRecheck> }} SpyEnv
 *   The planner env (see domain/scanPriority.js): watched players, universe
 *   planet rows, per-coord report freshness (planets AND moons), rescan flags,
 *   session sent-coords, the clock, the planet/moon scan filter, the scan-mode
 *   map + cadence, and — when available — per-player danger (D), activity
 *   summaries, the player-id → name map for the label, the galaxy-view
 *   activity rings (`rings`, from state/activityObs — look freshness for the
 *   galaxy-look plan), and the per-player galaxy toggle (`galaxyMode` — a
 *   player switched off in "Watch via" gets no look proposals).
 */

/**
 * A proposed galaxy LOOK: one system to browse, refreshing every galaxy-watched
 * body in it (passive, undetectable by the targets).
 * @typedef {object} SpyLook
 * @property {number} galaxy
 * @property {number} system
 * @property {number} bodies   How many needs-sight bodies the visit covers.
 * @property {string} [why]
 * @property {boolean} [recheck]  An ambiguous-moon re-look window is open here
 *   (fleetLanding) — the Look face words the nudge instead of the "N left" count.
 */

/**
 * @typedef {object} SpyContext
 * @property {'probe'|'look'|null} proposal  Which action the button proposes:
 *   a probe send (courier flow), a galaxy look (one-tap navigation), or null
 *   when both plans are empty ("all scanned" end state).
 * @property {SpyTarget | null} candidate   Next body to probe, or null.
 * @property {SpyLook | null} look          Top galaxy-look system, or null.
 * @property {number} remaining             Bodies + systems still needing attention.
 * @property {boolean} hasWatched           Any players are on the watch-list.
 * @property {boolean} [strike]             The probe proposal is a moon-strike
 *   candidate (painted distinctly).
 * @property {'lone'|'newest'|'any'} [strikeTier]  The strike's ladder rung —
 *   picks the hint wording ('any' concedes the owner may be around).
 * @property {string} [why]                 The proposal's wording-safe reason line.
 */

/**
 * Pure `env → SpyContext`: the TOP entries of BOTH intel plans — the probe
 * scan plan (`domain/scanPriority.buildScanPlan`) and the galaxy-look plan
 * (`domain/galaxyWatch.buildGalaxyPlan`) — unified into one "best next intel
 * action". Higher priority wins; ties go to the look (it's free: no probes, no
 * fleet slot, and the target never sees it). Coords already probed this
 * session are skipped by the probe plan; a browsed system self-clears from the
 * look plan the moment its `oge:galaxyScanned` ingest lands.
 *
 * @param {SpyEnv} env
 * @returns {SpyContext}
 */
export function deriveSpy(env) {
  const { entries } = buildScanPlan(env);
  const looks = buildGalaxyPlan({
    players: env.players,
    universePlanets: env.universePlanets,
    rings: env.rings,
    rescan: env.rescan,
    nowMs: env.nowMs,
    staleMs: galaxyStaleMs(env.cadence),
    dangerByPlayer: env.dangerByPlayer,
    galaxyMode: env.galaxyMode,
    rechecks: env.rechecks,
  }).entries;

  const top = entries.length ? entries[0] : null;
  const lookTop = looks.length ? looks[0] : null;
  const pickLook = !!lookTop && (!top || lookTop.priority >= top.priority);
  const name = top && env.playerNames ? env.playerNames[top.playerId]?.name : undefined;
  const why = pickLook ? lookTop?.why : top?.why;
  return {
    proposal: pickLook ? 'look' : (top ? 'probe' : null),
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
    look: lookTop
      ? {
        galaxy: lookTop.galaxy,
        system: lookTop.system,
        bodies: lookTop.bodies.length,
        ...(lookTop.why ? { why: lookTop.why } : {}),
        ...(lookTop.recheck ? { recheck: true } : {}),
      }
      : null,
    remaining: entries.length + looks.length,
    hasWatched: (env.players || []).length > 0,
    ...(!pickLook && top?.strike
      ? { strike: true, ...(top.strikeTier ? { strikeTier: top.strikeTier } : {}) }
      : {}),
    ...(why ? { why } : {}),
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
  if (!ctx.proposal) {
    return { text: 'Reports', subtext: 'all scanned ✓', bg: BG_SPY_DONE };
  }
  // Galaxy look — one tap navigates to the system; browsing it refreshes every
  // galaxy-watched body there (passive, the target never sees it).
  if (ctx.proposal === 'look' && ctx.look) {
    const l = ctx.look;
    return {
      text: 'Look',
      subtext: `[${l.galaxy}:${l.system}]${l.bodies > 1 ? ` ×${l.bodies}` : ''}`,
      // Re-look nudge: an ambiguous moon there is orderable NOW (the fuzzy
      // "<15" marks have matured into exact minutes) — say so instead of the
      // generic remaining count.
      hint: l.recheck ? 'moon order? · look now' : `${ctx.remaining} left`,
      bg: BG_SPY_LOOK,
    };
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
      text: ctx.strike ? 'Strike' : 'Spy',
      subtext: who,
      hint: `${preflight.have}/${preflight.need} probes`,
      bg: ctx.strike ? BG_SPY_STRIKE : BG_SPY_IDLE,
      pulse: true,
    };
  }
  // Strike — a moon-strike candidate: distinct hot paint + a 🎯 so the one
  // deliberate tap that confirms it reads unmistakably. The hint tracks the
  // signal's tier so the claim never outruns the evidence: 'lone' = the
  // classic just-landed signature, 'newest' = the trail points at a parked
  // fleet, 'any' concedes the owner may be around.
  if (ctx.strike) {
    const claim = ctx.strikeTier === 'any'
      ? 'owner around?'
      : ctx.strikeTier === 'newest'
        ? 'parked fleet?'
        : 'fresh landing?';
    return {
      text: 'Strike',
      subtext: `🎯 ${who}`,
      hint: `${claim} · spy to confirm`,
      bg: BG_SPY_STRIKE,
      pulse: true,
    };
  }
  // Line 3 is the remaining count — "N left" (planets + moons still to scan).
  // `pulse` rides every probe-PROPOSAL paint (this one, strike, the probe
  // shortage above): "there is something to scan" is exactly the state the
  // FAB should nudge about — never Look/done/idle/error/mid-send.
  return {
    text: 'Spy',
    subtext: who,
    hint: `${ctx.remaining} left`,
    bg: BG_SPY_IDLE,
    pulse: true,
  };
}
