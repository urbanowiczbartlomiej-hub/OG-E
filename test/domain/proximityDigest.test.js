// @ts-check

// Unit tests for domain/proximityDigest — the pure per-prober aggregation behind
// the Spyglass "🛡 Who's been near you" strip (Etap H3). Pure over a plain
// newest-first log; the only interesting logic is the grouping, the same-system
// (RIP-range) detection from from/at coords, and the hot-first ordering.

import { describe, it, expect } from 'vitest';
import { digestProximityReports } from '../../src/domain/proximityDigest.js';

/** @param {Partial<import('../../src/domain/espionageReport.js').ProximityReport>} o */
const rep = (o) => /** @type {any} */ ({ byPlayerId: 1, atCoords: '1:1:1', ...o });

describe('digestProximityReports', () => {
  it('returns an empty digest for a non-array / empty input', () => {
    for (const bad of [[], null, undefined, 'x', 42]) {
      const d = digestProximityReports(/** @type {any} */ (bad));
      expect(d.players).toEqual([]);
      expect(d.totalReports).toBe(0);
      expect(d.playerCount).toBe(0);
      expect(d.sameSystemCount).toBe(0);
      expect(d.lastTs).toBeNull();
    }
  });

  it('collapses multiple alerts from one prober into a single counted row', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: 7, byPlayerName: 'Mqres', atCoords: '1:1:1', ts: 300 }),
      rep({ byPlayerId: 7, byPlayerName: 'Mqres', atCoords: '1:2:3', ts: 200 }),
      rep({ byPlayerId: 7, atCoords: '1:1:1', ts: 100 }), // dup body, older, no name
    ]);
    expect(d.totalReports).toBe(3);
    expect(d.playerCount).toBe(1);
    const e = d.players[0];
    expect(e.byPlayerId).toBe(7);
    expect(e.count).toBe(3);
    expect(e.name).toBe('Mqres');
    expect(e.lastTs).toBe(300);
    // Distinct bodies, newest first; the duplicate 1:1:1 is not repeated.
    expect(e.atCoords).toEqual(['1:1:1', '1:2:3']);
  });

  it('flags a prober whose origin is in the same system as the approached body', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: 9, atCoords: '1:117:6', fromCoords: '1:117:9', ts: 500 }),
    ]);
    expect(d.players[0].sameSystem).toBe(true);
    expect(d.players[0].sameSystemFrom).toBe('1:117:9');
    expect(d.sameSystemCount).toBe(1);
  });

  it('does not flag same-system when only the position differs across systems', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: 9, atCoords: '1:117:6', fromCoords: '1:118:6', ts: 1 }),
    ]);
    expect(d.players[0].sameSystem).toBe(false);
    expect(d.players[0].sameSystemFrom).toBeNull();
    expect(d.sameSystemCount).toBe(0);
  });

  it('sorts same-system probers first, then by newest alert, then by count', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: 1, atCoords: '2:2:2', fromCoords: '4:4:4', ts: 900 }), // newest, far
      rep({ byPlayerId: 2, atCoords: '3:5:6', fromCoords: '3:5:1', ts: 100 }), // same-system, old
    ]);
    // Same-system wins regardless of being older.
    expect(d.players[0].byPlayerId).toBe(2);
    expect(d.players[1].byPlayerId).toBe(1);
  });

  it('re-ranks fields by timestamp even when the log is unordered', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: 5, byPlayerName: 'old', atCoords: '1:1:1', fromCoords: '9:9:9', ts: 100 }),
      rep({ byPlayerId: 5, byPlayerName: 'new', atCoords: '1:2:2', fromCoords: '8:8:8', ts: 800 }),
    ]);
    const e = d.players[0];
    expect(e.name).toBe('new');
    expect(e.fromCoords).toBe('8:8:8');
    expect(e.atCoords[0]).toBe('1:2:2'); // newest body first
    expect(d.lastTs).toBe(800);
  });

  it('ignores entries without a numeric byPlayerId', () => {
    const d = digestProximityReports([
      rep({ byPlayerId: /** @type {any} */ (undefined), atCoords: '1:1:1' }),
      rep({ byPlayerId: 3, atCoords: '1:1:1', ts: 5 }),
    ]);
    expect(d.playerCount).toBe(1);
    expect(d.totalReports).toBe(1);
  });
});
