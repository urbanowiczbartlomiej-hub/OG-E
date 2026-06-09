// @vitest-environment happy-dom
//
// Tests for the Rewarding-watcher feature.
//
// Coverage:
//   1. allRewardsClaimed — pure DOM helper (item count + badge logic).
//   2. installRewardingWatcher — no-op on non-rewarding pages.
//   3. Install on the rewarding page: stamps done-day when all claimed.
//   4. Does not stamp when any item is unclaimed.
//   5. Does not re-stamp if the stored day already matches today.
//   6. Dispatches `oge:dailyStateChanged` after stamping.
//   7. MutationObserver picks up late DOM changes.
//   8. Dispose clears the observer / poll.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  allRewardsClaimed,
  installRewardingWatcher,
  _resetRewardingWatcherForTest,
} from '../../src/features/rewardingWatcher.js';
import { REWARDING_DONE_KEY } from '../../src/state/dailyActions.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a `.rewardlist-item` element, optionally with a `.reward-claimed-text` child. */
const makeItem = (claimed = false) => {
  const div = document.createElement('div');
  div.className = 'rewardlist-item';
  if (claimed) {
    const badge = document.createElement('div');
    badge.className = 'reward-claimed-text';
    div.appendChild(badge);
  }
  return div;
};

/** Build a minimal `#rewardings` container with the given items. */
const buildContainer = (/** @type {HTMLElement[]} */ ...items) => {
  const root = document.createElement('div');
  root.id = 'rewardings';
  items.forEach((item) => root.appendChild(item));
  return root;
};

/** Simulate the rewarding page URL (happy-dom allows location overrides). */
const setRewardingPage = () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { search: '?page=ingame&component=rewarding', host: 's163-pl.ogame.gameforge.com' },
  });
};

/** Simulate a non-rewarding page. */
const setOtherPage = () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { search: '?page=ingame&component=overview', host: 's163-pl.ogame.gameforge.com' },
  });
};

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  _resetRewardingWatcherForTest();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── pure helper ───────────────────────────────────────────────────────────────

describe('allRewardsClaimed', () => {
  it('returns false for an empty container', () => {
    const c = buildContainer();
    expect(allRewardsClaimed(c)).toBe(false);
  });

  it('returns false when any item lacks the badge', () => {
    const c = buildContainer(makeItem(true), makeItem(false), makeItem(true));
    expect(allRewardsClaimed(c)).toBe(false);
  });

  it('returns true when every item has the badge', () => {
    const c = buildContainer(makeItem(true), makeItem(true));
    expect(allRewardsClaimed(c)).toBe(true);
  });

  it('returns true with a single claimed item', () => {
    expect(allRewardsClaimed(buildContainer(makeItem(true)))).toBe(true);
  });
});

// ── install on non-rewarding page ────────────────────────────────────────────

describe('installRewardingWatcher — not on rewarding page', () => {
  it('returns a no-op dispose and does not stamp localStorage', () => {
    setOtherPage();
    const dispose = installRewardingWatcher();
    expect(typeof dispose).toBe('function');
    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBeNull();
    dispose(); // must not throw
  });
});

// ── install on rewarding page ─────────────────────────────────────────────────

describe('installRewardingWatcher — on rewarding page', () => {
  beforeEach(() => {
    setRewardingPage();
    // Fix "now" to 2026-06-09 at 15:00 → game day = 2026-06-09
    vi.setSystemTime(new Date('2026-06-09T15:00:00'));
  });

  it('stamps done-day immediately when all items are already claimed', () => {
    const container = buildContainer(makeItem(true), makeItem(true));
    document.body.appendChild(container);

    installRewardingWatcher();

    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBe('2026-06-09');
  });

  it('does not stamp when any item is unclaimed', () => {
    const container = buildContainer(makeItem(true), makeItem(false));
    document.body.appendChild(container);

    installRewardingWatcher();

    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBeNull();
  });

  it('does not re-stamp when the stored day already matches today', () => {
    localStorage.setItem(REWARDING_DONE_KEY, '2026-06-09');
    const container = buildContainer(makeItem(true));
    document.body.appendChild(container);

    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    installRewardingWatcher();

    expect(setSpy).not.toHaveBeenCalledWith(REWARDING_DONE_KEY, expect.anything());
  });

  it('dispatches oge:dailyStateChanged after stamping', () => {
    const container = buildContainer(makeItem(true));
    document.body.appendChild(container);

    let fired = false;
    document.addEventListener('oge:dailyStateChanged', () => { fired = true; });

    installRewardingWatcher();

    expect(fired).toBe(true);
  });

  it('does NOT dispatch oge:dailyStateChanged when already stamped today', () => {
    localStorage.setItem(REWARDING_DONE_KEY, '2026-06-09');
    const container = buildContainer(makeItem(true));
    document.body.appendChild(container);

    let fired = false;
    document.addEventListener('oge:dailyStateChanged', () => { fired = true; });

    installRewardingWatcher();

    expect(fired).toBe(false);
  });

  it('picks up completion via MutationObserver when DOM changes later', async () => {
    // Container starts with one unclaimed item.
    const container = buildContainer(makeItem(false));
    document.body.appendChild(container);

    installRewardingWatcher();
    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBeNull();

    // Claim the item.
    const badge = document.createElement('div');
    badge.className = 'reward-claimed-text';
    container.querySelector('.rewardlist-item')?.appendChild(badge);

    // Advance past the 200 ms debounce (without running the 3 s safety poll
    // into an infinite loop, which `runAllTimersAsync` would trigger).
    await vi.advanceTimersByTimeAsync(300);

    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBe('2026-06-09');
  });

  it('is idempotent — second install returns same dispose', () => {
    const container = buildContainer(makeItem(true));
    document.body.appendChild(container);

    const d1 = installRewardingWatcher();
    const d2 = installRewardingWatcher();
    expect(d1).toBe(d2);
  });

  it('dispose clears the safety poll (no stamps after dispose)', () => {
    const container = buildContainer(makeItem(false));
    document.body.appendChild(container);

    const dispose = installRewardingWatcher();
    dispose();

    // Claim the item AFTER dispose.
    const badge = document.createElement('div');
    badge.className = 'reward-claimed-text';
    container.querySelector('.rewardlist-item')?.appendChild(badge);

    vi.advanceTimersByTime(10_000);

    expect(localStorage.getItem(REWARDING_DONE_KEY)).toBeNull();
  });
});
