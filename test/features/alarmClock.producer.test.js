// @vitest-environment happy-dom
//
// Unit tests for the DOM extractors of the alarmClock producer. The
// alarmClock logic itself (clustering / reconcile) is covered by the pure
// `domain/waves` + `domain/adhoc` tests; here we only verify that we read
// the right rows out of `#eventContent` and normalise their fields, using
// a fixture shaped like the real event-list capture.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  extractReturnEntries, extractPresentFleets, signatureOf, fsCapReadyIds,
} from '../../src/features/alarmClock/producer.js';

/**
 * Build one `#eventContent` row.
 *
 * @param {{ id: string, mission?: string, ret?: string, arrival: string, coords: string }} o
 * @returns {string}
 */
const row = ({ id, mission = '15', ret = 'true', arrival, coords }) => `
  <tr class="eventFleet" id="eventRow-${id}"
      data-mission-type="${mission}" data-return-flight="${ret}"
      data-arrival-time="${arrival}">
    <td class="coordsOrigin">
      <a href="#">[${coords}]</a>
    </td>
  </tr>`;

/** @param {string} rowsHtml */
const paint = (rowsHtml) => {
  document.body.innerHTML = `<table id="eventContent"><tbody>${rowsHtml}</tbody></table>`;
};

describe('extractReturnEntries', () => {
  it('reads returnAt and dense origin coords from return-flight rows', () => {
    paint(row({ id: '141279718', arrival: '1779913212', coords: '4:467:15' }));
    const entries = extractReturnEntries();
    expect(entries).toEqual([
      { returnAt: 1779913212, origin: '4:467:15' },
    ]);
  });

  it('ignores outbound rows (return-flight="false")', () => {
    paint(
      row({ id: '1', ret: 'false', arrival: '1779912245', coords: '4:467:15' }) +
      row({ id: '2', ret: 'true', arrival: '1779913212', coords: '4:467:15' }),
    );
    const entries = extractReturnEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].returnAt).toBe(1779913212);
  });

  it('ignores non-expedition missions', () => {
    paint(row({ id: '9', mission: '3', arrival: '1779913212', coords: '4:467:15' }));
    expect(extractReturnEntries()).toEqual([]);
  });

  it('reads every expedition in a multi-planet burst', () => {
    paint(
      row({ id: '141279718', arrival: '1779913212', coords: '4:467:15' }) +
      row({ id: '141279726', arrival: '1779913216', coords: '4:468:14' }) +
      row({ id: '141279723', arrival: '1779913218', coords: '4:469:15' }),
    );
    const entries = extractReturnEntries();
    expect(entries.map((e) => e.origin)).toEqual(['4:467:15', '4:468:14', '4:469:15']);
  });

  it('strips brackets and whitespace from coords', () => {
    paint(row({ id: '1', arrival: '1779913212', coords: ' 4 : 467 : 15 ' }));
    expect(extractReturnEntries()[0].origin).toBe('4:467:15');
  });
});

describe('extractPresentFleets', () => {
  it('reads every leg (any mission, any direction) as { id, arrivalAt }', () => {
    paint(
      // outbound expedition, returning expedition, and a transport
      row({ id: '100', ret: 'false', arrival: '1779912000', coords: '4:467:15' }) +
      row({ id: '101', ret: 'true', arrival: '1779913000', coords: '4:468:14' }) +
      row({ id: '102', mission: '3', ret: 'false', arrival: '1779914000', coords: '1:2:3' }),
    );
    expect(extractPresentFleets()).toEqual([
      { id: 'eventRow-100', arrivalAt: 1779912000 },
      { id: 'eventRow-101', arrivalAt: 1779913000 },
      { id: 'eventRow-102', arrivalAt: 1779914000 },
    ]);
  });

  it('skips rows without a parseable arrival time', () => {
    document.body.innerHTML =
      '<table id="eventContent"><tbody>' +
      '<tr class="eventFleet" id="eventRow-1"><td></td></tr>' +
      '</tbody></table>';
    expect(extractPresentFleets()).toEqual([]);
  });
});

const NOW = 1_000_000;
const DAY = 86400;
/** @param {string} id @param {number} arrivalAt */
const fsCand = (id, arrivalAt) => ({ id, arrivalAt, shipCount: 200000, label: 'x' });

describe('fsCapReadyIds', () => {
  it('includes a save whose earliest slot is within the 3-day cap', () => {
    expect(fsCapReadyIds([fsCand('eventRow-1', NOW + 2 * DAY)], [-600, 0, 600], NOW))
      .toEqual(['eventRow-1']);
  });

  it('excludes a save still beyond the cap, then includes it once it crosses', () => {
    const arrival = NOW + 5 * DAY; // earliest slot = arrival-600, ~5 days out
    expect(fsCapReadyIds([fsCand('eventRow-1', arrival)], [-600, 0, 600], NOW)).toEqual([]);
    // Same arrival, but observed 2 days later → earliest slot now < 3 days off.
    expect(fsCapReadyIds([fsCand('eventRow-1', arrival)], [-600, 0, 600], NOW + 2 * DAY + 700))
      .toEqual(['eventRow-1']);
  });

  it('uses the most-negative offset as the earliest slot, and tolerates no offsets', () => {
    // arrival exactly 3 days + 5 min out: a -600 offset pulls the first slot
    // inside the cap, but a 0-or-later schedule leaves it just outside.
    const arrival = NOW + 3 * DAY + 300;
    expect(fsCapReadyIds([fsCand('a', arrival)], [-600, 0], NOW)).toEqual(['a']);
    expect(fsCapReadyIds([fsCand('a', arrival)], [0, 600], NOW)).toEqual([]);
    expect(fsCapReadyIds([fsCand('a', arrival)], [], NOW)).toEqual([]);
  });

  it('drops candidates with a non-finite arrival', () => {
    expect(fsCapReadyIds([fsCand('a', NaN)], [-600], NOW)).toEqual([]);
  });
});

describe('signatureOf', () => {
  it('changes when a far fleet-save crosses into the schedulable window', () => {
    const present = [{ id: 'eventRow-1', arrivalAt: 9_999_999 }];
    // Same DOM (id + arrival unchanged) — only the cap-readiness flips. This
    // is the term that defeats the no-op short-circuit for a long fleet-save.
    expect(signatureOf([], present, [])).not.toBe(signatureOf([], present, ['eventRow-1']));
  });

  it('is order-independent across legs and ready-ids', () => {
    const a = signatureOf([], [{ id: 'b', arrivalAt: 2 }, { id: 'a', arrivalAt: 1 }], ['y', 'x']);
    const b = signatureOf([], [{ id: 'a', arrivalAt: 1 }, { id: 'b', arrivalAt: 2 }], ['x', 'y']);
    expect(a).toBe(b);
  });
});
