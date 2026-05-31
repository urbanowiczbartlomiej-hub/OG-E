// @vitest-environment happy-dom
//
// DOM tests for the fleet-save scan helpers — reading the per-leg ship
// count + ownership out of `#eventContent`, using fixtures shaped like the
// real event-list capture (locale-formatted ship totals, `friendly` /
// `hostile` countdown classes).
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  shipCountOf, isOwnFleet, fsLabelFor, extractFleetSaveCandidates,
} from '../../src/features/reminders/fsScan.js';

/**
 * Build one `#eventContent` row.
 *
 * @param {object} o
 * @param {string} o.id
 * @param {string} [o.mission]
 * @param {string} [o.ret]
 * @param {string} o.arrival
 * @param {string} o.ships     Locale-formatted ship total (e.g. '8.256.872').
 * @param {boolean} [o.own]    `friendly` (own) vs `hostile` (incoming).
 * @param {string} [o.dest]
 * @param {string} [o.origin]
 * @returns {string}
 */
const row = ({ id, mission = '4', ret = 'false', arrival, ships, own = true, dest = '4:478:14', origin = '7:281:15' }) => `
  <tr class="eventFleet" id="eventRow-${id}"
      data-mission-type="${mission}" data-return-flight="${ret}"
      data-arrival-time="${arrival}">
    <td class="countDown"><span class="${own ? 'friendly' : 'hostile'} textBeefy">x</span></td>
    <td class="detailsFleet"><span>${ships}</span></td>
    <td class="coordsOrigin"><a>[${origin}]</a></td>
    <td class="destCoords"><a>[${dest}]</a></td>
  </tr>`;

/** @param {string} rowsHtml */
const paint = (rowsHtml) => {
  document.body.innerHTML = `<table id="eventContent"><tbody>${rowsHtml}</tbody></table>`;
  return /** @type {HTMLElement} */ (document.querySelector('tr.eventFleet'));
};

describe('shipCountOf', () => {
  it('parses a locale-formatted total, ignoring the thousands separators', () => {
    expect(shipCountOf(paint(row({ id: '1', arrival: '1', ships: '8.256.872' })))).toBe(8256872);
    expect(shipCountOf(paint(row({ id: '1', arrival: '1', ships: '4.289' })))).toBe(4289);
  });

  it('returns NaN when the cell is absent / empty', () => {
    document.body.innerHTML = '<table id="eventContent"><tbody><tr class="eventFleet" id="eventRow-1"><td></td></tr></tbody></table>';
    expect(Number.isNaN(shipCountOf(/** @type {HTMLElement} */ (document.querySelector('tr'))))).toBe(true);
  });
});

describe('isOwnFleet', () => {
  it('is true for a friendly countdown, false for a hostile one', () => {
    expect(isOwnFleet(paint(row({ id: '1', arrival: '1', ships: '100', own: true })))).toBe(true);
    expect(isOwnFleet(paint(row({ id: '1', arrival: '1', ships: '100', own: false })))).toBe(false);
  });
});

describe('fsLabelFor', () => {
  it('labels an outbound leg with its destination coords', () => {
    expect(fsLabelFor(paint(row({ id: '1', arrival: '1', ships: '1', ret: 'false', dest: '4:478:14' }))))
      .toBe('Deployment → [4:478:14]');
  });

  it('labels a return leg with its origin coords (where it lands)', () => {
    expect(fsLabelFor(paint(row({ id: '1', mission: '15', ret: 'true', arrival: '1', ships: '1', origin: '7:281:15' }))))
      .toBe('Expedition → [7:281:15]');
  });
});

describe('extractFleetSaveCandidates', () => {
  it('reads own legs as { id, arrivalAt, shipCount, label }', () => {
    paint(row({ id: '100', arrival: '1780230414', ships: '8.256.872', dest: '4:478:14' }));
    expect(extractFleetSaveCandidates()).toEqual([
      { id: 'eventRow-100', arrivalAt: 1780230414, shipCount: 8256872, label: 'Deployment → [4:478:14]' },
    ]);
  });

  it('skips hostile (incoming) fleets', () => {
    paint(
      row({ id: '1', arrival: '1780230414', ships: '8.256.872', own: false }) +
      row({ id: '2', arrival: '1780230500', ships: '500000', own: true }),
    );
    expect(extractFleetSaveCandidates().map((c) => c.id)).toEqual(['eventRow-2']);
  });

  it('skips rows without a parseable arrival or ship count', () => {
    document.body.innerHTML =
      '<table id="eventContent"><tbody>' +
      '<tr class="eventFleet" id="eventRow-1"><td class="countDown"><span class="friendly">x</span></td></tr>' +
      '</tbody></table>';
    expect(extractFleetSaveCandidates()).toEqual([]);
  });
});
