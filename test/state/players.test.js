// @vitest-environment happy-dom

// Behavioural tests for the player-metadata cache listener. We drive the
// real `oge:galaxyScanned` event through the installed listener and assert
// the observable store state (merge by id, newest-wins, defensive skips).
// Uses `installPlayersListener` directly (not `initPlayersStore`) so no
// chrome.storage wiring is involved — the listener is the unit under test.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  playersStore,
  installPlayersListener,
  disposePlayersListener,
} from '../../src/state/players.js';
import { GALAXY_SCANNED_EVENT } from '../../src/lib/ogeEvents.js';

/** @param {any} detail */
const fire = (detail) =>
  document.dispatchEvent(new CustomEvent(GALAXY_SCANNED_EVENT, { detail }));

/** Read the store as a loose map for assertions. @returns {any} */
const cache = () => /** @type {any} */ (playersStore.get());

beforeEach(() => {
  playersStore.set({});
  installPlayersListener();
});

afterEach(() => {
  disposePlayersListener();
  playersStore.set({});
});

describe('players store listener', () => {
  it('merges incoming player metadata keyed by id', () => {
    fire({ galaxy: 1, system: 100, scannedAt: 1000, players: { 7: { id: 7, name: 'A', rank: 50 } } });
    expect(cache()[7]).toEqual({ id: 7, name: 'A', rank: 50, seenAt: 1000 });
  });

  it('keeps the newest sighting and ignores a stale one', () => {
    fire({ galaxy: 1, system: 1, scannedAt: 1000, players: { 7: { id: 7, name: 'old' } } });
    fire({ galaxy: 1, system: 2, scannedAt: 2000, players: { 7: { id: 7, name: 'new' } } });
    expect(cache()[7].name).toBe('new');
    fire({ galaxy: 1, system: 3, scannedAt: 500, players: { 7: { id: 7, name: 'stale' } } });
    expect(cache()[7].name).toBe('new');
    expect(cache()[7].seenAt).toBe(2000);
  });

  it('accumulates distinct players across systems', () => {
    fire({ galaxy: 1, system: 1, scannedAt: 1000, players: { 7: { id: 7, name: 'A' } } });
    fire({ galaxy: 1, system: 2, scannedAt: 1000, players: { 9: { id: 9, name: 'B' } } });
    expect(Object.keys(cache()).sort()).toEqual(['7', '9']);
  });

  it('ignores events without a players map', () => {
    fire({ galaxy: 1, system: 1, scannedAt: 1000 });
    expect(cache()).toEqual({});
  });
});
