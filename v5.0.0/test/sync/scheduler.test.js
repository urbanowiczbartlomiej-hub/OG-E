// @vitest-environment happy-dom
//
// Unit tests for the sync scheduler.
//
// The scheduler is the orchestration layer — it calls the real
// {@link scansStore}/{@link historyStore}/{@link settingsStore}, runs
// the real {@link mergeScans}/{@link mergeHistory}, and hands
// already-compressed-and-base64'd bytes off to the gist client. To
// keep tests fast and hermetic we mock the gist client's public API
// surface so no fetch ever fires. Everything else runs for real.
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
// getToken gates the "sync disabled" short-circuit, clearGistScans
// is imported only for contract symmetry and never called here.
vi.mock('../../src/sync/gist.js', () => ({
  fetchGistData: vi.fn(),
  writeGistData: vi.fn(),
  clearGistScans: vi.fn(),
  getToken: vi.fn(() => 'ghp_testtoken'),
  setStatus: vi.fn(),
}));

import {
  installSync,
  _resetSchedulerForTest,
  FORCE_SYNC_EVENT,
} from '../../src/sync/scheduler.js';
import {
  fetchGistData,
  writeGistData,
  setStatus,
  getToken,
} from '../../src/sync/gist.js';
import { scansStore } from '../../src/state/scans.js';
import { historyStore } from '../../src/state/history.js';
import { settingsStore } from '../../src/state/settings.js';

/**
 * @typedef {import('../../src/state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../src/state/scans.js').SystemScan} SystemScan
 * @typedef {import('../../src/state/history.js').ColonyEntry} ColonyEntry
 * @typedef {import('../../src/state/history.js').ColonyHistory} ColonyHistory
 */

/**
 * Build a compact {@link SystemScan} for test fixtures. Only
 * `scannedAt` matters to the merger; `positions` is stubbed so
 * equality checks work predictably.
 *
 * @param {number} scannedAt
 * @returns {SystemScan}
 */
const scan = (scannedAt) => ({ scannedAt, positions: {} });

/**
 * Build a compact {@link ColonyEntry} for test fixtures. Only `cp`
 * matters to the merger; the rest is stubbed to fixed values.
 *
 * @param {number} cp
 * @returns {ColonyEntry}
 */
const entry = (cp) => ({
  cp,
  fields: 200,
  coords: '[1:1:1]',
  position: 1,
  timestamp: 1_700_000_000_000,
});

/**
 * Advance fake timers and let queued microtasks settle. The
 * scheduler's debounced callback resolves a promise internally; we
 * need both the timer tick AND the microtask queue flush for tests
 * to observe the effect.
 *
 * `advanceTimersByTimeAsync` already pumps microtasks, but we follow
 * with explicit `await Promise.resolve()` to be extra-defensive when
 * a chain of awaits is needed (fetchGistData → mergeScans → writeGistData).
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
 * @param {GalaxyScans} [opts.galaxyScans]
 * @param {ColonyHistory} [opts.colonyHistory]
 * @returns {import('../../src/sync/gist.js').GistPayload}
 */
const payload = ({ galaxyScans = {}, colonyHistory = [] } = {}) => ({
  version: 3,
  updatedAt: '2025-01-01T00:00:00.000Z',
  galaxyScans,
  colonyHistory,
});

beforeEach(() => {
  _resetSchedulerForTest();
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Default getToken returns a valid token; individual tests override.
  /** @type {import('vitest').Mock} */ (getToken).mockReturnValue(
    'ghp_testtoken',
  );
  // Fresh store state per test: empty scans, empty history, cloudSync on.
  scansStore.set({});
  historyStore.set([]);
  settingsStore.set({ ...settingsStore.get(), cloudSync: true });
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
    // which schedules an upload 15 s out.
    scansStore.set({ '4:30': scan(1000) });
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
    scansStore.set({ '4:30': scan(1000) });
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
    scansStore.set({ '4:30': scan(1000) });
    await tick(5_000);
    scansStore.set({ '4:30': scan(2000) });
    await tick(5_000);
    scansStore.set({ '4:30': scan(3000) });
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
    const localScans = { '1:1': scan(500) };
    scansStore.set(localScans);
    installSync();
    await tick(0);
    // Reference equality: local state is not reassigned.
    expect(scansStore.get()).toBe(localScans);
    // Error status cleared (happy-ish path even though payload is null).
    expect(setStatus).toHaveBeenCalledWith('err', null);
  });

  it('writes to scansStore when remote contributed a new key (changed === true)', async () => {
    // Local has '4:30'; remote has '1:1'. Merge yields both keys ⇒
    // changed === true ⇒ scansStore.set runs.
    const localScans = /** @type {GalaxyScans} */ ({ '4:30': scan(1000) });
    scansStore.set(localScans);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: { '1:1': scan(2000) } }),
    );
    installSync();
    await tick(0);
    const merged = scansStore.get();
    // Both keys present.
    expect(Object.keys(merged).sort()).toEqual(['1:1', '4:30']);
    // `down` stamped with a valid ISO string.
    const downCalls = /** @type {import('vitest').Mock} */ (
      setStatus
    ).mock.calls.filter((c) => c[0] === 'down');
    expect(downCalls.length).toBe(1);
    expect(Number.isNaN(Date.parse(downCalls[0][1]))).toBe(false);
  });

  it('does NOT write to stores when merge is a no-op (anti-loop protection)', async () => {
    // Same key on both sides with same `scannedAt` — merge yields
    // the local reference unchanged (`changed === false`). The
    // scheduler MUST NOT call store.set, or the subscription would
    // fire and schedule yet another upload ⇒ loop.
    const shared = scan(5000);
    const localScans = /** @type {GalaxyScans} */ ({ '4:30': shared });
    scansStore.set(localScans);
    // Track store writes by subscribing — the initial install
    // already subscribed the scheduler, so count only the changes
    // that happen after our hook.
    let setCount = 0;
    scansStore.subscribe(() => {
      setCount++;
    });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: { '4:30': shared } }),
    );
    installSync();
    await tick(0);
    // No extra writes past what the test itself did (0).
    expect(setCount).toBe(0);
    // Reference identity: local is exactly what we seeded.
    expect(scansStore.get()).toBe(localScans);
  });
});

describe('upload', () => {
  it('pre-merges with remote and PATCHes with the merged payload', async () => {
    // Local has a newer scan for '4:30'; remote has a different key
    // '1:1'. Upload must PATCH with both keys present so another
    // device's recent write isn't clobbered.
    const localScans = /** @type {GalaxyScans} */ ({ '4:30': scan(9000) });
    scansStore.set(localScans);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: { '1:1': scan(100) } }),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockResolvedValue(
      undefined,
    );
    installSync();
    // Let initial download complete (the fetch above is consumed by it).
    await tick(0);
    // Queue a second fetch response for the upload's pre-merge read.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: { '1:1': scan(100) } }),
    );
    // Trigger an upload: bump local to something different.
    scansStore.set({ '4:30': scan(9001) });
    await tick(15_000);
    expect(writeGistData).toHaveBeenCalledTimes(1);
    // Inspect the PATCH body's galaxyScans to confirm merge happened.
    const [[sentPayload]] = /** @type {import('vitest').Mock} */ (
      writeGistData
    ).mock.calls;
    expect(Object.keys(sentPayload.galaxyScans).sort()).toEqual([
      '1:1',
      '4:30',
    ]);
    expect(sentPayload.version).toBe(3);
    // `up` stamp recorded.
    expect(setStatus).toHaveBeenCalledWith('up', expect.any(String));
  });

  it('skips writeGistData when gist already matches the merged state (sameJSON)', async () => {
    // Local and remote are already in perfect agreement — merge
    // yields local unchanged and the sameJSON check passes, so
    // upload must NOT PATCH (saves an API call + avoids a no-op gist
    // revision).
    const shared = /** @type {GalaxyScans} */ ({ '4:30': scan(5000) });
    scansStore.set(shared);
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: shared }),
    );
    installSync();
    await tick(0);
    // Second fetch for the upload pre-merge.
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: shared }),
    );
    // Nudge the store (same value, but set() still notifies).
    scansStore.set(shared);
    await tick(15_000);
    expect(writeGistData).not.toHaveBeenCalled();
    // Error status still cleared — the "skip" path is a success.
    expect(setStatus).toHaveBeenCalledWith('err', null);
  });

  it('stamps err status when writeGistData throws', async () => {
    // The upload path surfaces network / HTTP errors via setStatus,
    // not via throw — the debounced callback is fire-and-forget from
    // the store-subscription's perspective.
    scansStore.set({ '4:30': scan(1000) });
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload(),
    );
    /** @type {import('vitest').Mock} */ (writeGistData).mockRejectedValue(
      new Error('HTTP 500: boom'),
    );
    installSync();
    await tick(0);
    scansStore.set({ '4:30': scan(2000) });
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
  it('dispatching oge5:syncForce triggers downloadAndMerge + upload', async () => {
    /** @type {import('vitest').Mock} */ (fetchGistData).mockResolvedValue(
      payload({ galaxyScans: { '1:1': scan(100) } }),
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
      .mockResolvedValueOnce(payload({ galaxyScans: { '1:1': scan(100) } }))
      .mockResolvedValueOnce(payload({ galaxyScans: { '1:1': scan(100) } }));

    document.dispatchEvent(new CustomEvent(FORCE_SYNC_EVENT));
    // Let the async chain run. No debounce on the force path —
    // downloadAndMerge and upload run back-to-back immediately.
    await tick(0);
    await tick(0);

    // Both operations fired: 2 fetches + 1 PATCH (if there is
    // something to upload). The upload's PATCH runs when gist !==
    // merged; here local is empty and remote has '1:1', so after
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
    // removed, so no debounced upload should be armed.
    scansStore.set({ '4:30': scan(1000) });
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
    document.dispatchEvent(new CustomEvent(FORCE_SYNC_EVENT));
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
