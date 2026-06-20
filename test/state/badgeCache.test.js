// @vitest-environment happy-dom
//
// Unit tests for state/badgeCache — the optimistic planet-marker cache, a plain
// key-owner over safeLS with a versioned envelope `{version:2, bodies}`.
//
// happy-dom provides a real localStorage; we wipe it between cases and drive the
// public read/write/clear surface against the wire (matching settings.test.js).
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BADGE_CACHE_KEY,
  readBadgeCache,
  writeBadgeCache,
  clearBadgeCache,
} from '../../src/state/badgeCache.js';

beforeEach(() => {
  localStorage.clear();
});

describe('badgeCache', () => {
  it('exposes the canonical key', () => {
    expect(BADGE_CACHE_KEY).toBe('oge-badge-cache');
  });

  it('round-trips a per-body category-id map', () => {
    /** @type {Record<string, string[]>} */
    const bodies = {
      'p:1:2:3': ['attack', 'transport'],
      'm:4:5:6': ['expedition'],
    };
    writeBadgeCache(bodies);
    expect(readBadgeCache()).toEqual(bodies);
  });

  it('writes a version:2 envelope', () => {
    writeBadgeCache({ 'p:1:2:3': ['attack'] });
    const raw = JSON.parse(/** @type {string} */ (localStorage.getItem(BADGE_CACHE_KEY)));
    expect(raw.version).toBe(2);
    expect(raw.bodies).toEqual({ 'p:1:2:3': ['attack'] });
  });

  it('returns null when the key is absent', () => {
    expect(readBadgeCache()).toBeNull();
  });

  it('returns null when the stored value is not an object', () => {
    localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify('nope'));
    expect(readBadgeCache()).toBeNull();
  });

  it('returns null on a version mismatch (stale schema)', () => {
    localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify({ version: 1, bodies: { a: ['x'] } }));
    expect(readBadgeCache()).toBeNull();
  });

  it('returns null when bodies is missing', () => {
    localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify({ version: 2 }));
    expect(readBadgeCache()).toBeNull();
  });

  it('returns null when bodies is not an object', () => {
    localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify({ version: 2, bodies: 'x' }));
    expect(readBadgeCache()).toBeNull();
  });

  it('clearBadgeCache removes the key (subsequent read → null)', () => {
    writeBadgeCache({ a: ['x'] });
    expect(readBadgeCache()).not.toBeNull();
    clearBadgeCache();
    expect(localStorage.getItem(BADGE_CACHE_KEY)).toBeNull();
    expect(readBadgeCache()).toBeNull();
  });
});
