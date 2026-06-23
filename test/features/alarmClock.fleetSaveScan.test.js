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
  shipCountOf, isOwnFleet, fleetSaveLabelFor, extractFleetSaveCandidates, fleetRowMeta,
} from '../../src/features/alarmClock/fleetSaveScan.js';

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
 * @param {string} [o.originName]
 * @param {string} [o.destName]
 * @returns {string}
 */
const row = ({
  id, mission = '4', ret = 'false', arrival, ships, own = true,
  dest = '4:478:14', origin = '7:281:15', originName = 'P1', destName = 'Deep space',
}) => `
  <tr class="eventFleet" id="eventRow-${id}"
      data-mission-type="${mission}" data-return-flight="${ret}"
      data-arrival-time="${arrival}">
    <td class="countDown"><span class="${own ? 'friendly' : 'hostile'} textBeefy">x</span></td>
    <td class="detailsFleet"><span>${ships}</span></td>
    <td class="originFleet"><figure class="planetIcon planet"></figure>${originName}</td>
    <td class="coordsOrigin"><a>[${origin}]</a></td>
    <td class="destFleet"><span class="tooltip" title="${destName}"><figure></figure>${destName.slice(0, 6)}...</span></td>
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

describe('fleetSaveLabelFor', () => {
  it('labels an outbound leg with its destination coords', () => {
    expect(fleetSaveLabelFor(paint(row({ id: '1', arrival: '1', ships: '1', ret: 'false', dest: '4:478:14' }))))
      .toBe('Deployment → [4:478:14]');
  });

  it('labels a return leg with its origin coords (where it lands)', () => {
    expect(fleetSaveLabelFor(paint(row({ id: '1', mission: '15', ret: 'true', arrival: '1', ships: '1', origin: '7:281:15' }))))
      .toBe('Expedition → [7:281:15]');
  });
});

describe('fleetRowMeta', () => {
  it('captures launch/target coords + names and ship count', () => {
    const r = paint(row({
      id: '1', arrival: '1', ships: '4.323',
      origin: '4:467:15', originName: 'P1', dest: '4:467:16', destName: 'Deep space',
    }));
    expect(fleetRowMeta(r)).toEqual({
      origin: '[4:467:15]', originName: 'P1',
      target: '[4:467:16]', targetName: 'Deep space', shipCount: 4323,
    });
  });

  it('omits shipCount when unparseable; missing cells yield empty strings', () => {
    document.body.innerHTML =
      '<table id="eventContent"><tbody>' +
      '<tr class="eventFleet" id="eventRow-1"><td class="coordsOrigin"><a>[1:2:3]</a></td></tr>' +
      '</tbody></table>';
    const r = /** @type {HTMLElement} */ (document.querySelector('tr.eventFleet'));
    expect(fleetRowMeta(r)).toEqual({ origin: '[1:2:3]', originName: '', target: '', targetName: '' });
  });
});

describe('extractFleetSaveCandidates', () => {
  it('reads own legs with the full per-fleet metadata', () => {
    paint(row({ id: '100', arrival: '1780230414', ships: '8.256.872', dest: '4:478:14' }));
    expect(extractFleetSaveCandidates()).toEqual([
      {
        id: 'eventRow-100', arrivalAt: 1780230414, shipCount: 8256872,
        label: 'Deployment → [4:478:14]',
        // Landing body key (g:s:p:type) — outbound leg lands at the dest planet.
        // Byte-identical to badges/pure.js::bodyKey so the landed-FS flag aligns.
        landingKey: '4:478:14:1',
        origin: '[7:281:15]', originName: 'P1', target: '[4:478:14]', targetName: 'Deep space',
      },
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

  it('keeps the outbound leg of one-way missions (Deployment 4, Colonisation 7)', () => {
    paint(
      row({ id: '1', mission: '4', ret: 'false', arrival: '100', ships: '500000' }) +
      row({ id: '2', mission: '7', ret: 'false', arrival: '200', ships: '500000' }),
    );
    expect(extractFleetSaveCandidates().map((c) => c.id)).toEqual(['eventRow-1', 'eventRow-2']);
  });

  it('skips the OUTBOUND leg of a round-trip mission, keeping only the RETURN', () => {
    // Espionage (6) shows both legs at once; only the return lands home.
    paint(
      row({ id: '850', mission: '6', ret: 'false', arrival: '100', ships: '8108672' }) +
      row({ id: '851', mission: '6', ret: 'true', arrival: '300', ships: '8108672', origin: '4:478:14' }),
    );
    const got = extractFleetSaveCandidates();
    expect(got.map((c) => c.id)).toEqual(['eventRow-851']);
    expect(got[0].label).toBe('Espionage → [4:478:14]');
  });

  it('skips round-trip outbound for Transport (3) too', () => {
    paint(row({ id: '9', mission: '3', ret: 'false', arrival: '100', ships: '500000' }));
    expect(extractFleetSaveCandidates()).toEqual([]);
  });
});
