// @ts-check

// Unit tests for the ntfy.sh queue reconciler. `fetch` is stubbed globally so
// these tests don't touch the network — we assert on the calls made,
// not on real ntfy responses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  reconcileWaveQueue,
  reconcileAdhocQueue,
  reconcileFleetSaveQueue,
  adhocTitleFor,
  fsTitleFor,
  reminderFireTimes,
  titleFor,
  cancelWaveReminders,
  fetchScheduledMessages,
  offsetsForSchedule,
  DEFAULT_WAVE_OFFSETS_SEC,
  WAVE_PRIORITY,
  ADHOC_PRIORITY,
} from '../../src/sync/ntfyReconciler.js';
import { logger } from '../../src/lib/logger.js';

/**
 * Expected `auth=…` query param: base64 of the full `Authorization` header
 * (`Bearer <token>`), url-safe and stripped of `=` padding — exactly the
 * recipe ntfy documents (`echo -n "Bearer …" | base64 | tr -d '='`). Pins
 * the wire format independently of the production helper so a regression to
 * the old anonymous `btoa(':' + token)` form trips loudly.
 *
 * @param {string} token
 * @returns {string}
 */
const expectedAuthParam = (token) =>
  'auth=' + btoa('Bearer ' + token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

/** NDJSON poll response for the queue GET. @param {string[]} lines */
const queueResponse = (lines) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => lines.join('\n'),
});

/**
 * Dispatch fetch by method/URL so a reconcile pass (one GET poll, then N
 * POSTs, then maybe DELETEs) can be driven from a single mock. POSTs hand
 * back sequential `post-0`, `post-1`, … ids.
 *
 * @param {string[]} queueLines  NDJSON lines the poll returns.
 */
const dispatchReconcile = (queueLines) => {
  let postSeq = 0;
  fetchMock.mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/json?poll=1')) return queueResponse(queueLines);
    if (method === 'POST') return okResponse({ id: `post-${postSeq++}` });
    if (method === 'DELETE') return okResponse();
    throw new Error(`unexpected ${method} ${url}`);
  });
};

const TITLE = titleFor('s163-pl');
/** One queue NDJSON line for a message of ours at `time`. @param {string} id @param {number} time */
const ourMsg = (id, time) =>
  JSON.stringify({ id, time, event: 'message', title: TITLE });

describe('reminderFireTimes', () => {
  it('defaults to the default wave schedule offsets', () => {
    expect(reminderFireTimes(2000)).toEqual(DEFAULT_WAVE_OFFSETS_SEC.map((o) => 2000 + o));
    expect(reminderFireTimes(2000)).toHaveLength(DEFAULT_WAVE_OFFSETS_SEC.length);
  });

  it('applies an explicit offset list relative to baseAt', () => {
    expect(reminderFireTimes(2000, [0, 300, 900])).toEqual([2000, 2300, 2900]);
  });
});

describe('offsetsForSchedule', () => {
  it('parses a free-form minutes-first list into seconds after the wave returns', () => {
    expect(offsetsForSchedule('0m, 10m, 30m, 60m')).toEqual([0, 600, 1800, 3600]);
    expect(offsetsForSchedule('0, 5, 15')).toEqual([0, 300, 900]); // bare = minutes
    expect(offsetsForSchedule('90s, 2m')).toEqual([90, 120]);
  });

  it('drops negatives — a wave reminder cannot fire before the wave is back', () => {
    expect(offsetsForSchedule('-10m, 0m, 10m')).toEqual([0, 600]);
  });

  it('falls back to the default offsets for empty / all-garbage input (incl. an old preset key)', () => {
    expect(offsetsForSchedule('nope')).toEqual(DEFAULT_WAVE_OFFSETS_SEC);
    expect(offsetsForSchedule('standard')).toEqual(DEFAULT_WAVE_OFFSETS_SEC);
    expect(offsetsForSchedule(undefined)).toEqual(DEFAULT_WAVE_OFFSETS_SEC);
    expect(offsetsForSchedule('')).toEqual(DEFAULT_WAVE_OFFSETS_SEC);
  });
});

describe('titleFor', () => {
  it('prefixes the universe id', () => {
    expect(titleFor('s163-pl')).toBe('[s163-pl] Expeditions back');
  });
});

describe('reconcileWaveQueue', () => {
  const base = { topic: 'oge-test', token: 'tk_abc', universeId: 's163-pl' };
  // A uniform 6×10-min cadence, passed EXPLICITLY to every call so these
  // tests exercise slot math independently of the production default
  // (which the player can now override to any free-form list).
  const WAVE_OFFSETS = [0, 600, 1200, 1800, 2400, 3000];
  const WAVE_COUNT = WAVE_OFFSETS.length;
  const WAVE_INTERVAL = 600;

  it('posts every future slot when the queue is empty', async () => {
    dispatchReconcile([]);
    const { idsByWave, posted, cancelled } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec: WAVE_OFFSETS,
    });

    expect(posted).toBe(WAVE_COUNT);
    expect(cancelled).toBe(0);
    expect(idsByWave.w_2000).toEqual(['post-0', 'post-1', 'post-2', 'post-3', 'post-4', 'post-5']);

    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(WAVE_COUNT);
    const expectedAuth = expectedAuthParam('tk_abc');
    posts.forEach(([url, init], slot) => {
      expect(url).toBe(`https://ntfy.sh/oge-test?${expectedAuth}`);
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers.Title).toBe(TITLE);
      expect(init.headers['X-Delay']).toBe(String(2000 + slot * WAVE_INTERVAL));
      // Wave reminders are flat "default" priority now (3) — no escalation.
      expect(init.headers.Priority).toBe(String(WAVE_PRIORITY));
      // Tags were dropped entirely — no `Tags` header on any push.
      expect(init.headers.Tags).toBeUndefined();
      // Icon is a public https URL (ntfy app fetches it; moz-extension:// won't do).
      expect(init.headers.Icon).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\/icons\/icon128\.png$/);
      // Body states the wave's local return time + slot position; exact
      // clock string is TZ-dependent, so assert the shape. Wave nudges are
      // not max priority, so they carry no 🔥 flare.
      expect(init.body).toMatch(/^Expeditions back \(\d{1,2}:\d{2}(?:\s?[AP]M)?\) — reminder #\d+\/6\.$/);
    });
  });

  it('logs (and throws) when a 2xx publish response carries no id — a latent orphan', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    // GET poll → empty queue; POST → 2xx but the JSON body has no `id`, so we
    // have no cancellation handle for a message ntfy DID schedule.
    fetchMock.mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/json?poll=1')) return queueResponse([]);
      if (method === 'POST')
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({}), text: async () => '{}' };
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(
      reconcileWaveQueue({
        ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec: WAVE_OFFSETS,
      }),
    ).rejects.toThrow(/missing id/);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing id'));
  });

  it('honours an arbitrary schedule: posts one slot per offset at baseAt+offset', async () => {
    dispatchReconcile([]);
    const offsetsSec = [0, 300, 600, 900]; // 4 slots
    const { posted, idsByWave } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec,
    });

    expect(posted).toBe(offsetsSec.length);
    expect(idsByWave.w_2000).toHaveLength(offsetsSec.length);
    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    posts.forEach(([, init], slot) => {
      expect(init.headers['X-Delay']).toBe(String(2000 + offsetsSec[slot]));
      // Body slot count reflects the schedule length, not a hard-coded 6.
      expect(init.body).toContain(`/${offsetsSec.length}.`);
    });
  });

  it('queues a longer schedule at the given offsets', async () => {
    dispatchReconcile([]);
    const offsetsSec = [0, 180, 300, 480, 780, 1260, 2040, 3300];
    const { posted } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_5000', baseAt: 5000 }], offsetsSec,
    });
    expect(posted).toBe(8);
    const delays = fetchMock.mock.calls
      .filter((c) => c[1]?.method === 'POST')
      .map((c) => Number(c[1].headers['X-Delay']));
    expect(delays).toEqual(offsetsSec.map((o) => 5000 + o));
  });

  it('is idempotent: a fully-queued wave posts nothing and reuses the queued ids', async () => {
    const times = reminderFireTimes(2000, WAVE_OFFSETS);
    dispatchReconcile(times.map((t, i) => ourMsg(`q${i}`, t)));
    const { idsByWave, posted, cancelled } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec: WAVE_OFFSETS,
    });

    expect(posted).toBe(0);
    expect(cancelled).toBe(0);
    expect(idsByWave.w_2000).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('fills only the gaps of a partial (reload-interrupted) schedule', async () => {
    const times = reminderFireTimes(2000, WAVE_OFFSETS);
    // Only slots 0,1,2 made it onto the queue before the page reloaded.
    dispatchReconcile([ourMsg('q0', times[0]), ourMsg('q1', times[1]), ourMsg('q2', times[2])]);
    const { idsByWave, posted, cancelled } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec: WAVE_OFFSETS,
    });

    expect(posted).toBe(3);
    expect(cancelled).toBe(0);
    // Existing ids reused, new ones appended in fire order.
    expect(idsByWave.w_2000).toEqual(['q0', 'q1', 'q2', 'post-0', 'post-1', 'post-2']);
  });

  it('sweeps our messages that belong to no live wave (landed / re-sent / drifted)', async () => {
    // A live wave at baseAt=2000 plus a stale message at 9999 (no wave).
    const times = reminderFireTimes(2000, WAVE_OFFSETS);
    dispatchReconcile([...times.map((t, i) => ourMsg(`q${i}`, t)), ourMsg('stale', 9999)]);
    const { cancelled, posted } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_2000', baseAt: 2000 }], offsetsSec: WAVE_OFFSETS,
    });

    expect(posted).toBe(0);
    expect(cancelled).toBe(1);
    const del = fetchMock.mock.calls.find((c) => c[1]?.method === 'DELETE');
    expect(del?.[0]).toContain('/stale?');
  });

  it('cancels everything for the universe when no live waves are passed (feature off)', async () => {
    const times = reminderFireTimes(2000, WAVE_OFFSETS);
    dispatchReconcile(times.map((t, i) => ourMsg(`q${i}`, t)));
    const { posted, cancelled } = await reconcileWaveQueue({ ...base, now: 1000, waves: [] });

    expect(posted).toBe(0);
    expect(cancelled).toBe(WAVE_COUNT);
  });

  it('never touches another universe\'s messages on the shared topic', async () => {
    const otherTitle = titleFor('s201-pl');
    const otherMsg = JSON.stringify({ id: 'other', time: 9999, event: 'message', title: otherTitle });
    dispatchReconcile([otherMsg]);
    const { posted, cancelled } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [], // even with nothing of ours wanted…
    });
    expect(posted).toBe(0);
    expect(cancelled).toBe(0); // …the other server's message survives.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
  });

  it('protects an imminent slot (fires in <10s) from being swept or re-posted', async () => {
    // baseAt=1005, now=1000 → slot 0 at 1005 is in the future but too soon
    // to (re)schedule. It must stay queued and must not be re-posted.
    const queuedImminent = ourMsg('q-soon', 1005);
    const times = reminderFireTimes(1005, WAVE_OFFSETS); // [1005,1605,2205,2805,3405,4005]
    // Pre-queue slot 0 only; the rest are gaps to fill.
    dispatchReconcile([queuedImminent]);
    const { idsByWave, posted, cancelled } = await reconcileWaveQueue({
      ...base, now: 1000, waves: [{ id: 'w_1005', baseAt: 1005 }], offsetsSec: WAVE_OFFSETS,
    });

    expect(cancelled).toBe(0); // slot 0 protected (time 1005 > now)
    expect(posted).toBe(WAVE_COUNT - 1); // slots 1..5 posted
    // slot 0 is too-soon → not in the returned id set; only schedulable slots are.
    expect(idsByWave.w_1005).toEqual(['post-0', 'post-1', 'post-2', 'post-3', 'post-4']);
    expect(times[0]).toBe(1005);
  });
});

describe('adhocTitleFor', () => {
  it('prefixes the universe id and differs from the wave title', () => {
    expect(adhocTitleFor('s163-pl')).toBe('[s163-pl] Fleet');
    expect(adhocTitleFor('s163-pl')).not.toBe(titleFor('s163-pl'));
  });
});

describe('reconcileAdhocQueue', () => {
  const base = { topic: 'oge-test', token: 'tk_abc', universeId: 's163-pl' };
  const ADHOC_TITLE = adhocTitleFor('s163-pl');
  /** @param {string} id @param {number} time */
  const ourAdhoc = (id, time) =>
    JSON.stringify({ id, time, event: 'message', title: ADHOC_TITLE });

  it('posts one max-priority slot per entry at its fireAt, under the ad-hoc title', async () => {
    dispatchReconcile([]);
    const { idsByEntry, posted, cancelled } = await reconcileAdhocQueue({
      ...base, now: 1000,
      entries: [{ id: 'eventRow-42', fireAt: 5000, body: 'Ekspedycja → [4:467:16] o 20:23' }],
    });

    expect(posted).toBe(1);
    expect(cancelled).toBe(0);
    expect(idsByEntry['eventRow-42']).toEqual(['post-0']);

    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(post?.[1].headers.Title).toBe(ADHOC_TITLE);
    expect(post?.[1].headers.Priority).toBe(String(ADHOC_PRIORITY));
    // No `Tags` header any more.
    expect(post?.[1].headers.Tags).toBeUndefined();
    expect(post?.[1].headers['X-Delay']).toBe('5000');
    // Max-priority pushes carry the RED icon variant.
    expect(post?.[1].headers.Icon).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\/icons\/icon_red\.png$/);
    // Max-priority (player-armed) bodies get a trailing 🔥 flare.
    expect(post?.[1].body).toBe('Ekspedycja → [4:467:16] o 20:23 🔥');
  });

  it('is idempotent: an already-queued entry posts nothing and reuses the id', async () => {
    dispatchReconcile([ourAdhoc('q0', 5000)]);
    const { idsByEntry, posted } = await reconcileAdhocQueue({
      ...base, now: 1000,
      entries: [{ id: 'eventRow-42', fireAt: 5000, body: 'x' }],
    });
    expect(posted).toBe(0);
    expect(idsByEntry['eventRow-42']).toEqual(['q0']);
  });

  it('sweeps ad-hoc messages with no live entry, and cancels all when entries is empty', async () => {
    dispatchReconcile([ourAdhoc('q0', 5000), ourAdhoc('q1', 6000)]);
    const { posted, cancelled } = await reconcileAdhocQueue({ ...base, now: 1000, entries: [] });
    expect(posted).toBe(0);
    expect(cancelled).toBe(2);
  });

  it('never touches WAVE messages on the same shared topic (different title)', async () => {
    // A queued wave message must survive an ad-hoc reconcile that wants
    // nothing — the two kinds are separated purely by title.
    const waveMsg = JSON.stringify({ id: 'wave', time: 5000, event: 'message', title: titleFor('s163-pl') });
    dispatchReconcile([waveMsg]);
    const { posted, cancelled } = await reconcileAdhocQueue({ ...base, now: 1000, entries: [] });
    expect(posted).toBe(0);
    expect(cancelled).toBe(0);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
  });
});

describe('fsTitleFor', () => {
  it('prefixes the universe id and differs from the wave + ad-hoc titles', () => {
    expect(fsTitleFor('s163-pl')).toBe('[s163-pl] Fleet save');
    expect(fsTitleFor('s163-pl')).not.toBe(titleFor('s163-pl'));
    expect(fsTitleFor('s163-pl')).not.toBe(adhocTitleFor('s163-pl'));
  });
});

describe('reconcileFleetSaveQueue', () => {
  const base = { topic: 'oge-test', token: 'tk_abc', universeId: 's163-pl' };
  const FS_TITLE = fsTitleFor('s163-pl');
  /** @param {string} id @param {number} time */
  const ourFs = (id, time) => JSON.stringify({ id, time, event: 'message', title: FS_TITLE });

  it('posts one max-priority slot per future fireAt, under the FS title', async () => {
    dispatchReconcile([]);
    const { idsByEntry, posted, cancelled } = await reconcileFleetSaveQueue({
      ...base, now: 1000,
      entries: [{ id: 'eventRow-9', arrivalAt: 5000, label: 'Deployment → [4:478:14]', fireAts: [4400, 5000, 5600] }],
    });

    expect(posted).toBe(3);
    expect(cancelled).toBe(0);
    expect(idsByEntry['eventRow-9']).toEqual(['post-0', 'post-1', 'post-2']);

    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p[1].headers.Title).toBe(FS_TITLE);
      expect(p[1].headers.Priority).toBe(String(ADHOC_PRIORITY));
    }
    // Bodies state before/at/after landing honestly.
    const bodies = posts.map((p) => p[1].body);
    expect(bodies.some((b) => /before landing/.test(b))).toBe(true);
    expect(bodies.some((b) => /landing now/.test(b))).toBe(true);
    expect(bodies.some((b) => /after landing/.test(b))).toBe(true);
  });

  it('drops slots past ntfy\'s 3-day cap (would otherwise be rejected forever)', async () => {
    dispatchReconcile([]);
    const FOUR_DAYS = 4 * 24 * 3600;
    const { posted } = await reconcileFleetSaveQueue({
      ...base, now: 1000,
      entries: [{ id: 'eventRow-9', arrivalAt: 1000 + FOUR_DAYS, label: 'x', fireAts: [1000 + FOUR_DAYS] }],
    });
    expect(posted).toBe(0);
  });

  it('sweeps FS messages with no live entry, and cancels all when entries is empty', async () => {
    dispatchReconcile([ourFs('q0', 5000), ourFs('q1', 6000)]);
    const { posted, cancelled } = await reconcileFleetSaveQueue({ ...base, now: 1000, entries: [] });
    expect(posted).toBe(0);
    expect(cancelled).toBe(2);
  });

  it('never touches wave or ad-hoc messages on the shared topic (distinct title)', async () => {
    const waveMsg = JSON.stringify({ id: 'w', time: 5000, event: 'message', title: titleFor('s163-pl') });
    const adhocMsg = JSON.stringify({ id: 'a', time: 6000, event: 'message', title: adhocTitleFor('s163-pl') });
    dispatchReconcile([waveMsg, adhocMsg]);
    const { posted, cancelled } = await reconcileFleetSaveQueue({ ...base, now: 1000, entries: [] });
    expect(posted).toBe(0);
    expect(cancelled).toBe(0);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
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
    expect(url).toBe(`https://ntfy.sh/oge-t/json?poll=1&scheduled=1&${expectedAuthParam('tk_abc')}`);
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
    const expectedAuth = expectedAuthParam('tk');
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
