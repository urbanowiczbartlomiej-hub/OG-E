// Unit tests for the pure compute core of the espionage-scan FAB
// (`src/features/sendSpy/pure.js`). No DOM, no clock — `deriveSpy`/`renderSpy`
// are plain functions over plain data, so this is a node-environment test (no
// happy-dom pragma). Every test passes an explicit `nowMs`; nothing reads
// `Date.now()`.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  deriveSpy,
  renderSpy,
  SPY_STALE_MS,
  BG_SPY_IDLE,
  BG_SPY_DONE,
  BG_SPY_ERROR,
} from '../../../src/features/sendSpy/pure.js';

const NOW = 1_700_000_000_000;

/** Epoch SECONDS for a report taken `ageMs` before NOW. @param {number} ageMs */
const tsSecAgo = (ageMs) => Math.floor((NOW - ageMs) / 1000);

/**
 * Build a SpyEnv with sane defaults; override per-test. The galaxy-LOOK plan
 * is muted by default (`galaxyMode: 'off'` for every fixture player) so the
 * probe-plan tests stay deterministic — the look plan proposes every
 * never-sighted watched body, which without rings is ALL of them. The
 * dedicated look-branch tests below re-enable it explicitly.
 * @param {Partial<import('../../../src/features/sendSpy/pure.js').SpyEnv>} [over]
 * @returns {import('../../../src/features/sendSpy/pure.js').SpyEnv}
 */
function env(over = {}) {
  return {
    players: [],
    universePlanets: [],
    spiedByPlayer: {},
    nowMs: NOW,
    galaxyMode: { 42: 'off', 10: 'off', 80: 'off' },
    ...over,
  };
}

describe('deriveSpy', () => {
  it('no watched players → null candidate, 0 remaining, hasWatched false', () => {
    const ctx = deriveSpy(env());
    expect(ctx).toEqual({
      proposal: null, candidate: null, look: null, remaining: 0, hasWatched: false,
    });
  });

  it('watched player with un-spied planets → candidate + remaining counts ALL needing-scan', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [
          { coords: '1:2:3', player: 42 },
          { coords: '1:2:8', player: 42 },
          { coords: '9:9:9', player: 7 }, // not watched
        ],
        spiedByPlayer: {},
      }),
    );
    expect(ctx.hasWatched).toBe(true);
    // candidate is the first planet (galaxy→system→position order).
    expect(ctx.candidate).toEqual({ galaxy: 1, system: 2, position: 3, playerId: '42', bodyType: 1 });
    // BOTH watched planets need a scan; the unwatched player's is ignored.
    expect(ctx.remaining).toBe(2);
  });

  it('fully-fresh-spied player → null candidate, 0 remaining', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [
          { coords: '1:2:3', player: 42 },
          { coords: '1:2:8', player: 42 },
        ],
        spiedByPlayer: {
          42: {
            '1:2:3': tsSecAgo(60_000),
            '1:2:8': tsSecAgo(60_000),
          },
        },
      }),
    );
    expect(ctx.hasWatched).toBe(true);
    expect(ctx.candidate).toBeNull();
    expect(ctx.remaining).toBe(0);
  });

  it('sentCoords skips a coord (advances past an in-flight probe)', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [
          { coords: '1:2:3', player: 42 },
          { coords: '1:2:8', player: 42 },
        ],
        spiedByPlayer: {},
        sentCoords: new Set(['1:2:3']),
      }),
    );
    // First planet was just sent → candidate advances to the second.
    expect(ctx.candidate).toEqual({ galaxy: 1, system: 2, position: 8, playerId: '42', bodyType: 1 });
    expect(ctx.remaining).toBe(1);
  });

  it('a stale report (older than 7d) counts as needing a scan', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [{ coords: '1:2:3', player: 42 }],
        spiedByPlayer: {
          42: { '1:2:3': tsSecAgo(SPY_STALE_MS + 60_000) },
        },
      }),
    );
    expect(ctx.candidate).toEqual({ galaxy: 1, system: 2, position: 3, playerId: '42', bodyType: 1 });
    expect(ctx.remaining).toBe(1);
  });

  it('a rescan flag newer than the report forces needing-scan on an otherwise-fresh planet', () => {
    const reportAge = 60_000; // fresh by age
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [{ coords: '1:2:3', player: 42 }],
        spiedByPlayer: {
          42: { '1:2:3': tsSecAgo(reportAge) },
        },
        // Re-scan requested AFTER the report was taken → treat as stale.
        rescan: { 42: NOW - 1000 },
      }),
    );
    expect(ctx.candidate).toEqual({ galaxy: 1, system: 2, position: 3, playerId: '42', bodyType: 1 });
    expect(ctx.remaining).toBe(1);
  });

  it('a rescan flag OLDER than the report does not force a re-scan', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [{ coords: '1:2:3', player: 42 }],
        spiedByPlayer: {
          42: { '1:2:3': tsSecAgo(60_000) },
        },
        // Re-scan requested BEFORE the report → already satisfied by the report.
        rescan: { 42: NOW - 2 * 60_000 },
      }),
    );
    expect(ctx.candidate).toBeNull();
    expect(ctx.remaining).toBe(0);
  });
});

describe('deriveSpy — galaxy-look branch', () => {
  it('galaxy watch on + never sighted → look proposal covering the whole system', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [
          { coords: '1:2:3', player: 42 },
          { coords: '1:2:8', player: 42 },
        ],
        // Probe plan satisfied (fresh reports) — only the look plan remains.
        spiedByPlayer: {
          42: { '1:2:3': tsSecAgo(60_000), '1:2:8': tsSecAgo(60_000) },
        },
        galaxyMode: {}, // un-mute the look plan (env() mutes it by default)
      }),
    );
    expect(ctx.proposal).toBe('look');
    expect(ctx.candidate).toBeNull();
    // ONE system visit covers BOTH watched bodies.
    expect(ctx.look).toMatchObject({ galaxy: 1, system: 2, bodies: 2 });
    expect(ctx.remaining).toBe(1);
  });

  it('a fresh sighting (rings) satisfies the look plan → nothing proposed', () => {
    const ctx = deriveSpy(
      env({
        players: ['42'],
        universePlanets: [
          { coords: '1:2:3', player: 42 },
          { coords: '1:2:8', player: 42 },
        ],
        spiedByPlayer: {
          42: { '1:2:3': tsSecAgo(60_000), '1:2:8': tsSecAgo(60_000) },
        },
        galaxyMode: {},
        // Both bodies sighted an hour ago (quiet look, m = -1) — well inside
        // the default 24h galaxy staleness.
        rings: {
          42: {
            '1:2:3:1': [{ t: tsSecAgo(3_600_000), m: -1 }],
            '1:2:8:1': [{ t: tsSecAgo(3_600_000), m: -1 }],
          },
        },
      }),
    );
    expect(ctx.proposal).toBeNull();
    expect(ctx.look).toBeNull();
    expect(ctx.remaining).toBe(0);
  });

  it('a strike coord forces the moon to the top with the strike flag', () => {
    const ctx = deriveSpy(
      env({
        players: ['42', '80'],
        universePlanets: [
          { coords: '1:2:3', player: 42, hasMoon: true },
          { coords: '2:2:2', player: 80 },
        ],
        spiedByPlayer: {
          // The strike moon has a FRESH report — a strike bypasses the
          // freshness gate (any report predates the landing).
          42: { '1:2:3': tsSecAgo(60_000) },
        },
        dangerByPlayer: { 42: 1, 80: 80 }, // danger alone would rank 80 first
        strikes: new Map([['1:2:3:3', {
          coord: '1:2:3', bodyType: /** @type {3} */ (3), overrideKey: '1:2:3:3',
          freshAgeMs: 0, quiet: 1, total: 1,
          confidence: /** @type {'strong'} */ ('strong'),
          tier: /** @type {'lone'} */ ('lone'), concurrent: false, coMoons: 0,
        }]]),
      }),
    );
    expect(ctx.proposal).toBe('probe');
    expect(ctx.strike).toBe(true);
    expect(ctx.candidate).toMatchObject({ galaxy: 1, system: 2, position: 3, playerId: '42', bodyType: 3 });
    expect(ctx.why).toContain('landing');
  });
});

describe('deriveSpy — look-first doctrine + reports', () => {
  // Two watched bodies: one needs a PROBE (never scanned), one needs a LOOK
  // (never sighted) — the doctrine says the look leads.
  const bothPlansEnv = (over = {}) => env({
    players: ['42'],
    universePlanets: [{ coords: '1:2:3', player: 42 }],
    spiedByPlayer: {}, // never scanned → probe candidate exists
    galaxyMode: {},    // look plan live → never sighted → look candidate exists
    ...over,
  });

  it('a pending look outranks an ordinary probe', () => {
    const ctx = deriveSpy(bothPlansEnv());
    expect(ctx.proposal).toBe('look');
  });

  it('a strike probe cuts the line past pending looks', () => {
    const ctx = deriveSpy(bothPlansEnv({
      universePlanets: [{ coords: '1:2:3', player: 42, hasMoon: true }],
      strikes: new Map([['1:2:3:3', {
        coord: '1:2:3', bodyType: /** @type {3} */ (3), overrideKey: '1:2:3:3',
        freshAgeMs: 0, quiet: 1, total: 1,
        confidence: /** @type {'strong'} */ ('strong'),
        tier: /** @type {'newest'} */ ('newest'), concurrent: false, coMoons: 0,
      }]]),
    }));
    expect(ctx.proposal).toBe('probe');
    expect(ctx.strike).toBe(true);
    expect(ctx.strikeTier).toBe('newest');
  });

  // Both plans satisfied; one probe sent this session, its report not
  // ingested yet → the closing "Reports" nudge.
  const doneEnv = (/** @type {Record<string, number>} */ sentAt) => env({
    players: ['42'],
    universePlanets: [{ coords: '1:2:3', player: 42 }],
    spiedByPlayer: { 42: { '1:2:3': tsSecAgo(3_600_000) } },
    sentCoords: new Set(Object.keys(sentAt)),
    sentAt,
    galaxyMode: {},
    rings: { 42: { '1:2:3:1': [{ t: tsSecAgo(60_000), m: -1 }] } },
  });

  it('patrol looks join the plan; a system proposed by BOTH keeps the higher-priority entry', () => {
    const ctx = deriveSpy(env({
      players: ['42'],
      universePlanets: [{ coords: '1:2:3', player: 42 }],
      spiedByPlayer: { 42: { '1:2:3': tsSecAgo(60_000) } }, // probe plan satisfied
      galaxyMode: {}, // watch look for never-sighted 1:2 exists (priority ~0.65)
      patrolLooks: [
        { galaxy: 1, system: 2, label: '1:2', bodies: [], worst: 'none', priority: 0.1, why: 'patrol · 1 slot' },
        { galaxy: 7, system: 7, label: '7:7', bodies: [], worst: 'none', priority: 0.4, why: 'patrol · 2 slots' },
      ],
    }));
    expect(ctx.proposal).toBe('look');
    // The watch-driven 1:2 wins its own label; the patrol-only 7:7 remains.
    expect(ctx.look).toMatchObject({ galaxy: 1, system: 2 });
    expect(ctx.remaining).toBe(2);
  });

  it('reports close the loop: both plans empty + un-ingested session send', () => {
    const ctx = deriveSpy(doneEnv({ '1:2:3': NOW - 5 * 60_000 }));
    expect(ctx.proposal).toBe('reports');
    expect(ctx.pendingReports).toBe(1);
  });

  it('an ingested report NEWER than the send clears the nudge', () => {
    const ctx = deriveSpy({
      ...doneEnv({ '1:2:3': NOW - 5 * 60_000 }),
      spiedByPlayer: { 42: { '1:2:3': tsSecAgo(60_000) } }, // 1 min ago > send
    });
    expect(ctx.proposal).toBeNull();
  });

  it('a send with no report for 30+ min stops counting (a destroyed probe must not wedge the button)', () => {
    const ctx = deriveSpy(doneEnv({ '1:2:3': NOW - 31 * 60_000 }));
    expect(ctx.proposal).toBeNull();
  });

  it('renderSpy paints the reports face (calm, count, tap hint)', () => {
    const paint = renderSpy({
      proposal: 'reports', candidate: null, look: null, remaining: 0,
      hasWatched: true, pendingReports: 3,
    });
    expect(paint).toMatchObject({ text: 'Reports', subtext: '3 new', bg: BG_SPY_DONE });
  });
});

describe('renderSpy', () => {
  it('hasWatched false → muted "no targets" idle paint', () => {
    const paint = renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: false });
    expect(paint).toEqual({ text: 'Spy', subtext: 'no targets', bg: BG_SPY_IDLE, dim: true });
  });

  it('hasWatched true, candidate null → "Reports" done paint (BG_SPY_DONE)', () => {
    const paint = renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: true });
    expect(paint.text).toBe('Reports');
    expect(paint.bg).toBe(BG_SPY_DONE);
    expect(paint.dim).toBeUndefined();
  });

  it('candidate set → "Spy" paint with the coord in the subtext', () => {
    const paint = renderSpy({
      proposal: 'probe',
      candidate: { galaxy: 1, system: 2, position: 3, playerId: '42' },
      look: null,
      remaining: 4,
      hasWatched: true,
    });
    expect(paint.text).toBe('Spy');
    expect(paint.bg).toBe(BG_SPY_IDLE);
    expect(paint.subtext).toContain('1:2:3');
    // The remaining count moved from the subtext to the third "N left" line.
    expect(paint.hint).toContain('4');
  });
});

describe('renderSpy — probe pre-flight (Etap G)', () => {
  /** @type {import('../../../src/features/sendSpy/pure.js').SpyContext} */
  const ctx = {
    proposal: 'probe',
    candidate: { galaxy: 1, system: 2, position: 3, playerId: '42' },
    look: null,
    remaining: 4,
    hasWatched: true,
  };

  it('enough probes on hand → normal "Spy" paint, no shortage hint', () => {
    const paint = renderSpy(ctx, { have: 20, need: 20 });
    expect(paint.text).toBe('Spy');
    expect(paint.bg).toBe(BG_SPY_IDLE);
    // With enough probes the hint is the remaining-count ("N left"), NOT a
    // probe-shortage warning (have/need).
    expect(paint.hint).toBe('4 left');
    expect(paint.hint).not.toMatch(/probes/);
  });

  it('too few probes (but some) → hint shows have/need, still armable', () => {
    const paint = renderSpy(ctx, { have: 5, need: 20 });
    expect(paint.text).toBe('Spy');
    expect(paint.hint).toBe('5/20 probes');
    expect(paint.subtext).toContain('1:2:3');
  });

  it('zero probes on hand → error "No probes!" paint before the tap', () => {
    const paint = renderSpy(ctx, { have: 0, need: 20 });
    expect(paint.text).toBe('No probes!');
    expect(paint.bg).toBe(BG_SPY_ERROR);
    expect(paint.subtext).toContain('1:2:3');
  });

  it('preflight is ignored on the done / no-targets states', () => {
    expect(renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: true }, { have: 0, need: 20 }).text)
      .toBe('Reports');
    expect(renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: false }, { have: 0, need: 20 }).text)
      .toBe('Spy');
  });
});

// The FAB's needs-attention glow: `pulse` rides EXACTLY the probe-proposal
// paints ("there is something to scan"), so the orchestrator can relay it
// blindly (paintZone → setFabModuleAlert) and every other state clears it.
describe('renderSpy — pulse contract', () => {
  /** @type {import('../../../src/features/sendSpy/pure.js').SpyContext} */
  const probeCtx = {
    proposal: 'probe',
    candidate: { galaxy: 1, system: 2, position: 3, playerId: '42' },
    look: null,
    remaining: 4,
    hasWatched: true,
  };

  it('probe proposal pulses (plain, strike, and probe-shortage variants)', () => {
    expect(renderSpy(probeCtx).pulse).toBe(true);
    expect(renderSpy({ ...probeCtx, strike: true }).pulse).toBe(true);
    expect(renderSpy(probeCtx, { have: 5, need: 20 }).pulse).toBe(true);
  });

  it('non-proposal states never pulse (no targets, done, look, no-probes error)', () => {
    expect(renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: false }).pulse)
      .toBeUndefined();
    expect(renderSpy({ proposal: null, candidate: null, look: null, remaining: 0, hasWatched: true }).pulse)
      .toBeUndefined();
    expect(renderSpy({
      proposal: 'look',
      candidate: null,
      look: { galaxy: 2, system: 40, bodies: 3 },
      remaining: 3,
      hasWatched: true,
    }).pulse).toBeUndefined();
    expect(renderSpy(probeCtx, { have: 0, need: 20 }).pulse).toBeUndefined();
  });
});

describe('deriveSpy — priority ranking (Etap G)', () => {
  it('proposes the highest-danger watched player\'s planet first', () => {
    const ctx = deriveSpy(
      env({
        players: ['10', '80'],
        universePlanets: [
          { coords: '1:1:1', player: 10 },
          { coords: '2:2:2', player: 80 },
        ],
        spiedByPlayer: {},
        dangerByPlayer: { 10: 10, 80: 80 },
      }),
    );
    expect(ctx.candidate).toEqual({ galaxy: 2, system: 2, position: 2, playerId: '80', bodyType: 1 });
    expect(ctx.remaining).toBe(2);
    expect(typeof ctx.why).toBe('string');
  });
});
