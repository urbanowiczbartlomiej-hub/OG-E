// @ts-check

// Per-PLAYER danger model (v2) — one coherent 0..1 scalar `D` per player, the
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
// alone never could. Verified empirically on s163-pl: every top bandit has a
// real fleet and destroyed ≥ ~0.5G; the biggest hunters carry POSITIVE honour
// (the honour axis alone is blind to them — destroyed is not).
//
// Bounds, not false precision. `ships`/`destroyed` are contaminated in both
// directions (a probe/cargo swarm dilutes average ship cost; a bunker that
// eats attackers scores "destroyed" too), so we never pretend to know the
// exact fleet — we bound the MOBILE (attack-capable) military and lean the
// point estimate with cheap, robust signals: ship count, kill history,
// bandit tier and planet DISPERSION (an aggressor scatters planets across the
// server to sit near many victims; a builder clusters them).
//
// Friendly players (your alliance / buddies) are excluded outright — D = 0.
// Honoured players get NO threat boost (the old model amplified them, which
// was backwards — they prefer stronger targets than a fresh colony).
//
// Pure: plain functions over plain data. No DOM/timers/storage/chrome.
//
// @see domain/heatField.js — reads D per occupant to build the threat field.
// @see domain/cellClass.js — reads D for the occupancy map's threat intensity.

import { honorClass } from './apiOccupancy.js';
import { honorRank } from './players.js';

/**
 * @typedef {'apex'|'raider'|'declawed'|'fortress'|'turtle'|'fleeter'|'eco'|'friendly'|'unknown'} DangerLabel
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
 *   points (fleet, defense excluded).
 * @property {number} mobileLo      Lower bound of mobile military.
 * @property {number} mobileHi      Upper bound (≤ total military).
 * @property {'spied'|'ships'|'prior'} provenance  How mobileMil was derived:
 *   `spied` = exact (fully-spied: fleet = military − known defense); `ships`
 *   = bounded by the ship count (0 ships = a hard 0), tightened by any partial
 *   spy; `prior` = the feed carried no ship count, so a modelled mobility
 *   fraction was used.
 * @property {number} predator      0..1 — hunts (kill history × mobility).
 * @property {number} banditTier    0..3.
 * @property {boolean} friendly     Your alliance / buddy — never a threat.
 * @property {number} [ships]       Ship count echo (undefined = unknown).
 * @property {number} [destroyed]   Lifetime military-destroyed echo.
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

/** Median of an ascending-sorted array (0 when empty). @param {number[]} a */
const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0);

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
 *   occupied-planet rows — per-player planet coords for the dispersion signal.
 * @property {Record<string, {defensePts:number, coverageComplete:boolean, spiedCount:number, planetCount?:number}>} [spied]
 *   Per-player spy summary (from `estimateHiddenFleet`): the defence points we
 *   have seen and whether coverage is complete. Fully spied → fleet = military
 *   − defence EXACTLY (the precise refinement of the ships bound). Partial →
 *   seen defence is a floor, so military − seen-defence is an UPPER bound.
 * @property {number} [ownMilitary]  Your military points — the strength anchor.
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

/**
 * Build every player's {@link DangerProfile} from the API feeds. One O(n log n)
 * pass to collect the server distributions (ships / destroyed / military
 * percentiles + a fallback anchor), then a profile per player that appears in
 * the military OR honour feed (the only players who can pose a fleet threat or
 * carry a bandit rank; everyone else is a mild active-base or unknown).
 *
 * @param {DangerInput} input
 * @returns {Map<number, DangerProfile>}
 */
export const buildDangerProfiles = (input) => {
  const military = input.military ?? {};
  const destroyed = input.destroyed ?? {};
  const apiPlayers = input.apiPlayers ?? {};
  const players = input.players ?? {};

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

  // Strength anchor: your military points; before calibration fall back to the
  // server median so the field still ranks (the dashboard stamp warns it's
  // uncalibrated). `2×anchor = full strength` mirrors the old model's scale.
  const anchor = input.ownMilitary && input.ownMilitary > 0
    ? input.ownMilitary
    : Math.max(1, median(militaryVals));

  // Planet dispersion: distinct galaxies per player. An aggressor scatters
  // planets across the server (more victims within reach of each home); a
  // builder clusters. Count distinct galaxies from the raw planet rows.
  /** @type {Map<number, Set<number>>} */
  const galaxiesByPlayer = new Map();
  for (const pl of input.universePlanets ?? []) {
    if (pl.player == null || !pl.coords) continue;
    const g = parseInt(pl.coords.split(':')[0], 10);
    if (!Number.isFinite(g)) continue;
    let set = galaxiesByPlayer.get(pl.player);
    if (!set) { set = new Set(); galaxiesByPlayer.set(pl.player, set); }
    set.add(g);
  }

  const ownAlliance = input.ownAlliance
    || (input.ownId && apiPlayers[input.ownId] ? apiPlayers[input.ownId].alliance : undefined);

  /** @type {Map<number, DangerProfile>} */
  const out = new Map();
  const ids = new Set([...Object.keys(military), ...Object.keys(input.honor ?? {})]);

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
    // with isFinite — an unguarded NaN would propagate through clamp01
    // (NaN < 0 and NaN > 1 are both false, so it returns NaN unchanged) all
    // the way to `danger`, poisoning the field and the badge.
    const militaryPts = mil && Number.isFinite(mil.score) ? /** @type {number} */ (mil.score) : 0;
    // Attribute absent (undefined) OR present-but-garbage (NaN) → 0 ships;
    // only a real number counts. Feed lacking the attribute entirely → unknown.
    const ships = mil && feedHasShips ? (Number.isFinite(mil.ships) ? /** @type {number} */ (mil.ships) : 0) : undefined;
    const destroyedPts = destroyed[idStr] && Number.isFinite(destroyed[idStr].score)
      ? /** @type {number} */ (destroyed[idStr].score) : 0;
    const { banditTier } = honourTiers(idStr, input, meta);

    const destroyedPct = destroyedPts > 0 ? pctRank(destroyedVals, destroyedPts) : 0;
    const shipsPct = typeof ships === 'number' && ships > 0 ? pctRank(shipsVals, ships) : (ships === 0 ? 0 : 0.4);
    const dispersion = clamp01(((galaxiesByPlayer.get(id)?.size ?? 1) - 1) / 3);

    // ── Mobile (attack-capable) military — bounded, never fake-precise. ──
    let mobileLo = 0;
    let mobileHi = militaryPts;
    let mobileMil;
    /** @type {'spied'|'ships'|'prior'} */
    let provenance;
    if (typeof ships === 'number') {
      provenance = 'ships';
      if (ships === 0) {
        // Hard: no ships = no attack, whatever the point total. The single
        // most reliable "safe" fact the API gives us.
        mobileMil = 0; mobileLo = 0; mobileHi = 0;
      } else {
        mobileLo = ships; // ≥ 1 pt/ship (a probe is ~1 pt)
        // Keep the upper bound ≥ the floor: if the feed is internally
        // inconsistent (score 0 but ships > 0), trust the ship floor so the
        // reported bounds never contradict (lo ≤ mobileMil ≤ hi).
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
    // Defence we've spied is real fleet-less points; mobile = military − defence.
    // Complete coverage → EXACT. Partial → seen defence is a floor on total
    // defence, so military − seenDefence is an UPPER bound (tighten hi only).
    const spy = input.spied ? input.spied[idStr] : undefined;
    if (spy && spy.spiedCount > 0 && ships !== 0) {
      const mobFromSpy = Math.max(0, militaryPts - spy.defensePts);
      // The FRESH ship count is a hard floor (≥1 pt/ship, hourly feed); the spy
      // report can be arbitrarily old.
      const floor = typeof ships === 'number' ? ships : 0;
      // "Exact" only when coverage is complete AND consistent with that floor.
      // A complete-but-STALE spy (defence since torn down, or the score moved)
      // can imply LESS fleet than the current ships prove exists — trusting it
      // would make a live fleeter read ~0 while claiming exactness (the unsafe
      // direction). Then treat its defence as an upper-bound tightening only,
      // never below the floor, and DON'T claim 'spied'.
      if (spy.coverageComplete && mobFromSpy >= floor) {
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

    const strength = clamp01(mobileMil / (2 * anchor));
    const predator = destroyedPct * (0.4 + 0.6 * shipsPct);
    const banditBonus = 0.12 * banditTier;
    const ACTIVE_BASE = 0.08; // active but unremarkable — a dim, non-zero red

    let danger;
    if (ships === 0) {
      // Cannot attack right now — threat 0 regardless of honour history.
      danger = 0;
    } else {
      danger = clamp01(Math.max(ACTIVE_BASE, strength * (0.4 + 0.6 * predator) + banditBonus));
    }

    // ── Label + reasons ──────────────────────────────────────────────────
    const militaryPct = militaryPts > 0 ? pctRank(militaryVals, militaryPts) : 0;
    /** @type {DangerLabel} */
    let label;
    if (ships === 0) label = banditTier > 0 ? 'declawed' : 'turtle';
    else if (banditTier > 0) label = strength >= 0.15 ? 'raider' : 'declawed';
    else if (predator >= 0.5 && shipsPct >= 0.5 && strength >= 0.4) label = 'apex';
    else if (militaryPct >= 0.7 && strength < 0.25) label = 'fortress';
    else if (strength >= 0.2) label = 'fleeter';
    else if (militaryPts > 0) label = 'eco';
    else label = 'unknown';

    /** @type {string[]} */
    const reasons = [];
    if (typeof ships === 'number') {
      reasons.push(ships === 0 ? '0 ships — cannot attack' : `${fmt(ships)} ships`);
    }
    if (mobileMil > 0 || provenance === 'spied') {
      const x = mobileMil / anchor;
      // Exact (fully spied) drops the "~"; estimates keep it.
      const approx = provenance === 'spied' ? '' : '~';
      reasons.push(`${approx}${fmt(mobileMil)} mobile mil (${x >= 1 ? `${x.toFixed(1)}×` : `${(x * 100).toFixed(0)}% of`} your anchor)`);
    }
    if (banditTier > 0) reasons.push(`Bandit tier ${banditTier}/3`);
    if (destroyedPts > 0) reasons.push(`destroyed ${fmt(destroyedPts)} (top ${Math.round((1 - destroyedPct) * 100)}%)`);
    if (dispersion >= 0.5) reasons.push(`planets across ${galaxiesByPlayer.get(id)?.size} galaxies`);
    if (spy && spy.spiedCount > 0) {
      // provenance === 'spied' is the single source of truth for "exact" —
      // a complete-but-stale spy that failed the floor check reads as a floor,
      // not exact (see the refinement above).
      reasons.push(provenance === 'spied'
        ? `spied ${spy.spiedCount}/${spy.planetCount} — exact fleet`
        : `spied ${spy.spiedCount}/${spy.planetCount ?? '?'} (defence floor)`);
    } else if (provenance === 'prior') {
      reasons.push('fleet share estimated (no ship count)');
    }

    out.set(id, {
      id, danger, mobileMil, mobileLo, mobileHi, provenance, predator, banditTier,
      friendly: false,
      ...(typeof ships === 'number' ? { ships } : {}),
      ...(destroyedPts > 0 ? { destroyed: destroyedPts } : {}),
      label, reasons,
    });
  }

  return out;
};

/** Human-facing label text for a {@link DangerLabel}. */
export const DANGER_LABELS = /** @type {Record<DangerLabel, string>} */ ({
  apex: 'Apex hunter',
  raider: 'Bandit raider',
  declawed: 'Declawed bandit',
  fortress: 'Fortress',
  turtle: 'Turtle',
  fleeter: 'Fleeter',
  eco: 'Economist',
  friendly: 'Friendly',
  unknown: 'Unknown',
});
