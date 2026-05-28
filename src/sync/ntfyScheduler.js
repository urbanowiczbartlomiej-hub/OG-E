// @ts-check

// ntfy.sh scheduled-delivery client. The only piece of OG-E that actually
// talks to ntfy.sh — everything upstream just hands us a wave + topic +
// token. There is no `wrangler`-deployed Worker any more; ntfy.sh's own
// queue is the cron.
//
// # How scheduling works on ntfy
//
// `POST https://ntfy.sh/<topic>` with the `X-Delay` header schedules the
// message for future delivery. The header accepts a Unix timestamp (or
// duration/natural-language; we always send an epoch second). ntfy holds
// the message in its server-side queue and pushes it at the scheduled
// moment, regardless of whether anyone is "watching". The publish
// response is JSON containing `id` — that's the cancellation handle:
// `DELETE https://ntfy.sh/<topic>/<id>` removes a scheduled message
// before delivery (no-op if it already fired or never existed).
//
// Hard constraints (from ntfy docs):
//   - minimum delay  10 seconds
//   - maximum delay  3 days
//
// We schedule SIX messages per wave (`REMINDER_COUNT`), 10 minutes apart
// (`REMINDER_INTERVAL_SEC`), starting at the wave's `nextWaveAt`. Sub-
// minimum delays are sent immediately (no X-Delay header) — that covers
// the case where the player opens a game tab AFTER a wave already
// landed, so the first reminder fires right away.
//
// # Authentication
//
// ntfy.sh's free / Pro plans rate-limit anonymous publishers per IP. The
// Cloudflare-edge IPs are shared by thousands of Workers, so anonymous
// publishing from a Worker is unworkable in practice; that's why we made
// the user paste a personal access token. With the token, the per-IP
// budget no longer applies — the rate limit is per account. The token
// is mirrored from chrome.storage by the histogram tab and passed in
// here as a parameter; this module never reads storage directly.

/* global fetch */

/**
 * Fetch wrapper for ntfy.sh requests. Routes through the background
 * service worker when running inside an extension content script, so
 * the request is made from extension origin and bypasses Firefox's
 * CORS restriction on content scripts.
 *
 * # Why the proxy is needed
 *
 * Firefox content scripts are subject to CORS even when the extension
 * has declared `host_permissions` for the target. ntfy.sh responds to
 * CORS preflights with `Access-Control-Allow-Headers: *`; per the Fetch
 * spec that wildcard does NOT cover `Authorization`, so every ntfy
 * request with a Bearer token fails the preflight and is never sent.
 *
 * The background service worker (`src/background.js`) runs at extension
 * origin. Extension-origin requests bypass web-page CORS restrictions,
 * so the Authorization header goes through without issue.
 *
 * # Test-environment fallback
 *
 * `browser` is undefined in Node / happy-dom. The fallback path uses
 * `globalThis.fetch` directly, keeping all existing test stubs working
 * with no changes to the test suite.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, text(): Promise<string>, json(): Promise<unknown> }>}
 */
const ntfyFetch = async (url, init = {}) => {
  // Access `browser` via globalThis so TypeScript doesn't error under
  // strict mode — `browser` isn't declared in lib.dom and we must treat
  // it as a possibly-undefined property on the global object (same
  // pattern as `pickStorage` in lib/storage.js).
  const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
  if (g.browser?.runtime?.sendMessage) {
    const result = await g.browser.runtime.sendMessage({
      type: 'ntfy-fetch',
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ?? null,
    });
    const { text } = result;
    return {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }
  // Test environment or non-extension context — use fetch directly.
  return /** @type {any} */ (fetch(url, init));
};

/**
 * Total reminders queued per wave. Six × ten minutes ≈ one hour of
 * nudges — long enough that an AFK player should notice, short enough
 * that an already-acknowledged-but-not-yet-resent wave doesn't keep
 * vibrating into the next day.
 */
export const REMINDER_COUNT = 6;

/** Gap, in seconds, between consecutive reminders for the same wave. */
export const REMINDER_INTERVAL_SEC = 600;

/** ntfy's documented minimum `X-Delay` value (anything smaller fires immediately). */
const NTFY_MIN_DELAY_SEC = 10;

/**
 * Schedule {@link REMINDER_COUNT} pushes for one wave. Returns the
 * array of ntfy message ids in the order they were scheduled — keep
 * this array for the cancellation handle.
 *
 * Each push fires at `nextWaveAt + i * REMINDER_INTERVAL_SEC`. Pushes
 * whose absolute time is already <= now + 10s are sent immediately
 * (no `X-Delay` header); the rest get an `X-Delay` with the absolute
 * Unix timestamp.
 *
 * Priority escalates across the six reminders — default→high→max,
 * two per band — so a user who shrugs off the first ping gets louder
 * later ones. See `postOne` for the exact ladder.
 *
 * Network failures throw — the caller (in `syncReminderWaves`) treats
 * a partial schedule as "try again next sync tick" by NOT persisting
 * an advance in `lastSig`. Already-scheduled ids inside this call are
 * returned even if a later one fails, so the caller can cancel them.
 *
 * @param {object} args
 * @param {{ id: string, nextWaveAt: number, fleetCount: number, origins: string[] }} args.wave
 * @param {string} args.topic
 * @param {string} args.token   ntfy.sh access token (Bearer).
 * @param {number} args.now     Epoch SECONDS — pass injected for testability.
 * @param {string} args.universeId  OGame server id, used as the title prefix.
 * @returns {Promise<string[]>}
 */
export const scheduleWaveReminders = async ({ wave, topic, token, now, universeId }) => {
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < REMINDER_COUNT; i++) {
    const fireAt = wave.nextWaveAt + i * REMINDER_INTERVAL_SEC;
    const id = await postOne({ topic, token, fireAt, now, n: i + 1, universeId });
    ids.push(id);
  }
  return ids;
};

/**
 * Fetch ntfy's currently-scheduled queue for `topic`. Each entry is one
 * undelivered scheduled message — i.e. `time` is strictly in the future.
 * Used by the OG-E Dashboard's Reminders tab to render the actual
 * upcoming push times (cross-referenced against the gist's per-wave
 * `scheduledMessageIds`) and by the orphan-cleanup sweep.
 *
 * # Why the explicit `time > now` filter
 *
 * `?poll=1&scheduled=1` returns ntfy's entire ~12 h message log, not
 * just future-scheduled messages: past delivered messages, scheduled
 * messages, AND `message_delete` audit events. We filter to:
 *
 *   - `event === 'message'` (drop keepalives + delete records), AND
 *   - `time > now` (drop past-delivered messages that are still in
 *     ntfy's cache but already fired — sweeping those just burns
 *     account quota on no-op DELETEs).
 *
 * Each undelivered entry contains:
 *
 *   - `id`   — ntfy message id (matches what `scheduleWaveReminders`
 *              returned).
 *   - `time` — Unix epoch seconds the push will fire (for scheduled
 *              messages, this is the resolved `X-Delay` moment).
 *
 * Network failures throw; the caller renders a fallback in that case.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.now    Epoch seconds; entries with `time <= now`
 *   are dropped.
 * @returns {Promise<Array<{ id: string, time: number, message?: string, title?: string }>>}
 */
export const fetchScheduledMessages = async ({ topic, token, now }) => {
  const url = `https://ntfy.sh/${topic}/json?poll=1&scheduled=1`;
  const res = await ntfyFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ntfy poll ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  /** @type {Array<{ id: string, time: number, message?: string, title?: string }>} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (
        obj &&
        typeof obj.id === 'string' &&
        obj.event === 'message' &&
        typeof obj.time === 'number' &&
        obj.time > now
      ) {
        out.push(obj);
      }
    } catch {
      // Malformed line — skip rather than poison the whole fetch.
    }
  }
  return out;
};

/**
 * Cancel previously-scheduled messages. Per-message failures are
 * swallowed — a 404 on a message that already fired (or that ntfy
 * forgot) is the common case, not an error. Returns the count of ids
 * that the server accepted as deleted, so the caller can log/diagnose.
 *
 * @param {object} args
 * @param {string[]} args.ids
 * @param {string} args.topic
 * @param {string} args.token
 * @returns {Promise<number>}
 */
export const cancelWaveReminders = async ({ ids, topic, token }) => {
  if (!ids || ids.length === 0) return 0;
  let ok = 0;
  for (const id of ids) {
    try {
      const res = await ntfyFetch(`https://ntfy.sh/${topic}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) ok++;
    } catch {
      // Network blip — drop. The message will fire on schedule if
      // it was still queued; not the end of the world.
    }
  }
  return ok;
};

/**
 * Compute the ntfy priority for the n-th reminder (1-indexed) in the
 * escalation ladder: 3, 3, 4, 4, 5, 5. Start at "default" so the first
 * ping doesn't yank the user out of whatever they're doing, then bump
 * by one band every two reminders until we cap at max.
 *
 *   n=1,2 → 3 (default)
 *   n=3,4 → 4 (high)
 *   n=5,6 → 5 (max)
 *
 * Exported for the tests; runtime callers go through `postOne`.
 *
 * @param {number} n
 * @returns {number}
 */
export const priorityForReminder = (n) =>
  3 + Math.min(2, Math.floor(Math.max(0, n - 1) / 2));

/**
 * Publish one message. Splits the immediate vs delayed path: ntfy
 * rejects `X-Delay` values below {@link NTFY_MIN_DELAY_SEC}, so we
 * just publish without the header in that range and let it deliver
 * straight away.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.fireAt  Absolute epoch seconds when this push should land.
 * @param {number} args.now
 * @param {number} args.n       Which-of-six this push is (1..6).
 * @param {string} args.universeId  Server id, used as the title prefix.
 * @returns {Promise<string>}
 */
const postOne = async ({ topic, token, fireAt, now, n, universeId }) => {
  const delay = fireAt - now;
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${token}`,
    Title: `[${universeId}] Expeditions back`,
    Tags: 'rocket',
    Priority: String(priorityForReminder(n)),
  };
  if (delay >= NTFY_MIN_DELAY_SEC) headers['X-Delay'] = String(fireAt);

  const body = `Expeditions returned - Reminder #${n}.`;
  const res = await ntfyFetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ntfy publish ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = /** @type {{ id?: string }} */ (await res.json().catch(() => ({})));
  if (!json.id) throw new Error('ntfy publish: response missing id');
  return json.id;
};
