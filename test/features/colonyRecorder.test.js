// @vitest-environment happy-dom
//
// Unit tests for the colony-recorder feature.
//
// The module reads ONE thing from the page: `#planetList`'s planet rows, via
// the shared `features/shared/planetRows.js` projection (each row's
// `data-tooltip-title` carries its `(used/max)` field pair). It writes a
// {@link ColonyEntry} to `historyStore` for EVERY row that is fresh
// (`used === 0`) and not already recorded.
//
// That is the behaviour these tests exist to pin. The recorder used to read
// `#diameterContentField` on `component=overview`, which exposes the pair for
// the ACTIVE planet only — so an observation was lost unless the player
// personally opened each fresh colony's overview before building on it.
// Colonising three slots in one go made that likely rather than rare. Hence
// the cases below about recording planets you are NOT standing on, recording
// several in one pass, and recording off the overview page entirely.
//
// Tests use happy-dom (DOM + localStorage available), a shared
// `setupSidebarScene` helper to paint a canonical planet sidebar, and
// reset both `historyStore` and the module-scope `installed` sentinel
// between cases via `_resetColonyRecorderForTest`. The hydration-race
// regression case mocks `chromeStore` to keep `initHistoryStore`'s load
// pending until the test resolves it manually.
//
// # Why every test drains microtasks after install
//
// `installColonyRecorder` fires `tryCollect` immediately, but the collect is
// async and clears several gates before it can write: the fresh-planet DOM
// filter, an async read of the cp index (`state/historyCpIndex` — the small key
// that spares the content script from hydrating the whole history on every
// page-load), and only then `whenHistoryHydrated`; the append also awaits
// `whenColonizeDecisionsHydrated`. Each is a separate promise hop, so a single
// `await Promise.resolve()` lands mid-chain and the store still reads empty —
// hence `flushMicrotasks()`. See `state/history.js` and
// `features/colonyRecorder.js` for the underlying race rationale.
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
import { HISTORY_CP_INDEX_KEY_BASE } from '../../src/state/historyCpIndex.js';
import { encodeCpRanges, cpRangesHas } from '../../src/domain/cpRanges.js';

/** @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry */

/**
 * Drain the microtask queue.
 *
 * Do NOT shave this back to a single `await Promise.resolve()`. `tryCollect`
 * clears three staged gates before it can write — the fresh-planet DOM filter,
 * an async read of the cp index (`state/historyCpIndex`), then
 * `whenHistoryHydrated` — and the append additionally awaits
 * `whenColonizeDecisionsHydrated`. Each is its own promise hop, so one tick
 * lands mid-chain and the store still looks empty. The count is deliberately
 * generous: these are microtasks, so over-draining costs nothing, while
 * under-draining produces a passing-looking assertion on an unfinished write.
 *
 * @param {number} [ticks]
 * @returns {Promise<void>}
 */
const flushMicrotasks = async (ticks = 16) => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

/** @typedef {{ cp?: number, usedFields?: number, maxFields?: number, coords?: string, name?: string, active?: boolean, moon?: boolean, tooltip?: string | null }} PlanetSpec */

/**
 * Render one `#planetList` row the way OGame does: the field pair lives in
 * the link's `data-tooltip-title`, entity-decoded (which is what
 * `getAttribute` hands back in the browser too).
 *
 * @param {PlanetSpec} spec
 * @returns {string}
 */
const planetRow = ({
  cp = 12345,
  usedFields = 0,
  maxFields = 163,
  coords = '[4:30:8]',
  name = 'Kolonia',
  active = false,
  moon = false,
  tooltip,
} = {}) => {
  const tip = tooltip === undefined
    ? `<b>Kolonia ${coords}</b><br/>Forma życia: Mechy<br/>16.494km (${usedFields}/${maxFields})<br/>od -165 °C do -125 °C`
    : tooltip;
  const tipAttr = tip === null ? '' : ` data-tooltip-title="${tip.replace(/"/g, '&quot;')}"`;
  // Moons carry a `moon-` id, which is exactly how the shared projection
  // excludes them — a moon's field count is lunar-base capacity, a different
  // quantity that must never enter a planet-field statistic.
  const id = moon ? `moon-${cp}` : `planet-${cp}`;
  return `<div class="smallplanet${active ? ' hightlightPlanet' : ''}" id="${id}">
      <a class="planetlink"${tipAttr}><span class="planet-name">${name}</span></a>
    </div>`;
};

/**
 * Paint the document to look like any ingame page's planet sidebar. All knobs
 * are optional — the defaults describe ONE fresh colony at cp=12345, [4:30:8],
 * 163 max fields, 0 used. Pass `planets` for the multi-planet cases.
 *
 * `page` writes `location.search` directly (happy-dom 14's `replaceState`
 * does NOT update `location.search` — same workaround as
 * `test/bridges/sendFleetHook.test.js`). The recorder no longer gates on the
 * page, and one of the tests below proves it.
 *
 * @param {PlanetSpec & { planets?: PlanetSpec[], page?: string }} [opts]
 * @returns {void}
 */
const setupSidebarScene = ({ planets, page = 'overview', ...one } = {}) => {
  location.search = `?page=ingame&component=${page}`;
  const rows = (planets ?? [{ active: true, ...one }]).map(planetRow).join('');
  document.body.innerHTML = `<div id="planetList">${rows}</div>`;
};

beforeEach(() => {
  historyStore.set([]);
  document.body.innerHTML = '';
  _resetColonyRecorderForTest();
});

afterEach(() => {
  // Unwire persistence between EVERY case, not just in the hydration-race
  // block. `tryCollect` calls `initHistoryStore()` itself now (it hydrates the
  // history lazily, only when the cp index reports a genuinely new colony), so
  // any case that records a colony leaves the store wired. `initHistoryStore`
  // is idempotent and returns EARLY when it is already wired — which means it
  // would not install a fresh pending hydrate promise for the next case, and
  // `whenHistoryHydrated()` would hand that case an already-resolved gate. The
  // race regression below then silently stops testing the race: its dedup read
  // sees the empty initial store instead of waiting for the stored history.
  // Disposing here keeps each case starting from "no persistence wired".
  disposeHistoryStore();
  historyStore.set([]);
  _resetColonyRecorderForTest();
});

// ──────────────────────────────────────────────────────────────────
// Happy path + gating cases
// ──────────────────────────────────────────────────────────────────

describe('installColonyRecorder — synchronous path', () => {
  it('records a fresh colony when the sidebar is populated', async () => {
    const before = Date.now();
    setupSidebarScene();
    installColonyRecorder();
    await flushMicrotasks();

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

  it('records off the overview page too — any ingame page renders the sidebar', async () => {
    // The whole point of reading the sidebar: the observation no longer
    // depends on the player opening this colony's overview.
    setupSidebarScene({ page: 'galaxy' });
    installColonyRecorder();
    await flushMicrotasks();
    expect(historyStore.get().map((e) => e.cp)).toEqual([12345]);
  });

  it('records a fresh colony the player is NOT standing on', async () => {
    // No `.hightlightPlanet` anywhere: the active planet is irrelevant now.
    setupSidebarScene({ planets: [{ cp: 777, coords: '[7:7:7]', maxFields: 190 }] });
    installColonyRecorder();
    await flushMicrotasks();

    const entry = /** @type {ColonyEntry} */ (historyStore.get()[0]);
    expect(entry.cp).toBe(777);
    expect(entry.fields).toBe(190);
  });

  it('records EVERY fresh colony in one pass', async () => {
    // The multi-colony case the sidebar read exists for: colonise three slots
    // in one go and all three land, rather than whichever one got an overview
    // visit before its first building.
    setupSidebarScene({
      planets: [
        { cp: 1, coords: '[1:1:1]', maxFields: 100 },
        { cp: 2, coords: '[1:1:2]', maxFields: 150 },
        { cp: 3, coords: '[1:1:3]', maxFields: 200 },
      ],
    });
    installColonyRecorder();
    await flushMicrotasks();

    expect(historyStore.get().map((e) => [e.cp, e.fields]))
      .toEqual([[1, 100], [2, 150], [3, 200]]);
  });

  it('skips planets that are already built (used > 0) but keeps fresh siblings', async () => {
    // `max` is NOT fixed for a planet's lifetime (Terraformer and lifeform
    // bonuses raise it), so a developed planet's number would bias the
    // histogram upward. `used === 0` is the proxy for "still pristine".
    setupSidebarScene({
      planets: [
        { cp: 10, coords: '[1:1:1]', usedFields: 42 },
        { cp: 11, coords: '[1:1:2]', usedFields: 0, maxFields: 188 },
      ],
    });
    installColonyRecorder();
    await flushMicrotasks();

    expect(historyStore.get().map((e) => e.cp)).toEqual([11]);
  });

  it('records nothing when every planet is already built', async () => {
    setupSidebarScene({ usedFields: 42 });
    installColonyRecorder();
    await flushMicrotasks();
    expect(historyStore.get()).toEqual([]);
  });

  it('never records a moon — its field count is a different quantity', async () => {
    setupSidebarScene({
      planets: [
        { cp: 50, coords: '[5:5:5]', moon: true, maxFields: 20 },
        { cp: 51, coords: '[5:5:6]', maxFields: 170 },
      ],
    });
    installColonyRecorder();
    await flushMicrotasks();

    expect(historyStore.get().map((e) => e.cp)).toEqual([51]);
  });

  it('skips a row whose tooltip is missing or malformed, keeping the good ones', async () => {
    setupSidebarScene({
      planets: [
        { cp: 60, coords: '[6:1:1]', tooltip: null },
        { cp: 61, coords: '[6:1:2]', tooltip: '<b>Kolonia</b><br/>no numbers here' },
        { cp: 62, coords: '[6:1:3]', maxFields: 175 },
      ],
    });
    installColonyRecorder();
    await flushMicrotasks();

    expect(historyStore.get().map((e) => e.cp)).toEqual([62]);
  });

  it('does nothing when the sidebar is absent (not an ingame page)', async () => {
    location.search = '?page=somethingElse';
    document.body.innerHTML = '<div>no sidebar here</div>';
    installColonyRecorder();
    await flushMicrotasks();
    expect(historyStore.get()).toEqual([]);
  });

  it('parses position from arbitrary galaxy/system/position triples', async () => {
    // Slot 15 is the largest legal value; make sure multi-digit
    // positions parse correctly (the regex uses \d+, not [1-9]).
    setupSidebarScene({ coords: '[6:100:15]' });
    installColonyRecorder();
    await flushMicrotasks();

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

    setupSidebarScene({ cp: 12345 });
    installColonyRecorder();
    await flushMicrotasks();

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

    setupSidebarScene({ cp: 22222 });
    installColonyRecorder();
    await flushMicrotasks();

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
    setupSidebarScene();

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
    await flushMicrotasks();
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

  it('records once the sidebar appears mid-poll', async () => {
    // Start on the overview URL but with NO overview nodes yet. The
    // hydrate-gate fires first (tryCollect returns false because DOM
    // is empty), then waitFor starts polling. We then paint the scene
    // and advance timers enough to let the next poll see the element
    // and call tryCollect a second time.
    location.search = '?page=ingame&component=overview&cp=12345';

    installColonyRecorder();

    // Drain the hydrate-gate microtask so the first tryCollect runs
    // and (because the DOM is empty) schedules the waitFor poll.
    await flushMicrotasks();
    expect(historyStore.get()).toEqual([]);

    // Now the overview nodes land in the document. The default
    // intervalMs is 200; advancing by 250ms guarantees one more poll
    // tick after the mutation.
    setupSidebarScene();
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
    setupSidebarScene({ cp: 33333, maxFields: 200, coords: '[3:3:3]' });
    installColonyRecorder();

    // Hydrate is still pending — no write must have escaped yet.
    // Letting microtasks drain proves the gate holds even when the
    // event loop is quiet.
    await flushMicrotasks();
    expect(setSpy).not.toHaveBeenCalled();
    expect(historyStore.get()).toEqual([]);

    // Land the hydrate. Persist's onHydrate resolves the gate, the
    // deferred tryCollect fires, the dedup check now sees both prior
    // entries, the new cp passes, and the append produces a 3-row
    // history — NOT a 1-row history that wiped the prior data.
    resolveGet(stored);
    await flushMicrotasks();

    const finalHistory = historyStore.get();
    expect(finalHistory.map((e) => e.cp)).toEqual([11111, 22222, 33333]);

    // The save trace MUST reflect the full 3-row payload by the end —
    // anything shorter means a write-through fired while the store was
    // mid-race. We don't pin the exact call count: the hydrate echo also
    // fires a save with the 2-row stored snapshot, AND recording a fresh
    // colony now additionally stamps a colonizeDecisions "mine" marker — a
    // non-array map under its own key, which can be the very last raw chrome
    // write. Select the last HISTORY write by its array shape; that also
    // sidesteps pinning the per-universe storage KEY (`localhost:oge_colonyHistory`
    // under happy-dom vs `s163-pl:oge_colonyHistory` on a real Gameforge tab).
    expect(setSpy).toHaveBeenCalled();
    // Both the history and the cp index persist as ARRAYS, so Array.isArray
    // alone would also match the index (a number[]). History rows are objects
    // carrying `cp`, which is the discriminator.
    const historyWrites = setSpy.mock.calls
      .map((c) => Object.values(c[0])[0])
      .filter((v) => Array.isArray(v) && v.every((e) => e && typeof e === 'object' && 'cp' in e));
    expect(historyWrites.length).toBeGreaterThan(0);
    const lastHistory = historyWrites[historyWrites.length - 1];
    expect(lastHistory.map((/** @type {ColonyEntry} */ e) => e.cp))
      .toEqual([11111, 22222, 33333]);
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
    setupSidebarScene({ cp: 12345 });
    installColonyRecorder();

    await flushMicrotasks();

    resolveGet(stored);
    await flushMicrotasks();

    // Length stays at 1 — the prior observation wins, original
    // timestamp preserved.
    const finalHistory = historyStore.get();
    expect(finalHistory).toHaveLength(1);
    expect(finalHistory[0]?.timestamp).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// The cp-index fast path
// ──────────────────────────────────────────────────────────────────
//
// This is the behaviour the whole lazy-history change rests on: on a page-load
// where the small index already knows every fresh planet, the big
// `oge_colonyHistory` key must NEVER be read. Without a test here the
// optimisation can silently degrade back into a no-op — it fails SAFE (the
// index under-reporting just means a slow path), so nothing else would notice.

describe('installColonyRecorder — cp-index fast path', () => {
  /** Keys passed to chrome.storage.local.get, in order. @type {string[]} */
  let getKeys;
  /** @type {Record<string, unknown>} */
  let disk;
  /** @type {import('vitest').Mock} */
  let setSpy;

  /** @param {string} base @returns {boolean} */
  const readAnyKeyEndingIn = (base) => getKeys.some((k) => k.endsWith(base));

  beforeEach(() => {
    getKeys = [];
    disk = {};
    setSpy = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (/** @type {string} */ key, /** @type {(items: Record<string, unknown>) => void} */ cb) => {
            getKeys.push(key);
            cb(key in disk ? { [key]: disk[key] } : {});
          },
          set: (/** @type {Record<string, unknown>} */ items, /** @type {(() => void) | undefined} */ cb) => {
            setSpy(items);
            Object.assign(disk, items);
            cb?.();
          },
          remove: () => {},
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT read the colony history when the index already knows the cp', async () => {
    // Seed the index (only) with the sidebar's cp.
    disk[`${location.host}:${HISTORY_CP_INDEX_KEY_BASE}`] = encodeCpRanges([12345]);

    setupSidebarScene({ cp: 12345 });
    installColonyRecorder();
    await flushMicrotasks();

    expect(readAnyKeyEndingIn(HISTORY_CP_INDEX_KEY_BASE)).toBe(true);
    // The point of the change: the unbounded key is untouched.
    expect(readAnyKeyEndingIn('oge_colonyHistory')).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    expect(historyStore.get()).toEqual([]);
  });

  it('reads nothing at all when no planet is fresh — not even the index', async () => {
    // Gate 1 is a DOM-only test, so the quiet steady state costs zero storage.
    setupSidebarScene({ cp: 12345, usedFields: 3 });
    installColonyRecorder();
    await flushMicrotasks();

    expect(getKeys).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('DOES read the history when the index does not know the cp', async () => {
    // Index knows a different colony, so this one is a candidate and the slow
    // path must run — the index is never allowed to authorise a write on its own.
    disk[`${location.host}:${HISTORY_CP_INDEX_KEY_BASE}`] = encodeCpRanges([999]);

    setupSidebarScene({ cp: 12345, maxFields: 163 });
    installColonyRecorder();
    await flushMicrotasks();

    expect(readAnyKeyEndingIn('oge_colonyHistory')).toBe(true);
    expect(historyStore.get().map((e) => e.cp)).toEqual([12345]);
  });

  it('self-heals an index that under-reports, without re-recording', async () => {
    // The history already holds the cp but the index does not (a dashboard
    // import or a gist merge unioned it in behind the index's back). The
    // recorder must NOT append a duplicate, and must rewrite the index so the
    // next page-load stops at the fast path.
    const historyKey = `${location.host}:oge_colonyHistory`;
    disk[historyKey] = [
      { cp: 12345, fields: 163, coords: '[4:30:8]', position: 8, timestamp: 1 },
    ];
    disk[`${location.host}:${HISTORY_CP_INDEX_KEY_BASE}`] = [];

    setupSidebarScene({ cp: 12345 });
    installColonyRecorder();
    await flushMicrotasks();

    // No duplicate, original timestamp intact.
    expect(historyStore.get()).toHaveLength(1);
    expect(historyStore.get()[0]?.timestamp).toBe(1);

    // The index now covers the cp — derived from the authority, so it also
    // absorbed what the index had never seen.
    const idxWrites = setSpy.mock.calls
      .map((c) => Object.entries(c[0])[0])
      .filter(([k]) => k.endsWith(HISTORY_CP_INDEX_KEY_BASE));
    expect(idxWrites.length).toBeGreaterThan(0);
    const written = /** @type {number[]} */ (idxWrites[idxWrites.length - 1][1]);
    expect(cpRangesHas(written, 12345)).toBe(true);
  });

  it('does not write the index on the append path — only from a stored history', async () => {
    // Deliberate: the append and an index write are two independent storage
    // writes with no ordering guarantee. If the index landed and the history did
    // not, the index would claim a cp that is not in the history and that
    // observation would be skipped forever. So the index is only ever derived
    // from a history array read back OUT of storage.
    disk[`${location.host}:${HISTORY_CP_INDEX_KEY_BASE}`] = [];

    setupSidebarScene({ cp: 777, maxFields: 200 });
    installColonyRecorder();
    await flushMicrotasks();

    expect(historyStore.get().map((e) => e.cp)).toEqual([777]);
    const idxWrites = setSpy.mock.calls
      .map((c) => Object.keys(c[0])[0])
      .filter((k) => k.endsWith(HISTORY_CP_INDEX_KEY_BASE));
    expect(idxWrites).toEqual([]);
  });
});
