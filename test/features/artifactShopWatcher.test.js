// @vitest-environment happy-dom
//
// Tests for the Artifact-Shop watcher feature.
//
// Coverage:
//   1. allTiersClaimed — pure DOM helper (tier count + tierClaimed logic).
//   2. parseEventRemainingSeconds — regex over inline CountdownTimer call.
//   3. artifactShopDoneUntil — end-time vs. fallback-window math.
//   4. installArtifactShopWatcher — no-op on non-artifactshop pages.
//   5. Stamps the event end time when every rank is claimed.
//   6. Falls back to the fixed window when no countdown is present.
//   7. Does not stamp when any rank is unclaimed.
//   8. Does not re-stamp while a window is still active (cur > now).
//   9. Dispatches `oge:dailyStateChanged` after stamping.
//  10. MutationObserver picks up a late completion.
//  11. Dispose clears the safety poll.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  allTiersClaimed,
  parseEventRemainingSeconds,
  artifactShopDoneUntil,
  installArtifactShopWatcher,
  _resetArtifactShopWatcherForTest,
} from '../../src/features/artifactShopWatcher.js';
import { ARTIFACT_SHOP_DONE_KEY } from '../../src/state/dailyActions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_MS = 7 * DAY_MS;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a `<tier-scrollbar>` with one `<tier>` per entry. `true` ⇒ claimed
 * (gets the `tierClaimed` class), `false` ⇒ in-progress / locked.
 *
 * @param {boolean[]} claimedFlags
 * @returns {HTMLElement}
 */
const buildScrollbar = (claimedFlags) => {
  const bar = document.createElement('tier-scrollbar');
  claimedFlags.forEach((claimed, i) => {
    const tier = document.createElement('tier');
    tier.setAttribute('data-tier-id', String(i + 1));
    if (claimed) tier.className = 'tierClaimed';
    else tier.className = i === claimedFlags.length - 1 ? '' : 'tierInProgress';
    bar.appendChild(tier);
  });
  return bar;
};

/** Append the inline countdown script OGame renders on the Artifact-Shop page. */
const addCountdownScript = (/** @type {number} */ seconds) => {
  const script = document.createElement('script');
  script.textContent = `new CountdownTimer('eventTime', ${seconds}, 'https://x/', null, true, 3)`;
  document.body.appendChild(script);
};

/** Simulate the Artifact-Shop page URL. */
const setArtifactShopPage = () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { search: '?page=ingame&component=artifactshop', host: 's163-pl.ogame.gameforge.com' },
  });
};

/** Simulate a non-artifactshop page. */
const setOtherPage = () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { search: '?page=ingame&component=overview', host: 's163-pl.ogame.gameforge.com' },
  });
};

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  // Stub the OGame timer class so an injected <script>, if happy-dom executes
  // it on append, is a harmless no-op rather than a ReferenceError.
  /** @type {any} */ (globalThis).CountdownTimer = function () {};
  vi.useFakeTimers();
});

afterEach(() => {
  _resetArtifactShopWatcherForTest();
  document.body.innerHTML = '';
  delete (/** @type {any} */ (globalThis).CountdownTimer);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── pure helpers ───────────────────────────────────────────────────────────────

describe('allTiersClaimed', () => {
  it('returns false when the scrollbar is absent / empty', () => {
    expect(allTiersClaimed(document)).toBe(false);
    document.body.appendChild(buildScrollbar([]));
    expect(allTiersClaimed(document)).toBe(false);
  });

  it('returns false when any rank is not claimed', () => {
    document.body.appendChild(buildScrollbar([true, true, true, true, true, true, false, false]));
    expect(allTiersClaimed(document)).toBe(false);
  });

  it('returns true when every rank carries tierClaimed', () => {
    document.body.appendChild(buildScrollbar([true, true, true, true, true, true, true, true]));
    expect(allTiersClaimed(document)).toBe(true);
  });
});

describe('parseEventRemainingSeconds', () => {
  it('extracts the integer from a CountdownTimer call', () => {
    expect(
      parseEventRemainingSeconds("new CountdownTimer('eventTime', 561941, 'url', null, true, 3)"),
    ).toBe(561941);
  });

  it('tolerates double quotes and extra whitespace', () => {
    expect(parseEventRemainingSeconds('CountdownTimer( "eventTime" ,  42 ,')).toBe(42);
  });

  it('returns 0 when no eventTime timer is present', () => {
    expect(parseEventRemainingSeconds("new CountdownTimer('otherTimer', 99)")).toBe(0);
    expect(parseEventRemainingSeconds('nothing here')).toBe(0);
  });
});

describe('artifactShopDoneUntil', () => {
  it('returns now + remaining when the countdown is known', () => {
    expect(artifactShopDoneUntil(1_000_000, 3600)).toBe(1_000_000 + 3600 * 1000);
  });

  it('falls back to the fixed window when remaining is 0', () => {
    expect(artifactShopDoneUntil(1_000_000, 0)).toBe(1_000_000 + FALLBACK_MS);
  });
});

// ── install on non-artifactshop page ──────────────────────────────────────────

describe('installArtifactShopWatcher — not on the artifact-shop page', () => {
  it('returns a no-op dispose and does not stamp localStorage', () => {
    setOtherPage();
    document.body.appendChild(buildScrollbar([true, true]));
    const dispose = installArtifactShopWatcher();
    expect(typeof dispose).toBe('function');
    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBeNull();
    dispose(); // must not throw
  });
});

// ── install on the artifact-shop page ─────────────────────────────────────────

describe('installArtifactShopWatcher — on the artifact-shop page', () => {
  const NOW = new Date('2026-06-17T12:00:00');

  beforeEach(() => {
    setArtifactShopPage();
    vi.setSystemTime(NOW);
  });

  it('stamps the event end time when every rank is claimed', () => {
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));
    addCountdownScript(3600);

    installArtifactShopWatcher();

    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBe(String(NOW.getTime() + 3600 * 1000));
  });

  it('falls back to the fixed window when no countdown script is present', () => {
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));

    installArtifactShopWatcher();

    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBe(String(NOW.getTime() + FALLBACK_MS));
  });

  it('does not stamp when any rank is unclaimed', () => {
    document.body.appendChild(buildScrollbar([true, true, true, true, true, true, false, false]));

    installArtifactShopWatcher();

    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBeNull();
  });

  it('does not re-stamp while the stored window is still in the future', () => {
    localStorage.setItem(ARTIFACT_SHOP_DONE_KEY, String(NOW.getTime() + DAY_MS));
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));
    addCountdownScript(3600);

    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    installArtifactShopWatcher();

    expect(setSpy).not.toHaveBeenCalledWith(ARTIFACT_SHOP_DONE_KEY, expect.anything());
  });

  it('re-stamps when the stored window has already expired', () => {
    localStorage.setItem(ARTIFACT_SHOP_DONE_KEY, String(NOW.getTime() - DAY_MS));
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));
    addCountdownScript(3600);

    installArtifactShopWatcher();

    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBe(String(NOW.getTime() + 3600 * 1000));
  });

  it('dispatches oge:dailyStateChanged after stamping', () => {
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));

    let fired = false;
    document.addEventListener('oge:dailyStateChanged', () => { fired = true; });

    installArtifactShopWatcher();

    expect(fired).toBe(true);
  });

  it('does NOT dispatch when a window is already active', () => {
    localStorage.setItem(ARTIFACT_SHOP_DONE_KEY, String(NOW.getTime() + DAY_MS));
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));

    let fired = false;
    document.addEventListener('oge:dailyStateChanged', () => { fired = true; });

    installArtifactShopWatcher();

    expect(fired).toBe(false);
  });

  it('picks up completion via MutationObserver when the component re-renders fully claimed', async () => {
    document.body.appendChild(buildScrollbar([true, true, true, true, true, true, true, false]));

    installArtifactShopWatcher();
    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBeNull();

    // OGame re-renders the rank list (a childList mutation) once the final
    // rank is claimed — swap in an all-claimed scrollbar.
    document.querySelector('tier-scrollbar')?.remove();
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));

    // Advance past the 200 ms debounce (but not into the 3 s poll, which
    // runAllTimersAsync would loop on forever).
    await vi.advanceTimersByTimeAsync(300);

    // Stamped during the debounce tick, so the fallback is relative to the
    // (slightly advanced) clock — assert the window rather than an exact ms.
    const stamped = Number(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY));
    expect(stamped).toBeGreaterThanOrEqual(NOW.getTime() + FALLBACK_MS);
    expect(stamped).toBeLessThanOrEqual(NOW.getTime() + FALLBACK_MS + 1000);
  });

  it('is idempotent — second install returns the same dispose', () => {
    document.body.appendChild(buildScrollbar(Array(8).fill(true)));
    const d1 = installArtifactShopWatcher();
    const d2 = installArtifactShopWatcher();
    expect(d1).toBe(d2);
  });

  it('dispose clears the safety poll (no stamps after dispose)', () => {
    const bar = buildScrollbar([true, true, true, true, true, true, true, false]);
    document.body.appendChild(bar);

    const dispose = installArtifactShopWatcher();
    dispose();

    // Claim the last rank AFTER dispose.
    bar.lastElementChild?.classList.add('tierClaimed');
    vi.advanceTimersByTime(10_000);

    expect(localStorage.getItem(ARTIFACT_SHOP_DONE_KEY)).toBeNull();
  });
});
