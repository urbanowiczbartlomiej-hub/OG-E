// Unit tests for domain/presence.js — the offline-window engine behind the
// dossier heatmap. The suite pins the engine's three honesty properties:
//
//   1. a consistent nightly quiet band reads cold+confident and becomes the
//      picked attack window;
//   2. ONE positive blip inside that band does not flip it warm (Beta shrink +
//      exception down-weighting), matching the shipped smoke check;
//   3. unobserved hours are LOW-CONFIDENCE, never "offline" — the window can
//      only cover hours we actually looked at.
//
// Time note: the grid buckets by LOCAL `getDay()`/`getHours()`, so fixtures
// are built with the LOCAL Date constructor and expectations are derived from
// the same calls — the suite is timezone-independent (June 2026 dates avoid
// every DST boundary in both hemispheres).
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  buildPresenceProbes,
  buildPresenceGrid,
  pickOfflineWindow,
  summarizePresence,
  COLLAPSE_MS,
} from '../../src/domain/presence.js';

/** Epoch SECONDS of a local June-2026 moment.
 * @param {number} day @param {number} hour @param {number} [minute] */
const atSec = (day, hour, minute = 30) =>
  Math.floor(new Date(2026, 5, day, hour, minute).getTime() / 1000);

/** "Now": July 1, 2026 local noon — every fixture is well inside recency. */
const NOW = new Date(2026, 6, 1, 12).getTime();

/** The local hour a probe at (day, hour) lands in (same call the grid makes).
 * @param {number} day @param {number} hour */
const hourOf = (day, hour) => new Date(atSec(day, hour) * 1000).getHours();

/**
 * A 28-day routine: quiet looks (m = -1) through the night hours, positive
 * activity (m = 0) in the evening. Spread across two bodies like real galaxy
 * browsing.
 * @param {{ blipDay?: number }} [opts]  Add ONE positive night blip on this day.
 * @returns {import('../../src/domain/routine.js').RoutineBody[]}
 */
const routineBodies = ({ blipDay } = {}) => {
  /** @type {import('../../src/domain/activityObs.js').ActivityObs[]} */
  const a = [];
  /** @type {import('../../src/domain/activityObs.js').ActivityObs[]} */
  const b = [];
  for (let day = 1; day <= 28; day++) {
    // Night: three quiet looks spaced 2 h apart — WIDER than the 90-min
    // correlation window, so each survives the per-moment collapse as its own
    // probe (looks 60 min apart would chain-collapse into one).
    a.push({ t: atSec(day, 1), m: -1 }, { t: atSec(day, 5), m: -1 });
    b.push({ t: atSec(day, 3), m: -1 });
    // Evening: seen active.
    a.push({ t: atSec(day, 19), m: 0 });
    b.push({ t: atSec(day, 21), m: 0 });
    if (blipDay === day) b.push({ t: atSec(day, 3, 45), m: 0 });
  }
  return [
    { coord: '1:2:3', history: [], activity: a },
    { coord: '1:2:8', history: [], activity: b },
  ];
};

/** The night hours the fixtures cover (via the grid's own local bucketing). */
const NIGHT_HOURS = () => [hourOf(1, 1), hourOf(1, 3), hourOf(1, 5)];
/** The evening hours the fixtures mark active. */
const EVENING_HOURS = () => [hourOf(1, 19), hourOf(1, 21)];

describe('buildPresenceProbes', () => {
  it('collapses looks inside one correlation window into a single probe', () => {
    const t0 = atSec(10, 12, 0);
    const { probes } = buildPresenceProbes([
      {
        coord: '1:2:3',
        history: [],
        activity: [
          { t: t0, m: -1 },
          { t: t0 + Math.floor(COLLAPSE_MS / 1000) - 60, m: -1 }, // same moment
          { t: t0 + Math.floor(COLLAPSE_MS / 1000) + 3600, m: -1 }, // a new moment
        ],
      },
    ], NOW);
    expect(probes).toHaveLength(2);
  });

  it('counts positives and negatives separately', () => {
    const { positives, negatives } = buildPresenceProbes(routineBodies(), NOW);
    expect(positives).toBeGreaterThan(0);
    expect(negatives).toBeGreaterThan(positives); // nights outnumber evenings
  });
});

describe('grid + pickOfflineWindow', () => {
  it('a consistent nightly quiet band becomes the picked window — never the active evening', () => {
    const { probes } = buildPresenceProbes(routineBodies(), NOW);
    const grid = buildPresenceGrid(probes, NOW, { scale: 'day' });
    const win = pickOfflineWindow(grid);
    expect(win).not.toBeNull();
    const w = /** @type {NonNullable<typeof win>} */ (win);
    const winHours = [];
    for (let h = w.startH; h <= w.endH; h++) winHours.push(h);
    // Anchored on the observed night band (the hour-kernel may widen it by a
    // neighbouring hour — that's coverage smoothing, not a claim violation)…
    expect(winHours.some((h) => NIGHT_HOURS().includes(h))).toBe(true);
    // …but NEVER touching the hours the player is demonstrably active.
    for (const h of EVENING_HOURS()) expect(winHours).not.toContain(h);
    expect(w.looks).toBeGreaterThan(0);
  });

  it('the evening cells read warm, the night cells cold (P separation)', () => {
    const { probes } = buildPresenceProbes(routineBodies(), NOW);
    const grid = buildPresenceGrid(probes, NOW, { scale: 'day' });
    const night = grid.cells[0][hourOf(1, 3)];
    const evening = grid.cells[0][hourOf(1, 19)];
    expect(night.p).toBeLessThan(0.2);
    expect(evening.p).toBeGreaterThan(0.5);
    expect(night.conf).toBeGreaterThan(0.5); // many looks → confident
  });

  it('one night blip stays cold and does not destroy the window (Beta shrink)', () => {
    const { probes } = buildPresenceProbes(routineBodies({ blipDay: 14 }), NOW);
    const grid = buildPresenceGrid(probes, NOW, { scale: 'day' });
    const blipCell = grid.cells[0][hourOf(14, 3)]; // 3:45 buckets with the 3:xx looks
    expect(blipCell.hits).toBeGreaterThan(0); // the blip IS recorded honestly…
    expect(blipCell.p).toBeLessThan(0.35); // …but 1-in-28 does not flip the hour warm
    expect(pickOfflineWindow(grid)).not.toBeNull();
  });

  it('an unobserved hour has zero confidence', () => {
    const { probes } = buildPresenceProbes(routineBodies(), NOW);
    const grid = buildPresenceGrid(probes, NOW, { scale: 'day' });
    const unobserved = grid.cells[0][hourOf(1, 10)];
    expect(unobserved.looks).toBe(0);
    expect(unobserved.conf).toBe(0);
  });
});

describe('summarizePresence', () => {
  it('summarises a routine into a grid + a picked window; sparse data degrades to occasional', () => {
    const full = summarizePresence(routineBodies(), NOW);
    expect(full.grid).not.toBeNull();
    expect(['week', 'day']).toContain(full.scale);

    const sparse = summarizePresence([
      { coord: '1:2:3', history: [], activity: [{ t: atSec(1, 12), m: -1 }] },
    ], NOW);
    expect(sparse.scale).toBe('occasional');
  });
});
