// @ts-check

// Unit tests for domain/allianceIntel — the pure core of the alliance
// Spyglass share: canonical member keys, doc normalisation (version guard),
// own-block build from local intel, the per-member-block merge, and the
// display union.

import { describe, it, expect } from 'vitest';
import {
  ALLIANCE_INTEL_VERSION,
  memberKeyFor,
  emptyAllianceDoc,
  normalizeAllianceDoc,
  buildMemberBlock,
  mergeOwnBlock,
  allianceLedgerForPid,
  summarizeAllianceIntel,
} from '../../src/domain/allianceIntel.js';
import { unpackPresenceLedger } from '../../src/domain/presenceLedger.js';

describe('memberKeyFor', () => {
  it('trims and collapses inner whitespace', () => {
    expect(memberKeyFor('  Yo  xid \n')).toBe('Yo xid');
  });

  it('bounds the key to 40 chars and tolerates junk input', () => {
    expect(memberKeyFor('x'.repeat(60))).toHaveLength(40);
    expect(memberKeyFor('')).toBe('');
    expect(memberKeyFor(/** @type {any} */ (null))).toBe('');
  });
});

describe('normalizeAllianceDoc', () => {
  it('treats an absent file (null) as an empty doc for the universe', () => {
    expect(normalizeAllianceDoc(null, 's163-pl')).toEqual(emptyAllianceDoc('s163-pl'));
  });

  it('REJECTS (null) a doc with a different schema version — never overwrite a newer format', () => {
    expect(normalizeAllianceDoc({ version: ALLIANCE_INTEL_VERSION + 1, members: {} }, 's163-pl'))
      .toBeNull();
    expect(normalizeAllianceDoc({ members: {} }, 's163-pl')).toBeNull();
    expect(normalizeAllianceDoc('garbage', 's163-pl')).toBeNull();
  });

  it('forces the expected universeId (a hand-copied file cannot relabel itself)', () => {
    const doc = normalizeAllianceDoc(
      { version: 1, universeId: 's999-xx', members: {} }, 's163-pl',
    );
    expect(doc?.universeId).toBe('s163-pl');
  });

  it('normalises member blocks and drops malformed players/fields', () => {
    const doc = normalizeAllianceDoc({
      version: 1,
      members: {
        '  Alice ': {
          updatedAtSec: 1000,
          players: {
            7: { name: 'Bob', tag: 'enemy', lastSpySec: 500, lastSeenSec: -3, bodiesSpied: 2 },
            8: { tag: 'bogus', lastSpySec: 'NaN' },
            9: null,
          },
        },
        '': { updatedAtSec: 1, players: {} }, // empty key → dropped
        Mallory: 'not-an-object', // malformed block → dropped
      },
    }, 's163-pl');
    expect(doc).not.toBeNull();
    expect(Object.keys(/** @type {any} */ (doc).members)).toEqual(['Alice']);
    const alice = /** @type {any} */ (doc).members.Alice;
    expect(alice.updatedAtSec).toBe(1000);
    expect(alice.players['7']).toEqual({ name: 'Bob', lastSpySec: 500, bodiesSpied: 2 });
    // Unknown fields (incl. the retired tag) + non-numeric timestamps stripped,
    // but the entry survives.
    expect(alice.players['8']).toEqual({});
    expect(alice.players['9']).toBeUndefined();
  });
});

describe('buildMemberBlock', () => {
  it('derives lastSpySec (newest across bodies) + bodiesSpied from targetReports-shaped data', () => {
    const block = buildMemberBlock({
      reports: {
        7: {
          '1:2:3': { latest: { timestamp: 100 }, history: [] },
          '1:2:4': { latest: { timestamp: 900 }, history: [] },
        },
      },
      nowSec: 5000,
    });
    expect(block.updatedAtSec).toBe(5000);
    expect(block.players['7'].lastSpySec).toBe(900);
    expect(block.players['7'].bodiesSpied).toBe(2);
  });

  it('derives lastSeenSec as the newest IMPLIED interaction (t − m·60), skipping m = -1', () => {
    const block = buildMemberBlock({
      activity: {
        7: {
          '1:2:3:1': [
            { t: 1000, m: 30 }, // implied 1000 − 1800 → negative-ish, still a candidate
            { t: 2000, m: -1 }, // negative evidence — contributes nothing
            { t: 1500, m: 5 },  // implied 1200 — the newest interaction
          ],
        },
      },
      nowSec: 5000,
    });
    expect(block.players['7'].lastSeenSec).toBe(1200);
  });

  it('shares a name only alongside an observation — bare names/ids stay local', () => {
    const block = buildMemberBlock({
      playerNames: { 7: 'Bob', 8: 'Ghost' },
      reports: { 7: { '1:2:3': { latest: { timestamp: 100 }, history: [] } } },
      nowSec: 1,
    });
    expect(block.players['7']).toEqual({ name: 'Bob', lastSpySec: 100, bodiesSpied: 1 });
    expect(block.players['8']).toBeUndefined();
  });
});

describe('mergeOwnBlock', () => {
  it('touches only the own block, keeps every other member verbatim, and does not mutate', () => {
    const doc = emptyAllianceDoc('s163-pl');
    doc.members.Alice = { updatedAtSec: 1, players: { 7: { name: 'Bob' } } };
    doc.members.Me = { updatedAtSec: 2, players: {} };
    const next = mergeOwnBlock(doc, 'Me', { updatedAtSec: 9, players: { 8: {} } }, 9);
    expect(next.members.Alice).toBe(doc.members.Alice);
    expect(next.members.Me).toEqual({ updatedAtSec: 9, players: { 8: {} } });
    expect(doc.members.Me.updatedAtSec).toBe(2);
  });

  it('UNIONS the own block per player, field-wise max (multi-device safe)', () => {
    const doc = emptyAllianceDoc('s163-pl');
    // A previous block from THIS member (e.g. their other device / an earlier
    // share) already in the doc.
    doc.members.Me = {
      updatedAtSec: 5,
      players: { 7: { name: 'Bob', lastSpySec: 900, lastSeenSec: 100, bodiesSpied: 3 } },
    };
    // A fresh block that's newer on some fields, older on others.
    const fresh = {
      updatedAtSec: 8,
      players: { 7: { name: 'Bob', lastSpySec: 400, lastSeenSec: 700, bodiesSpied: 2 } },
    };
    const merged = mergeOwnBlock(doc, 'Me', fresh, 8).members.Me;
    // Every monotonic field takes the MAX — nothing the old block held is lost.
    expect(merged.players['7']).toEqual({
      name: 'Bob', lastSpySec: 900, lastSeenSec: 700, bodiesSpied: 3,
    });
    expect(merged.updatedAtSec).toBe(8);
  });

  it('unions the presence ledgers of the own block (OR of packed days)', () => {
    const doc = emptyAllianceDoc('s163-pl');
    const dayA = String(20000);
    const dayB = String(20001);
    // prev block covers day A; fresh covers day B — the union must hold BOTH.
    doc.members.Me = {
      updatedAtSec: 5,
      players: { 7: { lastSpySec: 1, presence: `${(20000).toString(36)}.1.` } },
    };
    const fresh = {
      updatedAtSec: 8,
      players: { 7: { lastSpySec: 1, presence: `${(20001).toString(36)}.2.` } },
    };
    const merged = mergeOwnBlock(doc, 'Me', fresh, 20001 * 86400).members.Me;
    const ledger = unpackPresenceLedger(merged.players['7'].presence);
    expect(ledger[dayA]).toEqual([1, 0]);
    expect(ledger[dayB]).toEqual([2, 0]);
  });
});

describe('buildMemberBlock — presence ledgers (v2)', () => {
  it('packs a player ledger into the block and gates share on any observation', () => {
    const block = buildMemberBlock({
      ledgers: { 7: { 20000: [1 << 14, 0] } },
      nowSec: 20000 * 86400 + 3600,
    });
    // A ledger alone is an observation record → the id shares.
    expect(typeof block.players['7'].presence).toBe('string');
    expect(unpackPresenceLedger(block.players['7'].presence)['20000']).toEqual([1 << 14, 0]);
  });
});

describe('allianceLedgerForPid — pooling', () => {
  it('ORs one player ledger across every member block, listing contributors', () => {
    const doc = emptyAllianceDoc('s163-pl');
    doc.members.Alice = {
      updatedAtSec: 1, players: { 7: { presence: `${(20000).toString(36)}.1.` } },
    };
    doc.members.Bob = {
      updatedAtSec: 1, players: { 7: { presence: `${(20000).toString(36)}.2.4` } },
    };
    const { ledger, members } = allianceLedgerForPid(doc, '7');
    // Alice's active bit0 | Bob's active bit1 = 3; Bob's quiet bit2 = 4.
    expect(ledger['20000']).toEqual([3, 4]);
    expect(members).toEqual(['Alice', 'Bob']);
  });
});

describe('normalizeAllianceDoc — version tolerance', () => {
  it('READS a legacy v1 doc and preserves an unknown-but-bounded presence field on v2', () => {
    const v1 = normalizeAllianceDoc(
      { version: 1, members: { Al: { updatedAtSec: 1, players: { 7: { name: 'X' } } } } },
      's163-pl',
    );
    expect(v1).not.toBeNull();
    expect(v1?.members.Al.players['7'].name).toBe('X');
    const v2 = normalizeAllianceDoc(
      { version: 2, members: { Al: { updatedAtSec: 1, players: { 7: { presence: 'ffk.1.' } } } } },
      's163-pl',
    );
    expect(v2?.members.Al.players['7'].presence).toBe('ffk.1.');
  });

  it('emptyAllianceDoc stamps the CURRENT version (2)', () => {
    expect(emptyAllianceDoc('s163-pl').version).toBe(ALLIANCE_INTEL_VERSION);
    expect(ALLIANCE_INTEL_VERSION).toBe(2);
  });
});

describe('summarizeAllianceIntel', () => {
  it('unions players across members: newest timestamps win, watchers listed alphabetically', () => {
    const doc = emptyAllianceDoc('s163-pl');
    doc.members.Zed = {
      updatedAtSec: 10,
      players: { 7: { name: 'OldName', lastSpySec: 100 } },
    };
    doc.members.Alice = {
      updatedAtSec: 20, // fresher block → her name wins
      players: { 7: { name: 'NewName', lastSpySec: 50, lastSeenSec: 400 } },
    };
    const rows = summarizeAllianceIntel(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: '7',
      name: 'NewName',
      lastSpySec: 100,   // max across members
      lastSeenSec: 400,
      watchers: ['Alice', 'Zed'],
    });
  });

  it('sorts rows by their freshest signal, newest first', () => {
    const doc = emptyAllianceDoc('s163-pl');
    doc.members.Me = {
      updatedAtSec: 1,
      players: {
        1: { name: 'Stale', lastSpySec: 100 },
        2: { name: 'Fresh', lastSeenSec: 900 },
        3: { name: 'Never' },
      },
    };
    expect(summarizeAllianceIntel(doc).map((r) => r.name)).toEqual(['Fresh', 'Stale', 'Never']);
  });
});
