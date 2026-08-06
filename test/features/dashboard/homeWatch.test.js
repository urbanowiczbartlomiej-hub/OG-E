// @vitest-environment happy-dom

// Behavioural tests for the "Your neighbours" card renderer — driven through
// happy-dom, asserting the rendered DOM rather than internals.
//
// Focus: the Coords/Names switch. The systems on this card are OURS, so the
// switch reads them back as the bodies we hold there — and the coordinate must
// never simply vanish (it moves into the hover, so the galaxy link still says
// where it goes).

import { describe, it, expect } from 'vitest';
import { renderHomeWatchCard } from '../../../src/features/dashboard/homeWatch.js';

// Cast: the fixtures carry the FIELDS the renderer reads, not whole
// DangerProfile / HomeArrival records — spelling those out in full would test
// the type, not the card.
const baseArgs = (over = {}) => /** @type {any} */ ({
  hostEl: document.createElement('div'),
  systems: new Set(['4:212']),
  occupants: { '4:212': [{ playerId: '77', position: 8 }] },
  arrivals: [],
  names: { 77: { name: 'Yoxid' } },
  alliances: {},
  danger: new Map([[77, { danger: 0.82, friendly: false }]]),
  nowMs: 1_700_000_000_000,
  ...over,
});

describe('renderHomeWatchCard — Coords/Names', () => {
  it('shows the bare coordinate when no names were handed in', () => {
    const a = baseArgs();
    renderHomeWatchCard(a);
    expect(a.hostEl.textContent).toContain('4:212');
  });

  it('shows OUR body name instead, keeping the coord in the hover', () => {
    const a = baseArgs({ systemNames: { '4:212': 'Kolonia' } });
    renderHomeWatchCard(a);
    expect(a.hostEl.textContent).toContain('Kolonia');
    // The coord is not lost — it is the hover, so the row still says where it is.
    // The innermost one: the wrapper that holds the coord list has the same text
    // when there is a single system, and it is the leaf that carries the hover.
    const el = [...a.hostEl.querySelectorAll('span, a')]
      .find((e) => e.textContent === 'Kolonia' && e.children.length === 0);
    expect(el?.getAttribute('title')).toContain('4:212');
  });

  it('links a named system to the galaxy view when an origin is known', () => {
    const a = baseArgs({
      systemNames: { '4:212': 'Kolonia' },
      linkBase: 'https://s163-pl.ogame.gameforge.com',
    });
    renderHomeWatchCard(a);
    const link = /** @type {HTMLAnchorElement | null} */ (
      a.hostEl.querySelector('a[href*="galaxy=4"][href*="system=212"]'));
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe('Kolonia');
  });
});

describe('renderHomeWatchCard — neighbour rows', () => {
  it('paints the row rule with the neighbour Danger and names the player', () => {
    const a = baseArgs();
    renderHomeWatchCard(a);
    expect(a.hostEl.textContent).toContain('Yoxid');
    // Colour = Danger is the card's whole scanning language: a high-D neighbour
    // must not carry the same rule as a harmless one.
    const rules = [...a.hostEl.querySelectorAll('div')]
      .map((d) => /** @type {HTMLElement} */ (d).style.borderLeftColor)
      .filter(Boolean);
    expect(rules.length).toBeGreaterThan(0);
  });
});
