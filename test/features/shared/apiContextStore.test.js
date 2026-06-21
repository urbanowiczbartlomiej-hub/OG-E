// @ts-check

// Unit tests for features/shared/apiContextStore — the in-memory handoff that
// lets the colonize picker read the API-context feature's built occupancy index
// without a forbidden feature→feature import. Plain set/get with a test reset;
// no DOM/storage needed (node env).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setApiContext,
  getApiContext,
  _resetApiContextStoreForTest,
} from '../../../src/features/shared/apiContextStore.js';

/** A minimal handoff payload (typed loosely — only identity is asserted). */
const handoff = () =>
  /** @type {any} */ ({
    index: { occupied: new Map([['1:1:1', { player: 7 }]]), ownColonies: new Set(), occupiedByPosition: {} },
    server: { galaxies: 9, systems: 499 },
  });

beforeEach(() => {
  _resetApiContextStoreForTest();
});

describe('apiContextStore', () => {
  it('returns null before anything is published', () => {
    expect(getApiContext()).toBeNull();
  });

  it('round-trips the published context by reference', () => {
    const ctx = handoff();
    setApiContext(ctx);
    expect(getApiContext()).toBe(ctx);
  });

  it('overwrites with the latest publish', () => {
    const a = handoff();
    const b = handoff();
    setApiContext(a);
    setApiContext(b);
    expect(getApiContext()).toBe(b);
  });

  it('setApiContext(null) clears the held context', () => {
    setApiContext(handoff());
    setApiContext(null);
    expect(getApiContext()).toBeNull();
  });

  it('_resetApiContextStoreForTest clears the held context', () => {
    setApiContext(handoff());
    _resetApiContextStoreForTest();
    expect(getApiContext()).toBeNull();
  });
});
