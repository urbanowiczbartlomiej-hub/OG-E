// @ts-check

// Unit tests for domain/proximityDigest — the pure per-prober aggregation behind
// the Spyglass "Who's spying on you" strip (Etap H3). Pure over a plain
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
    // Distinct bodies ordered by newest scan first; the duplicate 1:1:1 is not
    // repeated but keeps BOTH its scan timestamps (newest first) — that per-body
    // scan history is what the panels surface on hover.
    expect(e.atBodies).toEqual([
      { coords: '1:1:1', moon: false, scans: [300, 100] },
      { coords: '1:2:3', moon: false, scans: [200] },
    ]);
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
    expect(e.atBodies[0].coords).toBe('1:2:2'); // newest body first
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

// ──────────────────────────────────────────────────────────────────
// Muting a prober (`ignoredPlayerIds`)
// ──────────────────────────────────────────────────────────────────
//
// The rule: a muted prober leaves the digest ENTIRELY — not just `players`, but
// the headline counts and `lastTs` too. Hiding the row while the number above it
// kept counting would leave the panel still nagging about the alert the user
// just acknowledged, which is the whole thing they were trying to stop.

describe('digestProximityReports — ignoredPlayerIds', () => {
  const log = [
    rep({ byPlayerId: 7, byPlayerName: 'Friend', fromCoords: '1:1:9', atCoords: '1:1:1', ts: 300 }),
    rep({ byPlayerId: 7, byPlayerName: 'Friend', fromCoords: '1:1:9', atCoords: '1:1:2', ts: 250 }),
    rep({ byPlayerId: 8, byPlayerName: 'Hostile', fromCoords: '4:9:9', atCoords: '1:1:1', ts: 100 }),
  ];

  it('is a no-op when the option is absent, empty, or names nobody in the log', () => {
    const base = digestProximityReports(log);
    for (const opt of [undefined, {}, { ignoredPlayerIds: [] }, { ignoredPlayerIds: [-999] }]) {
      const d = digestProximityReports(log, /** @type {any} */ (opt));
      expect(d.playerCount).toBe(base.playerCount);
      expect(d.totalReports).toBe(base.totalReports);
      expect(d.hiddenPlayerIds).toEqual([]);
    }
  });

  it('drops the muted prober from players AND from every headline count', () => {
    // Player 7 is the same-system one and owns the newest alerts, so muting them
    // must move all four numbers, not just the row list.
    const d = digestProximityReports(log, { ignoredPlayerIds: [7] });
    expect(d.players.map((p) => p.byPlayerId)).toEqual([8]);
    expect(d.playerCount).toBe(1);
    expect(d.totalReports).toBe(1); // both of player 7's alerts are gone
    expect(d.sameSystemCount).toBe(0);
    expect(d.lastTs).toBe(100); // recomputed — NOT the muted prober's 300
    expect(d.hiddenPlayerIds).toEqual([7]);
  });

  it('reports each hidden prober ONCE, however many alerts they own', () => {
    // `hiddenPlayerIds` drives a "Muted: <name>" affordance, which is per
    // player — two alerts from one muted prober is still one name.
    const d = digestProximityReports(log, { ignoredPlayerIds: [7] });
    expect(d.hiddenPlayerIds).toHaveLength(1);
  });

  it('accepts a Set or any iterable, not just an array', () => {
    const viaSet = digestProximityReports(log, { ignoredPlayerIds: new Set([7]) });
    const viaArray = digestProximityReports(log, { ignoredPlayerIds: [7] });
    expect(viaSet.players.map((p) => p.byPlayerId)).toEqual(viaArray.players.map((p) => p.byPlayerId));
    expect(viaSet.hiddenPlayerIds).toEqual(viaArray.hiddenPlayerIds);
  });

  it('muting everyone yields a genuinely empty digest, with all ids reported hidden', () => {
    // The caller distinguishes this from "no scans at all" — a window holding
    // nothing but muted probers must not read as quiet.
    const d = digestProximityReports(log, { ignoredPlayerIds: [7, 8] });
    expect(d.players).toEqual([]);
    expect(d.playerCount).toBe(0);
    expect(d.totalReports).toBe(0);
    expect(d.lastTs).toBeNull();
    expect([...d.hiddenPlayerIds].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('leaves the surviving prober untouched — muting is a filter, not a rewrite', () => {
    const kept = digestProximityReports(log, { ignoredPlayerIds: [7] }).players[0];
    const alone = digestProximityReports([log[2]]).players[0];
    expect(kept).toEqual(alone);
  });

  it('does not report a muted prober as hidden once their alerts age out of the log', () => {
    // The affordance must disappear on its own rather than offering to unmute
    // somebody who is no longer in the window at all.
    const d = digestProximityReports([log[2]], { ignoredPlayerIds: [7] });
    expect(d.hiddenPlayerIds).toEqual([]);
    expect(d.playerCount).toBe(1);
  });
});
