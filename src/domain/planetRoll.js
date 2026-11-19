// @ts-check

// Planet-size roll model — the pure maths behind the colony histogram's
// "expected" overlay. No DOM, no storage, no timers.
//
// The game rules this encodes (with the measurements behind them) live in
// docs/ogame-fleet-mechanics.md → Colonization ("How a planet's field count is
// built up", "The natural roll is a sum of three uniform draws", "Position
// table"). In short:
//
//   natural S ~ Bates/Irwin–Hall of order 3 on [min, max + 1)  (FIELD scale)
//   b        = planet size bonus, % of DIAMETER:
//              10 · (1 + E) · [Discoverer] + 5 · [Researchers alliance]
//   shown    = floor(S · (1 + b/100)²) + serverBonusFields
//
// E is the summed Discoverer Enhancement ("Discoverer total" on the in-game
// lifeform bonuses page). Each recorded colony carries its own `b` — the
// bonus in force when it was colonized — so the history never depends on
// today's classes or bonus.

/**
 * Natural field range per position (no class, no server bonus) — the community
 * reference table, cross-checked cell by cell (see the doc above).
 *
 * @type {Readonly<Record<number, readonly [number, number]>>}
 */
export const POSITION_FIELD_RANGE = Object.freeze({
  1: [96, 172], 2: [104, 176], 3: [112, 182], 4: [118, 208], 5: [133, 232],
  6: [146, 242], 7: [152, 248], 8: [156, 252], 9: [150, 246], 10: [142, 232],
  11: [136, 210], 12: [125, 186], 13: [114, 172], 14: [100, 168], 15: [90, 164],
});

/**
 * The planet size bonus (% of diameter) from the in-game parts.
 *
 * @param {{ e: number, discoverer: boolean, researcher: boolean }} p
 *   `e` is the Discoverer Enhancement total as a fraction (0.5369).
 * @returns {number}  e.g. 20.37
 */
export const sizeBonusPercent = (p) =>
  Math.round(((p.discoverer ? 10 * (1 + (p.e || 0)) : 0) + (p.researcher ? 5 : 0)) * 100) / 100;

/**
 * Field multiplier for a size bonus: fields grow with the square of the
 * diameter, so +20.37 % diameter is ×1.4489 fields.
 *
 * @param {number} bPercent
 * @returns {number}
 */
export const fieldMultiplier = (bPercent) => (1 + bPercent / 100) ** 2;

/**
 * CDF of the natural roll: P(S < x) for S ~ Irwin–Hall(3) scaled to
 * [min, max + 1). Piecewise cubic.
 *
 * @param {number} x
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export const rollCdf = (x, min, max) => {
  const w = (max + 1 - min) / 3;
  const u = (x - min) / w;
  if (u <= 0) return 0;
  if (u >= 3) return 1;
  if (u <= 1) return u ** 3 / 6;
  if (u <= 2) return (-2 * u ** 3 + 9 * u ** 2 - 9 * u + 3) / 6;
  return 1 - (3 - u) ** 3 / 6;
};

/**
 * P(roll ≥ x) — the chance one colonization reaches at least `x` natural fields.
 *
 * @param {number} x
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export const rollTail = (x, min, max) => 1 - rollCdf(x, min, max);

/**
 * Field multiplier of one recorded colony from its own stamped size bonus
 * `b`, or `null` when the colony was recorded without one.
 *
 * @param {{ b?: number }} entry
 * @returns {number | null}
 */
export const entryMultiplier = (entry) =>
  typeof entry.b === 'number' && entry.b >= 0 ? fieldMultiplier(entry.b) : null;

/**
 * Back-solve the natural (integer) field roll of one recorded colony.
 * shown = floor(S·k) + bonus ⇒ S ∈ [(shown−bonus)/k, (shown−bonus+1)/k);
 * the midpoint, floored, is the natural count the position table speaks in.
 * `null` when the colony carries no size bonus.
 *
 * @param {{ fields: number, b?: number }} entry
 * @param {number} serverBonus
 * @returns {number | null}
 */
export const naturalFields = (entry, serverBonus) => {
  const k = entryMultiplier(entry);
  return k == null ? null : Math.floor((entry.fields - serverBonus + 0.5) / k);
};

/**
 * The model as a CONTINUOUS curve over the histogram: at each sample point,
 * the number of colonies a bar of width `w` centred there should hold.
 * x is in bar units (bar i spans [i, i+1), its centre is i + 0.5), so the
 * curve lines up with bars that start at field `lo`.
 *
 * Natural mode (no `multipliers`): field values are natural rolls.
 * Shown mode: field values are shown fields; every colony contributes under
 * its own multiplier, so a bonus that changed over time is modelled exactly
 * (a mixture, not one curve). Pass multipliers as Map<k, count> — colonies
 * share few distinct bonuses, which keeps this cheap.
 *
 * @param {object} a
 * @param {number} a.lo            Field value where bar 0 starts.
 * @param {number} a.bars          Number of bars.
 * @param {number} a.w             Field values per bar.
 * @param {number} a.min           Position's natural minimum.
 * @param {number} a.max           Position's natural maximum.
 * @param {number} a.n             Colonies (natural mode).
 * @param {Map<number, number>} [a.multipliers]  k → colonies (shown mode).
 * @param {number} [a.serverBonus] Shown mode only.
 * @param {number} [a.samplesPerBar]
 * @returns {Array<{ x: number, y: number }>}
 */
export const expectedCurve = ({ lo, bars, w, min, max, n, multipliers, serverBonus = 0, samplesPerBar = 4 }) => {
  const steps = Math.max(1, Math.min(bars * samplesPerBar, 1200));
  /** @type {Array<{ x: number, y: number }>} */
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * bars;
    const a = lo + x * w - w / 2;
    const b = lo + x * w + w / 2;
    let y = 0;
    if (!multipliers) {
      y = n * (rollCdf(b, min, max) - rollCdf(a, min, max));
    } else {
      for (const [k, c] of multipliers) {
        y += c * (rollCdf((b - serverBonus) / k, min, max) - rollCdf((a - serverBonus) / k, min, max));
      }
    }
    out.push({ x, y });
  }
  return out;
};

/** Excess kurtosis of the model roll (sum of three uniforms: −1.2 / 3). */
export const ROLL_KURTOSIS = -0.4;

/**
 * Below this many colonies a sample kurtosis is mostly noise (its standard
 * error is about √(24 / n): ±0.28 at n = 300).
 */
export const KURTOSIS_MIN_N = 300;

/**
 * Sample standard deviation and excess kurtosis.
 *
 * @param {number[]} values
 * @returns {{ sd: number, kurtosis: number }}
 */
export const sampleSpread = (values) => {
  const n = values.length;
  if (n < 2) return { sd: NaN, kurtosis: NaN };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const kurtosis = sd > 0 ? values.reduce((s, v) => s + ((v - mean) / sd) ** 4, 0) / n - 3 : NaN;
  return { sd, kurtosis };
};
