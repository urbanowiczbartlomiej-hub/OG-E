// @vitest-environment happy-dom

// Behavioural test for the dossier's presence-history explorer (dossier.js
// presenceHistoryBlock, driven through the public buildDossier): the "Weeks"
// cycle (one row per ISO-week — the axis that keeps a rotating shift roster
// legible) is the default, the shift-rhythm verdict lines render above it,
// and the Cycle/Days chips switch views without throwing.
//
// The ledger fixture is a "casual evening player" — active hours 18–23 every
// day for 40 days — chosen because it is DEGENERATE-SAFE: activity spread
// uniformly across all 24 hours has a zero circular mean (the vector sums to
// the origin) and would make the rotation detector see no phase at all. A
// contiguous 6-hour block gives it a well-defined, stable phase, which is
// what a steady (non-shift-working) player actually looks like — the
// baseline the "no rotation" verdict must get right.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { buildDossier } from '../../../src/features/dashboard/dossier.js';

const DAY_S = 86400;
const nowMs = 1_700_000_000_000;
const dayNow = Math.floor(nowMs / 1000 / DAY_S);

/** Active bit-mask for local hours 18–23 (a stable, asymmetric evening block). */
const EVENING_MASK = ((1 << 24) - 1) & ~((1 << 18) - 1); // bits 18..23
/** The other 18 hours are QUIET (not merely unobserved) — a well-watched
 *  player, and the only way the Saturday daytime window (08–19) is guaranteed
 *  to have a verdict regardless of the runner's UTC offset shifting the
 *  evening block in or out of it. */
const QUIET_MASK = 0xffffff & ~EVENING_MASK;

/** @returns {any} minimal dossier args with a 40-day steady-evening presence history. */
const baseArgs = (over = {}) => ({
  playerId: '20',
  name: 'GumkaVIP',
  planets: [{ galaxy: 4, system: 474, position: 8, hasMoon: false }],
  reports: {},
  moons: {},
  rescan: {},
  nowMs,
  scanBodies: 'planets',
  colspan: 8,
  open: true,
  presenceHistory: {
    ledger: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [String(dayNow - i), [EVENING_MASK, QUIET_MASK]]),
    ),
    allianceMembers: [],
  },
  ...over,
});

/** @param {HTMLElement} root @param {string} label */
const chipButton = (root, label) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label);

describe('presence-history explorer — "Weeks" cycle + shift verdict', () => {
  it('defaults to the Weeks cycle and renders a steady-rhythm verdict', () => {
    const tr = buildDossier(baseArgs());
    expect(tr.textContent).toContain('PRESENCE — offline pattern');
    // Steady evening player, no rotation: the verdict must say so, not guess
    // a shift roster from a single degenerate cluster.
    expect(tr.textContent).toMatch(/Rhythm: steady/);
    expect(tr.textContent).not.toMatch(/Shift rotation/);
    // The Weeks grid renders week-row date labels (d.mm), not weekday names.
    expect(tr.textContent).not.toContain('Sun');
    expect(chipButton(tr, 'Weeks')).toBeTruthy();
    expect(chipButton(tr, 'Week × hour')).toBeTruthy();
    expect(chipButton(tr, 'Mon–Fri')).toBeTruthy();
  });

  it('switching to "Week × hour" renders the classic 7-row weekday grid', () => {
    const tr = buildDossier(baseArgs());
    chipButton(tr, 'Week × hour')?.click();
    expect(tr.textContent).toContain('Sun');
    expect(tr.textContent).toContain('Mon');
  });

  it('the "Mon–Fri" Days chip re-renders without throwing and is reflected in the basis line', () => {
    const tr = buildDossier(baseArgs());
    expect(() => chipButton(tr, 'Mon–Fri')?.click()).not.toThrow();
    expect(tr.textContent).toContain('(Mon–Fri)');
  });

  it('renders a Saturday-pattern line once enough weekends are classified', () => {
    // Whether the fixed evening block reads as daytime-active depends on the
    // runner's UTC offset (a fixed UTC hour range can land in a different
    // local clock slice per machine) — the state itself is covered,
    // timezone-safe, in domain/shiftPattern.test.js. Here we only check the
    // wiring: with ~5-6 Saturdays classified, SOME verdict line renders.
    const tr = buildDossier(baseArgs());
    expect(tr.textContent).toMatch(/Saturdays: (usually (active|quiet)|every other week|irregular)/);
  });

  it('shows the empty-coverage note instead of the explorer when there is no history', () => {
    const tr = buildDossier(baseArgs({ presenceHistory: { ledger: {}, allianceMembers: [] } }));
    expect(tr.textContent).toContain('No long-horizon coverage yet');
    expect(chipButton(tr, 'Weeks')).toBeFalsy();
  });
});
