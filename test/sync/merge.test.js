// Unit tests for the pure sync/merge reconcilers.
//
// Pure logic, Node environment — no DOM, no timers, no fake Date.now().
// Each test is a single (local, remote) → {merged, changed} comparison.
// The `changed` flag is load-bearing: it is the caller's anti-loop
// hint, so every case asserts it explicitly (not just the shape of
// the merged output).
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { mergeScans, mergeHistory } from '../../src/sync/merge.js';

/**
 * @typedef {import('../../src/state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../src/state/scans.js').SystemScan} SystemScan
 * @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../src/state/history.js').ColonyHistory} ColonyHistory
 */

/**
 * Compact factory for a `SystemScan` with the fields the merger cares
 * about. `positions` is stubbed as an empty record so every test can
 * assert identity / reference equality when checking which side won.
 *
 * @param {number} scannedAt
 * @returns {SystemScan}
 */
const scan = (scannedAt) => ({ scannedAt, positions: {} });

/**
 * Compact factory for a `ColonyEntry`. Fields unrelated to the merge
 * (`fields`, `coords`, `position`, `timestamp`) are stubbed so each
 * test can focus on `cp` — the one field that affects the merger.
 *
 * @param {number} cp
 * @param {Partial<ColonyEntry>} [overrides]
 * @returns {ColonyEntry}
 */
const entry = (cp, overrides = {}) => ({
  cp,
  fields: 200,
  coords: '[1:1:1]',
  position: 1,
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe('mergeScans', () => {
  it('returns empty merged and unchanged when both local and remote are empty', () => {
    const local = /** @type {GalaxyScans} */ ({});
    const { merged, changed } = mergeScans(local, {});
    // Empty-remote shortcut: identity with local, no write.
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('short-circuits to local identity when remote is undefined', () => {
    /** @type {GalaxyScans} */
    const local = { '4:30': scan(1000) };
    const { merged, changed } = mergeScans(local, undefined);
    // Must be the same reference so callers can cheaply detect the
    // no-op case — we never want to write an allocated copy when
    // nothing changed.
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('short-circuits to local identity when remote is null', () => {
    /** @type {GalaxyScans} */
    const local = { '1:1': scan(500) };
    const { merged, changed } = mergeScans(local, null);
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('imports every remote entry when local is empty', () => {
    /** @type {GalaxyScans} */
    const local = {};
    const r1 = scan(1000);
    const r2 = scan(2000);
    /** @type {GalaxyScans} */
    const remote = { '1:1': r1, '2:2': r2 };
    const { merged, changed } = mergeScans(local, remote);
    // New device bootstrap case — everything is new information.
    expect(merged).toEqual({ '1:1': r1, '2:2': r2 });
    expect(changed).toBe(true);
  });

  it('keeps local when local has a newer scannedAt for a shared key', () => {
    const l = scan(2000);
    const r = scan(1000);
    /** @type {GalaxyScans} */
    const local = { '4:30': l };
    /** @type {GalaxyScans} */
    const remote = { '4:30': r };
    const { merged, changed } = mergeScans(local, remote);
    // Local-newer path: remote contributed nothing → no write.
    expect(merged['4:30']).toBe(l);
    expect(changed).toBe(false);
  });

  it('adopts remote when remote has a newer scannedAt for a shared key', () => {
    const l = scan(1000);
    const r = scan(2000);
    /** @type {GalaxyScans} */
    const local = { '4:30': l };
    /** @type {GalaxyScans} */
    const remote = { '4:30': r };
    const { merged, changed } = mergeScans(local, remote);
    // Remote-newer path: this is the one non-trivial write case.
    expect(merged['4:30']).toBe(r);
    expect(changed).toBe(true);
  });

  it('breaks scannedAt ties in favour of local (>= bias)', () => {
    const l = scan(1500);
    const r = scan(1500);
    /** @type {GalaxyScans} */
    const local = { '4:30': l };
    /** @type {GalaxyScans} */
    const remote = { '4:30': r };
    const { merged, changed } = mergeScans(local, remote);
    // Equal timestamps → the strict > check fails, so local wins.
    // This is what keeps the no-op feedback loop quiet when a sync
    // round-trip comes back identical.
    expect(merged['4:30']).toBe(l);
    expect(changed).toBe(false);
  });

  it('adds a new remote-only key and marks changed', () => {
    /** @type {GalaxyScans} */
    const local = { '1:1': scan(1000) };
    const rNew = scan(2000);
    /** @type {GalaxyScans} */
    const remote = { '1:1': scan(1000), '2:2': rNew };
    const { merged, changed } = mergeScans(local, remote);
    expect(merged['2:2']).toBe(rNew);
    // Local kept for the shared key (tie → local).
    expect(merged['1:1']).toBe(local['1:1']);
    expect(changed).toBe(true);
  });

  it('treats missing scannedAt as 0 so the side with a number wins', () => {
    // A malformed remote (no scannedAt) must not beat a well-formed
    // local, and vice versa.
    /** @type {SystemScan} */
    const lBad = /** @type {SystemScan} */ ({ positions: {} }); // no scannedAt
    const rGood = scan(1);
    /** @type {GalaxyScans} */
    const local = { '4:30': lBad };
    /** @type {GalaxyScans} */
    const remote = { '4:30': rGood };
    const { merged, changed } = mergeScans(local, remote);
    // 0 < 1 → remote wins, and `changed` is true.
    expect(merged['4:30']).toBe(rGood);
    expect(changed).toBe(true);

    // Symmetric: good local beats malformed remote.
    /** @type {GalaxyScans} */
    const local2 = { '4:30': scan(1) };
    /** @type {GalaxyScans} */
    const remote2 = { '4:30': /** @type {SystemScan} */ ({ positions: {} }) };
    const result2 = mergeScans(local2, remote2);
    expect(result2.merged['4:30']).toBe(local2['4:30']);
    expect(result2.changed).toBe(false);
  });

  it('handles a mixed merge with local-wins, remote-wins, and remote-only keys', () => {
    const lOld = scan(1000);
    const rOld = scan(500); // loses to lOld (shared key, local newer)
    const lStale = scan(100);
    const rFresh = scan(999); // beats lStale
    const rNew = scan(2000); // local doesn't have this key at all
    /** @type {GalaxyScans} */
    const local = { '1:1': lOld, '2:2': lStale };
    /** @type {GalaxyScans} */
    const remote = { '1:1': rOld, '2:2': rFresh, '3:3': rNew };
    const { merged, changed } = mergeScans(local, remote);
    expect(merged['1:1']).toBe(lOld);   // local wins on age
    expect(merged['2:2']).toBe(rFresh); // remote wins on age
    expect(merged['3:3']).toBe(rNew);   // remote-only key
    // `changed` is true because remote contributed something: the
    // 2:2 upgrade and the 3:3 new key.
    expect(changed).toBe(true);
    // Sanity: merged has exactly the three keys.
    expect(Object.keys(merged).sort()).toEqual(['1:1', '2:2', '3:3']);
  });
});

describe('mergeHistory', () => {
  it('returns empty merged and unchanged when both sides are empty', () => {
    /** @type {ColonyHistory} */
    const local = [];
    const { merged, changed } = mergeHistory(local, []);
    // Empty-remote shortcut: identity with local.
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('short-circuits to local identity when remote is undefined', () => {
    /** @type {ColonyHistory} */
    const local = [entry(1), entry(2)];
    const { merged, changed } = mergeHistory(local, undefined);
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('short-circuits to local identity when remote is null', () => {
    /** @type {ColonyHistory} */
    const local = [entry(7)];
    const { merged, changed } = mergeHistory(local, null);
    expect(merged).toBe(local);
    expect(changed).toBe(false);
  });

  it('imports every remote entry when local is empty', () => {
    /** @type {ColonyHistory} */
    const local = [];
    const r1 = entry(10);
    const r2 = entry(20);
    const { merged, changed } = mergeHistory(local, [r1, r2]);
    // Bootstrap case — all remote entries survive.
    expect(merged).toEqual([r1, r2]);
    expect(changed).toBe(true);
  });

  it('keeps the local version on cp collision regardless of remote content', () => {
    // Local wins unconditionally. Even if the remote carries a
    // "newer" timestamp or different fields, first-hand local
    // observation is the source of truth.
    const lHit = entry(42, { timestamp: 1, fields: 100 });
    const rHit = entry(42, { timestamp: 9999, fields: 999 });
    /** @type {ColonyHistory} */
    const local = [lHit];
    const { merged, changed } = mergeHistory(local, [rHit]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(lHit);
    // No new cp arrived → no write, no anti-loop churn.
    expect(changed).toBe(false);
  });

  it('adds a remote-only cp and marks changed', () => {
    const lOnly = entry(1);
    const rNew = entry(2);
    /** @type {ColonyHistory} */
    const local = [lOnly];
    const { merged, changed } = mergeHistory(local, [rNew]);
    expect(merged).toHaveLength(2);
    expect(merged).toContain(lOnly);
    expect(merged).toContain(rNew);
    expect(changed).toBe(true);
  });

  it('adds multiple remote-only cps in remote order, after all locals', () => {
    const l1 = entry(1);
    const l2 = entry(2);
    const r3 = entry(3);
    const r4 = entry(4);
    /** @type {ColonyHistory} */
    const local = [l1, l2];
    const { merged, changed } = mergeHistory(local, [r3, r4]);
    // Map iteration is insertion order: locals first, then new
    // remotes in remote's order.
    expect(merged).toEqual([l1, l2, r3, r4]);
    expect(changed).toBe(true);
  });

  it('reports changed=false when remote is fully covered by local cps', () => {
    const l1 = entry(1);
    const l2 = entry(2);
    // Remote has the same cps but different field values — should
    // still be treated as covered (local wins on collision).
    const r1 = entry(1, { fields: 500 });
    const r2 = entry(2, { fields: 500 });
    /** @type {ColonyHistory} */
    const local = [l1, l2];
    const { merged, changed } = mergeHistory(local, [r1, r2]);
    expect(merged).toEqual([l1, l2]);
    expect(changed).toBe(false);
  });

  it('preserves local order and appends remote-only cps in remote order in a mixed merge', () => {
    const l1 = entry(1);
    const l2 = entry(2);
    // r1/r2 collide with l1/l2 (dropped), r3 is new.
    const r1 = entry(1, { fields: 50 });
    const r2 = entry(2, { fields: 50 });
    const r3 = entry(3);
    /** @type {ColonyHistory} */
    const local = [l1, l2];
    const { merged, changed } = mergeHistory(local, [r1, r2, r3]);
    // Asserts two properties in one: local entries win on collision,
    // AND the new cp is appended at the end in remote's order.
    expect(merged).toEqual([l1, l2, r3]);
    expect(changed).toBe(true);
  });
});
