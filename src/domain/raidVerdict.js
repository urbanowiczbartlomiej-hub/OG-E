// @ts-check

// Pure raid-decision core — the "jack point" of the Spyglass redesign. The whole
// daily loop ends in one question per target: raid or skip, and is it worth it
// right now? This composes the signals we already compute into ONE glanceable,
// confidence-tiered verdict + a loot estimate. No DOM, no time of its own
// (`nowMs` is passed in), so it is unit-testable with plain fixtures.
//
// Honesty rules (kept deliberately, per SPYGLASS-REDESIGN.md §6.4):
//   - loot is the BEST single planet's plunderable resources (you raid the
//     fattest body), from the freshest spy — not a fake server-wide sum;
//   - every verdict carries a confidence tier from the intel age;
//   - the fleet-risk caution uses the honest hidden-fleet / mobile-fleet bounds,
//     never a precise claim.
// The thresholds below are first-pass heuristics meant to be tuned once seen in
// the browser — they are named consts for exactly that reason.

/** Intel younger than this reads as high-confidence loot. */
const FRESH_MS = 12 * 60 * 60 * 1000; // 12 h
/** Older than this and the loot number is a low-confidence guess. */
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 d
/** Below this much plunderable loot, a target reads as "empty — skip". */
const LOOT_FLOOR = 500_000; // resources
/** A mobile/hidden fleet above this (in points) is a real bounce/return risk. */
const FLEET_RISK_FLOOR = 30_000; // points (~30M resources)
/** Default plunder fraction when a report doesn't carry loot% (½ of undefended). */
const DEFAULT_LOOT_PCT = 50;

/**
 * @typedef {import('./espionageReport.js').SpyReport} SpyReport
 * @typedef {import('./dangerScore.js').DangerProfile} DangerProfile
 * @typedef {import('./threatModel.js').HiddenFleetEstimate} HiddenFleetEstimate
 */

/**
 * @typedef {object} RaidVerdictInput
 * @property {DangerProfile} [profile]        Danger profile for the player (fleet bounds, friendly).
 * @property {HiddenFleetEstimate} [estimate] Hidden-fleet estimate for the player.
 * @property {SpyReport[]} [reports]          Newest-per-body reports for the player.
 * @property {boolean} [inBand]               Legally attackable? undefined = unknown (not asserted).
 * @property {number} [nowMs]                 Current time (ms). Defaults to 0.
 */

/**
 * @typedef {object} RaidVerdict
 * @property {'raid'|'loaded-risky'|'empty'|'scan'|'cant-hit'|'friendly'|'unknown'} kind
 * @property {string} label       Glanceable text ("RAID NOW", "loaded · fleet risk", …).
 * @property {'high'|'medium'|'low'} tier   Confidence in the loot/verdict.
 * @property {number} lootNow     Best single-planet plunderable resources (0 = none/unknown).
 * @property {string} [lootCoord] `"g:s:p"` of the best-loot body.
 * @property {number} [ageMs]     Age of the intel the loot came from.
 * @property {string[]} reasons   Short phrases explaining the verdict (no formatted numbers).
 */

/**
 * @param {Pick<SpyReport,'galaxy'|'system'|'position'>} r
 * @returns {string}
 */
function coordOf(r) {
  return `${r.galaxy}:${r.system}:${r.position}`;
}

/**
 * Decide raid-or-skip for one player and estimate the best loot right now.
 * @param {RaidVerdictInput} input
 * @returns {RaidVerdict}
 */
export function raidVerdict(input) {
  const { profile, estimate, reports, inBand, nowMs = 0 } = input;

  // Your own alliance / buddy — never a raid target.
  if (profile && profile.friendly) {
    return { kind: 'friendly', label: 'friendly', tier: 'high', lootNow: 0,
      reasons: ['your alliance / buddy'] };
  }

  // Out of the legal attack band.
  if (inBand === false) {
    return { kind: 'cant-hit', label: "can't hit", tier: 'high', lootNow: 0,
      reasons: ['outside your attack band'] };
  }

  const list = reports ?? [];
  if (!list.length) {
    return { kind: 'scan', label: 'scan first', tier: 'low', lootNow: 0,
      reasons: ['never spied'] };
  }

  // Best single-planet loot: you raid the fattest body. loot = resources × loot%,
  // taken from the freshest report that carries a resource figure.
  let lootNow = 0;
  /** @type {string|undefined} */ let lootCoord;
  /** @type {number|undefined} */ let lootTs;
  for (const r of list) {
    const res = r.resources;
    if (typeof res !== 'number' || !Number.isFinite(res) || res <= 0) continue;
    const pct = typeof r.lootPct === 'number' && Number.isFinite(r.lootPct)
      ? r.lootPct : DEFAULT_LOOT_PCT;
    const loot = res * (pct / 100);
    if (loot > lootNow) { lootNow = loot; lootCoord = coordOf(r); lootTs = r.timestamp; }
  }
  const ageMs = typeof lootTs === 'number' ? Math.max(0, nowMs - lootTs * 1000) : undefined;
  /** @type {'high'|'medium'|'low'} */
  const tier = ageMs == null ? 'low' : ageMs < FRESH_MS ? 'high' : ageMs < STALE_MS ? 'medium' : 'low';

  // Fleet-home risk: a big HIDDEN (flying) fleet can snipe a raid on return; a big
  // mobile-fleet ceiling means they can bring force to bear. Either argues caution.
  const hidden = estimate && Number.isFinite(estimate.hiddenFleetPoints) ? estimate.hiddenFleetPoints : 0;
  const mobileHi = profile && Number.isFinite(profile.mobileHi) ? profile.mobileHi : 0;
  const fleetRisk = Math.max(hidden, mobileHi); // points

  if (lootNow < LOOT_FLOOR) {
    return { kind: 'empty', label: 'skip — empty', tier, lootNow, lootCoord, ageMs,
      reasons: ['little to steal right now'] };
  }
  if (fleetRisk >= FLEET_RISK_FLOOR) {
    return { kind: 'loaded-risky', label: 'loaded · fleet risk', tier, lootNow, lootCoord, ageMs,
      reasons: ['loaded, but a mobile fleet could bounce the raid'] };
  }
  return { kind: 'raid', label: 'RAID NOW', tier, lootNow, lootCoord, ageMs,
    reasons: ['loaded, low fleet risk'] };
}
