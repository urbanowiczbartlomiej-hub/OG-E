// Unit tests for features/dashboard/format.js — pure formatting helpers
// shared across the dashboard's renderer files. No DOM, no happy-dom needed.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { compact, playerHoverTitle } from '../../../src/features/dashboard/format.js';

describe('compact', () => {
  it('formats billions/millions/thousands with the expected precision', () => {
    expect(compact(4_570_000_000)).toBe('4.57B');
    expect(compact(47_900_000)).toBe('47.9M');
    expect(compact(880_000)).toBe('880K');
    expect(compact(42)).toBe('42');
  });

  it('returns "—" for absent/non-finite input', () => {
    expect(compact(undefined)).toBe('—');
    expect(compact(NaN)).toBe('—');
    expect(compact(Infinity)).toBe('—');
  });
});

// The shared hover title for a clickable player name — one wording for every
// glance surface ("Your neighbours", "Who's spying on you") that shows a
// Danger-coloured nick and opens the same profile on click.
describe('playerHoverTitle', () => {
  it('states Danger unknown when no profile is held (not a zero Danger)', () => {
    expect(playerHoverTitle(undefined)).toMatch(/^Danger unknown/);
    expect(playerHoverTitle(null)).toMatch(/^Danger unknown/);
    expect(playerHoverTitle({})).toMatch(/^Danger unknown/);
  });

  it('reports the Danger number on the 0–100 scale the rest of the UI prints', () => {
    expect(playerHoverTitle({ danger: 0.913 })).toMatch(/^Danger 91\b/);
    expect(playerHoverTitle({ danger: 0 })).toMatch(/^Danger 0\b/);
    expect(playerHoverTitle({ danger: 1 })).toMatch(/^Danger 100\b/);
  });

  it('includes every reason on its own line when present', () => {
    const title = playerHoverTitle({ danger: 0.5, reasons: ['fleet-heavy', 'active bandit'] });
    expect(title).toContain('fleet-heavy');
    expect(title).toContain('active bandit');
  });

  it('always ends with the click affordance', () => {
    expect(playerHoverTitle({ danger: 0.1 })).toMatch(/Click for the full profile\.$/);
    expect(playerHoverTitle(undefined)).toMatch(/Click for the full profile\.$/);
  });
});
