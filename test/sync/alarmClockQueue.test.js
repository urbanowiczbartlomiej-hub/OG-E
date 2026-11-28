// Behavioural tests for the queue-as-state alarm clock (sync/alarmClock.js
// `syncAlarmClock`): the ntfy queue is the ONLY shared state, so two devices
// that run against the same fake ntfy server must converge without fighting,
// and nothing may touch GitHub. See docs/ntfy-queue-plan.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** In-memory chrome.storage (per-device: reset between "devices" by the test). */
/** @type {Map<string, unknown>} */
let storage = new Map();
vi.mock('../../src/lib/storage.js', async (orig) => {
  const real = /** @type {any} */ (await orig());
  return {
    ...real,
    chromeStore: {
      get: vi.fn(async (/** @type {string} */ k) => storage.get(k)),
      set: vi.fn(async (/** @type {string} */ k, /** @type {unknown} */ v) => { storage.set(k, v); }),
      getAll: vi.fn(async () => Object.fromEntries(storage)),
      getKeys: vi.fn(async () => [...storage.keys()]),
      remove: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {}),
    },
  };
});
vi.mock('../../src/sync/gist.js', () => ({
  getToken: vi.fn(() => ''),
  getGistId: vi.fn(() => ''),
}));

import { syncAlarmClock } from '../../src/sync/alarmClock.js';
import { decodeClick } from '../../src/domain/ntfyQueue.js';

const UNI = 's280-pl';
const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz0123';
const NOW = 1_800_000_000;

/**
 * Fake ntfy server: one topic's messages, poll / publish / delete.
 * @typedef {{ id: string, time: number, title?: string, click?: string, priority?: number }} Msg
 */
/** @type {Msg[]} */
let server = [];
let seq = 0;
/** @type {string[]} */
let calls = [];

const fakeFetch = vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${url.split('?')[0]}`);
  if (!url.startsWith('https://ntfy.sh/')) throw new Error(`unexpected host: ${url}`);
  const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
  if (method === 'GET') {
    const body = server.map((m) => JSON.stringify({ ...m, event: 'message' })).join('\n');
    return new Response(body, { status: 200 });
  }
  if (method === 'POST') {
    const delay = headers['X-Delay'];
    /** @type {Msg} */
    const m = {
      id: `m${++seq}`,
      time: delay ? Number(delay) : NOW,
      title: headers.Title,
      click: headers['X-Click'],
      priority: Number(headers['X-Priority']),
    };
    server.push(m);
    return new Response(JSON.stringify({ id: m.id }), { status: 200 });
  }
  if (method === 'DELETE') {
    const id = url.split('?')[0].split('/').pop();
    server = server.filter((m) => m.id !== id);
    return new Response('{}', { status: 200 });
  }
  throw new Error(`unexpected method ${method}`);
});

const config = {
  masterEnabled: true,
  enabled: false,
  fsEnabled: true,
  fsThreshold: 1000,
  fsOffsets: '0m, 10m, 20m',
  fsMinFlightSec: 0,
  adhocSchedule: '-5m, 0m',
  guardianEnabled: false,
  ntfyToken: TOKEN,
};

const ARRIVAL = NOW + 3600;
/** An own fleet leg in the event list. */
const leg = (id = 'eventRow-1', arrivalAt = ARRIVAL, shipCount = 646_568) => ({
  id, arrivalAt, shipCount, label: 'Deployment → [6:115:7]',
  origin: '[5:469:15]', originName: 'K3', target: '[6:115:7]', targetName: 'W5',
  landingKey: '6:115:7:1',
});

/** One device's sync round. @param {Record<string, unknown>} dom @param {number} [now] @param {object} [cfg] */
const run = (dom, now = NOW, cfg = config) => syncAlarmClock(/** @type {any} */ (cfg), {
  waveReturns: [], present: [], ...dom,
}, now, UNI);

const fsMsgs = () => server.filter((m) => m.title === `[${UNI}] Fleet save`);

beforeEach(() => {
  storage = new Map();
  server = [];
  seq = 0;
  calls = [];
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queue-as-state alarm clock', () => {
  it('without an ntfy token schedules nothing and says why', async () => {
    const res = await run({}, NOW, { ...config, ntfyToken: '' });
    expect(res).toEqual({ ok: false, reason: 'no-ntfy-token' });
    expect(calls).toEqual([]);
  });

  it('a fresh fleet-save is posted with its identity — and GitHub is never called', async () => {
    const l = leg();
    const res = await run({ present: [l], fleetSaveCandidates: [l] });
    expect(res.ok).toBe(true);
    expect(fsMsgs().map((m) => m.time).sort()).toEqual([ARRIVAL, ARRIVAL + 600, ARRIVAL + 1200]);
    const id = decodeClick(fsMsgs()[0].click);
    expect(id).toMatchObject({ kind: 'fs', key: 'eventRow-1', anchor: ARRIVAL, gen: 1, plan: [0, 600, 1200], extra: '6:115:7:1' });
    expect(calls.every((c) => c.includes('ntfy.sh'))).toBe(true);
  });

  it('a second device adopts the queued fleet-save instead of fighting over it', async () => {
    const l = leg();
    await run({ present: [l], fleetSaveCandidates: [l] });
    const before = fsMsgs().map((m) => m.id).sort();
    storage = new Map(); // device B: no local state at all
    // B would NOT classify it itself (threshold above the ship count) — the
    // queue is the lock, so it stays a fleet-save there too.
    const res = await run({ present: [l], fleetSaveCandidates: [l] }, NOW + 60, { ...config, fsThreshold: 10_000_000 });
    expect(res.fleetSave?.map((e) => e.id)).toEqual(['eventRow-1']);
    expect(fsMsgs().map((m) => m.id).sort()).toEqual(before);
  });

  it('a device that does not know a series leaves it alone', async () => {
    const l = leg();
    await run({ present: [l], fleetSaveCandidates: [l] });
    const n = fsMsgs().length;
    storage = new Map();
    // FS detection off on this device, leg still in flight: not wanted, not gone.
    await run({ present: [l], fleetSaveCandidates: [l] }, NOW + 60, { ...config, fsEnabled: false });
    expect(fsMsgs()).toHaveLength(n);
  });

  it('landing: the row is gone → landing detected, the remaining pings swept (player is back)', async () => {
    const l = leg();
    await run({ present: [l], fleetSaveCandidates: [l] });
    const res = await run({ present: [], fleetSaveCandidates: [] }, ARRIVAL + 30);
    expect(res.landings).toEqual([{ bodyKey: '6:115:7:1', landedAt: ARRIVAL }]);
    expect(fsMsgs().map((m) => m.time)).toEqual([ARRIVAL]); // +10 / +20 min cancelled
  });

  it('ad-hoc: arm posts, a plain rescan keeps it, disarm sweeps it', async () => {
    const l = leg('eventRow-7', NOW + 7200);
    const arm = (/** @type {any[]} */ prev) => [...prev, { id: l.id, arrivalAt: l.arrivalAt, label: l.label }];
    await run({ present: [l], fleetSaveCandidates: [], adhocMutate: arm });
    const ad = () => server.filter((m) => m.title === `[${UNI}] Fleet`);
    expect(ad().map((m) => m.time).sort()).toEqual([l.arrivalAt - 300, l.arrivalAt]);

    storage = new Map(); // another device, no local memory of the arm
    await run({ present: [l], fleetSaveCandidates: [] }, NOW + 60);
    expect(ad()).toHaveLength(2);

    const disarm = (/** @type {any[]} */ prev) => prev.filter((e) => e.id !== l.id);
    await run({ present: [l], fleetSaveCandidates: [], adhocMutate: disarm }, NOW + 120);
    expect(ad()).toHaveLength(0);
  });

  it('a slot cancelled on one device is not re-added by another', async () => {
    const l = leg();
    await run({ present: [l], fleetSaveCandidates: [l] });
    await run({ present: [l], fleetSaveCandidates: [l], fsCancelById: { [l.id]: [1200] } }, NOW + 60);
    expect(fsMsgs().map((m) => m.time).sort()).toEqual([ARRIVAL, ARRIVAL + 600]);
    expect(decodeClick(fsMsgs()[0].click)?.gen).toBe(2);
    storage = new Map();
    await run({ present: [l], fleetSaveCandidates: [l] }, NOW + 120); // B: no cancel known
    expect(fsMsgs().map((m) => m.time).sort()).toEqual([ARRIVAL, ARRIVAL + 600]);
  });

  it('migration: an old-format message at a slot time is retired, never doubled', async () => {
    server.push({ id: 'legacy', time: ARRIVAL + 600, title: `[${UNI}] Fleet save` });
    const l = leg();
    await run({ present: [l], fleetSaveCandidates: [l] });
    expect(fsMsgs().find((m) => m.id === 'legacy')).toBeUndefined();
    expect(fsMsgs().filter((m) => m.time === ARRIVAL + 600)).toHaveLength(1);
  });

  it('never touches another universe\'s messages', async () => {
    server.push({ id: 'other', time: NOW + 999, title: '[s1-pl] Fleet save', click: 'https://s1-pl.ogame.gameforge.com/#oge=1&k=fs&id=eventRow-1&s=0&a=1&g=1&p=0' });
    await run({ present: [], fleetSaveCandidates: [] }, NOW);
    expect(server.find((m) => m.id === 'other')).toBeDefined();
  });
});

describe('queue-as-state alarm clock — expedition waves', () => {
  const wcfg = { ...config, enabled: true, fsEnabled: false, schedule: '0m, 5m' };
  const RET = NOW + 5400;
  /** @param {number} at */
  const returns = (at) => [
    { id: 'eventRow-50', returnAt: at, origin: '5:469:15' },
    { id: 'eventRow-51', returnAt: at + 20, origin: '5:469:15' },
  ];
  const waveMsgs = () => server.filter((m) => m.title === `[${UNI}] Expeditions back`);

  /** Run until the wave is committed (membership settled) on this device. */
  const settle = async (/** @type {number} */ at, /** @type {number} */ from) => {
    for (const t of [from, from + 400, from + 800]) await run({ waveReturns: returns(at) }, t, wcfg);
  };

  it('a second device adopts the queued wave (anchor within tolerance), no double schedule', async () => {
    await settle(RET, NOW);
    const first = waveMsgs().map((m) => m.id).sort();
    expect(first.length).toBeGreaterThan(0);
    storage = new Map(); // device B saw the same wave a bit differently
    await settle(RET + 60, NOW + 900);
    expect(waveMsgs().map((m) => m.id).sort()).toEqual(first);
  });

  it('every member back → the wave\'s remaining pings are swept', async () => {
    await settle(RET, NOW);
    expect(waveMsgs().length).toBeGreaterThan(0);
    await run({ waveReturns: [] }, RET + 30, wcfg);
    expect(waveMsgs().filter((m) => m.time > RET + 30)).toHaveLength(0);
  });
});
