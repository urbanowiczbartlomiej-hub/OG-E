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
 *   base + bandit/honour accent only.
 * @property {number} [farmScale]    Points value that reads as a "full" farm
 *   (e.g. a high server percentile of inactive points). Omit → 1 (raw).
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

  // Anything else with an owner = an ACTIVE player → threat. Base danger for
  // being active at all, raised by relative military strength and honour tier.
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
 * Map a {@link CellClass} to an rgb() string. Void is near-black so the signal
 * pops; farm/threat ramp from a dim floor (so even a weak one is visible) to
 * full gold/red by intensity.
 *
 * @param {CellClass} cls
 * @returns {string}
 */
export const cellColor = ({ bucket, intensity }) => {
  switch (bucket) {
    case 'mine': return rgb(MINE);
    case 'blocked': return rgb(BLOCKED);
    case 'farm': return rgb(lerp(VOID, GOLD, 0.35 + 0.65 * intensity));
    case 'threat': return rgb(lerp(VOID, RED, 0.35 + 0.65 * intensity));
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
  const t = Math.max(0, Math.min(1, threat));
  const f = Math.max(0, Math.min(1, farm));
  /** @param {number} i */
  const ch = (i) => Math.min(255, Math.round(VOID[i] + t * (RED[i] - VOID[i]) + f * (GOLD[i] - VOID[i])));
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
};
