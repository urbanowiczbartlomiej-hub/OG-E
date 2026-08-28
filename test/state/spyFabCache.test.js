// @vitest-environment happy-dom
//
// Unit tests for state/spyFabCache — the Spyglass-FAB optimistic mount cache,
// a plain key-owner over safeLS holding the last reconciled "watch-list has
// players" verdict as a bare '1' flag.
//
// happy-dom provides a real localStorage; we wipe it between cases and drive
// the public read/write surface against the wire (matching badgeCache.test.js).
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SPY_FAB_SHOWN_KEY,
  readSpyFabShown,
  writeSpyFabShown,
  SPY_FAB_HOME_KEY,
  readSpyHomeUnread,
  writeSpyHomeUnread,
} from '../../src/state/spyFabCache.js';

beforeEach(() => {
  localStorage.clear();
});

describe('spyFabCache', () => {
  it('exposes the canonical key', () => {
    expect(SPY_FAB_SHOWN_KEY).toBe('oge-spy-fab-shown');
  });

  it('defaults to false when the key is absent', () => {
    expect(readSpyFabShown()).toBe(false);
  });

  it('round-trips shown=true as the "1" flag', () => {
    writeSpyFabShown(true);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBe('1');
    expect(readSpyFabShown()).toBe(true);
  });

  it('writeSpyFabShown(false) removes the key rather than storing a falsy marker', () => {
    writeSpyFabShown(true);
    writeSpyFabShown(false);
    expect(localStorage.getItem(SPY_FAB_SHOWN_KEY)).toBeNull();
    expect(readSpyFabShown()).toBe(false);
  });

  it('treats any non-"1" stored value as not shown', () => {
    localStorage.setItem(SPY_FAB_SHOWN_KEY, 'true');
    expect(readSpyFabShown()).toBe(false);
    localStorage.setItem(SPY_FAB_SHOWN_KEY, '0');
    expect(readSpyFabShown()).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// home-watch nudge mirror
// ──────────────────────────────────────────────────────────────────

describe('spyFabCache — home-watch nudge mirror', () => {
  it('exposes the canonical key', () => {
    expect(SPY_FAB_HOME_KEY).toBe('oge-spy-fab-home');
  });

  it('defaults to 0 when the key is absent', () => {
    expect(readSpyHomeUnread()).toBe(0);
  });

  it('round-trips a positive count', () => {
    writeSpyHomeUnread(3);
    expect(localStorage.getItem(SPY_FAB_HOME_KEY)).toBe('3');
    expect(readSpyHomeUnread()).toBe(3);
  });

  it('removes the key on 0 rather than storing a falsy marker', () => {
    writeSpyHomeUnread(3);
    writeSpyHomeUnread(0);
    expect(localStorage.getItem(SPY_FAB_HOME_KEY)).toBeNull();
    expect(readSpyHomeUnread()).toBe(0);
  });

  it('reads a garbage or negative value as nothing unread', () => {
    localStorage.setItem(SPY_FAB_HOME_KEY, 'lots');
    expect(readSpyHomeUnread()).toBe(0);
    localStorage.setItem(SPY_FAB_HOME_KEY, '-2');
    expect(readSpyHomeUnread()).toBe(0);
  });

  it('is independent of the mount flag — either can be set without the other', () => {
    writeSpyHomeUnread(1);
    expect(readSpyFabShown()).toBe(false);
    writeSpyFabShown(true);
    writeSpyHomeUnread(0);
    expect(readSpyFabShown()).toBe(true);
  });
});
