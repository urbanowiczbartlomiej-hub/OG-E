// @vitest-environment happy-dom
//
// Behavioural tests for the colony histogram's model view: the axis reaches
// today's size ceiling, the Today mode rescales every colony to today's bonus,
// and spread (fractional) counts show whole numbers over the bars while the
// exact share stays in the tooltip and the tap card.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderColonyModelChart } from '../../../src/features/dashboard/colonyModel.js';
import { fieldMultiplier } from '../../../src/domain/planetRoll.js';

/** @typedef {import('../../../src/state/history.js').ColonyEntry} ColonyEntry */

const TODAY_B = 20.37;
const TODAY_K = fieldMultiplier(TODAY_B);
const SERVER = 30;

/** @type {{ statsEl: HTMLElement, chartEl: HTMLElement, countInfoEl: HTMLElement, modelEl: HTMLElement }} */
let els;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="stats"></div><div class="holder"><div id="chart"></div></div><div id="ci"></div><div id="model"></div>';
  els = {
    statsEl: /** @type {HTMLElement} */ (document.getElementById('stats')),
    chartEl: /** @type {HTMLElement} */ (document.getElementById('chart')),
    countInfoEl: /** @type {HTMLElement} */ (document.getElementById('ci')),
    modelEl: /** @type {HTMLElement} */ (document.getElementById('model')),
  };
});

/**
 * @param {Partial<Parameters<typeof renderColonyModelChart>[0]>} o
 */
const render = (o) => renderColonyModelChart({
  ...els,
  entries: [],
  position: 7,
  mode: 'shown',
  showModel: false,
  serverBonus: SERVER,
  todayK: TODAY_K,
  todayBonus: TODAY_B,
  ...o,
});

/** A colony recorded at size bonus `b` (%) with `natural` fields rolled. @returns {ColonyEntry} */
const colony = (/** @type {number} */ natural, /** @type {number} */ b) =>
  /** @type {ColonyEntry} */ ({ fields: Math.floor(natural * fieldMultiplier(b)) + SERVER, position: 7, b });

const chip = (/** @type {string} */ name) =>
  [...els.statsEl.querySelectorAll('.fresh-chip')].map((c) => c.textContent ?? '').find((t) => t.startsWith(name + ' '));

const lastBarEnd = () => {
  const labels = [...els.chartEl.querySelectorAll('.bar-label')].map((l) => l.textContent ?? '');
  const last = labels[labels.length - 1];
  return Number(last.split('-').pop());
};

describe('colony model chart — axis', () => {
  it('ends at today\'s ceiling for P7: floor(248 × today) + server fields', () => {
    // Colonies rolled at a SMALLER bonus than today's: their own ceiling is lower.
    const entries = [colony(200, 10), colony(210, 10), colony(190, 10)];
    render({ entries, showModel: true });
    expect(lastBarEnd()).toBe(Math.floor(248 * TODAY_K) + SERVER);
  });

  it('without today\'s bonus falls back to the shown colonies\' own ceiling', () => {
    const entries = [colony(200, 10), colony(210, 10)];
    render({ entries, showModel: true, todayK: null, todayBonus: null });
    expect(lastBarEnd()).toBe(Math.floor(248 * fieldMultiplier(10)) + SERVER);
  });
});

describe('colony model chart — Today mode', () => {
  it('rescales each colony to today\'s bonus (interval midpoint)', () => {
    const e = colony(200, 0);
    render({ entries: [e], mode: 'today' });
    // k = 1 at b = 0 → natural interval [200, 201), midpoint 200.5.
    expect(chip('min')).toBe('min ' + (Math.floor(200.5 * TODAY_K) + SERVER));
  });

  it('falls back to Shown when today\'s bonus is unknown', () => {
    const e = colony(200, 0);
    render({ entries: [e], mode: 'today', todayK: null, todayBonus: null });
    expect(chip('min')).toBe('min ' + e.fields);
  });

  it('labels the tap card "Today … fields"', () => {
    render({ entries: [colony(200, 0)], mode: 'today' });
    const bar = /** @type {HTMLElement} */ ([...els.chartEl.querySelectorAll('.bar-group')]
      .find((g) => (g.querySelector('.bar-count')?.textContent ?? '') !== ''));
    bar.click();
    expect(document.querySelector('.colony-pop .rp-head')?.textContent).toMatch(/^Today .* fields$/);
  });
});

describe('colony model chart — spread counts', () => {
  it('whole numbers over the bars, decimals only in the tooltip and the card', () => {
    // At ×1.449 one shown value spans ~0.69 natural field → Natural splits it
    // across two bars as fractions.
    render({ entries: [colony(200, TODAY_B)], mode: 'natural' });
    const counts = [...els.chartEl.querySelectorAll('.bar-count')].map((c) => c.textContent ?? '');
    expect(counts.every((t) => !t.includes('.'))).toBe(true);
    const fractional = [...els.chartEl.querySelectorAll('.bar-group')]
      .find((g) => /\d\.\dx$/.test(/** @type {HTMLElement} */ (g.querySelector('.bar')).title));
    expect(fractional).toBeTruthy();
    /** @type {HTMLElement} */ (fractional).click();
    const mine = [...document.querySelectorAll('.colony-pop .rp-row')]
      .find((r) => r.firstChild?.textContent === 'Mine');
    expect(mine?.lastChild?.textContent).toMatch(/^\d\.\d$/);
  });

  it('a bin under 0.5 colony shows no number over its bar', () => {
    render({ entries: [colony(200, TODAY_B)], mode: 'natural' });
    for (const g of els.chartEl.querySelectorAll('.bar-group')) {
      const title = /** @type {HTMLElement} */ (g.querySelector('.bar')).title;
      const count = Number(title.split(': ')[1].replace('x', ''));
      if (count < 0.5) expect(g.querySelector('.bar-count')?.textContent).toBe('');
    }
  });
});
