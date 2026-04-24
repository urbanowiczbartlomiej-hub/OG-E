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
// between cases via `_resetColonyRecorderForTest`. A single deferred-DOM
// case exercises the `waitFor` retry path with vitest fake timers.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installColonyRecorder,
  _resetColonyRecorderForTest,
} from '../../src/features/colonyRecorder.js';
import { historyStore } from '../../src/state/history.js';

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
  it('records a fresh colony when the overview DOM is populated', () => {
    const before = Date.now();
    setupOverviewScene();
    installColonyRecorder();

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

  it('does nothing when the page is not the overview', () => {
    setupOverviewScene({ isOverview: false });
    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('skips planets that are already built (usedFields > 0)', () => {
    // Any non-zero usedFields means the planet is not "fresh" — see the
    // module header on why we only record on the first overview visit.
    setupOverviewScene({ usedFields: 42 });
    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when no planet is highlighted', () => {
    setupOverviewScene();
    // Strip the `.hightlightPlanet` marker — there is no "current"
    // planet to attribute the observation to.
    const active = document.querySelector('#planetList .hightlightPlanet');
    active?.classList.remove('hightlightPlanet');

    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when #positionContentField is missing', () => {
    setupOverviewScene();
    document.getElementById('positionContentField')?.remove();

    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when #diameterContentField text is malformed', () => {
    setupOverviewScene();
    const diameter = document.getElementById('diameterContentField');
    if (diameter) diameter.textContent = 'no numbers here';

    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('does nothing when the coords anchor text is not a bracketed triple', () => {
    setupOverviewScene();
    const anchor = document.querySelector('#positionContentField a');
    if (anchor) anchor.textContent = 'not coords';

    installColonyRecorder();
    expect(historyStore.get()).toEqual([]);
  });

  it('parses position from arbitrary galaxy/system/position triples', () => {
    // Slot 15 is the largest legal value; make sure multi-digit
    // positions parse correctly (the regex uses \d+, not [1-9]).
    setupOverviewScene({ coords: '[6:100:15]' });
    installColonyRecorder();

    const entry = /** @type {ColonyEntry} */ (historyStore.get()[0]);
    expect(entry.position).toBe(15);
    expect(entry.coords).toBe('[6:100:15]');
  });
});

// ──────────────────────────────────────────────────────────────────
// Dedup + append semantics
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — dedup', () => {
  it('skips the write when an entry with the same cp already exists', () => {
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

    const history = historyStore.get();
    expect(history).toHaveLength(1);
    expect(history[0]).toBe(existing);
  });

  it('appends when the active cp is new, keeping prior entries intact', () => {
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
  it('a second install on the same page-load does not record again', () => {
    setupOverviewScene();

    const dispose1 = installColonyRecorder();
    expect(historyStore.get()).toHaveLength(1);

    // Repeat installs return the same dispose handle without triggering
    // additional tryCollect calls. Even if they did, the dedup-by-cp
    // gate in tryCollect would catch the second write.
    const dispose2 = installColonyRecorder();
    const dispose3 = installColonyRecorder();

    expect(dispose2).toBe(dispose1);
    expect(dispose3).toBe(dispose1);
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
    await vi.advanceTimersByTimeAsync(5200);

    expect(historyStore.get()).toEqual([]);
  });

  it('records once the overview DOM appears mid-poll', async () => {
    // Start on the overview URL but with NO overview nodes yet. The
    // first sync tryCollect returns false; waitFor starts polling.
    // We then paint the scene before the timeout and advance timers
    // enough to let the next poll see the element and call tryCollect.
    location.search = '?page=ingame&component=overview&cp=12345';

    installColonyRecorder();

    // Sanity: nothing recorded yet — the DOM is still empty.
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
