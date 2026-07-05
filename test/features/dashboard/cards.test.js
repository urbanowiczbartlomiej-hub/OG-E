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
    // The label reads "Watchlist" with no count.
    expect(a.hostEl.querySelector('.watch-zone-label')?.textContent).toBe('Watchlist');
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
    expect(a.hostEl.querySelector('.watch-zone-label')?.textContent).toBe('Watchlist (1)');
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
