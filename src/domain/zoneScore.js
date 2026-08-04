// Zone scoring — the analyzer's single ranking model. Replaces the legacy
// 6-preset × 9-weight strategy dot-product (regions.js STRATEGIES) with a
// composition of the SAME two-channel threat/farm field the server map renders
// (domain/heatField.js), so list rank, strip colour and map colour finally
// speak one language.
//
// A candidate's fit ∈ [0,1] is a weighted sum of four bounded channels:
//
//   • safety  = 1 − threat sampled from the field (NISZCZ-reach threat
//               pressure at the candidate, relative to this server's p95).
//   • farm    = farm sampled from the field (points-weighted inactive loot
//               within farm reach, relative p95).
//   • room    = open settling space at the candidate: the free-slot share of
//               its window (Best spots), or the measured length of the free run
//               (Longest streaks, saturating around 15 systems but never
//               capped). Independent of WHICH slot you asked for — see
//               freeRoomShare for why that matters.
//   • target  = PvP opportunity: active-player density + honour-tier rate
//               from the window census (the one intent the two field
//               channels cannot express).
//
// Each zone (Safe zone / Farm hub / PvP zone) is just a weight vector over
// those channels, weights summing to 1 — so fit is comparable across zones,
// rows and universes (the field's p95 normalisation already cancels server
// speed/population).
//
// Data quality: a window's raw fit is blended toward a pessimistic prior by
// scan coverage, so a barely-scanned window can't outrank a fully-known one
// on one lucky data point.
//
// Pure: no DOM, no timers, no storage, no chrome — the `domain/` contract.
//
// @ts-check

import { sampleField, presenceBonus } from './heatField.js';
import { classifyCell } from './cellClass.js';
import { axisDelta, clamp01, flightDistance, reachThreat } from './geometry.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('./heatField.js').ThreatFarmField} ThreatFarmField
 * @typedef {import('./regions.js').Region} Region
 */

/**
 * @typedef {object} ZoneChannels
 * @property {number} safety   0..1 — 1 = no threat pressure in reach.
 * @property {number} farm     0..1 — relative farm value in reach.
 * @property {number} room     0..1 — open settling space (freeRoomShare, or
 *   `1 − e^(−run/15)` for a measured streak).
 * @property {number} target   0..1 — PvP target density in the window.
 * @property {number} coverage 0..1 — scanned/systemCount of the window.
 */

/**
 * The three analyzer zones. `label`/`hint` are rendered by the UI (the hint
 * under the control), `weights` sum to 1 over the {@link ZoneChannels}.
 *
 * @type {Record<string, { label: string, hint: string, weights: { safety: number, farm: number, room: number, target: number } }>}
 */
export const ZONES = {
  safe: {
    label: 'Safe zone',
    hint: 'Quiet space — low threat pressure within your offline window; farms and open room welcome. Good relocation targets.',
    weights: { safety: 0.6, farm: 0.15, room: 0.25, target: 0 },
  },
  farm: {
    label: 'Farm hub',
    hint: 'Farm-rich space — maximise inactive loot within your farm reach; threat still discounted.',
    weights: { safety: 0.25, farm: 0.6, room: 0.15, target: 0 },
  },
  pvp: {
    label: 'PvP zone',
    hint: 'Target-rich space — active players and honour targets nearby; safety matters least.',
    weights: { safety: 0.1, farm: 0.15, room: 0.1, target: 0.65 },
  },
};

/**
 * Fixed harm basis for the "Ignore worst" exclusion under zones. The legacy
 * feature ranked players by the ACTIVE strategy's negative weights (so it was
 * a no-op under all-positive presets); zones instead always measure plain
 * threat-to-a-newcomer: bandits by tier, strong-flagged and active occupants,
 * honoured fighters mildly. Fed to `findNeighbourhoodCandidates` as its
 * `weights` (only the signs/magnitudes matter to `playerHarm`).
 */
export const HARM_WEIGHTS = { bandit: -1, strong: -1, occupied: -0.5, honored: -0.4 };

/**
 * Fit of a window whose coverage is zero — the pessimistic prior blind spots
 * blend toward. Deliberately mediocre, not zero: unknown space is "probably
 * nothing special", never "provably terrible" (or the analyzer would herd
 * users away from every unscanned strip) and never "great" (or it would herd
 * them INTO blind spots).
 */
const UNKNOWN_PRIOR = 0.25;

/**
 * E-folding scale of the `room` channel under 'Longest streaks': `1 − e^(−run/15)`. Saturating but
 * never capped, so a longer run ALWAYS scores strictly higher (a hard
 * `clamp(run/15)` made every run ≥ 15 identical — under "Longest streaks"
 * that visibly shuffled the Length column and read as a broken sort).
 * 15 → 0.63, 30 → 0.86, 60 → 0.98.
 */
const STREAK_SCALE = 15;

/** Map any integer to 1..galaxyMax (circular). @param {number} s @param {number} galaxyMax */
const wrapSystem = (s, galaxyMax) => ((((s - 1) % galaxyMax) + galaxyMax) % galaxyMax) + 1;

/** Colonizable slots per system (16 is the expedition slot). */
const SLOTS_PER_SYSTEM = 15;

/**
 * Statuses that mean the slot holds NO body. `empty_sent` counts as free room:
 * a colonizer of ours is inbound, the space itself is still open. `abandoned`
 * does NOT — the remnant blocks the slot until OGame releases it.
 * @type {Set<string>}
 */
const FREE_STATUSES = new Set(['empty', 'empty_sent']);

/**
 * Free colonizable slots in one system, counted as `15 − bodies` so it works on
 * BOTH scan layers: the API composite lists every slot explicitly, while a
 * galaxy build that only reports occupied entries still yields the same count.
 * `null` when the system has no record at all (never seen).
 *
 * @param {Record<string | number, { status?: string }> | undefined} posMap
 * @returns {number | null}
 */
const freeSlotsInSystem = (posMap) => {
  if (!posMap) return null;
  let taken = 0;
  for (const cell of Object.values(posMap)) {
    if (cell && !FREE_STATUSES.has(String(cell.status))) taken++;
  }
  return Math.max(0, SLOTS_PER_SYSTEM - taken);
};

/**
 * How much open settling room a window holds, 0..1 — the mean free-slot share
 * across its systems, rescaled so a half-full neighbourhood reads 0 and virgin
 * space reads 1 (the raw share lives in a narrow 0.5–1 band, which would make
 * the channel almost constant and quietly hand the whole ranking to safety).
 *
 * Deliberately independent of the analyzer's Slots box. Which slot you settle
 * is a question about ONE cell; "is there room around here" is a property of
 * the area, and until 1.56 this channel measured a contiguous run of systems
 * with the REQUESTED slot free — so retyping 15 → 14 re-scored every candidate
 * and reshuffled a list of areas that had not changed at all (the user-visible
 * bug this replaced). Pure.
 *
 * @param {GalaxyScans} scans
 * @param {Pick<Region, 'galaxy'|'start'|'end'>} region
 * @param {number} galaxyMax
 * @returns {number}
 */
export const freeRoomShare = (scans, region, galaxyMax) => {
  const { start, end } = region;
  const span = end >= start ? end - start + 1 : galaxyMax - start + 1 + end;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    const free = freeSlotsInSystem(scans[`${region.galaxy}:${sys}`]?.positions);
    if (free == null) continue; // unseen — the coverage channel prices that in
    sum += free / SLOTS_PER_SYSTEM;
    n++;
  }
  if (!n) return 0;
  return clamp01((sum / n - 0.5) * 2);
};

/**
 * Mean field sample over a region's span (streak regions cover many systems;
 * area candidates a fixed window — either way the mean is what the candidate
 * "feels" across its systems). Null field (no API data yet) reads as neutral
 * threat and zero farm — see the fallback note on {@link computeZoneChannels}.
 *
 * @param {ThreatFarmField | null | undefined} field
 * @param {Pick<Region, 'galaxy'|'start'|'end'>} region
 * @param {number} galaxyMax
 * @returns {{ threat: number, farm: number }}
 */
const sampleRegion = (field, region, galaxyMax) => {
  if (!field) return { threat: 0.5, farm: 0 };
  let t = 0;
  let f = 0;
  let n = 0;
  const { start, end } = region;
  const span = end >= start ? end - start + 1 : galaxyMax - start + 1 + end;
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    const cell = sampleField(field, region.galaxy, sys);
    t += cell.threat;
    f += cell.farm;
    n++;
  }
  return n ? { threat: t / n, farm: f / n } : { threat: 0.5, farm: 0 };
};

/**
 * @typedef {object} ZoneContext
 * @property {ThreatFarmField | null} [field]  The threat/farm field built over
 *   the SAME composite scan map the candidates came from, at per-system
 *   resolution (`cols: systems`). `null`/omitted (no API data) degrades
 *   gracefully: safety reads a neutral 0.5, farm 0 — ranking then rests on
 *   room + target + coverage.
 * @property {GalaxyScans} scans
 * @property {number[]} positions  The analyzer's slot list (ANY-free rule).
 * @property {import('./scans.js').PositionStatus} [status]  Default `'empty'`.
 * @property {number} [galaxyMax]  Systems per galaxy (default 499).
 * @property {number} [ownMilitary]  Own military points — the threat anchor
 *   {@link excludedThreatDrop} grades excluded players with (same anchor the
 *   field itself was built with).
 * @property {Map<number, import('./dangerScore.js').DangerProfile>} [danger]
 *   Per-player danger profiles (v2). MUST be the same map the field was built
 *   with, or the exclusion re-sample grades players on a different scale than
 *   the field it edits (classifyCell would fall back to the legacy 0.3+
 *   heuristic while the field holds D-based intensities).
 */

/**
 * Field-aware "Ignore worst": the window's mean threat re-sampled AS IF the
 * excluded players were gone. Mirrors the field's own build rules — per-system
 * source = SUM over DISTINCT players of each player's danger D (v2; so dropping
 * a player removes exactly their D from the system's source, whether or not
 * they were the local maximum), emission spread by the RIP-reach kernel,
 * scaled by the field's own p95 — and, crucially, works PER CELL in RAW
 * (pre-clamp) units: a cell saturated past the p95 must not read as safer
 * just because a fraction of its (hidden) excess pressure was removed.
 *
 * Excluded players live inside the window by construction
 * (`findNeighbourhoodCandidates` gathers them from the window span), so only
 * span systems are re-read. A multi-planet excluded player's planets OUTSIDE
 * the span still emit into it — an accepted, conservative under-correction
 * (the drop never over-promises). Pure.
 *
 * @param {Region} region
 * @param {ZoneContext} ctx
 * @param {ThreatFarmField} field
 * @returns {number | null} Mean adjusted threat over the span (0..1), or
 *   `null` when the exclusions touch no threat source (caller keeps the
 *   plain sample).
 */
const adjustedThreatMean = (region, ctx, field) => {
  const excluded = region.excluded;
  if (!excluded || excluded.length === 0 || !(field.threatScale > 0)) return null;
  const excludedIds = new Set(excluded.map((p) => p.id));
  const galaxyMax = ctx.galaxyMax ?? 499;
  // Same ctx the field was built with — WITH danger — or classifyCell would
  // fall back to the legacy heuristic and grade excluded players on a scale
  // that no longer matches the D-based field this delta is subtracted from.
  const clsCtx = { ownMilitary: ctx.ownMilitary, danger: ctx.danger };
  const { start, end } = region;
  const span = end >= start ? end - start + 1 : galaxyMax - start + 1 + end;

  // Per excluded player: their danger D + the span systems where they emit
  // threat. Distinct per system (their multiple planets in one system are one
  // fleet), then grouped PER PLAYER — the drop must remove each excluded
  // player exactly the way buildThreatFarmField ADDED them (one deduped term
  // with the capped presence bonus), or a player dense in the window would be
  // over-subtracted and the region would read safer than the players you KEEP.
  /** @type {Map<number, { d: number, systems: number[] }>} */
  const byPlayer = new Map();
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    const positions = ctx.scans[`${region.galaxy}:${sys}`]?.positions;
    if (!positions) continue;
    /** @type {Map<number, number>} */
    const here = new Map(); // distinct excluded players in THIS system → max D
    for (const pos of Object.values(positions)) {
      if (!(pos.player && excludedIds.has(pos.player.id))) continue;
      const cls = classifyCell(pos.status, pos.player, clsCtx);
      if (cls.bucket !== 'threat') continue;
      const prev = here.get(pos.player.id) ?? 0;
      if (cls.intensity > prev) here.set(pos.player.id, cls.intensity);
    }
    for (const [id, intensity] of here) {
      const e = byPlayer.get(id);
      if (e) { if (intensity > e.d) e.d = intensity; e.systems.push(sys); }
      else byPlayer.set(id, { d: intensity, systems: [sys] });
    }
  }
  if (byPlayer.size === 0) return null;

  // Per span cell: subtract each excluded player's ONE deduped term (D ×
  // maxReach × presenceBonus(sumReach/maxReach) — identical to the field's
  // per-player fold) from the RAW sample, THEN clamp. (Only the excluded
  // players' IN-SPAN planets are seen here — the same conservative
  // under-correction as before: the drop never over-promises.)
  let total = 0;
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    const cell = sampleField(field, region.galaxy, sys);
    let dropRaw = 0;
    for (const { d, systems } of byPlayer.values()) {
      let sum = 0;
      let max = 0;
      for (const ssys of systems) {
        const dist = axisDelta(sys, ssys, galaxyMax, field.donutSystem);
        const r = reachThreat(flightDistance(0, dist), field.windowH);
        if (r > 0) { sum += r; if (r > max) max = r; }
      }
      if (max > 0) dropRaw += d * max * presenceBonus(sum / max);
    }
    total += clamp01((cell.threatRaw ?? cell.threat) - dropRaw / field.threatScale);
  }
  return total / span;
};

/**
 * Compute the four bounded channels + coverage for one candidate region.
 *
 * @param {Region} region
 * @param {ZoneContext} ctx
 * @returns {ZoneChannels}
 */
export const computeZoneChannels = (region, ctx) => {
  const galaxyMax = ctx.galaxyMax ?? 499;
  const s = region.score;
  let { threat, farm } = sampleRegion(ctx.field, region, galaxyMax);
  // "Ignore worst" reaches the safety channel: re-sample the window's threat
  // as if the excluded players were gone, so the ranking (not just the
  // report) reads the area as avoided. Memoised per field build — the
  // re-sample is the expensive half of an annotate when excludeN > 0.
  if (ctx.field && region.excluded && region.excluded.length) {
    if (!region.threatAdjMemo || region.threatAdjMemo.field !== ctx.field) {
      region.threatAdjMemo = { field: ctx.field, value: adjustedThreatMean(region, ctx, ctx.field) };
    }
    if (region.threatAdjMemo.value != null) threat = region.threatAdjMemo.value;
  }

  // Room: a streak region IS a measured run of free systems, so its own matched
  // length is the honest reading; an area candidate instead scores the free-slot
  // share of its window ({@link freeRoomShare}) — memoised on the region (its
  // scans are fixed for its lifetime; a field-knob drag must not re-walk every
  // candidate's window).
  const room = typeof region.center === 'number'
    ? (region.room ??= freeRoomShare(ctx.scans, region, galaxyMax))
    : 1 - Math.exp(-region.matched / STREAK_SCALE);

  // Target: active-player density + honour-tier rate over scanned systems.
  // `honorable` (live-cache fair-fight flag) sweetens when present; it is 0
  // on the pure-API composite. Both halves clamped so one crowded system
  // can't push the channel past 1.
  let target = 0;
  let coverage = 0;
  if (s && s.scanned > 0) {
    const n = s.scanned;
    target = clamp01(
      0.6 * clamp01((s.occupied + s.honorable) / n)
      + 0.4 * clamp01(s.honoredTierSum / (n * 3)),
    );
    coverage = clamp01(s.scanned / Math.max(1, s.systemCount));
  }

  return { safety: clamp01(1 - threat), farm, room, target, coverage };
};

/**
 * Weighted fit of a channel set under a zone, coverage-blended toward the
 * pessimistic prior. 0..1; higher = better.
 *
 * @param {ZoneChannels} ch
 * @param {keyof typeof ZONES | string} zoneKey
 * @returns {number}
 */
export const zoneFit = (ch, zoneKey) => {
  const w = (ZONES[zoneKey] ?? ZONES.safe).weights;
  const raw =
    w.safety * ch.safety
    + w.farm * ch.farm
    + w.room * ch.room
    + w.target * ch.target;
  return clamp01(ch.coverage * raw + (1 - ch.coverage) * UNKNOWN_PRIOR);
};

/**
 * Annotate every region with `channels` + `fit` for the zone and return a NEW
 * array sorted by fit (desc), tie-broken by free count then galaxy — the
 * analyzer's one ranking path for both find modes.
 *
 * @param {Region[]} regions
 * @param {keyof typeof ZONES | string} zoneKey
 * @param {ZoneContext} ctx
 * @returns {Region[]}
 */
export const annotateAndSortByZone = (regions, zoneKey, ctx) => {
  for (const r of regions) {
    r.channels = computeZoneChannels(r, ctx);
    r.fit = zoneFit(r.channels, zoneKey);
  }
  return [...regions].sort(
    (a, b) => (b.fit ?? 0) - (a.fit ?? 0) || b.matched - a.matched || a.galaxy - b.galaxy,
  );
};
