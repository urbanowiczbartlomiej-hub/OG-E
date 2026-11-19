// @ts-check

// Colony histogram WITH the roll model — the single-position view of the
// "Big Colony Hunting" chart. On top of the plain bars of ./colony.js:
//
//   • Shown / Natural: bars over the fields as the game shows them, or over the
//     natural roll back-solved through EACH colony's own stamped size bonus
//     (`ColonyEntry.b`, domain/planetRoll.js) — never through today's bonus;
//   • the model as one thin continuous line with a soft shade under it — the
//     roll is a continuous distribution, so it is drawn as one, behind the bars.
//
// Colonies without a stamped bonus can't be modelled, so whenever Natural or
// the model is on, the view keeps ONLY the colonies that carry one (and says
// "N of M"); mixing them in would compare data the model can't describe.
//
// DOM only: every number comes from domain/planetRoll.js.

import { computeFieldStats } from '../../domain/histogram.js';
import {
  POSITION_FIELD_RANGE,
  entryMultiplier,
  naturalFields,
  expectedCurve,
  sampleSpread,
  ROLL_KURTOSIS,
  KURTOSIS_MIN_N,
} from '../../domain/planetRoll.js';

/**
 * @typedef {import('../../state/history.js').ColonyEntry} ColonyEntry
 */

/** Same bar geometry as ./colony.js (count label + bar area + field label). */
const BAR_AREA_PX = 220;
const MIN_BAR_PX = 3;
const MIN_BAR_WIDTH_PX = 8;
/**
 * The model curve is drawn for at least this many colonies: with a handful of
 * colonies a true-to-n curve is a flat smear, while a 50-colony target shows
 * the shape the bars are growing into — they first catch up with it, then
 * settle onto it.
 */
const MODEL_MIN_N = 50;

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Does this position's view have anything to model? (Drives the Natural chip.)
 *
 * @param {ReadonlyArray<ColonyEntry>} entries
 * @returns {boolean}
 */
export const hasStampedBonus = (entries) => entries.some((e) => entryMultiplier(e) != null);

/**
 * Render the model view for ONE position.
 *
 * @param {{
 *   statsEl: HTMLElement,
 *   chartEl: HTMLElement,
 *   countInfoEl: HTMLElement,
 *   modelEl: HTMLElement,
 *   entries: ReadonlyArray<ColonyEntry>,
 *   position: number,
 *   mode: 'shown' | 'natural',
 *   showModel: boolean,
 *   serverBonus: number,
 * }} o
 * @returns {void}
 */
export const renderColonyModelChart = (o) => {
  const { statsEl, chartEl, countInfoEl, modelEl, position, serverBonus } = o;
  statsEl.textContent = '';
  chartEl.textContent = '';
  modelEl.textContent = '';

  const range = POSITION_FIELD_RANGE[position];
  const stamped = o.entries.filter((e) => entryMultiplier(e) != null);
  const mode = stamped.length ? o.mode : 'shown';
  const showModel = o.showModel && stamped.length > 0;
  const entries = mode === 'natural' || showModel ? stamped : o.entries;
  if (!entries.length || !range) {
    countInfoEl.textContent = '';
    chartEl.appendChild(el('div', 'empty', 'No colony data for this position yet.'));
    return;
  }
  const [min, max] = range;
  const n = entries.length;
  const values = mode === 'natural'
    ? entries.map((e) => /** @type {number} */ (naturalFields(e, serverBonus)))
    : entries.map((e) => e.fields);
  countInfoEl.textContent = n === o.entries.length
    ? `${n} colonies · P${position}`
    : `${n} of ${o.entries.length} colonies · P${position}`;

  const stats = computeFieldStats(values.map((v) => /** @type {ColonyEntry} */ ({ fields: v })));
  for (const [label, value] of /** @type {Array<[string, number]>} */ ([
    ['min', stats.min], ['max', stats.max], ['avg', stats.avg], ['median', stats.median],
  ])) {
    statsEl.appendChild(el('span', 'fresh-chip', label + ' ' + value));
  }
  // Spread: σ and kurtosis, the latter next to the model's. Kurtosis does not
  // change when values are scaled and shifted, so shown fields (natural ×
  // bonus + server fields) carry the roll's own kurtosis; only colonies with
  // very different bonuses mixed together would blur it. Dimmed while n is
  // too small for kurtosis to mean much.
  const spread = sampleSpread(values);
  statsEl.appendChild(el('span', 'fresh-chip', `σ ${spread.sd.toFixed(1)}`));
  const kurt = el('span', 'fresh-chip' + (n < KURTOSIS_MIN_N ? ' dim' : ''),
    `kurt ${spread.kurtosis.toFixed(2).replace('-', '−')} · model ${ROLL_KURTOSIS.toFixed(2).replace('-', '−')}`);
  if (n < KURTOSIS_MIN_N) kurt.title = `Few colonies (${n}): kurtosis is mostly noise below ${KURTOSIS_MIN_N}.`;
  statsEl.appendChild(kurt);

  // The model curve needs a multiplier for every colony on screen — true by
  // construction whenever it is on (the view is filtered to stamped colonies).
  const ks = entries.map((e) => entryMultiplier(e));
  const modelled = showModel && ks.every((k) => k != null);
  const kList = /** @type {number[]} */ (modelled ? ks : []);

  // Field range: the whole model support (empty edges show the shape),
  // widened to any observation outside it.
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (mode === 'natural') {
    lo = Math.min(lo, min);
    hi = Math.max(hi, max);
  } else if (modelled) {
    lo = Math.min(lo, Math.floor(min * Math.min(...kList)) + serverBonus);
    // Axis ends at the largest field count the game can show for the top
    // natural roll: floor(max × multiplier) + server fields (e.g. 252 × 1.44889
    // → 395). The roll model allows a sliver above (a natural "252" is any draw
    // in [252, 253)), but that bin would be empty forever (~1 in 3 million).
    hi = Math.max(hi, Math.floor(max * Math.max(...kList)) + serverBonus);
  }
  // Bar width follows the SCREEN only (as the plain chart): one field per bar
  // whenever it fits, grouped just enough to keep bars legible.
  const availableWidth = chartEl.clientWidth || Math.max(200, window.innerWidth - 40);
  const maxBars = Math.max(1, Math.floor(availableWidth / MIN_BAR_WIDTH_PX));
  const w = Math.max(1, Math.ceil((hi - lo + 1) / maxBars));
  /** @type {Array<{ start: number, end: number, count: number }>} */
  const bins = [];
  for (let s = lo; s <= hi; s += w) bins.push({ start: s, end: Math.min(s + w - 1, hi), count: 0 });
  for (const v of values) bins[Math.min(bins.length - 1, Math.floor((v - lo) / w))].count++;

  /** @type {Map<number, number> | undefined} */
  let byK;
  if (modelled && mode === 'shown') {
    byK = new Map();
    for (const k of kList) byK.set(k, (byK.get(k) || 0) + 1);
  }
  const modelScale = Math.max(n, MODEL_MIN_N) / n;
  const curve = modelled
    ? expectedCurve({ lo, bars: bins.length, w, min, max, n, multipliers: byK, serverBonus })
      .map((p) => ({ x: p.x, y: p.y * modelScale }))
    : null;
  const scale = Math.max(1, ...bins.map((b) => b.count), ...(curve ? curve.map((p) => p.y) : []));

  for (const bin of bins) {
    const label = bin.start === bin.end ? String(bin.start) : `${bin.start}-${bin.end}`;
    const group = el('div', 'bar-group');
    group.appendChild(el('div', 'bar-count', bin.count ? String(bin.count) : ''));
    const bar = el('div', 'bar');
    bar.style.height = (bin.count ? Math.max(Math.round((bin.count / scale) * BAR_AREA_PX), MIN_BAR_PX) : 0) + 'px';
    if (!bin.count) bar.style.minHeight = '0';
    bar.title = `${label}: ${bin.count}x`;
    group.appendChild(bar);
    group.appendChild(el('div', 'bar-label', label));
    chartEl.appendChild(group);
  }

  // The model: one thin continuous line with a soft shade under it — a
  // shadow behind the bars, not another set of marks. Stretched over the bar
  // area (x in bar units, y in bar pixels); the stroke keeps its 1px width.
  if (curve) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'chart-model');
    svg.setAttribute('viewBox', `0 0 ${bins.length} ${BAR_AREA_PX}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    /** @param {Array<{ x: number, y: number }>} c */
    const toPts = (c) => c.map((p) => `${p.x.toFixed(3)},${Math.max(0, BAR_AREA_PX - (p.y / scale) * BAR_AREA_PX).toFixed(2)}`);
    const pts = toPts(curve);
    const shade = document.createElementNS(NS, 'path');
    shade.setAttribute('class', 'chart-model-shade');
    shade.setAttribute('d', `M0,${BAR_AREA_PX} L${pts.join(' L')} L${bins.length},${BAR_AREA_PX} Z`);
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'chart-model-line');
    line.setAttribute('d', `M${pts.join(' L')}`);
    svg.appendChild(shade);
    svg.appendChild(line);
    chartEl.appendChild(svg);
  }
};
