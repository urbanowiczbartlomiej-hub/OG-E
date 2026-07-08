// Unit tests for the JSON-import reconcilers in sync/merge.js — the merges
// behind the dashboard Export/Import's new datasets (spy reports, activity
// rings, proximity log, player cache, alliance classes, body inventory).
// Same discipline as every other reconciler here: pure `{merged, changed}`,
// additive, local observations trusted first; `changed` must be precise (a
// false negative silently drops an import, a false positive burns a write).
//
// Node env — pure functions over plain data.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  mergeTargetReports,
  mergeActivityObs,
  mergeProximityReports,
  mergePlayerCache,
  mergeAllianceClassMap,
  mergeBodyInventory,
} from '../../src/sync/merge.js';
import { HISTORY_CAP } from '../../src/domain/targetReports.js';
import { ACTIVITY_RING_CAP } from '../../src/domain/activityObs.js';
import { PROXIMITY_CAP } from '../../src/state/proximityReports.js';

describe('mergeTargetReports', () => {
  /** @param {number} ts @param {Record<string, unknown>} [over] */
  const report = (ts, over = {}) => /** @type {any} */ ({ timestamp: ts, defenseValue: ts * 2, ...over });
  /** @param {number} ts @param {any[]} [history] */
  const entry = (ts, history = []) => ({ latest: report(ts), history });

  it('newer latest wins per body; local kept on tie; changed only on adoption', () => {
    const local = { 42: { '1:2:3:1': entry(100), '1:2:8:1': entry(500) } };
    const incoming = { 42: { '1:2:3:1': entry(200), '1:2:8:1': entry(400) } };
    const { merged, changed } = mergeTargetReports(local, incoming);
    expect(merged[42]['1:2:3:1'].latest.timestamp).toBe(200); // newer adopted
    expect(merged[42]['1:2:8:1'].latest.timestamp).toBe(500); // local kept
    expect(changed).toBe(true);
  });

  it('unions bodies and players the other side never saw', () => {
    const { merged, changed } = mergeTargetReports(
      { 42: { '1:2:3:1': entry(100) } },
      { 7: { '9:9:9:1': entry(50) } },
    );
    expect(Object.keys(merged).sort()).toEqual(['42', '7'].sort());
    expect(changed).toBe(true);
  });

  it('tolerates the legacy bare-SpyReport entry shape on either side', () => {
    const { merged } = mergeTargetReports(
      { 42: { '1:2:3:1': report(100) } }, // legacy: no {latest, history} wrapper
      { 42: { '1:2:3:1': entry(200, [{ ts: 150 }]) } },
    );
    expect(merged[42]['1:2:3:1'].latest.timestamp).toBe(200);
    expect(merged[42]['1:2:3:1'].history).toEqual([{ ts: 150 }]);
  });

  it('history unions by content, stays time-ordered, re-caps — and cap eviction still reads as changed', () => {
    const localHist = Array.from({ length: HISTORY_CAP }, (_, i) => ({ ts: 1000 + i }));
    const local = { 42: { '1:2:3:1': entry(5000, localHist) } };
    const incoming = { 42: { '1:2:3:1': entry(5000, [{ ts: 9000 }]) } };
    const { merged, changed } = mergeTargetReports(local, incoming);
    const hist = merged[42]['1:2:3:1'].history;
    expect(hist).toHaveLength(HISTORY_CAP); // capped: oldest evicted
    expect(hist[hist.length - 1]).toEqual({ ts: 9000 }); // newest last
    expect(hist[0]).toEqual({ ts: 1001 }); // ts:1000 fell off
    expect(changed).toBe(true); // same length, different ring — content compare
  });

  it('identical sides → changed false', () => {
    const local = { 42: { '1:2:3:1': entry(100, [{ ts: 50 }]) } };
    const { changed } = mergeTargetReports(local, JSON.parse(JSON.stringify(local)));
    expect(changed).toBe(false);
  });
});

describe('mergeActivityObs', () => {
  it('unions rings by (t, m), keeps time order, re-caps to the newest', () => {
    const localRing = Array.from({ length: ACTIVITY_RING_CAP }, (_, i) => ({ t: 1000 + i, m: -1 }));
    const local = { 42: { '1:2:3:1': localRing } };
    const incoming = { 42: { '1:2:3:1': [{ t: 9000, m: 0 }, { t: 1005, m: -1 }] } };
    const { merged, changed } = mergeActivityObs(local, incoming);
    const ring = merged[42]['1:2:3:1'];
    expect(ring).toHaveLength(ACTIVITY_RING_CAP);
    expect(ring[ring.length - 1]).toEqual({ t: 9000, m: 0 }); // new look joined, newest last
    expect(ring.filter((o) => o.t === 1005)).toHaveLength(1); // duplicate collapsed
    expect(changed).toBe(true);
  });

  it('identical sides → changed false; junk observations dropped', () => {
    const local = { 42: { '1:2:3:1': [{ t: 100, m: -1 }] } };
    expect(mergeActivityObs(local, JSON.parse(JSON.stringify(local))).changed).toBe(false);
    const { merged } = mergeActivityObs(local, /** @type {any} */ ({ 42: { '1:2:3:1': [{ bogus: true }] } }));
    expect(merged[42]['1:2:3:1']).toEqual([{ t: 100, m: -1 }]);
  });
});

describe('mergeProximityReports', () => {
  /** @param {number} byPlayerId @param {number} ts */
  const rep = (byPlayerId, ts) => ({ byPlayerId, atCoords: '1:2:3', ts });

  it('unions with the writer\'s identity triple, newest-first, capped', () => {
    const local = [rep(1, 300), rep(2, 100)];
    const incoming = [rep(1, 300), rep(3, 200)]; // first is a duplicate
    const { merged, changed } = mergeProximityReports(local, incoming);
    expect(merged.map((r) => r.ts)).toEqual([300, 200, 100]);
    expect(changed).toBe(true);
  });

  it('caps at the window size, keeping the newest', () => {
    const local = Array.from({ length: PROXIMITY_CAP }, (_, i) => rep(i, 1000 + i));
    const { merged } = mergeProximityReports(local, [rep(999, 5000)]);
    expect(merged).toHaveLength(PROXIMITY_CAP);
    expect(merged[0].ts).toBe(5000);
  });

  it('nothing new → changed false and local order preserved', () => {
    const local = [rep(1, 300), rep(2, 100)];
    const { merged, changed } = mergeProximityReports(local, [rep(2, 100)]);
    expect(changed).toBe(false);
    expect(merged).toEqual(local);
  });
});

describe('mergePlayerCache', () => {
  it('newer seenAt wins per id; local kept on tie/missing', () => {
    const local = { 1: { id: 1, name: 'Old', seenAt: 100 }, 2: { id: 2, name: 'Mine', seenAt: 500 } };
    const incoming = { 1: { id: 1, name: 'New', seenAt: 200 }, 2: { id: 2, name: 'Theirs', seenAt: 500 }, 3: { id: 3, name: 'Added', seenAt: 50 } };
    const { merged, changed } = mergePlayerCache(local, incoming);
    expect(merged[1].name).toBe('New');
    expect(merged[2].name).toBe('Mine'); // tie → local
    expect(merged[3].name).toBe('Added');
    expect(changed).toBe(true);
  });

  it('nothing newer → changed false', () => {
    const local = { 1: { id: 1, name: 'A', seenAt: 100 } };
    expect(mergePlayerCache(local, { 1: { id: 1, name: 'B', seenAt: 100 } }).changed).toBe(false);
  });
});

describe('mergeAllianceClassMap', () => {
  it('fills gaps only — the local harvest outranks the file on conflict', () => {
    const { merged, changed } = mergeAllianceClassMap(
      { 500: 'warrior' },
      /** @type {any} */ ({ 500: 'trader', 600: 'explorer', 700: 42 }), // junk value dropped
    );
    expect(merged).toEqual({ 500: 'warrior', 600: 'explorer' });
    expect(changed).toBe(true);
    expect(mergeAllianceClassMap({ 500: 'warrior' }, { 500: 'trader' }).changed).toBe(false);
  });
});

describe('mergeBodyInventory', () => {
  /** @param {number} capturedAt @param {number} n */
  const inv = (capturedAt, n) => /** @type {import('../../src/state/bodies.js').BodyInventory} */ ({
    bodies: Array.from({ length: n }, (_, i) => ({
      cp: i, name: `B${i}`, galaxy: 1, system: 2, position: i + 1, type: 1,
    })),
    capturedAt,
  });

  it('whole-snapshot newest-capturedAt wins — never a body-level union', () => {
    const local = inv(100, 3);
    const newer = mergeBodyInventory(local, inv(200, 2));
    expect(newer.merged.bodies).toHaveLength(2); // replaced wholesale
    expect(newer.changed).toBe(true);
    const older = mergeBodyInventory(local, inv(50, 9));
    expect(older.merged).toBe(local);
    expect(older.changed).toBe(false);
  });

  it('a newer stamp without a bodies array is ignored (corrupt file)', () => {
    const local = inv(100, 3);
    expect(mergeBodyInventory(local, { capturedAt: 999 }).merged).toBe(local);
  });
});
