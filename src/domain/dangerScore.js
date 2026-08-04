// @ts-check

// Per-PLAYER danger model (v3) — one coherent 0..1 scalar `D` per player, the
// substrate the threat field and the map colours read, replacing the old
// per-position `militaryScore / (2·ownMilitary)` heuristic that was blind to
// the single most important OGame fact: military POINTS are fleet + DEFENSE
// combined, and defense cannot attack anyone.
//
// The game-changer is free and server-wide: the military highscore (type 3,
// fetched hourly) carries a per-player `ships` COUNT, and the "military
// destroyed" highscore (type 5) is a lifetime kill history that ONLY combat
// moves (production and expeditions never touch it). Together they separate
// the harmless defensive whale (10–100× your military, all bunker, 0–few
// ships) from the real aggressor (fleet + a trail of kills), which points
// alone never could.
//
// v3 fixes two calibration failures of v2, both traced to the SCALE:
//   1) TOO MANY 100/100 — v2's `strength = mobileMil/(2·ownMilitary)` saturated
//      for every player ≥2× your own military, so on a mature server the whole
//      upper half piled at the ceiling. v3 makes strength ABSOLUTE and
//      percentile-anchored: `strength = pctRank(serverCombatMil) / 0.975`, so
//      only the top ~2.5% of the server's real combat fleet reaches ~1.0. This
//      also decouples D from your own fleet — correct, because the field's job
//      is "who could crush a fresh colony here", and a fresh colony has ~0 fleet.
//   2) CARGO-SWARM FALSE POSITIVES — a hoard of small transporters / probes is a
//      huge ship COUNT and a huge military POINT total, yet is worthless in
//      combat. v3 reads the free composition tell `res/ship = militaryPts·1000 /
//      ships`: a cheap swarm sits ~1–4k/ship, real warships ~30–150k/ship, and a
//      defense-inflated bunker reads very HIGH (defence is folded into the score,
//      not the count). A quality factor `q(res/ship)` discounts both the swarm
//      and the bunker in the combat estimate (medium gate — floor 0.4, never a
//      hard zero, since a swarm can still hide a real detachment).
//
// Reach (dispersion) is a first-class aggressor tell: an aggressor scatters
// planets to sit within striking range of many victims (a wide system spread
// across a few galaxies, plus a couple of very-close bodies for a safe
// inter-planet fleet-save); a builder CLUSTERS. The owner's certainty is
// asymmetric — a clustered empire is a reliable "not aggressive" signal, while
// spread only PERMITS aggression — so clustering damps reach hard, and the
// close-FS-pair is a weak, reason-only tell that can never rescue a cluster.
//
// Bounds, not false precision. `ships`/`destroyed` are contaminated in both
// directions, so we never pretend to know the exact fleet — we bound the MOBILE
// (attack-capable) military and lean the point estimate with cheap, robust
// signals: ship count, kill history, bandit tier and planet dispersion.
//
// Friendly players (your alliance / buddies) are excluded outright — D = 0.
// Honoured players get NO threat boost.
//
// Pure: plain functions over plain data. No DOM/timers/storage/chrome.
//
// @see domain/heatField.js — reads D per occupant to build the threat field.
// @see domain/cellClass.js — reads D for the occupancy map's threat intensity.

import { honorClass } from './apiOccupancy.js';
import { honorRank } from './players.js';
import { isWarriorAlliance } from './allianceClass.js';
import { estimateCombatShare } from './threatModel.js';
import { pointsToResources } from './unitCosts.js';

/**
 * @typedef {'apex'|'raider'|'declawed'|'fortress'|'turtle'|'fleeter'|'cargo'|'eco'|'friendly'|'unknown'} DangerLabel
 */

/**
 * One apex tell — a single named signal in the {@link ApexBreakdown} scorecard.
 * @typedef {object} ApexTell
 * @property {string} key    Stable id (`ships`|`resPerShip`|`warrior`|`reach`|`kills`|`fsSpot`).
 * @property {string} label  Short keyword shown in the scorecard chip (UI rule: keywords, not sentences).
 * @property {boolean} fired Whether this tell's threshold was met.
 */

/**
 * Structured apex breakdown — the 6 tells behind {@link DangerProfile.apexSignals},
 * split into the two model legs so the dossier can render a scorecard that shows
 * WHICH signals fired (and which are missing) instead of a bare `N/6`. Present
 * only when the apex bonus fired (≥2 tells incl. ≥1 aggression).
 * @typedef {object} ApexBreakdown
 * @property {number} total  Fired-tell count (0..6) — mirrors `apexSignals`.
 * @property {ApexTell[]} capability  Top ships, res/ship, warrior (aggression-agnostic).
 * @property {ApexTell[]} aggression  Reach, kills, FS spot (demonstrated aggression).
 */

/**
 * One player's danger profile. `danger` is the field/strength scalar (×100 for
 * display); everything else explains WHY, so the UI can justify a colour
 * instead of asserting one.
 *
 * @typedef {object} DangerProfile
 * @property {number} id
 * @property {number} danger        0..1 — the threat scalar D (×100 = display).
 * @property {number} mobileMil     Point estimate of ATTACK-CAPABLE military
 *   points (fleet, defense excluded). NOT combat-quality-discounted — this stays
 *   an honest points bound; the quality discount `q` lives in the scalar only.
 * @property {number} mobileLo      Lower bound of mobile military.
 * @property {number} mobileHi      Upper bound (≤ total military).
 * @property {'spied'|'ships'|'prior'} provenance  How mobileMil was derived:
 *   `spied` = exact (fully-spied: fleet = military − known defense); `ships`
 *   = bounded by the ship count (0 ships = a hard 0), tightened by any partial
 *   spy; `prior` = the feed carried no ship count, so a modelled mobility
 *   fraction was used.
 * @property {number} predator      0..1 — hunts (kill history × combat-graded ships).
 * @property {number} banditTier    0..3.
 * @property {boolean} friendly     Your alliance / buddy — never a threat.
 * @property {number} [ships]       Ship count echo (undefined = unknown).
 * @property {number} [destroyed]   Lifetime military-destroyed echo.
 * @property {number} [resPerShip]  Estimated REAL resources per ship of the mobile
 *   fleet (mobileMil points inverted through the composition prior — civil ships
 *   weigh ×0.5 in the score). Undefined = ships unknown/0.
 * @property {number} [combatQuality]  q(res/ship) in 0..1 — how combat-grade the hulls look.
 * @property {number} [combatShare]  0.05..0.95 — assumed combat share BY VALUE of the
 *   player's fleet (spied composition + aggression lean); the pts→res knob.
 * @property {number} [reach]       0..1 — tactical dispersion / striking reach.
 * @property {number} [spread]      0..1 — fraction of planets NOT in a huddle (the
 *   raw geometry behind reach; {@link isMinerProfile} reads it).
 * @property {number} [galaxies]    Distinct galaxies the empire occupies.
 * @property {number} [planetCount] Planets in the universe snapshot.
 * @property {number} [apexSignals] 0..6 — how many apex tells fired (top ships,
 *   optimal res/ship, warrior alliance, reach, kills, FS spot). Denominator =
 *   APEX_TELLS_TOTAL.
 * @property {ApexBreakdown} [apex]  Structured 6-tell breakdown, present only when
 *   the apex bonus fired (≥2 tells incl. ≥1 aggression). The dossier renders it as
 *   a scorecard; `apexSignals` stays the scalar the terse tooltips read.
 * @property {string} [allianceId]    Player's alliance id (players.xml), for the
 *   dashboard's "alliance class unknown → open the ranking" deep link.
 * @property {string} [allianceClass] Resolved alliance class slug ('warrior' |
 *   'trader' | 'explorer' | 'none'). Absent = class not known for this player's
 *   alliance (drives the unknown-class hint).
 * @property {DangerLabel} label
 * @property {string[]} reasons     Short human phrases for the tooltip.
 */

/** Clamp to 0..1. @param {number} n */
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Compact magnitude for the reason strings (4.2G / 47.9M / 340k / 12). @param {number} n */
const fmt = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
};

/**
 * Fraction of the (ascending-sorted) population strictly below `v` — the
 * percentile rank in 0..1. Empty population → 0.
 * @param {number[]} sortedAsc
 * @param {number} v
 * @returns {number}
 */
const pctRank = (sortedAsc, v) => {
  const n = sortedAsc.length;
  if (!n) return 0;
  // binary search for the first index whose value is >= v
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / n;
};

/**
 * INCLUSIVE percentile rank — fraction of the (ascending-sorted) population `<= v`.
 * Unlike {@link pctRank} (strictly-below), the maximum element maps to 1.0, so a
 * lone or fully-tied top holder saturates instead of collapsing to 0 — the right
 * behaviour for "where do I sit in the distribution, counting myself". Empty → 1
 * (a value with no comparison set is, vacuously, the top). Used for `strength`.
 * @param {number[]} sortedAsc
 * @param {number} v
 * @returns {number}
 */
const pctRankLE = (sortedAsc, v) => {
  const n = sortedAsc.length;
  if (!n) return 1;
  // binary search for the first index whose value is > v (upper bound)
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / n;
};

/**
 * Combat-quality factor `q ∈ [0.4, 1]` from resources-per-ship — the free
 * composition tell. A cheap-hull swarm (probes / small transporters, ~1–4k) is
 * worthless in combat; real warships live ~30–150k; a very HIGH figure means
 * the military score is defence, not fleet (defence inflates points without ship
 * count). MEDIUM gate: it never zeroes (floor 0.4) — a swarm can still ferry a
 * hidden combat detachment — it just discounts. All thresholds heuristic/tunable.
 * @param {number} rps  resources per ship (militaryPts·1000/ships)
 * @returns {number}
 */
export const combatQuality = (rps) => {
  if (!(rps > 0)) return 0.2;
  if (rps <= 3_000) return 0.2; // pure probe / small-transporter swarm — heavily discounted
  if (rps <= 15_000) return 0.2 + (0.4 * (rps - 3_000)) / 12_000; // → 0.60
  if (rps <= 40_000) return 0.6 + (0.4 * (rps - 15_000)) / 25_000; // → 1.00
  if (rps <= 150_000) return 1.0; // prime warship window
  if (rps <= 500_000) return 1.0 - (0.4 * (rps - 150_000)) / 350_000; // → 0.60 (defence/RIP-inflated)
  return 0.6;
};

/**
 * @typedef {object} ReachInfo
 * @property {number} reach     0..1 — tactical striking reach (spread-dominant).
 * @property {number} galaxies  Distinct galaxies occupied.
 * @property {number} spread    0..1 — fraction of planets NOT in a defensive huddle.
 * @property {number} planets   Planet count the metrics were computed from.
 * @property {boolean} fsPair   A same/adjacent-system own-planet pair exists.
 * @property {boolean} fsSpot   The AGGRESSOR overnight-FS tell: an FS pair amid an
 *   otherwise-spread empire (spread high). A clustered empire that merely happens
 *   to have close planets (a defensive huddle) is NOT an fsSpot.
 */

/** OGame galaxy width in systems — distance wraps (system 1 and 499 are neighbours). */
const GALAXY_SYSTEMS = 499;
/** Same-galaxy neighbour within this many systems ⇒ the planet is part of a huddle (defensive/eco). */
const CLUSTER_GAP = 25;
/** Same/adjacent system ⇒ a tight FS pair (the overnight inter-planet fleet-save cycle). */
const FS_GAP = 1;

/** Circular system distance within a galaxy (1..499 wrap). @param {number} a @param {number} b */
const sysDist = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, GALAXY_SYSTEMS - d);
};

/**
 * Tactical reach from a player's planet coordinates. The aggressor signature the
 * owner described: planets SPREAD to sit within striking range of many victims,
 * plus exactly ONE tight pair (the overnight FS cycle, fleet flying between two
 * own planets in one system) — the rest are dispersed strike/teleport spots
 * (depesza / GumkaVIP / Wlodek / pawel1000). The counter-pattern is a defensive
 * HUDDLE: many planets bunched in nearby systems, plus a couple of far spots only
 * to avoid losing every moon to one RIP raid (Qbaba) — high planet-count but low
 * reach. So reach is driven by SPREAD = the fraction of planets that are NOT in a
 * huddle (no same-galaxy neighbour within CLUSTER_GAP), which is robust to a lone
 * far outlier. `fsSpot` — the aggressor overnight-FS tell — fires ONLY when a tight
 * pair sits amid an otherwise-spread empire, so a cluster with close planets never
 * trips it.
 * @param {Array<{g:number,s:number}>} planets
 * @returns {ReachInfo}
 */
const computeReach = (planets) => {
  const galaxies = planets ? new Set(planets.map((p) => p.g)).size : 0;
  if (!planets || planets.length < 2) {
    return { reach: 0, galaxies, spread: 0, planets: planets ? planets.length : 0, fsPair: false, fsSpot: false };
  }
  /** @type {Map<number, number[]>} */
  const byGalaxy = new Map();
  for (const p of planets) {
    let arr = byGalaxy.get(p.g);
    if (!arr) { arr = []; byGalaxy.set(p.g, arr); }
    arr.push(p.s);
  }
  const total = planets.length;
  let clustered = 0;
  let fsPair = false;
  for (const sys of byGalaxy.values()) {
    for (let i = 0; i < sys.length; i++) {
      let huddled = false;
      for (let j = 0; j < sys.length; j++) {
        if (i === j) continue;
        const d = sysDist(sys[i], sys[j]);
        if (d <= CLUSTER_GAP) huddled = true;
        if (d <= FS_GAP) fsPair = true;
      }
      if (huddled) clustered += 1;
    }
  }
  const spread = clamp01(1 - clustered / total);
  const galaxyFootprint = clamp01((galaxies - 1) / 3); // 1→0, 4+→1 (plateau)
  // Spread GATES reach (a huddle scores ~0 whatever the galaxy count); galaxy
  // footprint only amplifies an already-spread empire.
  const reach = clamp01(spread * (0.7 + 0.3 * galaxyFootprint));
  const fsSpot = spread >= 0.5 && fsPair;
  return { reach, galaxies, spread, planets: total, fsPair, fsSpot };
};

/**
 * @typedef {object} DangerInput
 * @property {Record<string, {score?:number, ships?:number}>} [military]  Military
 *   highscore (type 3): id → {score, ships}. `ships` absent on a present row = 0
 *   (server omits it for pure-defense accounts) — but only trust that when the
 *   feed carries the attribute AT ALL (see `feedHasShips`); else ships is unknown.
 * @property {Record<string, {score?:number}>} [destroyed]  Military destroyed
 *   (type 5): id → {score}. Lifetime kill history.
 * @property {Record<string, {position?:number, score?:number}>} [honor]  Honour
 *   highscore (type 7): id → {position, score}. Negative score = bandit.
 * @property {number} [honorTotal]  Ranked-player count (honour feed length),
 *   for {@link honorClass}'s bottom-N bandit thresholds.
 * @property {Record<string, {alliance?:string, status?:string}>} [apiPlayers]
 *   players.xml: id → {alliance, status}. Alliance id joins the own-alliance test.
 * @property {Record<number, import('./players.js').PlayerMeta>} [players]  Live
 *   player cache — read for flags (buddy / allianceMember) and a live rankClass
 *   fallback when the honour feed is thin.
 * @property {Array<{coords:string, player?:number}>} [universePlanets]  Raw
 *   occupied-planet rows — per-player planet coords for the reach signal.
 * @property {Record<string, {defensePts:number, coverageComplete:boolean, spiedCount:number, planetCount?:number, allianceClass?:string, visibleCombatShare?:number}>} [spied]
 *   Per-player spy summary (from `estimateHiddenFleet`): the defence points we
 *   have seen and whether coverage is complete. Fully spied → fleet = military
 *   − defence EXACTLY (the precise refinement of the ships bound). Partial →
 *   seen defence is a floor, so military − seen-defence is an UPPER bound.
 *   `allianceClass` is the newest report's alliance class icon ('warrior' |
 *   'trader' | 'explorer') — a spy-report FALLBACK source for the class (the
 *   public API has none). Superseded by `allianceClasses` when the ranking has
 *   been harvested; 'warrior' reads as an apex capability tell + a small lift.
 * @property {Record<string, string>} [allianceClasses]  allianceId → class slug
 *   ('warrior' | 'trader' | 'explorer' | 'none'), harvested from the ALLIANCE
 *   highscore DOM (state/allianceClass). The comprehensive, spy-free source for
 *   the warrior-alliance tell — joined per player via `apiPlayers[id].alliance`.
 * @property {number} [ownMilitary]  Your military points — kept for callers/UI,
 *   no longer the strength anchor (v3 strength is absolute/percentile).
 * @property {string} [ownId]        Your player id (to read your own alliance).
 * @property {string} [ownAlliance]  Your alliance id (own-alliance exclusion).
 */

/**
 * Bandit / honoured tier for a player, from the synthesised honour class
 * (whole-server, no live scan) with a live-scan rankClass fallback.
 * @param {string} id
 * @param {DangerInput} input
 * @param {import('./players.js').PlayerMeta | undefined} meta
 * @returns {{ banditTier: number, honoredTier: number }}
 */
const honourTiers = (id, input, meta) => {
  const row = input.honor ? input.honor[id] : undefined;
  const rc = honorClass(row, input.honorTotal ?? 0) ?? (meta ? meta.rankClass : undefined);
  const hr = honorRank(rc);
  if (!hr) return { banditTier: 0, honoredTier: 0 };
  return hr.kind === 'bandit'
    ? { banditTier: hr.tier, honoredTier: 0 }
    : { banditTier: 0, honoredTier: hr.tier };
};

// ── Danger assembly weights — all heuristic, tunable. ─────────────────────────
/** Percentile at which combat strength saturates to 1.0 (top ~2.5% of server combat fleet). */
const STRENGTH_TOP_PCT = 0.975;
/** How much tactical reach lifts danger directly (an aggressor's striking radius). */
const REACH_WEIGHT = 0.22;
/** Active-but-unremarkable floor — a dim, non-zero red for any player who CAN fly. */
const ACTIVE_BASE = 0.08;
/** Apex tell thresholds. */
const APEX_SHIPS_PCT = 0.95; // top 5% ship count (absolute)
const APEX_Q = 0.85; // res/ship in the warship window
const APEX_REACH = 0.55; // tactically spread
const APEX_DESTROYED_PCT = 0.9; // top 10% kill history
/**
 * Total apex tells that can fire — the display denominator of the
 * "apex signals N/…" reason. 3 capability (top ships, optimal res/ship,
 * warrior-class alliance) + 3 aggression (reach, kill history, FS spot).
 * MUST track the tell sums in pass 2 — the old hardcoded "/4" drifted into
 * the impossible "5/4" once the fsSpot tell landed.
 */
const APEX_TELLS_TOTAL = 6;
/**
 * Direct danger lift for a warrior-class ALLIANCE (spy-report intel): the
 * whole alliance opted into the combat class (fleet bonuses), a deliberate
 * combat-oriented context. Small — a context tell, not demonstrated
 * aggression; it consumes headroom via the same soft ceiling as the rest.
 */
const WARRIOR_ALLIANCE_WEIGHT = 0.05;

/**
 * Build every player's {@link DangerProfile} from the API feeds. Two passes:
 * pass 1 estimates each player's combat-mobile military (bounded, quality-graded
 * by res/ship) and collects the server distribution; pass 2 turns that into an
 * absolute percentile strength and the final danger scalar. Profiles are built
 * for every player in the military OR honour feed.
 *
 * @param {DangerInput} input
 * @returns {Map<number, DangerProfile>}
 */
export const buildDangerProfiles = (input) => {
  const military = input.military ?? {};
  const destroyed = input.destroyed ?? {};
  const apiPlayers = input.apiPlayers ?? {};
  const players = input.players ?? {};
  // Alliance id → class slug, harvested from the ALLIANCE highscore DOM
  // (state/allianceClass). The comprehensive, spy-free source for the 'warrior
  // alliance' tell — joined per player via `apiPlayers[id].alliance`.
  const allianceClasses = input.allianceClasses ?? {};

  // Does the military feed carry the ships attribute at all? A feed cached by
  // a pre-`ships` parser (or a server that doesn't emit it) has it on no row —
  // then "absent = 0 ships" would paint every player a confident, wrong
  // "cannot attack". One carrying row (any real server has fleeters) is proof.
  const feedHasShips = Object.values(military).some((r) => typeof r.ships === 'number');

  // Server distributions for the percentile signals.
  /** @type {number[]} */ const shipsVals = [];
  /** @type {number[]} */ const destroyedVals = [];
  /** @type {number[]} */ const militaryVals = [];
  for (const id of Object.keys(military)) {
    const m = military[id];
    if (typeof m.score === 'number' && m.score > 0) militaryVals.push(m.score);
    if (feedHasShips && typeof m.ships === 'number' && m.ships > 0) shipsVals.push(m.ships);
  }
  for (const id of Object.keys(destroyed)) {
    const d = destroyed[id];
    if (typeof d.score === 'number' && d.score > 0) destroyedVals.push(d.score);
  }
  shipsVals.sort((a, b) => a - b);
  destroyedVals.sort((a, b) => a - b);
  militaryVals.sort((a, b) => a - b);

  // Reach: per-player planet coordinates → tactical dispersion. One pass over
  // the raw rows collects {galaxy, system} per player, then computeReach scores it.
  /** @type {Map<number, Array<{g:number,s:number}>>} */
  const planetsByPlayer = new Map();
  for (const pl of input.universePlanets ?? []) {
    if (pl.player == null || !pl.coords) continue;
    const parts = pl.coords.split(':');
    const g = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!Number.isFinite(g) || !Number.isFinite(s)) continue;
    let arr = planetsByPlayer.get(pl.player);
    if (!arr) { arr = []; planetsByPlayer.set(pl.player, arr); }
    arr.push({ g, s });
  }
  /** @type {Map<number, ReachInfo>} */
  const reachByPlayer = new Map();
  for (const [pid, planets] of planetsByPlayer) reachByPlayer.set(pid, computeReach(planets));

  const ownAlliance = input.ownAlliance
    || (input.ownId && apiPlayers[input.ownId] ? apiPlayers[input.ownId].alliance : undefined);

  /** @type {Map<number, DangerProfile>} */
  const out = new Map();
  const ids = new Set([...Object.keys(military), ...Object.keys(input.honor ?? {})]);

  // ── Pass 1: per-player combat-mobile estimate + the server combatMil distribution. ──
  /**
   * @typedef {object} Partial
   * @property {number} id
   * @property {number} militaryPts
   * @property {number|undefined} ships
   * @property {number} destroyedPts
   * @property {number} banditTier
   * @property {number} destroyedPct
   * @property {number} shipsPct
   * @property {number} mobileLo
   * @property {number} mobileHi
   * @property {number} mobileMil
   * @property {'spied'|'ships'|'prior'} provenance
   * @property {number|undefined} rps
   * @property {number} q
   * @property {number} combatMil
   * @property {number} combatShare  Assumed combat share BY VALUE (the pts→res knob).
   * @property {ReachInfo} reach
   * @property {{spiedCount:number, planetCount?:number}|undefined} spy
   * @property {boolean} warriorAlliance  The player's ALLIANCE is warrior-class
   *   (combat bonuses) — from the highscore harvest OR a spy report; an apex
   *   capability tell.
   * @property {string|undefined} allianceId    Player's alliance id (players.xml).
   * @property {string|undefined} allianceClass Resolved class slug ('warrior' |
   *   'trader' | 'explorer' | 'none'), or undefined = alliance class not known.
   */
  /** @type {Partial[]} */
  const partials = [];
  /** @type {number[]} */
  const combatMilVals = [];

  for (const idStr of ids) {
    const id = Number(idStr);
    if (!Number.isFinite(id)) continue;
    const meta = players[id];
    const flags = meta ? meta.flags : undefined;

    // ── Friendly: your alliance (tag match) or a buddy → never a threat. ──
    const inOwnAlliance = !!(ownAlliance && apiPlayers[idStr] && apiPlayers[idStr].alliance === ownAlliance);
    const friendly = !!(flags && (flags.buddy || flags.allianceMember)) || inOwnAlliance;
    if (friendly) {
      out.set(id, {
        id, danger: 0, mobileMil: 0, mobileLo: 0, mobileHi: 0, provenance: 'prior',
        predator: 0, banditTier: 0, friendly: true, label: 'friendly',
        reasons: ['your alliance / buddy — not a threat'],
      });
      continue;
    }

    const mil = military[idStr];
    // Number('<garbage>') is NaN and passes `typeof === 'number'`, so guard
    // with isFinite — an unguarded NaN would propagate through clamp01 all the
    // way to `danger`, poisoning the field and the badge.
    const militaryPts = mil && Number.isFinite(mil.score) ? /** @type {number} */ (mil.score) : 0;
    // Attribute absent (undefined) OR present-but-garbage (NaN) → 0 ships;
    // only a real number counts. Feed lacking the attribute entirely → unknown.
    const ships = mil && feedHasShips ? (Number.isFinite(mil.ships) ? /** @type {number} */ (mil.ships) : 0) : undefined;
    const destroyedPts = destroyed[idStr] && Number.isFinite(destroyed[idStr].score)
      ? /** @type {number} */ (destroyed[idStr].score) : 0;
    const { banditTier } = honourTiers(idStr, input, meta);

    const destroyedPct = destroyedPts > 0 ? pctRank(destroyedVals, destroyedPts) : 0;
    const shipsPct = typeof ships === 'number' && ships > 0 ? pctRank(shipsVals, ships) : (ships === 0 ? 0 : 0.4);
    const reach = reachByPlayer.get(id) ?? { reach: 0, galaxies: 0, spread: 0, planets: 0, fsPair: false, fsSpot: false };
    const dispersion = clamp01((reach.galaxies - 1) / 3);

    // ── Mobile (attack-capable) military — bounded, never fake-precise. ──
    let mobileLo = 0;
    let mobileHi = militaryPts;
    let mobileMil;
    /** @type {'spied'|'ships'|'prior'} */
    let provenance;
    if (typeof ships === 'number') {
      provenance = 'ships';
      if (ships === 0) {
        // Hard: no ships = no attack, whatever the point total.
        mobileMil = 0; mobileLo = 0; mobileHi = 0;
      } else {
        mobileLo = ships; // ≥ 1 pt/ship (a probe is ~1 pt)
        mobileHi = Math.max(militaryPts, mobileLo);
        // Mobility prior: how much of the military is likely FLEET, leant by
        // cheap offensive tells. Bounded so a lone signal can't dominate.
        const prior = clamp01(
          0.4 + 0.25 * dispersion + 0.2 * (banditTier > 0 ? 1 : 0) + 0.2 * destroyedPct,
        );
        mobileMil = Math.max(mobileLo, Math.min(mobileHi, militaryPts * prior));
      }
    } else {
      // Feed carried no ship count — pure prior, wider uncertainty.
      provenance = 'prior';
      const prior = clamp01(0.4 + 0.25 * dispersion + 0.2 * (banditTier > 0 ? 1 : 0) + 0.2 * destroyedPct);
      mobileMil = militaryPts * prior;
      mobileHi = militaryPts;
    }

    // ── Spy refinement: collapse the bound to the truth where we have it. ──
    const spyRow = input.spied ? input.spied[idStr] : undefined;
    if (spyRow && spyRow.spiedCount > 0 && ships !== 0) {
      const mobFromSpy = Math.max(0, militaryPts - spyRow.defensePts);
      const floor = typeof ships === 'number' ? ships : 0;
      if (spyRow.coverageComplete && mobFromSpy >= floor) {
        mobileMil = mobFromSpy;
        mobileLo = mobFromSpy;
        mobileHi = mobFromSpy;
        provenance = 'spied';
      } else {
        mobileHi = Math.max(floor, Math.min(mobileHi, mobFromSpy));
        mobileLo = Math.min(mobileLo, mobileHi);
        mobileMil = Math.max(mobileLo, Math.min(mobileMil, mobileHi));
      }
    }

    // Alliance class: prefer the comprehensive highscore harvest (covers every
    // member, no spy needed), fall back to a spied report's own alliance class.
    // A harvested 'none' is truthy, so it correctly wins over a stale spy report
    // and is NOT mistaken for "unknown". undefined = never harvested (→ the
    // dashboard's "alliance class unknown" hint). Resolved BEFORE the combat-
    // quality block: the warrior tell feeds the composition prior below.
    const allianceId = apiPlayers[idStr] ? apiPlayers[idStr].alliance : undefined;
    const allianceClass = (allianceId ? allianceClasses[allianceId] : undefined)
      || (spyRow ? spyRow.allianceClass : undefined);
    const warriorAlliance = isWarriorAlliance(allianceClass);

    // ── Combat quality (res/ship) → the danger-only combat discount. ──
    // res/ship is measured on the FLEET estimate (mobileMil), NOT total military.
    // Defence inflates militaryPts without adding ships, so a naive total res/ship
    // makes a bunker farmer's cheap transporters read like warships (the pentagon
    // case: 28k total res/ship "looked" combat, but 38M of 54.6M was defence). Since
    // mobileMil already subtracts the defence we've SPIED, a scan collapses the fleet
    // res/ship to its true, cheap value and q — hence danger — drops with it.
    //
    // mobileMil is in MILITARY points (civil ships weigh ×0.5 there), so a naive
    // ·1000/ships understates a cargo fleet's real res/ship by up to 2× (pentagon:
    // 7.4k vs a real 12.4k). Convert through the composition prior first: spied
    // composition when we have it, leaned toward warships by aggression tells
    // (warrior alliance, wide server reach, top kill history, bandit rank) — an
    // aggressive player's fleet skews combat, not transporters.
    const combatShare = estimateCombatShare({
      visibleCombatShare: spyRow ? spyRow.visibleCombatShare : undefined,
      warriorAlliance,
      wideReach: reach.reach >= APEX_REACH,
      heavyKills: destroyedPct >= APEX_DESTROYED_PCT,
      bandit: banditTier >= 2,
    });
    const rps = typeof ships === 'number' && ships > 0
      ? pointsToResources(mobileMil, combatShare) / ships
      : undefined;
    const q = typeof rps === 'number' ? combatQuality(rps) : 1;
    const combatMil = ships === 0 ? 0 : mobileMil * q;
    if (combatMil > 0) combatMilVals.push(combatMil);

    partials.push({
      id, militaryPts, ships, destroyedPts, banditTier, destroyedPct, shipsPct,
      mobileLo, mobileHi, mobileMil, provenance, rps, q, combatMil, reach, combatShare,
      spy: spyRow ? { spiedCount: spyRow.spiedCount, planetCount: spyRow.planetCount } : undefined,
      warriorAlliance,
      allianceId, allianceClass,
    });
  }

  combatMilVals.sort((a, b) => a - b);

  // ── Pass 2: absolute strength + danger + label + reasons. ──
  for (const p of partials) {
    // Absolute combat strength: where this player's combat-mobile military sits
    // in the SERVER distribution (INCLUSIVE rank, so a lone/tied top holder
    // saturates instead of collapsing to 0), rescaled so the top ~2.5% → 1.0.
    const strength = p.combatMil > 0
      ? clamp01(pctRankLE(combatMilVals, p.combatMil) / STRENGTH_TOP_PCT)
      : 0;
    // Predator: kill history × combat-graded ship prominence (q gates the raw
    // ship-count percentile, so a cargo swarm no longer inflates it).
    // Predator = demonstrated aggression, but GATED by real combat capability so a
    // mega-bunker's DEFENSIVE "destroyed" (its defence eating attackers earns
    // destroyed points too) doesn't read as offensive killing. No unconditional
    // floor any more: the whole term scales with hull quality q — cheap transporters
    // ⇒ the kills were almost certainly defensive, not raids (the pentagon case).
    const predator = p.destroyedPct * p.q * (0.3 + 0.7 * p.shipsPct);
    // Bandit honour rank is a lifetime aggressor tell, but a DECLAWED bandit with
    // ~0 current fleet must not warm the field on rank alone — scale by strength,
    // keeping 40% of the signal at strength 0 (the persistent-reputation floor).
    const banditBonus = 0.12 * p.banditTier * (0.4 + 0.6 * strength);
    const reachVal = p.reach.reach;

    // Apex tells, split into CAPABILITY (fleet size + composition + warrior-class
    // alliance — aggression-agnostic) and AGGRESSION (wide spread, kill history,
    // and the overnight-FS-amid-spread pattern). The bonus needs ≥2 tells AND at
    // least one AGGRESSION tell, so a peaceful top-tier builder (big fleet, good
    // composition, no kills, clustered — even in a warrior alliance) does NOT
    // read apex. apexSignals (0..APEX_TELLS_TOTAL) is the full count for the
    // label/tooltip; the bonus is capped so it can't dominate the headroom.
    // Each tell is named ONCE and reused for both the count and the structured
    // breakdown, so the dossier scorecard can never drift from the score.
    const tShips = p.shipsPct >= APEX_SHIPS_PCT;
    const tResPerShip = p.q >= APEX_Q;
    const tWarrior = p.warriorAlliance;
    const tReach = reachVal >= APEX_REACH;
    const tKills = p.destroyedPct >= APEX_DESTROYED_PCT && p.q >= 0.6;
    const tFsSpot = p.reach.fsSpot;
    const capabilityTells = (tShips ? 1 : 0) + (tResPerShip ? 1 : 0) + (tWarrior ? 1 : 0);
    const aggressionTells = (tReach ? 1 : 0) + (tKills ? 1 : 0) + (tFsSpot ? 1 : 0);
    const apexSignals = capabilityTells + aggressionTells;
    const apex = apexSignals >= 2 && aggressionTells >= 1 ? Math.min(0.3, 0.1 * (apexSignals - 1)) : 0;
    // Structured breakdown for the dossier scorecard — built only when the bonus
    // gate fires (same condition as the `apex signals N/6` reason), so a weak
    // player never gets an all-empty card. Labels are short keywords (UI rule).
    /** @type {ApexBreakdown | undefined} */
    const apexBreakdown = apex > 0 ? {
      total: apexSignals,
      capability: [
        { key: 'ships', label: 'top ships', fired: tShips },
        { key: 'resPerShip', label: 'res/ship', fired: tResPerShip },
        { key: 'warrior', label: 'warrior', fired: tWarrior },
      ],
      aggression: [
        { key: 'reach', label: 'reach', fired: tReach },
        { key: 'kills', label: 'kills', fired: tKills },
        { key: 'fsSpot', label: 'FS spot', fired: tFsSpot },
      ],
    } : undefined;
    // Warrior-class alliance: a small direct lift on top of the tell — the whole
    // alliance opted into combat bonuses, so "a few extra points" even when the
    // apex gate doesn't fire. Scaled by strength so a shell of a fleet in a
    // warrior alliance isn't warmed on affiliation alone.
    const warriorBonus = p.warriorAlliance ? WARRIOR_ALLIANCE_WEIGHT * (0.4 + 0.6 * strength) : 0;

    let danger;
    if (p.ships === 0) {
      danger = 0; // Cannot attack right now — threat 0 regardless of honour history.
    } else {
      // Soft ceiling (headroom fill): the base combat term sets the floor, and
      // the aggressor bonuses (bandit + reach + apex) consume the REMAINING
      // headroom to 1.0 rather than summing past it. Monotone, always ≤1, with
      // natural diminishing returns — so the top ~2.5% SPREADS across ~90–100
      // (ordered by base) instead of every strong aggressor pinning at exactly 100.
      const base = strength * (0.4 + 0.6 * predator);
      const lift = clamp01(banditBonus + REACH_WEIGHT * reachVal + apex + warriorBonus);
      danger = clamp01(Math.max(ACTIVE_BASE, base + (1 - base) * lift));
    }

    // ── Label ────────────────────────────────────────────────────────────────
    const militaryPct = p.militaryPts > 0 ? pctRank(militaryVals, p.militaryPts) : 0;
    /** @type {DangerLabel} */
    let label;
    if (p.ships === 0) label = p.banditTier > 0 ? 'declawed' : 'turtle';
    else if (p.banditTier > 0) label = strength >= 0.15 ? 'raider' : 'declawed';
    else if (apexSignals >= 3 && strength >= 0.4) label = 'apex';
    else if (p.q <= 0.5 && p.shipsPct >= 0.6) label = 'cargo';
    else if (militaryPct >= 0.7 && strength < 0.25) label = 'fortress';
    else if (strength >= 0.2) label = 'fleeter';
    else if (p.militaryPts > 0) label = 'eco';
    else label = 'unknown';

    // ── Reasons ────────────────────────────────────────────────────────────────
    /** @type {string[]} */
    const reasons = [];
    if (typeof p.ships === 'number') {
      reasons.push(p.ships === 0 ? '0 ships — cannot attack' : `${fmt(p.ships)} ships`);
    }
    if (p.mobileMil > 0 || p.provenance === 'spied') {
      const approx = p.provenance === 'spied' ? '' : '~';
      const strengthTxt = strength >= 0.999 ? 'server top ~2.5%' : `${Math.round(strength * 100)}% strength`;
      // Headline the COMBAT-graded fleet (hull-quality discounted); mobileMil is
      // the honest points bound behind it, shown only when the discount is large
      // (cheap hulls / spied defence) so the two numbers don't just restate each other.
      reasons.push(`${approx}${fmt(p.combatMil)} combat fleet (${strengthTxt})`);
      if (p.mobileMil > p.combatMil * 1.15) {
        // Game language, not model jargon ("mobile-mil bound × hull quality"
        // said nothing to a player): fleet points × the combat-quality factor,
        // with the plain-words meaning when the factor is low.
        const qNote = p.q < 0.5 ? ' — few real warships' : '';
        reasons.push(`${fmt(p.mobileMil)} fleet × ${p.q.toFixed(2)} combat quality${qNote}`);
      }
    }
    if (typeof p.rps === 'number' && p.q < 0.7 && p.ships) {
      // "cheap hulls" is not game vocabulary — name the ship kinds instead.
      reasons.push(`≈ ${fmt(p.rps)} res/ship — mostly transporters/probes, not warships`);
    }
    if (p.banditTier > 0) reasons.push(`Bandit tier ${p.banditTier}/3`);
    if (p.destroyedPts > 0) {
      const defensive = p.q < 0.5 ? ', likely DEFENSIVE (cheap fleet — kills from own defence)' : '';
      reasons.push(`destroyed ${fmt(p.destroyedPts)} (top ${Math.round((1 - p.destroyedPct) * 100)}%${defensive})`);
    }
    if (p.reach.galaxies >= 2) reasons.push(`planets across ${p.reach.galaxies} galaxies`);
    if (p.reach.spread >= 0.5) reasons.push(`tactically spread (reach ${Math.round(reachVal * 100)}%)`);
    // The counter-signature, stated as plainly as the spread one: a packed
    // empire is a miner/economy account — and a Spyglass opportunity, since one
    // colony next door covers all of it.
    if (isMinerProfile({ spread: p.reach.spread, galaxies: p.reach.galaxies, planetCount: p.reach.planets })) {
      reasons.push(`huddled empire — ${p.reach.planets} planets packed together (miner profile)`);
    }
    if (p.warriorAlliance) reasons.push('warrior-class alliance (combat bonuses)');
    if (p.reach.fsSpot) reasons.push('FS spot amid spread');
    if (apex > 0) reasons.push(`apex signals ${apexSignals}/${APEX_TELLS_TOTAL}`);
    if (p.spy && p.spy.spiedCount > 0) {
      reasons.push(p.provenance === 'spied'
        ? `spied ${p.spy.spiedCount}/${p.spy.planetCount} — exact fleet`
        : `spied ${p.spy.spiedCount}/${p.spy.planetCount ?? '?'} (defence floor)`);
    } else if (p.provenance === 'prior') {
      reasons.push('fleet share estimated (no ship count)');
    }

    out.set(p.id, {
      id: p.id, danger, mobileMil: p.mobileMil, mobileLo: p.mobileLo, mobileHi: p.mobileHi,
      provenance: p.provenance, predator, banditTier: p.banditTier, friendly: false,
      combatShare: p.combatShare,
      ...(typeof p.ships === 'number' ? { ships: p.ships } : {}),
      ...(p.destroyedPts > 0 ? { destroyed: p.destroyedPts } : {}),
      ...(typeof p.rps === 'number' ? { resPerShip: p.rps, combatQuality: p.q } : {}),
      reach: reachVal, spread: p.reach.spread, galaxies: p.reach.galaxies,
      planetCount: p.reach.planets, apexSignals,
      ...(apexBreakdown ? { apex: apexBreakdown } : {}),
      ...(p.allianceId ? { allianceId: p.allianceId } : {}),
      ...(p.allianceClass ? { allianceClass: p.allianceClass } : {}),
      label, reasons,
    });
  }

  return out;
};

/**
 * Miner (huddled-empire) thresholds — the mirror image of the aggressor reach
 * this module already scores. An aggressor spreads planets so many victims sit
 * within striking range; a MINER does the opposite and packs everything into a
 * few nearby systems, because short hops are what makes hauling mined resources
 * cheap. Same geometry, read the other way round.
 *
 * `spread ≤ 0.34` = at least two thirds of the empire sits in a huddle (a
 * same-galaxy neighbour within 25 systems), `galaxies ≤ 2` keeps out empires
 * that merely have one dense pocket inside a server-wide footprint, and
 * `planets ≥ 3` is the floor where "clustered" means anything at all.
 */
export const MINER_SPREAD_MAX = 0.34;
export const MINER_MAX_GALAXIES = 2;
export const MINER_MIN_PLANETS = 3;

/**
 * Is this a huddled "miner" empire — everything within easy hauling distance?
 * Why it matters for Spyglass: their bodies are all in one pocket, so ONE colony
 * of ours next door watches the whole account, and a moon there is in reach.
 * `false` when the geometry is unknown (no snapshot ⇒ no verdict). Pure.
 *
 * @param {Pick<DangerProfile, 'spread' | 'galaxies' | 'planetCount'>} [profile]
 * @returns {boolean}
 */
export const isMinerProfile = (profile) => {
  if (!profile || typeof profile.spread !== 'number') return false;
  return (profile.planetCount ?? 0) >= MINER_MIN_PLANETS
    && (profile.galaxies ?? 99) <= MINER_MAX_GALAXIES
    && profile.spread <= MINER_SPREAD_MAX;
};

/** Human-facing label text for a {@link DangerLabel}. */
export const DANGER_LABELS = /** @type {Record<DangerLabel, string>} */ ({
  apex: 'Apex hunter',
  raider: 'Bandit raider',
  declawed: 'Declawed bandit',
  fortress: 'Fortress',
  turtle: 'Turtle',
  fleeter: 'Fleeter',
  cargo: 'Cargo swarm',
  eco: 'Economist',
  friendly: 'Friendly',
  unknown: 'Unknown',
});
