// @vitest-environment happy-dom
//
// Unit tests for the DOM extractor of the expedition-reminder feature.
// The reminder logic itself (clustering / reconcile) is covered by the
// pure `domain/waves` tests; here we only verify that we read the right
// rows out of `#eventContent` and normalise their fields, using a
// fixture shaped like the real `odp.html` capture.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { extractReturnEntries } from '../../src/features/expeditionReminder/index.js';

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
