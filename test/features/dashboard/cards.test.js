// @vitest-environment happy-dom

// Behavioural tests for the Spyglass watchlist cards (Etap H4). The renderer is
// pure DOM over the same per-repaint data the table/dossier read; these drive it
// through happy-dom and assert the observable output — the empty-state ghost, one
// card per watched player, the verdict text, and the click → onOpen deep-link.

// @ts-check

import { describe, it, expect } from 'vitest';
import { renderWatchlistCards } from '../../../src/features/dashboard/cards.js';

/** @returns {any} minimal args with sensible empties, overridable per test. */
const baseArgs = (over = {}) => ({
  hostEl: document.createElement('div'),
  watchedIds: new Set(),
  candidates: [],
  verdicts: {},
  estimates: {},
  danger: new Map(),
  routines: {},
  relationships: {},
  reportsByPlayer: {},
  inBand: {},
  nowMs: 1_700_000_000_000,
  onOpen: () => {},
  ...over,
});

describe('renderWatchlistCards', () => {
  it('renders a single ghost onboarding card when nobody is watched', () => {
    const a = baseArgs();
    renderWatchlistCards(a);
    const cards = a.hostEl.querySelectorAll('.watch-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toMatch(/Nobody watched yet/i);
    // The label reads "Watchlist" with no count (now a gv-card-title, matching
    // the Galaxy Viewer's card headers).
    expect(a.hostEl.querySelector('.gv-card-title')?.textContent).toBe('Watchlist');
  });

  it('renders one card per watched player with name + verdict, labelled with the count', () => {
    const a = baseArgs({
      watchedIds: new Set(['7']),
      candidates: [{ id: '7', name: 'Yoxid', ships: 890000 }],
      verdicts: { 7: { kind: 'raid', label: 'RAID NOW', tier: 'high', lootNow: 180e6, reasons: [] } },
      danger: new Map([[7, { danger: 0.82, friendly: false, mobileHi: 4e7 }]]),
    });
    renderWatchlistCards(a);
    const cards = a.hostEl.querySelectorAll('.watch-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Yoxid');
    expect(cards[0].textContent).toContain('RAID NOW');
    expect(a.hostEl.querySelector('.gv-card-title')?.textContent).toBe('Watchlist (1)');
  });

  it('clicking a card opens that player (deep-link, no watchlist mutation)', () => {
    /** @type {string[]} */
    const opened = [];
    const a = baseArgs({
      watchedIds: new Set(['7']),
      candidates: [{ id: '7', name: 'Yoxid', ships: 5 }],
      onOpen: (/** @type {string} */ pid) => opened.push(pid),
    });
    renderWatchlistCards(a);
    /** @type {HTMLElement} */ (a.hostEl.querySelector('.watch-card')).click();
    expect(opened).toEqual(['7']);
  });

  it('shows the pure-defense headline for a 0-ships player', () => {
    const a = baseArgs({
      watchedIds: new Set(['9']),
      candidates: [{ id: '9', name: 'Nova', ships: 0 }],
      danger: new Map([[9, { danger: 0.12, friendly: false, mobileHi: 0 }]]),
    });
    renderWatchlistCards(a);
    expect(a.hostEl.querySelector('.watch-card')?.textContent).toContain('pure defense');
  });
});

describe('renderWatchlistCards — unknown alliance-class nudge', () => {
  const linkBase = 'https://s163-pl.ogame.gameforge.com';

  it('flags a watched player with an alliance but unknown class (banner + inline deep-link)', () => {
    const a = baseArgs({
      watchedIds: new Set(['20']),
      candidates: [{ id: '20', name: 'GumkaVIP', ships: 500 }],
      danger: new Map([[20, { danger: 0.9, friendly: false, mobileHi: 4e6, allianceId: '500921' }]]),
      linkBase,
    });
    renderWatchlistCards(a);
    expect(a.hostEl.textContent).toMatch(/unknown alliance class/i);
    const link = /** @type {HTMLAnchorElement|null} */ (a.hostEl.querySelector('a[href*="searchRelId=500921"]'));
    expect(link).toBeTruthy();
    const href = link?.getAttribute('href') || '';
    expect(href).toContain(linkBase);
    expect(href).toContain('page=highscore');
    expect(href).toContain('category=2');
  });

  it('does NOT flag a player whose class is known (warrior)', () => {
    const a = baseArgs({
      watchedIds: new Set(['20']),
      candidates: [{ id: '20', name: 'GumkaVIP', ships: 500 }],
      danger: new Map([[20, { danger: 0.9, friendly: false, mobileHi: 4e6, allianceId: '500921', allianceClass: 'warrior' }]]),
      linkBase,
    });
    renderWatchlistCards(a);
    expect(a.hostEl.textContent).not.toMatch(/unknown alliance class/i);
  });

  it('does NOT flag a classless alliance (harvested "none" is KNOWN)', () => {
    const a = baseArgs({
      watchedIds: new Set(['20']),
      candidates: [{ id: '20', name: 'X', ships: 500 }],
      danger: new Map([[20, { danger: 0.5, friendly: false, mobileHi: 4e6, allianceId: '500921', allianceClass: 'none' }]]),
      linkBase,
    });
    renderWatchlistCards(a);
    expect(a.hostEl.textContent).not.toMatch(/unknown alliance class/i);
  });

  it('does NOT flag a friendly player, nor one with no alliance', () => {
    const a = baseArgs({
      watchedIds: new Set(['20', '21']),
      candidates: [{ id: '20', name: 'Mate', ships: 5 }, { id: '21', name: 'Loner', ships: 500 }],
      danger: new Map([
        [20, { danger: 0, friendly: true, mobileHi: 0, allianceId: '500921' }],
        [21, { danger: 0.5, friendly: false, mobileHi: 4e6 }],
      ]),
      linkBase,
    });
    renderWatchlistCards(a);
    expect(a.hostEl.textContent).not.toMatch(/unknown alliance class/i);
  });

  it('without linkBase the nudge is plain text (no link)', () => {
    const a = baseArgs({
      watchedIds: new Set(['20']),
      candidates: [{ id: '20', name: 'GumkaVIP', ships: 500 }],
      danger: new Map([[20, { danger: 0.9, friendly: false, mobileHi: 4e6, allianceId: '500921' }]]),
    });
    renderWatchlistCards(a);
    expect(a.hostEl.textContent).toMatch(/unknown alliance class/i);
    expect(a.hostEl.querySelector('a[href*="searchRelId"]')).toBeNull();
  });
});
