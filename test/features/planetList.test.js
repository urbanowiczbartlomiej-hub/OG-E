// @vitest-environment happy-dom
//
// Unit tests for the shared planet-list walk (`features/shared/planetList.js`)
// — the wrap-around `#planetList` traversal behind sendExpedition's free-slot
// search and dailyRun's collect-source walk. The two callers are covered
// end-to-end by `sendExpeditionHelpers.test.js` / `dailyRun.test.js`; here we
// isolate the traversal itself, in particular the three `active` modes
// (`first` / `skip` / `last`) and the wrap-around / id-shape edge cases.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import { findNextPlanetInList } from '../../src/features/shared/planetList.js';
import { ACTIVE_PLANET_CLASS, ACTIVE_MOON_CLASS } from '../../src/lib/gameDom.js';

/**
 * Build a `#planetList` from `[cp, ok, isActive]` tuples. `ok` becomes a
 * `data-ok` attribute the test predicate reads, so the walk is exercised
 * independently of any coord parsing. `cp` is the `planet-<cp>` id.
 *
 * @param {Array<[string, boolean, boolean?]>} rows
 */
const buildPlanetList = (rows) => {
  const items = rows
    .map(([cp, ok, active]) => {
      const cls = active ? `smallplanet ${ACTIVE_PLANET_CLASS}` : 'smallplanet';
      return `<div id="planet-${cp}" class="${cls}" data-ok="${ok ? '1' : '0'}"></div>`;
    })
    .join('');
  document.body.innerHTML = `<div id="planetList">${items}</div>`;
};

/** Predicate: match rows tagged `data-ok="1"`. */
const isOk = (/** @type {HTMLElement} */ p) => p.getAttribute('data-ok') === '1';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findNextPlanetInList', () => {
  it('returns null for an empty list in every mode', () => {
    buildPlanetList([]);
    expect(findNextPlanetInList(isOk, { active: 'first' })).toBe(null);
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe(null);
    expect(findNextPlanetInList(isOk, { active: 'last' })).toBe(null);
  });

  it('returns null when nothing matches the predicate', () => {
    buildPlanetList([
      ['10', false, true],
      ['20', false],
      ['30', false],
    ]);
    expect(findNextPlanetInList(isOk)).toBe(null);
  });

  it("'first' checks the active planet first", () => {
    buildPlanetList([
      ['10', true],
      ['20', true, true], // active
      ['30', true],
    ]);
    expect(findNextPlanetInList(isOk, { active: 'first' })).toBe('20');
  });

  it("'skip' and 'last' start at the planet after the active one", () => {
    buildPlanetList([
      ['10', true],
      ['20', true, true], // active
      ['30', true],
    ]);
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe('30');
    expect(findNextPlanetInList(isOk, { active: 'last' })).toBe('30');
  });

  it('differentiates the modes when ONLY the active planet matches', () => {
    buildPlanetList([
      ['10', false],
      ['20', true, true], // active — the sole match
      ['30', false],
    ]);
    expect(findNextPlanetInList(isOk, { active: 'first' })).toBe('20');
    expect(findNextPlanetInList(isOk, { active: 'last' })).toBe('20');
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe(null);
  });

  it('wraps around past the end of the list', () => {
    buildPlanetList([
      ['10', true], // only match, sits before the active planet
      ['20', false, true], // active (last index reached first going forward)
    ]);
    // Walking forward from the active planet wraps to index 0.
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe('10');
  });

  it('defaults to no active planet (start at index 0) when none is highlighted', () => {
    buildPlanetList([
      ['10', true],
      ['20', true],
    ]);
    // With no active row, every mode degrades to a plain full walk from
    // index 0 (REVIEW.md 3.8) — 'skip' no longer drops the first planet.
    expect(findNextPlanetInList(isOk, { active: 'first' })).toBe('10');
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe('10');
  });

  it('defaults to first mode when no opts are passed', () => {
    buildPlanetList([
      ['10', true, true],
      ['20', true],
    ]);
    expect(findNextPlanetInList(isOk)).toBe('10');
  });

  it('skips rows whose id is not a planet-<n>, continuing the walk', () => {
    // A matching `.smallplanet` with a non-planet id must be passed over.
    document.body.innerHTML = `
      <div id="planetList">
        <div id="moon-9" class="smallplanet" data-ok="1"></div>
        <div id="planet-30" class="smallplanet" data-ok="1"></div>
      </div>`;
    expect(findNextPlanetInList(isOk, { active: 'first' })).toBe('30');
  });

  it('returns the cp as a string', () => {
    buildPlanetList([['42', true, true]]);
    expect(findNextPlanetInList(isOk)).toBe('42');
  });

  it('passes the live element to the predicate', () => {
    buildPlanetList([
      ['10', false, true],
      ['20', true],
    ]);
    /** @type {string[]} */
    const seen = [];
    findNextPlanetInList((p) => {
      seen.push(p.id);
      return p.getAttribute('data-ok') === '1';
    });
    expect(seen).toContain('planet-10');
    expect(seen).toContain('planet-20');
  });

  it('a hightlightMoon row (moon page) counts as the active row — the walk advances from it', () => {
    // On moon pages the game swaps hightlightPlanet for hightlightMoon on the
    // row. `active: 'skip'` must skip THAT row and start from the next one.
    document.body.innerHTML = `
      <div id="planetList">
        <div id="planet-10" class="smallplanet" data-ok="1"></div>
        <div id="planet-20" class="smallplanet ${ACTIVE_MOON_CLASS}" data-ok="1"></div>
        <div id="planet-30" class="smallplanet" data-ok="1"></div>
      </div>`;
    expect(findNextPlanetInList(isOk, { active: 'skip' })).toBe('30');
  });

  it('cpOf overrides what a matching row\'s cp IS (the moon walk reads the moonlink)', () => {
    buildPlanetList([
      ['10', false, true],
      ['20', true],
    ]);
    document.getElementById('planet-20')?.insertAdjacentHTML(
      'beforeend', '<a class="moonlink" href="?page=ingame&cp=999"></a>',
    );
    const cp = findNextPlanetInList(isOk, {
      cpOf: (p) => {
        const href = p.querySelector('a.moonlink')?.getAttribute('href') || '';
        return new URL(href, 'https://s1.example.com/').searchParams.get('cp');
      },
    });
    expect(cp).toBe('999');
  });

  it('a null cpOf result skips the row and the walk continues', () => {
    buildPlanetList([
      ['10', true, true],
      ['20', true],
    ]);
    // Only planet-20 carries a moon — the moon-cp extractor passes over 10.
    document.getElementById('planet-20')?.insertAdjacentHTML(
      'beforeend', '<a class="moonlink" href="?cp=777"></a>',
    );
    const cp = findNextPlanetInList(isOk, {
      cpOf: (p) => {
        const href = p.querySelector('a.moonlink')?.getAttribute('href') || '';
        return href ? new URL(href, 'https://s1.example.com/').searchParams.get('cp') : null;
      },
    });
    expect(cp).toBe('777');
  });
});
