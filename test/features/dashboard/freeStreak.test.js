// @vitest-environment happy-dom

// Behavioural tests for the settlement-regions renderer. The feature had
// no coverage; these drive renderFreeRegions through happy-dom and assert
// the observable DOM for the three paths that matter most:
//
//   1. a real contiguous region (≥ MIN_REGION_LENGTH) renders the table +
//      record card + a coloured strip with a legend;
//   2. scattered free systems (no region) fall back to the individual
//      free-systems list with an explanatory note — the bug this fixes;
//   3. nothing free shows the "scan more" empty message and no table.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import { renderFreeRegions } from '../../../src/features/dashboard/freeStreak.js';

/** @type {HTMLElement} */
let containerEl;
/** @type {HTMLElement} */
let countInfoEl;

beforeEach(() => {
  containerEl = document.createElement('div');
  countInfoEl = document.createElement('span');
});

const empty = { status: 'empty' };
/** @param {number} id */
const occ = (id) => ({ status: 'occupied', player: { id, name: 'P' + id } });

/** @param {Record<string, Record<number, any>>} spec */
const scansOf = (spec) => {
  /** @type {any} */
  const out = {};
  for (const [key, positions] of Object.entries(spec)) out[key] = { scannedAt: 1, positions };
  return out;
};

const baseOpts = () => ({ containerEl, countInfoEl, maxGaps: 0 });

describe('renderFreeRegions', () => {
  it('renders a table, record card and a legended strip for a real region', () => {
    // Six consecutive systems with slot 8 empty → one region of length 6.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8] });

    expect(containerEl.querySelector('table.streak-table')).toBeTruthy();
    expect(containerEl.querySelector('.streak-record')).toBeTruthy();
    expect(containerEl.querySelectorAll('.region-strip .strip-cell')).toHaveLength(6);
    expect(containerEl.querySelector('.region-legend')).toBeTruthy();
    // Rich per-system detail is now a hover/pin popover, not a native title.
    expect(containerEl.querySelector('.region-strip-wrap .region-pop')).toBeTruthy();
    expect(countInfoEl.textContent).toMatch(/region/);
  });

  it('surfaces player-cache signals (strong / active-on-vac / outlaw) in the record', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = occ(10); // strong neighbour
    spec['4:3'][5] = { status: 'vacation', player: { id: 20, name: 'V' } }; // active-on-vac
    spec['4:4'][6] = occ(30); // outlaw
    /** @type {any} */
    const players = {
      10: { id: 10, name: 'A', flags: { strong: true } },
      20: { id: 20, name: 'V', flags: { active: true } },
      30: { id: 30, name: 'O', flags: { outlaw: true } },
    };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], players });

    const score = containerEl.querySelector('.streak-score');
    expect(score?.textContent).toMatch(/strong/);
    expect(score?.textContent).toMatch(/active-on-vac/);
    expect(score?.textContent).toMatch(/outlaw/);
  });

  it('annotates the top neighbour rank relative to our own (ownRank)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    // A ranked neighbour at #100; we sit at #250 → they are 150 above us.
    spec['4:2'][3] = { status: 'occupied', player: { id: 5, name: 'X', rank: 100 } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], ownRank: 250 });

    const score = containerEl.querySelector('.streak-score');
    expect(score?.textContent).toMatch(/top neighbour rank #100 \(150 above you\)/);
  });

  it('falls back to the individual free-systems list when no region forms', () => {
    // Slot 8 free at non-adjacent systems — no run of 5, so no region.
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (const s of [1, 3, 5, 7, 9]) spec[`4:${s}`] = { 8: empty };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8] });

    const note = containerEl.querySelector('.empty');
    expect(note).toBeTruthy();
    expect(note?.textContent).toMatch(/individual free system/);
    // The free systems are still listed in a table…
    expect(containerEl.querySelector('table.streak-table')).toBeTruthy();
    // …and the selected free system now gets the same interactive detail panel
    // (the table rows + detail are a unified interactive pair across all paths).
    expect(containerEl.querySelector('.streak-record')).toBeTruthy();
    expect(countInfoEl.textContent).toMatch(/individual free system/);
  });

  it('shows the scan-more empty state when nothing is free', () => {
    const scans = scansOf({ '4:1': { 8: occ(1) }, '4:2': { 8: occ(2) } });
    renderFreeRegions({ ...baseOpts(), scans, positions: [8] });

    const empties = containerEl.querySelectorAll('.empty');
    expect(empties).toHaveLength(1);
    expect(empties[0].textContent).toMatch(/Nothing to show yet/);
    expect(containerEl.querySelector('table.streak-table')).toBeFalsy();
    expect(countInfoEl.textContent).toMatch(/No confirmed empty regions/);
  });
});
