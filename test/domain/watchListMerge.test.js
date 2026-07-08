// Unit tests for domain/watchListMerge.js — the pure core of the Spyglass
// watch-list gist sync (SPYGLASS-SYNC-PLAN). One uniform per-key rule covers
// every family, so the suite drills that rule from both sides plus the three
// invariants the plan pins: first-sync seeding preserves local, tombstones are
// born only from an explicit diff, and a fresh device can never wipe remote.
//
// Node env — pure functions over plain data, every test passes an explicit
// `now`.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  WATCH_FAMILIES,
  WATCH_TOMBSTONE_GC_MS,
  normalizeWatchSlot,
  watchSlotHasData,
  composeWatchSlot,
  decomposeWatchSlot,
  seedWatchListLedger,
  stampWatchListDiff,
  mergeWatchList,
} from '../../src/domain/watchListMerge.js';

const NOW = 1_700_000_000_000;

/** A minimal normalized-shaped config. @param {Record<string, any>} [over] */
const cfg = (over = {}) => ({
  players: [],
  probes: 20,
  scanBodies: 'planets',
  rescan: {},
  relationships: {},
  mapHidden: {},
  scanMode: {},
  galaxyMode: {},
  cadence: { rescanHours: 48, galaxyHours: 24 },
  ...over,
});

/** An all-empty ledger. */
const emptyLedger = () => Object.fromEntries(WATCH_FAMILIES.map((f) => [f, {}]));

describe('normalizeWatchSlot / watchSlotHasData', () => {
  it('coerces junk into an all-empty slot (every family present)', () => {
    for (const raw of [null, undefined, 42, 'x', [], { watched: 'junk', rel: [1] }]) {
      const slot = normalizeWatchSlot(raw);
      for (const fam of WATCH_FAMILIES) expect(slot[fam]).toEqual({});
    }
  });

  it('drops records with non-finite ts and keeps tombstones (v absent)', () => {
    const slot = normalizeWatchSlot({
      watched: {
        1: { v: true, ts: 100 },
        2: { ts: 200 }, // tombstone
        3: { v: true, ts: 'NaN' }, // junk ts → dropped
        4: 'junk', // junk record → dropped
      },
    });
    expect(slot.watched).toEqual({ 1: { v: true, ts: 100 }, 2: { ts: 200 } });
  });

  it('hasData: keyed records count, virgin ts:0 singles do NOT', () => {
    // A never-configured universe composes its materialised defaults at ts 0 —
    // contributing that slot would pollute the gist for every visited server.
    const virgin = composeWatchSlot(cfg(), emptyLedger());
    expect(watchSlotHasData(virgin)).toBe(false);
    // A STAMPED single counts (a real cadence edit)…
    expect(watchSlotHasData(normalizeWatchSlot({ cadence: { _: { v: { rescanHours: 2, galaxyHours: 4 }, ts: NOW } } }))).toBe(true);
    // …and so does any keyed record, live or tombstone.
    expect(watchSlotHasData(normalizeWatchSlot({ watched: { 1: { ts: NOW } } }))).toBe(true);
  });
});

describe('composeWatchSlot / decomposeWatchSlot', () => {
  it('pairs live values with ledger stamps and turns dead stamps into tombstones', () => {
    const ledger = { ...emptyLedger(), watched: { 1: NOW, 9: NOW - 5 }, rel: { 1: NOW } };
    const slot = composeWatchSlot(cfg({ players: ['1'], relationships: { 1: 'enemy' } }), ledger);
    expect(slot.watched).toEqual({ 1: { v: true, ts: NOW }, 9: { ts: NOW - 5 } });
    expect(slot.rel).toEqual({ 1: { v: 'enemy', ts: NOW } });
    // Unstamped singles compose deterministically at ts 0.
    expect(slot.scanBodies).toEqual({ _: { v: 'planets', ts: 0 } });
  });

  it('round-trips through decompose (players sorted numerically, tombstones → ledger only)', () => {
    const slot = normalizeWatchSlot({
      watched: { 10: { v: true, ts: 1 }, 2: { v: true, ts: 2 }, 7: { ts: 3 } },
      scan: { '1:2:3:3': { v: 'off', ts: 4 } },
      cadence: { _: { v: { rescanHours: 12, galaxyHours: 6 }, ts: 5 } },
      scanBodies: { _: { v: 'both', ts: 6 } },
    });
    const { cfg: out, ledger } = decomposeWatchSlot(slot);
    expect(out.players).toEqual(['2', '10']); // numeric order, tombstoned 7 absent
    expect(out.scanMode).toEqual({ '1:2:3:3': 'off' });
    expect(out.cadence).toEqual({ rescanHours: 12, galaxyHours: 6 });
    expect(out.scanBodies).toBe('both');
    expect(ledger.watched).toEqual({ 10: 1, 2: 2, 7: 3 }); // tombstone stamp survives
  });
});

describe('seedWatchListLedger — first-sync safety', () => {
  /** The materialised defaults the state layer passes (state/watchList.js). */
  const DEFAULTS = { scanBodies: 'planets', cadence: { rescanHours: 48, galaxyHours: 24 } };

  it('stamps every live keyed entry at now, never creating a tombstone', () => {
    const c = cfg({ players: ['1', '2'], relationships: { 1: 'friend' }, scanMode: { 2: 'off' } });
    const { ledger, changed } = seedWatchListLedger(c, emptyLedger(), NOW, DEFAULTS);
    expect(changed).toBe(true);
    expect(ledger.watched).toEqual({ 1: NOW, 2: NOW });
    expect(ledger.rel).toEqual({ 1: NOW });
    expect(ledger.scan).toEqual({ 2: NOW });
    // Every ledger key corresponds to a LIVE config key — no tombstones.
    const slot = composeWatchSlot(c, ledger);
    for (const fam of WATCH_FAMILIES) {
      for (const rec of Object.values(slot[fam])) expect('v' in rec).toBe(true);
    }
  });

  it('seeds a TUNED single (real pre-ledger intent) but never a default-valued one', () => {
    // A default cadence carries no intent: stamping it at `now` would win LWW
    // over another device's OLDER tuned seed — the exact regression this rule
    // prevents. A tuned value is evidence of a real edit and gets protected.
    const dflt = seedWatchListLedger(cfg({ players: ['1'] }), emptyLedger(), NOW, DEFAULTS);
    expect(dflt.ledger.cadence).toEqual({});
    expect(dflt.ledger.scanBodies).toEqual({});
    const tuned = seedWatchListLedger(
      cfg({ players: ['1'], cadence: { rescanHours: 6, galaxyHours: 12 }, scanBodies: 'both' }),
      emptyLedger(), NOW, DEFAULTS,
    );
    expect(tuned.ledger.cadence).toEqual({ _: NOW });
    expect(tuned.ledger.scanBodies).toEqual({ _: NOW });
  });

  it('a virgin universe seeds nothing (materialised defaults must not sync)', () => {
    const { ledger, changed } = seedWatchListLedger(cfg(), emptyLedger(), NOW, DEFAULTS);
    expect(changed).toBe(false);
    expect(ledger.cadence).toEqual({});
    expect(ledger.scanBodies).toEqual({});
    expect(ledger.watched).toEqual({});
  });

  it('is idempotent (second seed changes nothing)', () => {
    const c = cfg({ players: ['1'] });
    const first = seedWatchListLedger(c, emptyLedger(), NOW, DEFAULTS);
    const second = seedWatchListLedger(c, first.ledger, NOW + 999, DEFAULTS);
    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
  });
});

describe('stampWatchListDiff — the only birthplace of tombstones', () => {
  it('stamps additions and value changes at now', () => {
    const prev = cfg({ players: ['1'], relationships: { 1: 'neutral' } });
    const next = cfg({ players: ['1', '2'], relationships: { 1: 'enemy' } });
    const seeded = seedWatchListLedger(prev, emptyLedger(), NOW - 100).ledger;
    const { ledger, changed } = stampWatchListDiff(prev, next, seeded, NOW);
    expect(changed).toBe(true);
    expect(ledger.watched).toEqual({ 1: NOW - 100, 2: NOW });
    expect(ledger.rel).toEqual({ 1: NOW }); // re-tag re-stamps
  });

  it('keeps a removed key\'s ledger entry re-stamped at now — the tombstone', () => {
    const prev = cfg({ players: ['1', '2'] });
    const next = cfg({ players: ['2'] });
    const seeded = seedWatchListLedger(prev, emptyLedger(), NOW - 100).ledger;
    const { ledger } = stampWatchListDiff(prev, next, seeded, NOW);
    expect(ledger.watched[1]).toBe(NOW); // dead in next + stamped = tombstone
    const slot = composeWatchSlot(next, ledger);
    expect(slot.watched[1]).toEqual({ ts: NOW });
  });

  it('stamps a single only on a REAL value change, never as backfill', () => {
    const prev = cfg();
    const probesOnly = cfg({ probes: 33 }); // probes is not a synced family
    expect(stampWatchListDiff(prev, probesOnly, emptyLedger(), NOW).changed).toBe(false);
    const tuned = cfg({ cadence: { rescanHours: 6, galaxyHours: 12 } });
    const { ledger, changed } = stampWatchListDiff(prev, tuned, emptyLedger(), NOW);
    expect(changed).toBe(true);
    expect(ledger.cadence).toEqual({ _: NOW });
  });

  it('GCs tombstones older than the horizon', () => {
    const ancient = NOW - WATCH_TOMBSTONE_GC_MS - 1000;
    const ledger = { ...emptyLedger(), watched: { 9: ancient } }; // dead + ancient
    const { ledger: out } = stampWatchListDiff(cfg(), cfg(), ledger, NOW);
    expect(out.watched).toEqual({});
  });
});

describe('mergeWatchList — uniform newest-ts rule', () => {
  /** @param {unknown} v @param {number} ts */
  const live = (v, ts) => ({ v, ts });
  /** @param {number} ts */
  const dead = (ts) => ({ ts });
  // Stamps must sit NEAR `now` — a tombstone older than the 60-day horizon is
  // (correctly) GC'd by the merge, so absolute toy values like `200` would
  // vanish and test the GC instead of the rule.
  /** @param {number} agoMs */
  const T = (agoMs) => NOW - agoMs;

  it('a later removal beats an earlier add, and vice-versa', () => {
    const localAdd = normalizeWatchSlot({ watched: { 1: live(true, T(300)) } });
    const remoteRemove = normalizeWatchSlot({ watched: { 1: dead(T(200)) } });
    const a = mergeWatchList(localAdd, remoteRemove, NOW);
    expect(a.merged.watched[1]).toEqual(dead(T(200)));
    expect(a.changed).toBe(true); // remote's removal must be adopted

    const localReAdd = normalizeWatchSlot({ watched: { 1: live(true, T(100)) } });
    const b = mergeWatchList(localReAdd, remoteRemove, NOW);
    expect(b.merged.watched[1]).toEqual(live(true, T(100)));
    expect(b.changed).toBe(false); // remote contributed nothing local lacked
  });

  it('unions distinct keys from both sides', () => {
    const local = normalizeWatchSlot({ watched: { 1: live(true, T(100)) } });
    const remote = normalizeWatchSlot({ watched: { 2: live(true, T(100)) }, rel: { 2: live('enemy', T(100)) } });
    const { merged, changed } = mergeWatchList(local, remote, NOW);
    expect(Object.keys(merged.watched).sort()).toEqual(['1', '2']);
    expect(merged.rel[2]).toEqual(live('enemy', T(100)));
    expect(changed).toBe(true);
  });

  it('is symmetric — both devices converge on the same winner', () => {
    const a = normalizeWatchSlot({
      watched: { 1: live(true, T(500)), 2: dead(T(100)) },
      cadence: { _: live({ rescanHours: 6, galaxyHours: 12 }, T(200)) },
    });
    const b = normalizeWatchSlot({
      watched: { 1: dead(T(400)), 2: live(true, T(300)) },
      cadence: { _: live({ rescanHours: 48, galaxyHours: 24 }, T(250)) },
    });
    const ab = mergeWatchList(a, b, NOW).merged;
    const ba = mergeWatchList(b, a, NOW).merged;
    expect(ab).toEqual(ba);
    expect(ab.watched[1]).toEqual(dead(T(400)));
    expect(ab.watched[2]).toEqual(dead(T(100)));
    expect(/** @type {any} */ (ab.cadence._.v).rescanHours).toBe(6); // whole-object LWW via the "_" key
  });

  it('breaks an exact-ts tie in favour of the LIVE record, symmetrically', () => {
    const local = normalizeWatchSlot({ watched: { 1: dead(T(100)) } });
    const remote = normalizeWatchSlot({ watched: { 1: live(true, T(100)) } });
    expect(mergeWatchList(local, remote, NOW).merged.watched[1]).toEqual(live(true, T(100)));
    expect(mergeWatchList(remote, local, NOW).merged.watched[1]).toEqual(live(true, T(100)));
  });

  it('C6: an empty fresh device adopts remote and invents nothing', () => {
    const fresh = composeWatchSlot(cfg(), emptyLedger());
    const remote = normalizeWatchSlot({
      watched: { 1: live(true, 100) },
      rel: { 1: live('enemy', 100) },
    });
    const { merged, changed } = mergeWatchList(fresh, remote, NOW);
    expect(changed).toBe(true);
    expect(merged.watched).toEqual(remote.watched);
    expect(merged.rel).toEqual(remote.rel);
    // Nothing local leaked in as a tombstone that could delete remote data.
    for (const fam of WATCH_FAMILIES) {
      for (const rec of Object.values(merged[fam])) expect('v' in rec).toBe(true);
    }
  });

  it('the seeded side survives a first merge against established remote (invariant 2)', () => {
    const localCfg = cfg({ players: ['7'], cadence: { rescanHours: 2, galaxyHours: 4 } });
    const ledger = seedWatchListLedger(localCfg, emptyLedger(), NOW).ledger;
    const local = composeWatchSlot(localCfg, ledger);
    const remote = normalizeWatchSlot({
      watched: { 1: live(true, NOW - 5000) },
      cadence: { _: live({ rescanHours: 48, galaxyHours: 24 }, NOW - 5000) },
    });
    const { merged } = mergeWatchList(local, remote, NOW);
    expect(merged.watched[7]).toEqual(live(true, NOW)); // local star preserved
    expect(merged.watched[1]).toEqual(live(true, NOW - 5000)); // remote unioned
    expect(/** @type {any} */ (merged.cadence._.v).rescanHours).toBe(2); // locally-tuned cadence wins (newer seed)
  });

  it('GCs tombstones past the horizon and tolerates junk remote', () => {
    const local = normalizeWatchSlot({
      watched: { 1: dead(NOW - WATCH_TOMBSTONE_GC_MS - 1), 2: live(true, 100) },
    });
    const { merged, changed } = mergeWatchList(local, 'junk-from-hand-edited-gist', NOW);
    expect(merged.watched).toEqual({ 2: live(true, 100) });
    expect(changed).toBe(false);
  });

  it('changed stays false when remote equals local exactly', () => {
    const slot = normalizeWatchSlot({ watched: { 1: live(true, 100) }, rel: { 1: live('friend', 90) } });
    const { merged, changed } = mergeWatchList(slot, JSON.parse(JSON.stringify(slot)), NOW);
    expect(changed).toBe(false);
    expect(merged).toEqual(slot);
  });
});
