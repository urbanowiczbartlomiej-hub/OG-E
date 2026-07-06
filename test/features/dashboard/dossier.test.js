// @vitest-environment happy-dom

// Behavioural test for the dossier's per-body table (dossier.js buildDossier):
// the `body` coords link to the in-game galaxy view when the game origin is
// known, and stay plain text when it isn't.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { buildDossier } from '../../../src/features/dashboard/dossier.js';

/** @returns {any} minimal dossier args, overridable per test. */
const baseArgs = (over = {}) => ({
  playerId: '20',
  name: 'GumkaVIP',
  planets: [{ galaxy: 4, system: 474, position: 8, hasMoon: false }],
  reports: {},
  moons: {},
  rescan: {},
  nowMs: 1_700_000_000_000,
  scanBodies: 'planets',
  colspan: 8,
  open: true,
  ...over,
});

describe('buildDossier — per-body coord links', () => {
  it('renders the coord as an in-game galaxy link when linkBase is given', () => {
    const tr = buildDossier(baseArgs({ linkBase: 'https://s163-pl.ogame.gameforge.com' }));
    const link = /** @type {HTMLAnchorElement|null} */ (tr.querySelector('a[href*="component=galaxy"]'));
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe('4:474:8');
    const href = link?.getAttribute('href') || '';
    expect(href).toContain('https://s163-pl.ogame.gameforge.com/game/index.php');
    expect(href).toContain('galaxy=4');
    expect(href).toContain('system=474');
    expect(href).toContain('position=8');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('renders the coord as plain text (no link) when linkBase is absent', () => {
    const tr = buildDossier(baseArgs());
    expect(tr.querySelector('a[href*="component=galaxy"]')).toBeNull();
    expect(tr.textContent).toContain('4:474:8');
  });
});
