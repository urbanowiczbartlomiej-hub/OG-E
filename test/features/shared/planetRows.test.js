// @vitest-environment happy-dom
//
// Behavioural tests for the shared `#planetList` projection — the ONE DOM read
// that both the colony recorder and the abandon detector now go through. The
// interesting cases are all about the sidebar being external markup we don't
// control: malformed rows, moon rows, a missing sidebar.
//
// @ts-check

import { describe, it, expect, afterEach } from 'vitest';
import { parsePlanetRow, readPlanetRows } from '../../../src/features/shared/planetRows.js';

/**
 * Build one `.smallplanet` row the way OGame renders it.
 *
 * @param {{ id?: string, coords?: string, used?: number, max?: number, name?: string, tooltip?: string | null }} o
 * @returns {string}
 */
const row = ({ id = 'planet-33001', coords = '[4:9:8]', used = 0, max = 235, name = 'Kolonia', tooltip } = {}) => {
  const tip = tooltip === undefined
    ? `<b>Kolonia ${coords}</b><br/>16.494km (${used}/${max})<br/>od -165 °C do -125 °C`
    : tooltip;
  const tipAttr = tip === null ? '' : ` data-tooltip-title="${tip.replace(/"/g, '&quot;')}"`;
  return `<div class="smallplanet" id="${id}">
    <a class="planetlink"${tipAttr}><span class="planet-name">${name}</span></a>
  </div>`;
};

/** @param {string} inner */
const mount = (inner) => { document.body.innerHTML = `<div id="planetList">${inner}</div>`; };

/** @returns {Element} the single row currently mounted. */
const only = () => /** @type {Element} */ (document.querySelector('.smallplanet'));

afterEach(() => { document.body.innerHTML = ''; });

describe('parsePlanetRow', () => {
  it('projects a well-formed row', () => {
    mount(row({ id: 'planet-33001', coords: '[4:9:8]', used: 0, max: 235, name: 'Kolonia' }));
    expect(parsePlanetRow(only())).toEqual({
      cp: 33001, coords: '[4:9:8]', galaxy: 4, system: 9, position: 8,
      name: 'Kolonia', used: 0, max: 235,
    });
  });

  it('trims the display name and tolerates an empty one', () => {
    mount(row({ name: '  Spaced  ' }));
    expect(parsePlanetRow(only())?.name).toBe('Spaced');
    mount(row({ name: '' }));
    expect(parsePlanetRow(only())?.name).toBe('');
  });

  it('rejects a row whose id is not a planet id', () => {
    mount(row({ id: 'moon-33002' }));
    expect(parsePlanetRow(only())).toBeNull();
  });

  it('rejects a non-numeric or zero planet id', () => {
    mount(row({ id: 'planet-abc' }));
    expect(parsePlanetRow(only())).toBeNull();
    mount(row({ id: 'planet-0' }));
    expect(parsePlanetRow(only())).toBeNull();
  });

  it('rejects a row with no planet link', () => {
    mount('<div class="smallplanet" id="planet-1"><span>no link</span></div>');
    expect(parsePlanetRow(only())).toBeNull();
  });

  it('rejects a row whose tooltip attribute is missing or unparseable', () => {
    mount(row({ tooltip: null }));
    expect(parsePlanetRow(only())).toBeNull();
    mount(row({ tooltip: '<b>Kolonia</b><br/>no numbers here' }));
    expect(parsePlanetRow(only())).toBeNull();
  });
});

describe('readPlanetRows', () => {
  it('projects every planet row in document order', () => {
    mount(
      row({ id: 'planet-1', coords: '[1:1:1]', used: 0, max: 100, name: 'A' })
      + row({ id: 'planet-2', coords: '[2:2:2]', used: 5, max: 200, name: 'B' })
      + row({ id: 'planet-3', coords: '[3:3:3]', used: 0, max: 300, name: 'C' }),
    );
    expect(readPlanetRows().map((r) => [r.cp, r.name, r.used, r.max]))
      .toEqual([[1, 'A', 0, 100], [2, 'B', 5, 200], [3, 'C', 0, 300]]);
  });

  it('excludes moon rows by construction — a moon field count is a different quantity', () => {
    mount(
      row({ id: 'planet-1', name: 'Planet' })
      + row({ id: 'moon-2', name: 'Moon' }),
    );
    expect(readPlanetRows().map((r) => r.name)).toEqual(['Planet']);
  });

  it('drops a malformed row instead of failing the whole scan', () => {
    mount(
      row({ id: 'planet-1', name: 'Good' })
      + row({ id: 'planet-2', name: 'Broken', tooltip: null })
      + row({ id: 'planet-3', name: 'AlsoGood' }),
    );
    expect(readPlanetRows().map((r) => r.name)).toEqual(['Good', 'AlsoGood']);
  });

  it('reads empty on a page with no sidebar — the correct answer, not an error', () => {
    document.body.innerHTML = '<div>not an ingame page</div>';
    expect(readPlanetRows()).toEqual([]);
  });

  it('reads empty for an existing but childless sidebar', () => {
    mount('');
    expect(readPlanetRows()).toEqual([]);
  });
});
