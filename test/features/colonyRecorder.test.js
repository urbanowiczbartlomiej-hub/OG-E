// @vitest-environment happy-dom
//
// Unit tests for the colony-recorder feature.
//
// The module reads three things from the page:
//   - `location.search` must contain `component=overview`,
//   - `#planetList .hightlightPlanet` gives us the current `cp`,
//   - `#diameterContentField` + `#positionContentField a` give size/coords.
// ... and writes a {@link ColonyEntry} to `historyStore` when the planet
// is fresh (`usedFields === 0`) and not already recorded.
//
// Tests use happy-dom (DOM + localStorage available), a shared
// `setupOverviewScene` helper to paint a canonical overview page, and
// reset both `historyStore` and the module-scope `installed` sentinel
// between cases via `_resetColonyRecorderForTest`. The hydration-race
// regression case mocks `chromeStore` to keep `initHistoryStore`'s load
// pending until the test resolves it manually.
//
// # Why every test awaits a microtask after install
//
// `installColonyRecorder` gates the first `tryCollect` on
// `whenHistoryHydrated()`. In tests that bypass `initHistoryStore` the
// gate is pre-resolved, so the deferred `tryCollect` fires on the
// next microtask rather than synchronously. A single
// `await Promise.resolve()` (or any awaited timer flush) is enough to
// drain that microtask before asserting on the store. See
// `state/history.js` and `features/colonyRecorder.js` for the
// underlying race rationale.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installColonyRecorder,
  _resetColonyRecorderForTest,
} from '../../src/features/colonyRecorder.js';
import {
  historyStore,
  initHistoryStore,
  disposeHistoryStore,
} from '../../src/state/history.js';

/** @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry */

/**
 * Paint the document to look like an OGame overview page. All knobs are
 * optional — the defaults describe a fresh colony at cp=12345, [4:30:8],
 * 163 max fields, 0 used. Individual tests override just the field they
 * care about.
 *
 * Writes `location.search` directly (happy-dom 14's `replaceState` does
 * NOT update `location.search` — this is the same workaround used by
 * `test/bridges/sendFleetHook.test.js`).
 *
 * @param {{ cp?: number, usedFields?: number, maxFields?: number, coords?: string, isOverview?: boolean }} [opts]
 * @returns {void}
 */
const setupOverviewScene = ({
  cp = 12345,
  usedFields = 0,
  maxFields = 163,
  coords = '[4:30:8]',
  isOverview = true,
} = {}) => {
  location.search = isOverview
    ? `?page=ingame&component=overview&cp=${cp}`
    : `?page=ingame&component=galaxy`;
  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet hightlightPlanet" id="planet-${cp}"></div>
    </div>
    <div id="diameterContentField">12345km (${usedFields}/${maxFields})</div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

beforeEach(() => {
  historyStore.set([]);
  document.body.innerHTML = '';
  _resetColonyRecorderForTest();
});

afterEach(() => {
  historyStore.set([]);
  _resetColonyRecorderForTest();
});

// ──────────────────────────────────────────────────────────────────
// Happy path + gating cases
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — synchronous path', () => {
  it('records a fresh colony when the overview DOM is populated', async () => {
    const before = Date.now();
    setupOverviewScene();
    installColonyRecorder();
    await Promise.resolve();

    const history = historyStore.get();
    expect(history).toHaveLength(1);

    const entry = /** @type {ColonyEntry} */ (history[0]);
    expect(entry.cp).toBe(12345);
    expect(entry.fields).toBe(163);
    expect(entry.coords).toBe('[4:30:8]');
    expect(entry.position).toBe(8);
    // Timestamp is recorded at observation time — assert a plausible
    // range rather than an exact value, to stay robust under clock drift.
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('does nothing when the page is not the overview', async () => {
    setupOverviewScene({ isOverview: false });
    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('skips planets that are already built (usedFields > 0)', async () => {
    // Any non-zero usedFields means the planet is not "fresh" — see the
    // module header on why we only record on the first overview visit.
    setupOverviewScene({ usedFields: 42 });
    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when no planet is highlighted', async () => {
    setupOverviewScene();
    // Strip the `.hightlightPlanet` marker — there is no "current"
    // planet to attribute the observation to.
    const active = document.querySelector('#planetList .hightlightPlanet');
    active?.classList.remove('hightlightPlanet');

    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when #positionContentField is missing', async () => {
    setupOverviewScene();
    document.getElementById('positionContentField')?.remove();

    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when #diameterContentField text is malformed', async () => {
    setupOverviewScene();
    const diameter = document.getElementById('diameterContentField');
    if (diameter) diameter.textContent = 'no numbers here';

    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when the coords anchor text is not a bracketed triple', async () => {
    setupOverviewScene();
    const anchor = document.querySelector('#positionContentField a');
    if (anchor) anchor.textContent = 'not coords';

    installColonyRecorder();
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);
  });

  it('parses position from arbitrary galaxy/system/position triples', async () => {
    // Slot 15 is the largest legal value; make sure multi-digit
    // positions parse correctly (the regex uses \d+, not [1-9]).
    setupOverviewScene({ coords: '[6:100:15]' });
    installColonyRecorder();
    await Promise.resolve();

    const entry = /** @type {ColonyEntry} */ (historyStore.get()[0]);
    expect(entry.position).toBe(15);
    expect(entry.coords).toBe('[6:100:15]');
  });
});

// ──────────────────────────────────────────────────────────────────
// Dedup + append semantics
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — dedup', () => {
  it('skips the write when an entry with the same cp already exists', async () => {
    // Pre-seed history with an entry for the cp we are about to visit.
    // The recorder must treat that as "already observed" and keep history
    // at length 1 — no duplicate row, and the original timestamp wins.
    const existing = /** @type {ColonyEntry} */ ({
      cp: 12345,
      fields: 163,
      coords: '[4:30:8]',
      position: 8,
      timestamp: 1,
    });
    historyStore.set([existing]);

    setupOverviewScene({ cp: 12345 });
    installColonyRecorder();
    await Promise.resolve();

    const history = historyStore.get();
    expect(history).toHaveLength(1);
    expect(history[0]).toBe(existing);
  });

  it('appends when the active cp is new, keeping prior entries intact', async () => {
    const prior = /** @type {ColonyEntry} */ ({
      cp: 11111,
      fields: 100,
      coords: '[1:1:1]',
      position: 1,
      timestamp: 1,
    });
    historyStore.set([prior]);

    setupOverviewScene({ cp: 22222 });
    installColonyRecorder();
    await Promise.resolve();

    const history = historyStore.get();
    expect(history).toHaveLength(2);
    // Insertion order preserved — prior entry first, new observation appended.
    expect(history[0]).toBe(prior);
    expect(history[1]?.cp).toBe(22222);
  });
});

// ──────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — idempotency', () => {
  it('a second install on the same page-load does not record again', async () => {
    setupOverviewScene();

    // First install schedules a deferred tryCollect through the
    // historyHydrated gate; the store is still empty at this point.
    const dispose1 = installColonyRecorder();

    // Repeat installs return the same dispose handle without scheduling
    // additional tryCollect calls. They short-circuit on the module-
    // scope `installed` sentinel before reaching the gate at all.
    const dispose2 = installColonyRecorder();
    const dispose3 = installColonyRecorder();

    expect(dispose2).toBe(dispose1);
    expect(dispose3).toBe(dispose1);

    // Flush the first install's deferred work; the dedup-by-cp gate in
    // tryCollect would also catch a second write if one had slipped in.
    await Promise.resolve();
    expect(historyStore.get()).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Deferred DOM — retry via waitFor
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — deferred DOM (waitFor retry)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves to null (no write) when the DOM never arrives within timeout', async () => {
    // Overview URL is set, but the page never renders its content nodes.
    // The waitFor polling should exhaust its 5000ms budget and leave
    // historyStore empty — the recorder silently gives up.
    location.search = '?page=ingame&component=overview&cp=12345';

    installColonyRecorder();

    // Push past the 5s timeout — waitFor resolves with null and the
    // `.then` calls tryCollect(), which no-ops because the DOM is empty.
    // `advanceTimersByTimeAsync` flushes microtasks as it goes, so the
    // hydrate-gate `.then` fires inside this advance too.
    await vi.advanceTimersByTimeAsync(5200);

    expect(historyStore.get()).toEqual([]);
  });

  it('records once the overview DOM appears mid-poll', async () => {
    // Start on the overview URL but with NO overview nodes yet. The
    // hydrate-gate fires first (tryCollect returns false because DOM
    // is empty), then waitFor starts polling. We then paint the scene
    // and advance timers enough to let the next poll see the element
    // and call tryCollect a second time.
    location.search = '?page=ingame&component=overview&cp=12345';

    installColonyRecorder();

    // Drain the hydrate-gate microtask so the first tryCollect runs
    // and (because the DOM is empty) schedules the waitFor poll.
    await Promise.resolve();
    expect(historyStore.get()).toEqual([]);

    // Now the overview nodes land in the document. The default
    // intervalMs is 200; advancing by 250ms guarantees one more poll
    // tick after the mutation.
    setupOverviewScene();
    await vi.advanceTimersByTimeAsync(250);

    const history = historyStore.get();
    expect(history).toHaveLength(1);
    expect(history[0]?.cp).toBe(12345);
  });
});

// ──────────────────────────────────────────────────────────────────
// Hydration race regression — see colonyRecorder.js module header.
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — hydration race regression', () => {
  // The full chromeStore surface is mocked here (not via vi.mock at
  // module scope — that would clobber the other describe blocks which
  // exercise historyStore directly without going through chromeStore).
  // We hand-roll the get/set fakes per test so we can hold the load
  // promise pending until the assertion point.

  /** @type {Promise<unknown>} */
  let pendingGet;
  /** @type {(value: unknown) => void} */
  let resolveGet;
  /** @type {import('vitest').Mock} */
  let setSpy;

  beforeEach(() => {
    pendingGet = new Promise((r) => { resolveGet = r; });
    setSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (/** @type {string} */ key, /** @type {(items: Record<string, unknown>) => void} */ cb) => {
            // Bridge the test-controlled promise into the
            // callback-shaped chrome.storage.local.get contract.
            void pendingGet.then((value) => {
              cb(value === undefined ? {} : { [key]: value });
            });
          },
          set: (/** @type {Record<string, unknown>} */ items, /** @type {(() => void) | undefined} */ cb) => {
            setSpy(items);
            cb?.();
          },
          remove: () => {},
        },
        onChanged: {
          addListener: () => {},
          removeListener: () => {},
        },
      },
    });
  });

  afterEach(() => {
    disposeHistoryStore();
    vi.unstubAllGlobals();
  });

  it('does NOT overwrite stored history with a single fresh entry when hydrate is in flight', async () => {
    // Simulates the Firefox failure mode: chrome.storage.local holds
    // two prior colonies, but DOMContentLoaded (and therefore
    // installColonyRecorder) runs before the get round-trip lands.
    // The fix must keep the first tryCollect waiting on
    // whenHistoryHydrated so the dedup read sees the real history,
    // not the empty initial.

    /** @type {ColonyEntry[]} */
    const stored = [
      { cp: 11111, fields: 100, coords: '[1:1:1]', position: 1, timestamp: 1 },
      { cp: 22222, fields: 150, coords: '[2:2:2]', position: 2, timestamp: 2 },
    ];

    initHistoryStore();
    setupOverviewScene({ cp: 33333, maxFields: 200, coords: '[3:3:3]' });
    installColonyRecorder();

    // Hydrate is still pending — no write must have escaped yet.
    // Letting microtasks drain proves the gate holds even when the
    // event loop is quiet.
    await Promise.resolve();
    await Promise.resolve();
    expect(setSpy).not.toHaveBeenCalled();
    expect(historyStore.get()).toEqual([]);

    // Land the hydrate. Persist's onHydrate resolves the gate, the
    // deferred tryCollect fires, the dedup check now sees both prior
    // entries, the new cp passes, and the append produces a 3-row
    // history — NOT a 1-row history that wiped the prior data.
    resolveGet(stored);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const finalHistory = historyStore.get();
    expect(finalHistory.map((e) => e.cp)).toEqual([11111, 22222, 33333]);

    // The save trace MUST reflect the full 3-row payload by the end —
    // anything shorter means a write-through fired while the store was
    // mid-race. We don't pin the exact call count (the hydrate echo
    // also fires a save with the 2-row stored snapshot) but the last
    // observed payload must include the new colony. We also don't pin
    // the exact storage KEY — under happy-dom `location.host` is
    // `'localhost'` and the per-universe namespace puts the data under
    // `'localhost:oge_colonyHistory'` here; under a real Gameforge tab
    // it would be `'s163-pl:oge_colonyHistory'`. Reading the single
    // value out of the payload sidesteps that.
    expect(setSpy).toHaveBeenCalled();
    const lastCall = setSpy.mock.calls[setSpy.mock.calls.length - 1];
    /** @type {Record<string, ColonyEntry[]>} */
    const lastPayload = lastCall[0];
    const values = Object.values(lastPayload);
    expect(values).toHaveLength(1);
    expect(values[0].map((e) => e.cp)).toEqual([11111, 22222, 33333]);
  });

  it('skips the write when the in-flight hydrate already contains this cp', async () => {
    // Stored copy already has cp=12345. The recorder must NOT
    // double-add it after hydrate lands — the dedup gate has to see
    // the real, hydrated history rather than the empty initial.
    /** @type {ColonyEntry[]} */
    const stored = [
      { cp: 12345, fields: 163, coords: '[4:30:8]', position: 8, timestamp: 1 },
    ];

    initHistoryStore();
    setupOverviewScene({ cp: 12345 });
    installColonyRecorder();

    await Promise.resolve();
    await Promise.resolve();

    resolveGet(stored);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Length stays at 1 — the prior observation wins, original
    // timestamp preserved.
    const finalHistory = historyStore.get();
    expect(finalHistory).toHaveLength(1);
    expect(finalHistory[0]?.timestamp).toBe(1);
  });
});
