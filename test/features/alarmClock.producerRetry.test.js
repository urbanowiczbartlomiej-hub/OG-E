// @vitest-environment happy-dom
//
// Behavioural tests for the alarmClock producer's self-retry after a failed
// sync. The live bug: a failed sync (gist rate-limit backoff) only set
// `pendingForce` and waited for an UNRELATED trigger, so a clicked ad-hoc
// reminder sat in "syncing" (hourglass) and never reached ntfy. Now the
// producer retries on its own timer — just past an active backoff, else with
// a doubling delay — until the queued intent drains.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const syncAlarmClock = vi.fn();
let backoffUntil = 0;

vi.mock('../../src/sync/alarmClock.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  syncAlarmClock: (/** @type {unknown[]} */ ...args) => syncAlarmClock(...args),
}));
vi.mock('../../src/sync/gist.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  getBackoffUntil: () => backoffUntil,
}));

const { installAlarmClockProducer, _resetAlarmClockProducerForTest } =
  await import('../../src/features/alarmClock/producer.js');
const { readPending } = await import('../../src/features/alarmClock/pending.js');

const OK = { ok: true, changed: true, scheduled: 1, cancelled: 0, fleetSave: [], landings: [], failedKinds: {} };
const entry = { id: 'eventRow-1', arrivalAt: 2_000_000_000, label: 'x', createdAt: 1 };

/** Flush the producer's awaited promise chain without advancing time much. */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/**
 * Install the producer and let its own initial (debounced) pass settle first:
 * with an empty queue and the master switch off it is a no-op, so every
 * counted sync below is one the test caused.
 */
const installed = async () => {
  const p = installAlarmClockProducer();
  await vi.advanceTimersByTimeAsync(1_600);
  expect(syncAlarmClock).not.toHaveBeenCalled();
  return p;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  backoffUntil = 0;
  syncAlarmClock.mockReset();
  document.body.innerHTML = '<table id="eventContent"><tbody></tbody></table>';
});

afterEach(() => {
  _resetAlarmClockProducerForTest();
  vi.useRealTimers();
});

describe('alarmClock producer — retry after a failed sync', () => {
  it('retries on its own after a thrown sync and drains the queued arm', async () => {
    syncAlarmClock.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValue(OK);
    const p = await installed();
    const uni = p.universeId;
    p.armAdhoc(entry);
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(1);
    expect(readPending(uni)).toHaveLength(1); // failed → intent kept

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(2);
    expect(readPending(uni)).toHaveLength(0); // retried → drained
  });

  it('waits until just past an active gist backoff before retrying', async () => {
    backoffUntil = Date.now() + 60_000;
    syncAlarmClock.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue(OK);
    const p = await installed();
    p.armAdhoc(entry);
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncAlarmClock).toHaveBeenCalledTimes(1); // still inside the backoff
    await vi.advanceTimersByTimeAsync(31_500);
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(2);
    expect(readPending(p.universeId)).toHaveLength(0);
  });

  it('doubles the retry delay on consecutive failures', async () => {
    syncAlarmClock
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue(OK);
    const p = await installed();
    p.armAdhoc(entry);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000); // 1st retry (fails)
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000); // not yet — next delay is 20 s
    expect(syncAlarmClock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_500);
    await flush();
    expect(syncAlarmClock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent no-token result', async () => {
    syncAlarmClock.mockResolvedValue({ ok: false, reason: 'no-token' });
    const p = await installed();
    p.armAdhoc(entry);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncAlarmClock).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a pending retry', async () => {
    syncAlarmClock.mockRejectedValue(new Error('down'));
    const p = await installed();
    p.armAdhoc(entry);
    await flush();
    p.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncAlarmClock).toHaveBeenCalledTimes(1);
  });
});
