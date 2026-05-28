// @ts-check

// Unit tests for the ntfy.sh scheduler. `fetch` is stubbed globally so
// these tests don't touch the network — we assert on the calls made,
// not on real ntfy responses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleWaveReminders,
  cancelWaveReminders,
  fetchScheduledMessages,
  priorityForReminder,
  REMINDER_COUNT,
  REMINDER_INTERVAL_SEC,
} from '../../src/sync/ntfyScheduler.js';

/** @type {ReturnType<typeof vi.fn>} */
let fetchMock;

/** @param {{ id?: string }} body */
const okResponse = (body = { id: 'msg' }) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errResponse = (status = 500, body = 'kaboom') => ({
  ok: false,
  status,
  statusText: 'ERR',
  json: async () => ({}),
  text: async () => body,
});

beforeEach(() => {
  fetchMock = vi.fn();
  // @ts-expect-error — overriding the global for the test scope.
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const WAVE = {
  id: 'w_1-1-1__1-2-1',
  nextWaveAt: 2000,
  fleetCount: 2,
  origins: ['1:1:1', '1:2:1'],
};

describe('scheduleWaveReminders', () => {
  it('publishes REMINDER_COUNT (=6) messages with X-Delay spaced REMINDER_INTERVAL_SEC apart', async () => {
    let i = 0;
    fetchMock.mockImplementation(async () => okResponse({ id: `id-${i++}` }));

    const ids = await scheduleWaveReminders({
      wave: WAVE,
      topic: 'oge-test',
      token: 'tk_abc',
      now: 1000,
      universeId: 's163-pl',
    });

    expect(ids).toHaveLength(REMINDER_COUNT);
    expect(ids).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5']);
    expect(fetchMock).toHaveBeenCalledTimes(REMINDER_COUNT);

    const expectedAuth = 'auth=' + btoa(':tk_abc');
    for (let slot = 0; slot < REMINDER_COUNT; slot++) {
      const [url, init] = fetchMock.mock.calls[slot];
      expect(url).toBe(`https://ntfy.sh/oge-test?${expectedAuth}`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers['X-Delay']).toBe(
        String(WAVE.nextWaveAt + slot * REMINDER_INTERVAL_SEC),
      );
    }
  });

  it('omits X-Delay for slots whose absolute time is already (within 10s of) now', async () => {
    fetchMock.mockImplementation(async () => okResponse({ id: 'x' }));
    await scheduleWaveReminders({
      wave: WAVE, topic: 'oge-test', token: 'tk', now: 2005, universeId: 's163-pl',
    });
    const slot0Init = fetchMock.mock.calls[0][1];
    expect(slot0Init.headers['X-Delay']).toBeUndefined();
    const slot1Init = fetchMock.mock.calls[1][1];
    expect(slot1Init.headers['X-Delay']).toBe('2600');
  });

  it('escalates priority: 3,3,4,4,5,5 across the six reminders', async () => {
    fetchMock.mockImplementation(async () => okResponse({ id: 'x' }));
    await scheduleWaveReminders({
      wave: WAVE, topic: 't', token: 'tk', now: 0, universeId: 's163-pl',
    });
    expect(fetchMock.mock.calls.map((c) => c[1].headers.Priority)).toEqual(
      ['3', '3', '4', '4', '5', '5'],
    );
  });

  it('uses the universe-prefixed title and a simple body', async () => {
    fetchMock.mockImplementation(async () => okResponse({ id: 'x' }));
    await scheduleWaveReminders({
      wave: WAVE, topic: 't', token: 'tk', now: 0, universeId: 's163-pl',
    });
    for (let slot = 0; slot < REMINDER_COUNT; slot++) {
      const init = fetchMock.mock.calls[slot][1];
      expect(init.headers.Title).toBe('[s163-pl] Expeditions back');
      expect(init.body).toBe(`Expeditions returned - Reminder #${slot + 1}.`);
    }
  });

  it('throws on ntfy error and surfaces the response body', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(429, 'rate limited'));
    await expect(
      scheduleWaveReminders({
        wave: WAVE, topic: 't', token: 'tk', now: 0, universeId: 's163-pl',
      }),
    ).rejects.toThrow(/429.*rate limited/);
  });

  it('throws when ntfy returns OK without an id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    await expect(
      scheduleWaveReminders({
        wave: WAVE, topic: 't', token: 'tk', now: 0, universeId: 's163-pl',
      }),
    ).rejects.toThrow(/missing id/);
  });
});

describe('priorityForReminder', () => {
  it('starts at default (3), climbs by one band every two reminders, caps at max (5)', () => {
    expect([1, 2, 3, 4, 5, 6].map(priorityForReminder)).toEqual([3, 3, 4, 4, 5, 5]);
  });

  it('clamps non-positive and over-range inputs', () => {
    expect(priorityForReminder(0)).toBe(3);
    expect(priorityForReminder(-1)).toBe(3);
    expect(priorityForReminder(99)).toBe(5);
  });
});

describe('fetchScheduledMessages', () => {
  /** @param {string} text */
  const ndjsonResponse = (text) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => text,
  });

  it('GETs /topic/json?poll=1&scheduled=1&auth=… (no Authorization header)', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(''));
    await fetchScheduledMessages({ topic: 'oge-t', token: 'tk_abc', now: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://ntfy.sh/oge-t/json?poll=1&scheduled=1&auth=${btoa(':tk_abc')}`);
    expect(init).toBeUndefined();
  });

  it('parses NDJSON: one message per line, future-only', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(
      '{"id":"a","time":2000,"event":"message","message":"m1"}\n' +
      '{"id":"b","time":2600,"event":"message","message":"m2"}\n',
    ));
    const out = await fetchScheduledMessages({ topic: 't', token: 'tk', now: 1500 });
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out[0].time).toBe(2000);
  });

  it('drops past-delivered messages still in ntfy cache (time <= now)', async () => {
    // ntfy's poll endpoint returns ~12h of cache content including
    // already-delivered messages. We MUST filter them — otherwise the
    // orphan sweep DELETEs them and ntfy bills each request against
    // our account quota.
    fetchMock.mockResolvedValue(ndjsonResponse(
      '{"id":"past","time":900,"event":"message","message":"already fired"}\n' +
      '{"id":"now","time":1000,"event":"message","message":"exactly now"}\n' +
      '{"id":"future","time":1500,"event":"message","message":"upcoming"}\n',
    ));
    const out = await fetchScheduledMessages({ topic: 't', token: 'tk', now: 1000 });
    expect(out.map((m) => m.id)).toEqual(['future']);
  });

  it('skips message_delete audit events even when in the future', async () => {
    // ntfy records every cancellation as its own log entry that lingers
    // in the cache; those have `event === "message_delete"` and must
    // not be treated as queued messages.
    fetchMock.mockResolvedValue(ndjsonResponse(
      '{"id":"del","time":5000,"event":"message_delete"}\n' +
      '{"id":"real","time":5000,"event":"message"}\n',
    ));
    const out = await fetchScheduledMessages({ topic: 't', token: 'tk', now: 1000 });
    expect(out.map((m) => m.id)).toEqual(['real']);
  });

  it('skips keepalives and other non-"message" event types', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(
      '{"id":"k","event":"keepalive","time":5000}\n' +
      '{"id":"a","time":2000,"event":"message"}\n',
    ));
    const out = await fetchScheduledMessages({ topic: 't', token: 'tk', now: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('skips malformed lines without poisoning the whole response', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(
      '{"id":"a","time":2000,"event":"message"}\n' +
      'not json\n' +
      '{"id":"b","time":3000,"event":"message"}\n',
    ));
    const out = await fetchScheduledMessages({ topic: 't', token: 'tk', now: 1000 });
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('returns empty array for empty body', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(''));
    expect(await fetchScheduledMessages({ topic: 't', token: 'tk', now: 0 })).toEqual([]);
  });

  it('throws on non-OK with the response body in the message', async () => {
    fetchMock.mockResolvedValue(errResponse(401, 'unauthorized'));
    await expect(
      fetchScheduledMessages({ topic: 't', token: 'bad', now: 0 }),
    ).rejects.toThrow(/401.*unauthorized/);
  });
});

describe('cancelWaveReminders', () => {
  it('DELETEs each id via ?auth=… URL (no Authorization header)', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const ok = await cancelWaveReminders({
      ids: ['a', 'b', 'c'], topic: 't', token: 'tk',
    });
    const expectedAuth = 'auth=' + btoa(':tk');
    expect(ok).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const [url, init] = fetchMock.mock.calls[i];
      expect(url).toBe(`https://ntfy.sh/t/${['a','b','c'][i]}?${expectedAuth}`);
      expect(init.method).toBe('DELETE');
      expect(init.headers).toBeUndefined();
    }
  });

  it('swallows per-id failures (a 404 on an already-fired message is fine)', async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(404))
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(errResponse(500));
    const ok = await cancelWaveReminders({
      ids: ['x', 'y', 'z'], topic: 't', token: 'tk',
    });
    expect(ok).toBe(1);
  });

  it('is a no-op for an empty / missing id list', async () => {
    expect(await cancelWaveReminders({ ids: [], topic: 't', token: 'tk' })).toBe(0);
    // @ts-expect-error — defensive against undefined input
    expect(await cancelWaveReminders({ ids: undefined, topic: 't', token: 'tk' })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
