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

/**
 * Find the neighbourhood stat-card whose label matches `label` (trailing ★s
 * stripped), or undefined. The score line is now a row of `.stat-card`s.
 * @param {Element|null} root @param {string} label
 */
const cardEl = (root, label) =>
  [...(root?.querySelectorAll('.stat-card') ?? [])].find(
    (c) => (c.querySelector('.stat-label')?.textContent || '').replace(/\s*★+$/, '').trim() === label,
  );
/** @param {Element|null} root @param {string} label @returns {string|null} */
const cardValue = (root, label) => {
  const c = cardEl(root, label);
  return c ? (c.querySelector('.stat-value')?.textContent || '').trim() : null;
};

/** @param {Record<string, Record<number, any>>} spec */
const scansOf = (spec) => {
  /** @type {any} */
  const out = {};
  for (const [key, positions] of Object.entries(spec)) out[key] = { scannedAt: 1, positions };
  return out;
};

// `find` now defaults to 'spots' (neighbourhood windows, radius 15) — most of
// this suite pins down the per-system classification/labelling logic that was
// authored against a fixed 6-system STREAK region, so explicitly ask for the
// 'streaks' path to keep those fixtures meaningful. The new 'spots' default
// and zone-based ranking get their own dedicated tests below.
const baseOpts = () => ({ containerEl, countInfoEl, maxGaps: 0, find: 'streaks' });

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
    expect(countInfoEl.textContent).toMatch(/streak/);
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

    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Strong')).toBe('1');
    expect(cardValue(record, 'Active-on-vac')).toBe('1');
    expect(cardValue(record, 'Outlaw')).toBe('1');
  });

  it('classifies occupants by NoobProtection band and shows a target summary', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = occ(1); // honorable target
    spec['4:3'][5] = occ(2); // weak (newbie / protected)
    spec['4:4'][6] = occ(3); // strong
    /** @type {any} */
    const players = {
      1: { id: 1, name: 'H', flags: { honorable: true } },
      2: { id: 2, name: 'N', flags: { newbie: true } },
      3: { id: 3, name: 'S', flags: { strong: true } },
    };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], players });

    // Region target breakdown as stat cards in the detail panel.
    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Honorable')).toBe('1');
    expect(cardValue(record, 'Weak')).toBe('1');
    expect(cardValue(record, 'Strong')).toBe('1');

    // Per-occupant card: hovering system 2's strip cell pops a card that labels
    // the honorable occupant "Honorable", not the flat "Occupied".
    const cells = containerEl.querySelectorAll('.region-strip .strip-cell');
    cells[1].dispatchEvent(new Event('mouseenter')); // index 1 = system 2
    const pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/Honorable/);
    expect(pop?.textContent).not.toMatch(/Occupied/);
  });

  it('labels a live-scanned occupant with no special standing "Normal", not "Occupied"', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = occ(1); // plain "white" occupant
    /** @type {any} */
    const players = { 1: { id: 1, name: 'W', flags: { active: true } } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], players });

    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Normal')).toBe('1');

    const cells = containerEl.querySelectorAll('.region-strip .strip-cell');
    cells[1].dispatchEvent(new Event('mouseenter')); // system 2
    const pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/Normal/);
    expect(pop?.textContent).not.toMatch(/Occupied/);
  });

  it('keeps "Occupied" for an occupant we have NOT live-scanned (absent from the cache)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = occ(99); // occupant id 99 not present in the (empty) cache
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], players: {} });

    const cells = containerEl.querySelectorAll('.region-strip .strip-cell');
    cells[1].dispatchEvent(new Event('mouseenter'));
    const pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/Occupied/);
    expect(pop?.textContent).not.toMatch(/Normal/);
  });

  it('marks bandit occupants with their tier and a separate per-tier breakdown', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = { status: 'occupied', player: { id: 1, name: 'KB', rankClass: 'rank_bandit3' } };
    spec['4:3'][5] = { status: 'occupied', player: { id: 2, name: 'B', rankClass: 'rank_bandit1' } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8] });

    // Region-level bandit breakdown by tier, as cards separate from target bands.
    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Bandit King')).toBe('1');
    expect(cardValue(record, 'Bandit')).toBe('1');

    // Per-occupant chip on the Bandit King's system card (system 2).
    const cells = containerEl.querySelectorAll('.region-strip .strip-cell');
    cells[1].dispatchEvent(new Event('mouseenter'));
    const pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/Bandit King/);
  });

  it('never renders an "undefined" occupant name (falls back to cache name / id)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = { status: 'occupied', player: { id: 7 } }; // no per-slot name
    spec['4:3'][5] = { status: 'occupied', player: { id: 9 } }; // not cached
    /** @type {any} */
    const players = { 7: { id: 7, name: 'FromCache', flags: { active: true } } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], players });

    const cells = containerEl.querySelectorAll('.region-strip .strip-cell');
    cells[1].dispatchEvent(new Event('mouseenter')); // system 2 → id 7 (cached)
    let pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/FromCache/);
    expect(pop?.textContent).not.toMatch(/undefined/);

    cells[2].dispatchEvent(new Event('mouseenter')); // system 3 → id 9 (not cached)
    pop = containerEl.querySelector('.region-pop');
    expect(pop?.textContent).toMatch(/player 9/);
    expect(pop?.textContent).not.toMatch(/undefined/);
  });

  it('annotates the top neighbour rank relative to our own (ownRank)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    // A ranked neighbour at #100; we sit at #250 → they are 150 above us.
    spec['4:2'][3] = { status: 'occupied', player: { id: 5, name: 'X', rank: 100 } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8], ownRank: 250 });

    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Top rank')).toBe('#100');
    // the relative-to-you detail moved to the card tooltip.
    expect(cardEl(record, 'Top rank')?.getAttribute('title')).toMatch(/150 ranks above you/);
  });

  it('shows compact "Avg points" / "Avg military" cards when API points are present', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    // One API-mapped neighbour carrying account points → 1.2M / 340k cards.
    spec['4:2'][3] = { status: 'occupied', player: { id: 5, name: 'X', score: 1200000, militaryScore: 340000 } };
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8] });

    const record = containerEl.querySelector('.streak-record');
    expect(cardValue(record, 'Avg points')).toBe('1.2M');
    expect(cardValue(record, 'Avg military')).toBe('340k');
  });

  it('omits the points cards when no scanned player carries points (live-only scans)', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    spec['4:2'][3] = occ(5);
    renderFreeRegions({ ...baseOpts(), scans: scansOf(spec), positions: [8] });

    const record = containerEl.querySelector('.streak-record');
    expect(cardEl(record, 'Avg points')).toBeUndefined();
    expect(cardEl(record, 'Avg military')).toBeUndefined();
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
    expect(countInfoEl.textContent).toMatch(/No confirmed empty streaks/);
  });
});

describe("renderFreeRegions — 'spots' (default find) and zone-based ranking", () => {
  it('defaults to the candidate ("Best spots") table when find is omitted', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    renderFreeRegions({ containerEl, countInfoEl, maxGaps: 0, scans: scansOf(spec), positions: [8] });

    const table = containerEl.querySelector('table.streak-table');
    expect(table).toBeTruthy();
    // The candidate table has "Window"/"Ignored" columns; the streak table
    // has "Length"/"Gaps" instead — this is the observable mode fingerprint.
    const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent);
    expect(headers).toContain('Window');
    expect(headers).toContain('Ignored');
    expect(headers).not.toContain('Length');
    expect(countInfoEl.textContent).toMatch(/spot/);
  });

  it('explicit find:"streaks" opts back into the streak table', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    renderFreeRegions({ containerEl, countInfoEl, maxGaps: 0, scans: scansOf(spec), positions: [8], find: 'streaks' });

    const table = containerEl.querySelector('table.streak-table');
    const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent);
    expect(headers).toContain('Length');
    expect(headers).toContain('Gaps');
  });

  it('every rendered row carries a numeric Fit score (0-100), zone-ranked even without a field', () => {
    /** @type {Record<string, Record<number, any>>} */
    const spec = {};
    for (let s = 1; s <= 6; s++) spec[`4:${s}`] = { 8: empty };
    renderFreeRegions({ containerEl, countInfoEl, maxGaps: 0, scans: scansOf(spec), positions: [8], find: 'streaks' });
    const fitCell = containerEl.querySelector('table.streak-table tbody tr td:nth-child(2)');
    expect(Number(fitCell?.textContent)).toBeGreaterThanOrEqual(0);
    expect(Number(fitCell?.textContent)).toBeLessThanOrEqual(100);
  });

  it("zone weighting shifts a target-rich candidate's Fit — higher under 'pvp' than under 'safe'", () => {
    // One free-slot centre (system 1) surrounded by active honoured occupants
    // — a target-rich but not especially "quiet" neighbourhood. No field is
    // supplied (safety/farm stay at their field-less neutral values), so the
    // ONLY channel the two zones weight differently that actually moves here
    // is `target` (pvp: 0.65, safe: 0) — pvp must score this candidate higher.
    /** @type {Record<string, Record<number, any>>} */
    const spec = { '4:1': { 8: empty } };
    for (const s of [2, 3, 4, 5]) {
      spec[`4:${s}`] = { 3: { status: 'occupied', player: { id: 100 + s, name: 'T' + s, rankClass: 'rank_honored2' } } };
    }
    const scans = scansOf(spec);

    renderFreeRegions({ containerEl, countInfoEl, maxGaps: 0, scans, positions: [8], zone: 'pvp' });
    const pvpFit = Number(containerEl.querySelector('table.streak-table tbody tr td:nth-child(2)')?.textContent);

    const containerSafe = document.createElement('div');
    const countSafe = document.createElement('span');
    renderFreeRegions({ containerEl: containerSafe, countInfoEl: countSafe, maxGaps: 0, scans, positions: [8], zone: 'safe' });
    const safeFit = Number(containerSafe.querySelector('table.streak-table tbody tr td:nth-child(2)')?.textContent);

    expect(pvpFit).toBeGreaterThan(safeFit);
  });
});
