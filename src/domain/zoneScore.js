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
//   • streak  = contiguous free-system run at the candidate — open, quiet
//               space (room for future relocations); saturates around 15
//               systems but keeps growing, so longer is always better.
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

import { sampleField } from './heatField.js';
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
 * @property {number} streak   0..1 — contiguous free run, `1 − e^(−run/15)`.
 * @property {number} target   0..1 — PvP target density in the window.
 * @property {number} coverage 0..1 — scanned/systemCount of the window.
 */

/**
 * The three analyzer zones. `label`/`hint` are rendered by the UI (the hint
 * under the control), `weights` sum to 1 over the {@link ZoneChannels}.
 *
 * @type {Record<string, { label: string, hint: string, weights: { safety: number, farm: number, streak: number, target: number } }>}
 */
export const ZONES = {
  safe: {
    label: 'Safe zone',
    hint: 'Quiet space — low threat pressure within your offline window; farms and open room welcome. Good relocation targets.',
    weights: { safety: 0.6, farm: 0.15, streak: 0.25, target: 0 },
  },
  farm: {
    label: 'Farm hub',
    hint: 'Farm-rich space — maximise inactive loot within your farm reach; threat still discounted.',
    weights: { safety: 0.25, farm: 0.6, streak: 0.15, target: 0 },
  },
  pvp: {
    label: 'PvP zone',
    hint: 'Target-rich space — active players and honour targets nearby; safety matters least.',
    weights: { safety: 0.1, farm: 0.15, streak: 0.1, target: 0.65 },
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
 * E-folding scale of the `streak` channel: `1 − e^(−run/15)`. Saturating but
 * never capped, so a longer run ALWAYS scores strictly higher (a hard
 * `clamp(run/15)` made every run ≥ 15 identical — under "Longest streaks"
 * that visibly shuffled the Length column and read as a broken sort).
 * 15 → 0.63, 30 → 0.86, 60 → 0.98.
 */
const STREAK_SCALE = 15;

/** Map any integer to 1..galaxyMax (circular). @param {number} s @param {number} galaxyMax */
const wrapSystem = (s, galaxyMax) => ((((s - 1) % galaxyMax) + galaxyMax) % galaxyMax) + 1;

/**
 * Length of the contiguous run of systems around `centre` where at least one
 * of the requested `positions` is confirmed `status` — the same ANY-free rule
 * that qualified the centre as a candidate. Bounded by `galaxyMax` (a fully
 * free galaxy is one full circle). Pure.
 *
 * @param {GalaxyScans} scans
 * @param {number} galaxy
 * @param {number} centre
 * @param {number[]} positions
 * @param {import('./scans.js').PositionStatus} status
 * @param {number} galaxyMax
 * @returns {number}
 */
export const contiguousFreeRun = (scans, galaxy, centre, positions, status, galaxyMax) => {
  /** @param {number} sys @returns {boolean} */
  const isFree = (sys) => {
    const posMap = scans[`${galaxy}:${sys}`]?.positions;
    if (!posMap) return false;
    return positions.some((p) => posMap[/** @type {any} */ (String(p))]?.status === status);
  };
  if (!isFree(centre)) return 0;
  let run = 1;
  for (let d = 1; d < galaxyMax; d++) {
    if (!isFree(wrapSystem(centre + d, galaxyMax))) break;
    run++;
  }
  for (let d = 1; run < galaxyMax; d++) {
    const sys = wrapSystem(centre - d, galaxyMax);
    if (!isFree(sys)) break;
    run++;
  }
  return Math.min(run, galaxyMax);
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
 *   streak + target + coverage.
 * @property {GalaxyScans} scans
 * @property {number[]} positions  The analyzer's slot list (ANY-free rule).
 * @property {import('./scans.js').PositionStatus} [status]  Default `'empty'`.
 * @property {number} [galaxyMax]  Systems per galaxy (default 499).
 * @property {number} [ownMilitary]  Own military points — the threat anchor
 *   {@link excludedThreatDrop} grades excluded players with (same anchor the
 *   field itself was built with).
 */

/**
 * Field-aware "Ignore worst": how much of the window's (normalised) threat
 * sample the excluded players account for. Mirrors the field's own build
 * rules — per-system source = MAX occupant intensity (so dropping a player
 * only matters where they WERE the local maximum), emission spread by the
 * RIP-reach kernel, result scaled by the field's own p95 — so subtracting it
 * from the sampled threat reads "the area as if you avoided them".
 *
 * Excluded players live inside the window by construction
 * (`findNeighbourhoodCandidates` gathers them from the window span), so only
 * span systems need re-reading. Pure.
 *
 * @param {Region} region
 * @param {ZoneContext} ctx
 * @param {ThreatFarmField} field
 * @returns {number} Mean normalised threat reduction over the span (≥ 0).
 */
const excludedThreatDrop = (region, ctx, field) => {
  const excluded = region.excluded;
  if (!excluded || excluded.length === 0 || !(field.threatScale > 0)) return 0;
  const excludedIds = new Set(excluded.map((p) => p.id));
  const galaxyMax = ctx.galaxyMax ?? 499;
  const clsCtx = { ownMilitary: ctx.ownMilitary };
  const { start, end } = region;
  const span = end >= start ? end - start + 1 : galaxyMax - start + 1 + end;

  // Per span system: the threat-source delta = max intensity of ALL occupants
  // minus max intensity of the KEPT ones (0 unless an excluded player was the
  // local maximum — matching how buildThreatFarmField sources threat).
  /** @type {Array<{ sys: number, delta: number }>} */
  const sources = [];
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    const positions = ctx.scans[`${region.galaxy}:${sys}`]?.positions;
    if (!positions) continue;
    let maxAll = 0;
    let maxKept = 0;
    for (const pos of Object.values(positions)) {
      const cls = classifyCell(pos.status, pos.player, clsCtx);
      if (cls.bucket !== 'threat') continue;
      if (cls.intensity > maxAll) maxAll = cls.intensity;
      if (!(pos.player && excludedIds.has(pos.player.id)) && cls.intensity > maxKept) {
        maxKept = cls.intensity;
      }
    }
    if (maxAll > maxKept) sources.push({ sys, delta: maxAll - maxKept });
  }
  if (sources.length === 0) return 0;

  // Spread each delta by the same RIP-reach kernel the field used and average
  // over the span — the counterpart of sampleRegion's mean.
  let total = 0;
  for (let i = 0; i < span; i++) {
    const sys = wrapSystem(start + i, galaxyMax);
    for (const src of sources) {
      const d = axisDelta(sys, src.sys, galaxyMax, field.donutSystem);
      total += src.delta * reachThreat(flightDistance(0, d), field.windowH);
    }
  }
  return (total / span) / field.threatScale;
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
  const status = ctx.status ?? 'empty';
  const s = region.score;
  let { threat, farm } = sampleRegion(ctx.field, region, galaxyMax);
  // "Ignore worst" reaches the safety channel: subtract the excluded players'
  // share of the sampled threat, so the ranking (not just the report) reads
  // the area as if they were avoided.
  if (ctx.field && region.excluded && region.excluded.length) {
    threat = Math.max(0, threat - excludedThreatDrop(region, ctx, ctx.field));
  }

  // Streak: a real streak region carries its own matched count; an area
  // candidate measures the ANY-free run through its centre — memoised on the
  // region (its scans/positions are fixed for its lifetime; re-annotation on
  // a field-knob drag must not re-walk the galaxy per candidate).
  const run = typeof region.center === 'number'
    ? (region.freeRun ??= contiguousFreeRun(ctx.scans, region.galaxy, region.center, ctx.positions, status, galaxyMax))
    : region.matched;
  const streak = 1 - Math.exp(-run / STREAK_SCALE);

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

  return { safety: clamp01(1 - threat), farm, streak, target, coverage };
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
    + w.streak * ch.streak
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
