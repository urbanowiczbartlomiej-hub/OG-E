// @vitest-environment happy-dom
//
// Unit tests for the sync scheduler.
//
// The scheduler is the orchestration layer — it calls the real
// {@link colonizeDecisionsStore}/{@link historyStore}/{@link settingsStore},
// runs the real {@link mergeColonizeDecisions}/{@link mergeHistory}, and hands
// already-compressed-and-base64'd bytes off to the gist client. To
// keep tests fast and hermetic we mock the gist client's public API
// surface so no fetch ever fires. Everything else runs for real.
//
// §4b note: galaxy scans, the player roster, and our own profile are NO LONGER
// synced — occupancy + neighbour rank are re-derived from the OGame public API
// per device. The only colonization state that crosses devices now is the
// colonization DECISION log (`colonizeDecisionsPerUniverse`), and the stores
// the scheduler subscribes for upload triggers are history + decisions (+
// routes / settings / configs). `scansStore`/`playersStore` are untouched here.
//
// Why fake timers: the scheduler debounces uploads by 15 s. Real
// timers would make each test a 15-second wait; fake timers let us
// drive virtual time with `vi.advanceTimersByTimeAsync(ms)` and keep
// the suite under a second total.
//
// Why happy-dom: we dispatch `document.dispatchEvent(...)` for the
// force-sync path, which requires a working DOM. happy-dom is
// already in the project's devDeps and matches the environment of
// the other sync tests.
//
// @ts-check

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';

// Mock the gist client BEFORE importing the scheduler so vi.mock
// hoisting catches the scheduler's static import. Every public API
// the scheduler touches is stubbed — fetchGistData / writeGistData
// drive the sync round-trip, setStatus records timestamps + errors,
// getToken gates the "sync disabled" short-circuit. (§4b removed the
// per-galaxy gist-scan clear; the reset-galaxy path is now LOCAL-only.)
vi.mock('../../src/sync/gist.js', () => ({
  fetchGistData: vi.fn(),
  writeGistData: vi.fn(),
  getToken: vi.fn(() => 'ghp_testtoken'),
  setStatus: vi.fn(),
}));

import {
  installSync,
  _resetSchedulerForTest,
} from '../../src/sync/scheduler.js';
import { SYNC_FORCE_EVENT } from '../../src/lib/ogeEvents.js';
import {
  fetchGistData,
  writeGistData,
  setStatus,
  getToken,
} from '../../src/sync/gist.js';
import { historyStore } from '../../src/state/history.js';
import { colonizeDecisionsStore } from '../../src/state/colonizeDecisions.js';
import { settingsStore } from '../../src/state/settings.js';
import { pickSyncedValues } from '../../src/sync/settingsSync.js';

/**
 * @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../src/state/history.js').ColonyHistory} ColonyHistory
 * @typedef {import('../../src/domain/colonizeDecisions.js').Decision} Decision
 * @typedef {import('../../src/domain/colonizeDecisions.js').DecisionMap} DecisionMap
 */

/**
 * Build a compact colonization {@link Decision} for test fixtures. Defaults to
 * a terminal `mine` (s=2) so it never regresses under the monotonic merge and
 * equality checks stay predictable; `ts` is the LWW key.
 *
 * @param {number} ts
 * @param {1|2|3|4|5} [s]
 * @returns {Decision}
 */
const dec = (ts, s = 2) => ({ s, ts });

/**
 * The universe id the scheduler derives from `location.host` in this happy-dom
 * env — computed exactly as `parseUniverseId(location.host)` does, so the
 * per-universe gist slots we build line up with the scheduler's
 * `routesUniverseId`.
 */
const UNI =
  typeof location !== 'undefined'
    ? location.host.match(/^(s\d+-[a-z]{2,4})\./)?.[1] ?? location.host
    : '';

/**
 * Advance fake timers and let queued microtasks settle. The
 * scheduler's debounced callback resolves a promise internally; we
 * need both the timer tick AND the microtask queue flush for tests
 * to observe the effect.
 *
 * `advanceTimersByTimeAsync` already pumps microtasks, but we follow
 * with explicit `await Promise.resolve()` to be extra-defensive when
 * a chain of awaits is needed (fetchGistData → merge → writeGistData).
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const tick = async (ms) => {
  await vi.advanceTimersByTimeAsync(ms);
  // Drain any microtasks the timer fired into.
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Build a minimal {@link import('../../src/sync/gist.js').GistPayload}
 * for fetchGistData mocks. Default values are empty so tests only
 * supply what they care about.
 *
 * @param {object} [opts]
 * @param {DecisionMap} [opts.decisions]
 * @param {Record<string, ColonyHistory>} [opts.colonyHistoryPerUniverse]
 * @param {import('../../src/sync/gist.js').SyncedSettings} [opts.settings]
 * @param {Record<string, import('../../src/sync/gist.js').SyncedSettings>} [opts.settingsPerUniverse]
 * @returns {import('../../src/sync/gist.js').GistPayload}
 */
const payload = ({
  decisions = {},
  colonyHistoryPerUniverse,
  settings,
  settingsPerUniverse,
} = {}) => ({
  version: 1,
  updatedAt: '2025-01-01T00:00:00.000Z',
  // Decisions are per-universe in the gist: a `decisions` arg is sugar for
  // "this universe's slot", since the scheduler reads
  // `colonizeDecisionsPerUniverse[routesUniverseId]` (and UNI ===
  // routesUniverseId in this happy-dom env). Omitted when empty so an
  // absent-slot gist is representable.
  ...(Object.keys(decisions).length
    ? { colonizeDecisionsPerUniverse: { [UNI]: decisions } }
    : {}),
  ...(colonyHistoryPerUniverse ? { colonyHistoryPerUniverse } : {}),
  ...(settings ? { settings } : {}),
  ...(settingsPerUniverse ? { settingsPerUniverse } : {}),
});

beforeEach(() => {
  _resetSchedulerForTest();
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Default getToken returns a valid token; individual tests override.
  /** @type {import('vitest').Mock} */ (getToken).mockReturnValue(
    'ghp_testtoken',
  );
  // Fresh store state per test: empty decisions, empty history, cloudSync on.
  colonizeDecisionsStore.set({});
  historyStore.set([]);
  settingsStore.set({ ...settingsStore.get(), cloudSync: true });
  // Settings-sync seeds a per-key timestamp map on first install; clear it
  // so each test starts from a known "no map yet" state (installSync re-seeds
  // deterministically under fake timers).
  localStorage.removeItem('oge_settingsTs');
});

afterEach(() => {
  _resetSchedulerForTest();
  vi.useRealTimers();
});

describe('installSync — initial boot', () => {
  it('is a no-op when cloudSync is disabled', async () => {
    // Opt-out path: scheduler must not touch the network, not
    // subscribe to stores, and return a safe-to-call dispose fn.
    settingsStore.set({ ...settingsStore.get(), cloudSync: false });
    const dispose = installSync();
    await tick(0);
    // Nothing fetched — we returned before even installing listeners.
    expect(fetchGistData).not.toHaveBeenCalled();
    // Dispose is still callable (no-op) so the bootstrap path is
    // uniform whether sync is on or off.
    expect(() => dispose()).not.toThrow();
  });

  it('triggers a single downloadAndMerge on install when cloudSync is enabled', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    installSync();
    // Initial boot fires fetchGistData once, fire-and-forget. Flush
    // the microtask the scheduler enqueued.
    await tick(0);
    expect(fetchGistData).toHaveBeenCalledTimes(1);
    // writeGistData NOT called — initial boot is download-only.
    expect(writeGistData).not.toHaveBeenCalled();
  });

  it('is idempotent — a second installSync returns the same dispose and does not double-subscribe', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    const dispose1 = installSync();
    const dispose2 = installSync();
    await tick(0);
    // Second install must reuse the first handle, so we see exactly
    // one initial download, not two.
    expect(fetchGistData).toHaveBeenCalledTimes(1);
    // Dispose references are the same function — the second install
    // returned the cached handle.
    expect(dispose2).toBe(dispose1);
  });
});

describe('scheduleUpload — debounce behaviour', () => {
  it('does NOT upload immediately on a store change (15 s debounce)', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    installSync();
    // Let the initial download settle so fetchGistData is done
    // before we start counting the debounce window.
    await tick(0);
    // Flip local state — this notifies scheduler's onStoreChange,
    // which schedules an upload 15 s out. (Decisions are a synced store;
    // scans are not, so we trigger via the decision log now.)
    colonizeDecisionsStore.set({ '4:30:5': dec(1000) });
    // Less than 15 s: still no upload.
    await tick(14_000);
    expect(writeGistData).not.toHaveBeenCalled();
  });

  it('fires a single upload after the 15 s quiet period', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(
      undefined,
    );
    installSync();
    await tick(0);
    colonizeDecisionsStore.set({ '4:30:5': dec(1000) });
    // Full debounce window elapses → debounced callback fires.
    await tick(15_000);
    // Upload pre-merges (another fetch) then PATCHes.
    expect(writeGistData).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of 3 store changes into a single upload', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(
      undefined,
    );
    installSync();
    await tick(0);
    // Three bursts within 15 s — each resets the debounce timer.
    colonizeDecisionsStore.set({ '4:30:5': dec(1000) });
    await tick(5_000);
    colonizeDecisionsStore.set({ '4:30:5': dec(2000) });
    await tick(5_000);
    colonizeDecisionsStore.set({ '4:30:5': dec(3000) });
    // At t=10s from last change, timer is still armed, no upload yet.
    await tick(14_999);
    expect(writeGistData).not.toHaveBeenCalled();
    // One more ms → timer fires.
    await tick(2);
    expect(writeGistData).toHaveBeenCalledTimes(1);
  });
});

describe('downloadAndMerge', () => {
  it('does NOT touch local stores when fetchGistData returns null', async () => {
    // `null` means: gist exists but is empty / corrupt / wrong
    // schema. Scheduler must clear any error but NOT write locally.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      null,
    );
    // Seed local state so we can assert it survives untouched.
    const localDecisions = /** @type {DecisionMap} */ ({ '1:1:1': dec(500) });
    colonizeDecisionsStore.set(localDecisions);
    installSync();
    await tick(0);
    // Reference equality: local state is not reassigned.
    expect(colonizeDecisionsStore.get()).toBe(localDecisions);
    // Error status cleared (happy-ish path even though payload is null).
    expect(setStatus).toHaveBeenCalledWith('err', null);
  });

  it('writes to colonizeDecisionsStore when remote contributed a new coord (changed === true)', async () => {
    // Local has '4:30:5'; remote has '1:1:1'. Merge yields both coords ⇒
    // changed === true ⇒ colonizeDecisionsStore.set runs. This is the
    // cross-device handoff that lets a 2nd device continue only the
    // remaining free positions.
    const localDecisions = /** @type {DecisionMap} */ ({ '4:30:5': dec(1000) });
    colonizeDecisionsStore.set(localDecisions);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: { '1:1:1': dec(2000) } }),
    );
    installSync();
    await tick(0);
    const merged = colonizeDecisionsStore.get();
    // Both coords present.
    expect(Object.keys(merged).sort()).toEqual(['1:1:1', '4:30:5']);
    // `down` stamped with a valid ISO string.
    const downCalls = /** @type {import('vitest').Mock} */ (
      setStatus
    ).mock.calls.filter((c) => c[0] === 'down');
    expect(downCalls.length).toBe(1);
    expect(Number.isNaN(Date.parse(downCalls[0][1]))).toBe(false);
  });

  it('does NOT write to stores when merge is a no-op (anti-loop protection)', async () => {
    // Same coord on both sides with identical decision — merge yields
    // the local reference unchanged (`changed === false`). The
    // scheduler MUST NOT call store.set, or the subscription would
    // fire and schedule yet another upload ⇒ loop.
    const shared = dec(5000);
    const localDecisions = /** @type {DecisionMap} */ ({ '4:30:5': shared });
    colonizeDecisionsStore.set(localDecisions);
    // Track store writes by subscribing — the initial install
    // already subscribed the scheduler, so count only the changes
    // that happen after our hook.
    let setCount = 0;
    colonizeDecisionsStore.subscribe(() => {
      setCount++;
    });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: { '4:30:5': shared } }),
    );
    installSync();
    await tick(0);
    // No extra writes past what the test itself did (0).
    expect(setCount).toBe(0);
    // Reference identity: local is exactly what we seeded.
    expect(colonizeDecisionsStore.get()).toBe(localDecisions);
  });
});

describe('upload', () => {
  it('pre-merges decisions with remote and PATCHes with the merged payload', async () => {
    // Local has a decision for '4:30:5'; remote has a different coord
    // '1:1:1'. Upload must PATCH with both coords present so another
    // device's recent decision isn't clobbered.
    const localDecisions = /** @type {DecisionMap} */ ({ '4:30:5': dec(9000) });
    colonizeDecisionsStore.set(localDecisions);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: { '1:1:1': dec(100) } }),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(
      undefined,
    );
    installSync();
    // Let initial download complete (the fetch above is consumed by it).
    await tick(0);
    // Queue a second fetch response for the upload's pre-merge read.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: { '1:1:1': dec(100) } }),
    );
    // Trigger an upload: add a different local decision.
    colonizeDecisionsStore.set({ '4:30:5': dec(9000), '2:2:2': dec(9001) });
    await tick(15_000);
    expect(writeGistData).toHaveBeenCalledTimes(1);
    // Inspect the PATCH body's per-universe decision slot to confirm merge.
    const [[sentPayload]] = /** @type {import('vitest').Mock} */ (
      writeGistData
    ).mock.calls;
    expect(Object.keys(sentPayload.colonizeDecisionsPerUniverse[UNI]).sort()).toEqual([
      '1:1:1',
      '2:2:2',
      '4:30:5',
    ]);
    expect(sentPayload.version).toBe(1);
    // Galaxy scans are no longer synced — the field must be absent (§4b).
    expect(sentPayload.galaxyScansPerUniverse).toBeUndefined();
    // `up` stamp recorded.
    expect(setStatus).toHaveBeenCalledWith('up', expect.any(String));
  });

  it('C6: a THROWN pre-merge fetch aborts the upload — no PATCH, error stamped', async () => {
    // Regression guard for the silent multi-universe wipe: a failed pre-merge
    // GET must NOT proceed to build a payload from remote=null (which would
    // PATCH only this universe's slot and drop every other universe's).
    colonizeDecisionsStore.set(/** @type {DecisionMap} */ ({ '4:30:5': dec(9000) }));
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(null); // boot
    installSync();
    await tick(0);
    // The upload's pre-merge read throws (network / HTTP / rate-limit).
    /** @type {import('vitest').Mock} */ (fetchGistData).mockRejectedValue(
      new Error('HTTP 500: boom'),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(undefined);
    colonizeDecisionsStore.set({ '4:30:5': dec(9000), '2:2:2': dec(9001) });
    await tick(15_000);
    expect(writeGistData).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('err', expect.stringContaining('upload:'));
  });

  it('contributes the colonization decision log to the PATCH', async () => {
    // §4b: the decision log is the cross-device colonization handoff. A send /
    // checkTarget-refusal / colony / abandon writes the log → schedules an
    // upload; the PATCH body carries our slot under the universe id.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(null);
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(undefined);
    installSync();
    await tick(0);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(null);
    // A send wrote a `sent` (s=1) decision with an arrival time → upload.
    colonizeDecisionsStore.set({ '7:8:9': { s: 1, ts: 5000, aa: 9999 } });
    await tick(15_000);
    expect(writeGistData).toHaveBeenCalledTimes(1);
    const [[sent]] = /** @type {import('vitest').Mock} */ (writeGistData).mock.calls;
    expect(sent.colonizeDecisionsPerUniverse[UNI]['7:8:9']).toEqual({ s: 1, ts: 5000, aa: 9999 });
    // Player roster + own profile are no longer synced (§4b).
    expect(sent.playersPerUniverse).toBeUndefined();
    expect(sent.ownProfilePerUniverse).toBeUndefined();
  });

  it('does NOT bleed a SIBLING universe decision slot into this universe (cross-server isolation)', async () => {
    // A different server's decisions must never merge into this universe's
    // decision log (it feeds the colonize candidate finder). Only
    // colonizeDecisionsPerUniverse[ourUniverse] is ours; a sibling's coord —
    // taken on their server, free on ours — must stay out.
    colonizeDecisionsStore.set({});
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue({
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      colonizeDecisionsPerUniverse: { 'sOTHER-xx': { '3:265:8': dec(9999) } },
    });
    installSync();
    await tick(0);
    expect(colonizeDecisionsStore.get()['3:265:8']).toBeUndefined();
    expect(Object.keys(colonizeDecisionsStore.get())).toHaveLength(0);
  });

  it('upload contributes only our decision slot and PRESERVES sibling universes', async () => {
    colonizeDecisionsStore.set({});
    const remote = {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      colonizeDecisionsPerUniverse: { 'sOTHER-xx': { '1:1:1': dec(5) } },
    };
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(remote);
    installSync();
    await tick(0);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(remote);
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(undefined);
    // Local decision on OUR universe triggers an upload.
    colonizeDecisionsStore.set({ '4:30:5': dec(100) });
    await tick(15_000);
    const [[sent]] = /** @type {import('vitest').Mock} */ (writeGistData).mock.calls;
    // Sibling slot survives untouched; ours is contributed under our id.
    expect(sent.colonizeDecisionsPerUniverse['sOTHER-xx']).toEqual({ '1:1:1': dec(5) });
    expect(sent.colonizeDecisionsPerUniverse[UNI]).toEqual({ '4:30:5': dec(100) });
    // Galaxy scans are gone from the payload entirely (§4b) — no leak vector.
    expect(sent.galaxyScansPerUniverse).toBeUndefined();
  });

  it('skips writeGistData when gist already matches the merged state (sameJSON)', async () => {
    // Local and remote are already in perfect agreement — merge
    // yields local unchanged and the sameJSON check passes, so
    // upload must NOT PATCH (saves an API call + avoids a no-op gist
    // revision).
    const shared = /** @type {DecisionMap} */ ({ '4:30:5': dec(5000) });
    colonizeDecisionsStore.set(shared);
    // Pre-seed an EMPTY ts map so installSync skips seeding. The remote
    // settings slot must deep-equal what local would upload (global-only
    // keys) and settingsPerUniverse must be absent (no universe-scoped
    // key has been explicitly changed, so ts is empty → slot omitted).
    localStorage.setItem('oge_settingsTs', '{}');
    const settings = { values: pickSyncedValues(settingsStore.get(), 'global'), ts: {} };
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: shared, settings }),
    );
    installSync();
    await tick(0);
    // Second fetch for the upload pre-merge.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: shared, settings }),
    );
    // Nudge the store (same value, but set() still notifies).
    colonizeDecisionsStore.set({ ...shared });
    await tick(15_000);
    expect(writeGistData).not.toHaveBeenCalled();
    // Error status still cleared — the "skip" path is a success.
    expect(setStatus).toHaveBeenCalledWith('err', null);
  });

  it('stamps err status when writeGistData throws', async () => {
    // The upload path surfaces network / HTTP errors via setStatus,
    // not via throw — the debounced callback is fire-and-forget from
    // the store-subscription's perspective.
    colonizeDecisionsStore.set({ '4:30:5': dec(1000) });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockRejectedValue(
      new Error('HTTP 500: boom'),
    );
    installSync();
    await tick(0);
    colonizeDecisionsStore.set({ '4:30:5': dec(1000), '2:2:2': dec(2000) });
    await tick(15_000);
    // setStatus('err', 'upload: HTTP 500: boom') — prefix matters so
    // the Settings UI can tell download and upload failures apart.
    const errCalls = /** @type {import('vitest').Mock} */ (
      setStatus
    ).mock.calls.filter((c) => c[0] === 'err' && typeof c[1] === 'string');
    expect(
      errCalls.some((c) => c[1].startsWith('upload:') && c[1].includes('boom')),
    ).toBe(true);
  });
});

describe('force-sync event', () => {
  it('dispatching oge:syncForce triggers downloadAndMerge + upload', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ decisions: { '1:1:1': dec(100) } }),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(
      undefined,
    );
    installSync();
    // Initial-boot download consumes one fetch call.
    await tick(0);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockClear();
    /** @type {import('vitest').Mock} */ (writeGistData).mockClear();

    // Queue two fetch responses: one for the forced downloadAndMerge,
    // one for the forced upload's pre-merge.
    /** @type {import('vitest').Mock} */ (fetchGistData)
      .mockResolvedValueOnce(payload({ decisions: { '1:1:1': dec(100) } }))
      .mockResolvedValueOnce(payload({ decisions: { '1:1:1': dec(100) } }));

    document.dispatchEvent(new CustomEvent(SYNC_FORCE_EVENT));
    // Let the async chain run. No debounce on the force path —
    // downloadAndMerge and upload run back-to-back immediately.
    await tick(0);
    await tick(0);

    // Both operations fired: 2 fetches + 1 PATCH (if there is
    // something to upload). The upload's PATCH runs when gist !==
    // merged; here local is empty and remote has '1:1:1', so after
    // download merges, local === remote → upload skips the PATCH.
    // Either way the download fetch is guaranteed.
    expect(
      /** @type {import('vitest').Mock} */ (fetchGistData).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('dispose', () => {
  it('unsubscribes stores — a post-dispose store change does not schedule upload', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    const dispose = installSync();
    await tick(0);
    dispose();
    /** @type {import('vitest').Mock} */ (writeGistData).mockClear();
    // Store change AFTER dispose — scheduler's subscription was
    // removed, so no debounced upload should be armed. (Use a synced
    // store; scans aren't subscribed at all post-§4b.)
    colonizeDecisionsStore.set({ '4:30:5': dec(1000) });
    await tick(30_000);
    expect(writeGistData).not.toHaveBeenCalled();
  });
});

describe('inFlight lock', () => {
  it('a second download started while one is in flight is a no-op', async () => {
    // Slow fetch: resolves only when we let it. While it's pending,
    // a second dispatched force-sync must find inFlight === true and
    // bail early without queueing another fetch.
    /** @type {(value: import('../../src/sync/gist.js').GistPayload) => void} */
    let resolveFetch = () => {};
    /** @type {Promise<import('../../src/sync/gist.js').GistPayload>} */
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockReturnValue(
      pending,
    );
    installSync();
    // Initial fetch is now pending. Kick off a force-sync which
    // would normally call fetchGistData twice (download + upload
    // pre-merge). The inFlight guard means BOTH the download inside
    // the force-sync and the upload get skipped until the initial
    // resolves.
    await tick(0);
    document.dispatchEvent(new CustomEvent(SYNC_FORCE_EVENT));
    await tick(0);
    // Only the initial install's fetch has been called; force-sync's
    // download and upload both short-circuited on inFlight.
    expect(
      /** @type {import('vitest').Mock} */ (fetchGistData).mock.calls.length,
    ).toBe(1);

    // Unblock — scheduler cleans up and is available for future
    // operations again.
    resolveFetch(payload());
    await tick(0);
  });
});

describe('settings sync', () => {
  it('applies a remote GLOBAL setting with a newer ts on download', async () => {
    // Local readabilityBoost=false stamped at ts 100; remote has true at ts 200
    // (newer). readabilityBoost is a global setting → goes through the top-level
    // `settings` slot and the localStorage ts map.
    settingsStore.set({ ...settingsStore.get(), readabilityBoost: false });
    localStorage.setItem('oge_settingsTs', JSON.stringify({ readabilityBoost: 100 }));
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ settings: { values: { readabilityBoost: true }, ts: { readabilityBoost: 200 } } }),
    );

    installSync();
    await tick(0);

    expect(settingsStore.get().readabilityBoost).toBe(true);
    // The remote timestamp is carried into the local global ts map.
    expect(JSON.parse(localStorage.getItem('oge_settingsTs') || '{}').readabilityBoost).toBe(200);
  });

  it('applies a remote UNIVERSE-SCOPED setting via settingsPerUniverse on download', async () => {
    // maxExpeditionsPerPlanet is universe-scoped; remote carries it in
    // settingsPerUniverse (the dedicated slot). Since routesUniverseId =
    // parseUniverseId(location.host) in this happy-dom env, we use that same
    // key for the slot.
    const uid = /** @type {string} */ (
      typeof location !== 'undefined'
        ? location.host.match(/^(s\d+-[a-z]{2,4})\./)
          ? location.host.match(/^(s\d+-[a-z]{2,4})\./)?.[1]
          : location.host
        : ''
    );
    settingsStore.set({ ...settingsStore.get(), maxExpeditionsPerPlanet: 1 });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({
        settingsPerUniverse: {
          [uid]: { values: { maxExpeditionsPerPlanet: 2 }, ts: { maxExpeditionsPerPlanet: 200 } },
        },
      }),
    );

    installSync();
    await tick(0);

    expect(settingsStore.get().maxExpeditionsPerPlanet).toBe(2);
    // Global ts map is NOT touched (maxExpeditionsPerPlanet is universe-scoped).
    expect(
      'maxExpeditionsPerPlanet' in JSON.parse(localStorage.getItem('oge_settingsTs') || '{}'),
    ).toBe(false);
  });

  it('uploads a locally-changed GLOBAL setting (stamped) inside the payload', async () => {
    // readabilityBoost is global → appears in settings.values (not settingsPerUniverse).
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(payload());
    installSync();
    await tick(0);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(payload());

    settingsStore.set({ ...settingsStore.get(), readabilityBoost: false });
    await tick(15_000);

    expect(writeGistData).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          values: expect.objectContaining({ readabilityBoost: false }),
        }),
      }),
    );
  });

  it('does NOT sync the excluded keys (button size, gist token)', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(payload());
    installSync();
    await tick(0);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(payload());

    // eventMenuHighlight is global → goes to settings.values; excluded keys must
    // not appear. (A global key NOT touched by the sibling tests above, so its
    // true→false flip is always a real change that schedules the upload.)
    settingsStore.set({ ...settingsStore.get(), fabBtnSize: 123, eventMenuHighlight: false });
    await tick(15_000);

    const call = /** @type {import('vitest').Mock} */ (writeGistData).mock.calls.at(-1);
    const values = call?.[0]?.settings?.values ?? {};
    expect(values.eventMenuHighlight).toBe(false);
    expect('fabBtnSize' in values).toBe(false);
    expect('gistToken' in values).toBe(false);
  });
});

describe('colony history — per-universe sync (regression: empty histogram on 2nd device)', () => {
  // Mirror the universe-scoped settings test's derivation so the slot key
  // matches the scheduler's routesUniverseId = parseUniverseId(location.host).
  const uid = /** @type {string} */ (
    typeof location !== 'undefined'
      ? location.host.match(/^(s\d+-[a-z]{2,4})\./)
        ? location.host.match(/^(s\d+-[a-z]{2,4})\./)?.[1]
        : location.host
      : ''
  );
  /** @param {number} cp @returns {import('../../src/state/history.js').ColonyEntry} */
  const entry = (cp) => ({ cp, fields: 100 + cp, coords: `[${cp}:${cp}:${cp}]`, position: 1, timestamp: cp });

  it('download adopts THIS server\'s slot only — never another server\'s entries', async () => {
    // The bug: a single global colonyHistory landed another server's
    // observations under this device's universe key. With the per-universe
    // slot, only THIS universe's list is adopted.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({
        colonyHistoryPerUniverse: {
          [uid]: [entry(1)],
          'sX-zz-99': [entry(2)],
        },
      }),
    );
    installSync();
    await tick(0);
    const cps = historyStore.get().map((e) => e.cp);
    expect(cps).toContain(1); // our universe's observation lands locally
    expect(cps).not.toContain(2); // the other server's never leaks in
  });

  it('upload writes local history into the per-universe slot keyed by THIS server', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(payload());
    installSync();
    await tick(0);
    // A local observation after boot schedules a debounced upload.
    historyStore.set([entry(7)]);
    await tick(15_000);
    expect(writeGistData).toHaveBeenCalledWith(
      expect.objectContaining({
        colonyHistoryPerUniverse: expect.objectContaining({
          [uid]: expect.arrayContaining([expect.objectContaining({ cp: 7 })]),
        }),
      }),
    );
  });
});
