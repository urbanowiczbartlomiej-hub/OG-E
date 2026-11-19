// @vitest-environment happy-dom
//
// The lifeform-bonus capture reads one number off the in-game "Lifeform
// bonuses" page: the Discoverer class total. These cases pin the DOM contract
// (by toggle id, with a label fallback) and the percent parsing.
//
// @ts-check

import { describe, it, expect, afterEach } from 'vitest';
import { parsePercent, findDiscovererTotal } from '../../src/features/lfBonusCapture.js';

afterEach(() => { document.body.innerHTML = ''; });

/**
 * @param {string} toggable
 * @param {string} label
 * @param {string} total
 * @returns {string}
 */
const heading = (toggable, label, total) => `<inner-bonus-item-heading data-toggable="${toggable}">
  <div class="subCategoryTitle" aria-label="${label}">${label}</div>
  <div class="subCategoryBonus">${total}</div>
</inner-bonus-item-heading>`;

describe('parsePercent', () => {
  it('reads comma and dot decimals in any language', () => {
    expect(parsePercent('Łącznie: 53,69%')).toBe(53.69);
    expect(parsePercent('Total: 47.5 %')).toBe(47.5);
    expect(parsePercent('Łącznie: 0%')).toBe(0);
  });

  it('returns null when there is no percentage', () => {
    expect(parsePercent('')).toBeNull();
    expect(parsePercent(null)).toBeNull();
    expect(parsePercent('n/a')).toBeNull();
  });
});

describe('findDiscovererTotal', () => {
  it('finds the Discoverer total by its toggle id', () => {
    document.body.innerHTML = '<technology-bonus-category>'
      + heading('601', 'Zbieracz', 'Łącznie: 0%')
      + heading('602', 'Generał', 'Łącznie: 0%')
      + heading('603', 'Odkrywca', 'Łącznie: 53,69%')
      + '</technology-bonus-category>';
    expect(findDiscovererTotal(document)?.textContent).toBe('Łącznie: 53,69%');
  });

  it('falls back to the class label when the toggle ids differ', () => {
    document.body.innerHTML = heading('901', 'Collector', 'Total: 0%') + heading('903', 'Discoverer', 'Total: 12.04%');
    expect(parsePercent(findDiscovererTotal(document)?.textContent)).toBe(12.04);
  });

  it('returns null on any other page', () => {
    document.body.innerHTML = '<div id="planetList"></div>';
    expect(findDiscovererTotal(document)).toBeNull();
  });
});
