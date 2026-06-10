// Pure-core tests for the Lifeforms button (src/features/sendLifeform/pure.js).
// Node environment — no DOM; every input arrives through explicit objects.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  LF_RESCAN_MS,
  isSystemLfStale,
  findNextLfSystem,
  countLfRemaining,
  derive,
  render,
  BG_LF_IDLE,
  BG_LF_ACTIVE,
  BG_LF_DONE,
} from '../../../src/features/sendLifeform/pure.js';

const NOW = 1_000_000_000_000;

/**
 * Build a GalaxyScans map from `{ 'g:s': lfScannedAt }` entries.
 * @param {Record<string, number>} entries
 */
const scansWithLf = (entries) => {
  /** @type {any} */
  const out = {};
  for (const [key, lfScannedAt] of Object.entries(entries)) {
    out[key] = { scannedAt: NOW, positions: {}, lfScannedAt };
  }
  return out;
};

describe('isSystemLfStale', () => {
  it('is stale when there is no record', () => {
    expect(isSystemLfStale(undefined, NOW)).toBe(true);
  });
  it('is stale when never discovered (no lfScannedAt)', () => {
    expect(isSystemLfStale({ scannedAt: NOW, positions: {} }, NOW)).toBe(true);
  });
  it('is fresh within the 7-day window', () => {
    const scan = { scannedAt: NOW, positions: {}, lfScannedAt: NOW - LF_RESCAN_MS + 1000 };
    expect(isSystemLfStale(scan, NOW)).toBe(false);
  });
  it('is stale once older than 7 days', () => {
    const scan = { scannedAt: NOW, positions: {}, lfScannedAt: NOW - LF_RESCAN_MS - 1 };
    expect(isSystemLfStale(scan, NOW)).toBe(true);
  });
});

describe('findNextLfSystem', () => {
  const home = { galaxy: 4, system: 250 };

  it('returns the current system itself when it is stale (distance 0 first)', () => {
    const scans = scansWithLf({}); // nothing discovered
    expect(findNextLfSystem(scans, { galaxy: 4, system: 250 }, NOW)).toEqual({
      galaxy: 4,
      system: 250,
    });
  });

  it('picks the nearest stale system by wrap-aware ring distance', () => {
    // Mark 248..252 fresh; nearest stale are 247 and 253 (distance 3) — the
    // "up" direction (253) is returned first at that distance.
    const scans = scansWithLf({
      '4:248': NOW, '4:249': NOW, '4:250': NOW, '4:251': NOW, '4:252': NOW,
    });
    expect(findNextLfSystem(scans, { galaxy: 4, system: 250 }, NOW)).toEqual({
      galaxy: 4,
      system: 253,
    });
  });

  it('treats system 1 and 499 as adjacent (wrap)', () => {
    // From system 1, mark 1 fresh; the two nearest (distance 1) are 2 and
    // 499. "up" (2) wins the tie — so mark 2 fresh too and expect 499.
    const scans = scansWithLf({ '4:1': NOW, '4:2': NOW });
    expect(findNextLfSystem(scans, { galaxy: 4, system: 1 }, NOW)).toEqual({
      galaxy: 4,
      system: 499,
    });
  });

  it('crosses to the next galaxy only after the current one is fully fresh', () => {
    // Make every system in galaxy 4 fresh; expect a hit in galaxy 5 (the
    // next entry of buildGalaxyOrder(4)).
    /** @type {any} */
    const scans = {};
    for (let s = 1; s <= 499; s++) scans[`4:${s}`] = { scannedAt: NOW, positions: {}, lfScannedAt: NOW };
    const next = findNextLfSystem(scans, home, NOW);
    expect(next?.galaxy).toBe(5);
    expect(next?.system).toBe(1);
  });

  it('returns null when every system in every galaxy is fresh', () => {
    /** @type {any} */
    const scans = {};
    for (let g = 1; g <= 7; g++) {
      for (let s = 1; s <= 499; s++) scans[`${g}:${s}`] = { scannedAt: NOW, positions: {}, lfScannedAt: NOW };
    }
    expect(findNextLfSystem(scans, home, NOW)).toBeNull();
  });
});

describe('countLfRemaining', () => {
  it('counts the whole universe when nothing is discovered', () => {
    expect(countLfRemaining({}, NOW)).toBe(7 * 499);
  });
  it('drops by one per freshly-discovered system', () => {
    expect(countLfRemaining(scansWithLf({ '4:250': NOW }), NOW)).toBe(7 * 499 - 1);
  });
});

describe('derive', () => {
  const base = { scans: {}, now: NOW, home: { galaxy: 4, system: 250 }, view: null, hasDiscoverBtn: false, cooldown: false };

  it('off galaxy → offGalaxy', () => {
    const ctx = derive({ ...base, search: '?page=ingame&component=overview' });
    expect(ctx.kind).toBe('offGalaxy');
  });

  it('on galaxy, viewed system stale + discover button present → discover', () => {
    const ctx = derive({
      ...base,
      search: '?page=ingame&component=galaxy',
      view: { galaxy: 4, system: 250 },
      hasDiscoverBtn: true,
    });
    expect(ctx.kind).toBe('discover');
    expect(ctx).toMatchObject({ target: { galaxy: 4, system: 250 } });
  });

  it('on galaxy, viewed system stale but NO discover button → navigate to same system', () => {
    const ctx = derive({
      ...base,
      search: '?page=ingame&component=galaxy',
      view: { galaxy: 4, system: 250 },
      hasDiscoverBtn: false,
    });
    expect(ctx).toMatchObject({ kind: 'navigate', target: { galaxy: 4, system: 250 } });
  });

  it('on galaxy, viewed system fresh → navigate to nearest stale', () => {
    const ctx = derive({
      ...base,
      search: '?page=ingame&component=galaxy',
      view: { galaxy: 4, system: 250 },
      scans: scansWithLf({ '4:250': NOW }),
      hasDiscoverBtn: true,
    });
    expect(ctx.kind).toBe('navigate');
    // nearest stale to 250 is 249 or 251 (distance 1; "up" 251 wins)
    expect(ctx).toMatchObject({ target: { galaxy: 4, system: 251 } });
  });

  it('everything fresh → allDone', () => {
    /** @type {any} */
    const scans = {};
    for (let g = 1; g <= 7; g++) {
      for (let s = 1; s <= 499; s++) scans[`${g}:${s}`] = { scannedAt: NOW, positions: {}, lfScannedAt: NOW };
    }
    const ctx = derive({
      ...base,
      search: '?page=ingame&component=galaxy',
      view: { galaxy: 4, system: 250 },
      scans,
    });
    expect(ctx.kind).toBe('allDone');
  });
});

describe('render', () => {
  it('discover → "Discover [g:s]" in the active violet', () => {
    const p = render({ kind: 'discover', target: { galaxy: 4, system: 250 }, cooldown: false, scansRemaining: 5 });
    expect(p).toMatchObject({ text: 'Discover', subtext: '[4:250]', bg: BG_LF_ACTIVE });
  });
  it('discover dims while cooling down', () => {
    const p = render({ kind: 'discover', target: { galaxy: 4, system: 250 }, cooldown: true, scansRemaining: 5 });
    expect(p.dim).toBe(true);
  });
  it('navigate → "Next [g:s]"', () => {
    const p = render({ kind: 'navigate', target: { galaxy: 5, system: 1 }, cooldown: false, scansRemaining: 5 });
    expect(p).toMatchObject({ text: 'Next', subtext: '[5:1]' });
  });
  it('offGalaxy → "To galaxy" (idle violet)', () => {
    const p = render({ kind: 'offGalaxy', scansRemaining: 10 });
    expect(p).toMatchObject({ text: 'To galaxy', bg: BG_LF_IDLE });
  });
  it('allDone → "All discovered!"', () => {
    const p = render({ kind: 'allDone', cooldown: false, scansRemaining: 0 });
    expect(p).toMatchObject({ text: 'All discovered!', bg: BG_LF_DONE });
  });
});
