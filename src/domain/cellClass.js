// Fixed, strategy-INDEPENDENT classification of a map cell into one of five
// buckets, each with a 0..1 intensity — the single colour language for the
// server map (sharp per-position view and, later, the two-channel field).
//
// The design (agreed): the abundant "void" is de-emphasised (black), so the
// signal pops. `i` and `I` inactives are ONE bucket (both are farm; how RICH
// they are — points → developed mines → loot — matters, not the i/I split).
// admin/banned/vacation are ONE bucket ("out of the game": blocks colonisation,
// neither farm nor threat). Active players are ONE bucket whose intensity grows
// with how much stronger-than-me they are (military) and with bandit/honour
// tier — a blended RISK signal (military also comes from defence, a honoured
// player may be a pure defender, so it's a signal, not a verdict; a BANDIT is
// the one sure sign of aggression → the strongest accent).
//
// Pure: plain functions over plain data. No DOM/timers/storage.
//
// @ts-check

/** @typedef {import('./scans.js').PositionStatus} PositionStatus */
/** @typedef {import('./scans.js').PositionPlayer} PositionPlayer */

/** The five fixed buckets. */
/** @typedef {'free'|'mine'|'blocked'|'farm'|'threat'} CellBucket */

/**
 * @typedef {object} CellClass
 * @property {CellBucket} bucket
 * @property {number} intensity  0..1 within the bucket (farm = richness,
 *   threat = risk; free/mine/blocked are flat).
 */

/**
 * @typedef {object} ClassifyContext
 * @property {number} [ownMilitary]  Our own military-highscore points — the
 *   anchor for "how much stronger militarily than me". Omit → threat uses the
 *   base + bandit/honour accent only. (Legacy fallback; superseded by `danger`.)
 * @property {number} [farmScale]    Points value that reads as a "full" farm
 *   (e.g. a high server percentile of inactive points). Omit → 1 (raw).
 * @property {Map<number, import('./dangerScore.js').DangerProfile>} [danger]
 *   Per-player danger profiles (v2). When present, an active occupant's threat
 *   intensity is that player's precomputed `D` — which already excludes defense
 *   (ships-bounded), zeroes friendly players, and neutralises honoured ones.
 *   The `ownMilitary`/rankClass formula below is the fallback when it's absent
 *   (no API danger layer yet, e.g. the map's legacy self-build path).
 */

// Statuses that are NOT a planet we care about → treated as free/void.
const VOID_STATUS = new Set(['empty', 'empty_sent', 'abandoned', 'reserved']);
// Untouchable / out-of-the-game occupants → one "blocked" bucket.
const BLOCKED_STATUS = new Set(['admin', 'banned', 'vacation']);
// Farmable dormant accounts → one "farm" bucket (i AND I).
const FARM_STATUS = new Set(['inactive', 'long_inactive']);

/**
 * Classify one occupied/empty slot.
 *
 * @param {PositionStatus|undefined} status
 * @param {PositionPlayer|undefined} player
 * @param {ClassifyContext} [ctx]
 * @returns {CellClass}
 */
export const classifyCell = (status, player, ctx = {}) => {
  if (!status || VOID_STATUS.has(status)) return { bucket: 'free', intensity: 0 };
  if (status === 'mine') return { bucket: 'mine', intensity: 1 };
  if (BLOCKED_STATUS.has(status)) return { bucket: 'blocked', intensity: 1 };

  if (FARM_STATUS.has(status)) {
    const pts = player && typeof player.score === 'number' ? player.score : 0;
    const scale = ctx.farmScale && ctx.farmScale > 0 ? ctx.farmScale : 1;
    // sqrt so a decent idler still reads bright and one absurd whale merely
    // saturates rather than dragging the rest into the dark.
    return { bucket: 'farm', intensity: Math.min(1, Math.sqrt(pts / scale)) };
  }

  // Anything else with an owner = an ACTIVE player → threat.
  //
  // v2: when the danger layer is present, the intensity IS that player's D —
  // defense already stripped (a ships=0 turtle reads ~0, not "10× your
  // military = max threat"), friendlies zeroed, honoured neutral.
  if (ctx.danger) {
    if (player && player.id != null) {
      const prof = ctx.danger.get(player.id);
      if (prof) return { bucket: 'threat', intensity: Math.max(0, Math.min(1, prof.danger)) };
    }
    // Danger layer active but this occupant has NO profile — a new/tiny/
    // unranked active absent from the highscore feeds. Read the model's active
    // base (matches dangerScore ACTIVE_BASE), NOT the legacy 0.3 heuristic
    // below: blending the two scales would paint an unranked newcomer redder
    // than a scored eco whale, inverting the whole point of v2.
    return { bucket: 'threat', intensity: 0.08 };
  }

  // Fallback (no danger layer AT ALL): base danger for being active, raised by
  // relative military strength and honour tier — the pre-v2 heuristic.
  let t = 0.3;
  const mil = player && typeof player.militaryScore === 'number' ? player.militaryScore : undefined;
  if (mil != null && ctx.ownMilitary && ctx.ownMilitary > 0) {
    // 2× my military reads as max threat from the strength axis alone.
    t = Math.max(t, Math.min(1, mil / (ctx.ownMilitary * 2)));
  }
  const rc = player && player.rankClass;
  if (typeof rc === 'string') {
    const tier = parseInt(rc.slice(-1), 10) || 1;
    // Bandit = sure aggressor → strong accent; honoured = maybe a defender → mild.
    t += (rc.startsWith('rank_bandit') ? 0.22 : 0.1) * tier;
  }
  return { bucket: 'threat', intensity: Math.max(0, Math.min(1, t)) };
};

// Palette anchors (data colours, not theme tokens — like the game status palette).
const VOID = [14, 16, 20];
const GOLD = [226, 170, 58];
const RED = [226, 72, 60];
const BLOCKED = [86, 91, 102];
const MINE = [47, 111, 208];

/** @param {number[]} a @param {number[]} b @param {number} t */
const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
/** @param {number[]} c */
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * Threat-emphasis curve for the map's danger (red) channel. The danger model D
 * is only an approximation, but the field read is clear that the TOP of the
 * range is disproportionately dangerous — a D≈100 aggressor is far worse than a
 * 90, while everyone below ~60 is roughly neutral. A linear ramp hides that; a
 * convex knee makes it read like a decibel scale: flat below THREAT_KNEE, then
 * a γ-shaped acceleration to full red at 1.
 *
 * Display-only — applied to `intensity` HERE, in the colour mapping. The danger
 * model D (`domain/dangerScore.js`) and the field aggregation
 * (`domain/heatField.js`) are left untouched, so ranking / thresholds elsewhere
 * are unchanged. Deliberately gentle (D is a guess) and knob-driven: nudge the
 * two constants to taste.
 *
 * @param {number} x  Intensity 0..1 (= D/100 for a per-player threat cell).
 * @returns {number}  Emphasised intensity 0..1, monotone non-decreasing.
 */
const THREAT_KNEE = 0.55;
const THREAT_GAMMA = 1.6;
const emphasizeThreat = (/** @type {number} */ x) => {
  if (x <= THREAT_KNEE) return 0;
  return ((x - THREAT_KNEE) / (1 - THREAT_KNEE)) ** THREAT_GAMMA;
};

/**
 * Map a {@link CellClass} to an rgb() string. Void is near-black so the signal
 * pops; farm ramps linearly from a dim floor to full gold by intensity, while
 * threat runs its intensity through {@link emphasizeThreat} first so the top of
 * the danger range dominates and the low end stays near the floor.
 *
 * @param {CellClass} cls
 * @returns {string}
 */
export const cellColor = ({ bucket, intensity }) => {
  switch (bucket) {
    case 'mine': return rgb(MINE);
    case 'blocked': return rgb(BLOCKED);
    case 'farm': return rgb(lerp(VOID, GOLD, 0.35 + 0.65 * intensity));
    case 'threat': return rgb(lerp(VOID, RED, 0.35 + 0.65 * emphasizeThreat(intensity)));
    default: return rgb(VOID);
  }
};

/**
 * Blend the two field channels (threat → red, farm → gold) additively over the
 * void, for the smooth server-map field. Both near a source → orange
 * ("juicy but risky").
 *
 * @param {number} threat  0..1
 * @param {number} farm    0..1
 * @returns {string} `rgb(r,g,b)`
 */
export const fieldColor = (threat, farm) => {
  // Same decibel-style emphasis as the sharp per-cell view, so the smooth field
  // and the per-position map read consistently (only truly dangerous regions
  // glow red). Farm stays linear — the emphasis is a danger-channel choice.
  const t = emphasizeThreat(Math.max(0, Math.min(1, threat)));
  const f = Math.max(0, Math.min(1, farm));
  /** @param {number} i */
  const ch = (i) => Math.min(255, Math.round(VOID[i] + t * (RED[i] - VOID[i]) + f * (GOLD[i] - VOID[i])));
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
};
