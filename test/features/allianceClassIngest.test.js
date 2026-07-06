// @vitest-environment happy-dom

// Behavioural tests for the alliance-class DOM harvester
// (features/allianceClassIngest). We drive a real (happy-dom) ALLIANCE-highscore
// fragment through the MutationObserver + initial sweep and assert the OBSERVABLE
// output: the `allianceId → class` map merged into the store. `state/allianceClass`
// is mocked so `mergeAllianceClasses` is a vi.fn we assert on — no chrome.storage.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/state/allianceClass.js', () => ({
  mergeAllianceClasses: vi.fn(() => Promise.resolve()),
}));

import { mergeAllianceClasses } from '../../src/state/allianceClass.js';
import {
  installAllianceClassIngest,
  _resetAllianceClassIngestForTest,
} from '../../src/features/allianceClassIngest/index.js';

/** @type {import('vitest').Mock} */
const merge = /** @type {any} */ (mergeAllianceClasses);

/** One alliance-highscore row. */
const row = (/** @type {string} */ id, /** @type {string} */ cls, /** @type {string} */ name) =>
  `<tr id="${id}"><td class="name"><div class="ally-name">`
  + `<span class="alliance_class small ${cls}">${name}</span></div></td></tr>`;

const rankingHtml = (/** @type {string} */ rows) =>
  `<table id="ranks" class="allyHighscore"><tbody>${rows}</tbody></table>`;

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  merge.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  _resetAllianceClassIngestForTest();
});

describe('installAllianceClassIngest — initial sweep (server-rendered ranking)', () => {
  it('harvests every parseable row into allianceId → class (incl. "none")', () => {
    document.body.innerHTML = rankingHtml(
      row('position500921', 'warrior', 'Szopy')
      + row('position500485', 'trader', 'Vendetta')
      + row('position500609', 'explorer', 'Badacze')
      + row('position501033', 'none', 'Urlopowicze'),
    );
    installAllianceClassIngest();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith({
      500921: 'warrior',
      500485: 'trader',
      500609: 'explorer',
      501033: 'none',
    });
  });

  it('skips rows with an unparseable id or a class-less span', () => {
    document.body.innerHTML = rankingHtml(
      row('position500921', 'warrior', 'Szopy')
      + '<tr id="notaposition"><td><span class="alliance_class small trader">x</span></td></tr>'
      + '<tr id="position777"><td class="name">no class span here</td></tr>',
    );
    installAllianceClassIngest();
    expect(merge).toHaveBeenCalledWith({ 500921: 'warrior' });
  });

  it('does nothing on a non-highscore page (no allyHighscore table)', () => {
    document.body.innerHTML = '<table id="ranks" class="playerHighscore"><tbody>'
      + '<tr id="position1"><td>Player</td></tr></tbody></table>';
    installAllianceClassIngest();
    expect(merge).not.toHaveBeenCalled();
  });

  it('is idempotent — a second install does not attach a second observer', () => {
    installAllianceClassIngest();
    installAllianceClassIngest();
    expect(merge).not.toHaveBeenCalled(); // empty body, no rows
  });
});

describe('installAllianceClassIngest — ajax pager (observer path)', () => {
  it('harvests a ranking injected AFTER install', async () => {
    installAllianceClassIngest(); // empty body first
    expect(merge).not.toHaveBeenCalled();

    const holder = document.createElement('div');
    holder.innerHTML = rankingHtml(row('position500501', 'warrior', 'SuperMega'));
    document.body.appendChild(holder);
    await tick();

    expect(merge).toHaveBeenCalledWith({ 500501: 'warrior' });
  });

  it('coalesces a burst and skips a re-sweep of the identical page', async () => {
    document.body.innerHTML = rankingHtml(row('position500921', 'warrior', 'Szopy'));
    installAllianceClassIngest();
    expect(merge).toHaveBeenCalledTimes(1);

    // Re-append the SAME table content — the signature guard skips the redundant merge.
    const holder = document.createElement('div');
    holder.innerHTML = rankingHtml(row('position500921', 'warrior', 'Szopy'));
    document.body.appendChild(holder);
    await tick();

    expect(merge).toHaveBeenCalledTimes(1);
  });
});
