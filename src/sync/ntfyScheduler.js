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
// We aim for SIX messages per wave (`REMINDER_COUNT`), 10 minutes apart
// (`REMINDER_INTERVAL_SEC`), starting at the wave's locked base time
// (`baseAt`). Slot i fires at `baseAt + i * REMINDER_INTERVAL_SEC`.
//
// # The queue is the source of truth — {@link reconcileWaveQueue}
//
// We do NOT blindly POST six messages and trust a separate gist write to
// remember their ids. On mobile, *sending a fleet reloads the game page*,
// which tears the content script down mid-flight — so a "POST six, then
// write the ids to the gist" sequence routinely lost the gist write after
// only some POSTs had landed. The result was stacked partial schedules
// (7×, 5×, 3× …) and orphaned messages with no stored id to cancel.
//
// Instead, scheduling is an *idempotent reconciliation* against ntfy's own
// scheduled queue, which is durable and pollable. Each pass:
//
//   1. Polls the queue and keeps only THIS universe's messages (matched by
//      the `[universeId] …` title — never touches other servers' topics).
//   2. Posts only the future slots that are MISSING from the queue.
//   3. Cancels any of this universe's future messages that belong to NO
//      live wave (landed, dismissed, lost-write partials, base drift).
//
// A page reload is now harmless: the next load re-polls and converges to
// exactly one message per future slot of every live wave. There is no
// "immediate fire" path — past/too-soon slots are simply left alone; while
// a wave is landing the player is by definition in-game and needs no nudge.
//
// # Authentication
//
// ntfy.sh's free / Pro plans rate-limit anonymous publishers per IP, and a
// burst send fires several POSTs in quick succession — easily enough to
// trip the anonymous budget. That's why we make the user paste a personal
// access token: with it the per-IP budget no longer applies — the rate
// limit is per account. The token
// is mirrored from chrome.storage by the histogram tab and passed in
// here as a parameter; this module never reads storage directly.

/* global fetch */

/**
 * Return the `auth=…` query-string parameter that authenticates the
 * request without an `Authorization` header.
 *
 * ntfy.sh accepts `?auth=base64(user:password)` on every endpoint as an
 * alternative to the `Authorization` header. For a bare access token the
 * "username" is empty and the token is the "password", so the encoding is
 * `btoa(':' + token)`.
 *
 * Using query-param auth avoids the Firefox CORS restriction: ntfy responds
 * with `Access-Control-Allow-Headers: *`, which — per the Fetch spec — does
 * NOT cover `Authorization`. Content-script requests that include that header
 * fail the CORS preflight in Firefox even when the extension has declared
 * `host_permissions` for ntfy.sh. The `auth` query param is an ordinary
 * non-forbidden header-free alternative that passes through without issue.
 *
 * `btoa` is available as a global in browsers and in Node ≥ 16 (the project
 * requires Node ≥ 20), so no polyfill is needed.
 *
 * @param {string} token  ntfy.sh access token.
 * @returns {string}  Ready-to-append query param, e.g. `auth=dGVzdA==`.
 */
const ntfyAuthParam = (token) => 'auth=' + btoa(':' + token);

/**
 * Total reminders queued per wave. Six × ten minutes ≈ one hour of
 * nudges — long enough that an AFK player should notice, short enough
 * that an already-acknowledged-but-not-yet-resent wave doesn't keep
 * vibrating into the next day.
 */
export const REMINDER_COUNT = 6;

/** Gap, in seconds, between consecutive reminders for the same wave. */
export const REMINDER_INTERVAL_SEC = 600;

/** ntfy's documented minimum `X-Delay` value (anything smaller would be rejected). */
const NTFY_MIN_DELAY_SEC = 10;

/**
 * The ntfy push title for a universe. Doubles as the per-universe filter
 * when reconciling the shared topic's queue: messages whose title is not
 * exactly this belong to another OGame server and are never touched.
 *
 * @param {string} universeId
 * @returns {string}
 */
export const titleFor = (universeId) => `[${universeId}] Expeditions back`;

/**
 * The {@link REMINDER_COUNT} absolute fire times for a wave whose schedule
 * is anchored at `baseAt` (epoch seconds): `baseAt + i * REMINDER_INTERVAL_SEC`
 * for `i` in `0..REMINDER_COUNT-1`. Pure — exported for the tests.
 *
 * @param {number} baseAt
 * @returns {number[]}
 */
export const reminderFireTimes = (baseAt) => {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < REMINDER_COUNT; i++) out.push(baseAt + i * REMINDER_INTERVAL_SEC);
  return out;
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
  const url = `https://ntfy.sh/${topic}/json?poll=1&scheduled=1&${ntfyAuthParam(token)}`;
  const res = await fetch(url);
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
      const res = await fetch(`https://ntfy.sh/${topic}/${id}?${ntfyAuthParam(token)}`, {
        method: 'DELETE',
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
    Title: titleFor(universeId),
    Tags: 'rocket',
    Priority: String(priorityForReminder(n)),
  };
  if (delay >= NTFY_MIN_DELAY_SEC) headers['X-Delay'] = String(fireAt);

  const body = `Expeditions returned - Reminder #${n}.`;
  const res = await fetch(`https://ntfy.sh/${topic}?${ntfyAuthParam(token)}`, {
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

/**
 * Reconcile this universe's slice of the shared ntfy queue so it holds
 * exactly one message per FUTURE reminder slot of every supplied live
 * wave — no more, no less. This is the whole scheduling contract; callers
 * just hand over the live waves and store the returned id sets.
 *
 * Idempotent and self-healing. Safe to run on every sync and after any
 * number of interrupted prior runs (the mobile page-reload case):
 *
 *   - **Universe isolation.** Only messages titled {@link titleFor} are
 *     considered "ours". The topic is shared across OGame servers (it is
 *     derived from the gist id), so every other server's schedule is
 *     invisible here and never cancelled.
 *   - **Post the gaps.** For each wave, slot `i` wants a message at
 *     `baseAt + i*interval`. We post only the slots that are far enough in
 *     the future to schedule (`>= now + NTFY_MIN_DELAY`) AND absent from
 *     the queue. Slots already queued are reused by their existing id.
 *   - **Sweep the rest.** Any of our future messages whose fire time
 *     matches no live wave's slot is cancelled — that covers landed waves,
 *     user-dismissed waves, lost-write partials, and base-time drift.
 *
 * Pass `waves: []` (e.g. feature disabled) to cancel everything queued for
 * this universe.
 *
 * `baseAt` is the wave's locked schedule anchor. The caller persists it on
 * first sight and feeds it back unchanged, so the slot times stay stable
 * across scans even as the earliest live return drifts.
 *
 * Per-message POST failures throw (the caller retries next tick); per-id
 * cancellation failures are swallowed inside {@link cancelWaveReminders}.
 *
 * @param {object} args
 * @param {Array<{ id: string, baseAt: number }>} args.waves  Live, non-dismissed waves.
 * @param {string} args.topic
 * @param {string} args.token       ntfy.sh access token (sent as a query param, not Bearer).
 * @param {number} args.now         Epoch SECONDS — injected for testability.
 * @param {string} args.universeId  OGame server id; the title prefix + queue filter.
 * @returns {Promise<{ idsByWave: Record<string, string[]>, posted: number, cancelled: number }>}
 *   `idsByWave` maps each wave id to its slot message ids in fire order.
 */
export const reconcileWaveQueue = async ({ waves, topic, token, now, universeId }) => {
  const title = titleFor(universeId);
  const all = await fetchScheduledMessages({ topic, token, now });
  const ours = all.filter((m) => m.title === title);

  // time -> id for a message already queued in this universe (first wins).
  /** @type {Map<number, string>} */
  const queuedById = new Map();
  for (const m of ours) if (!queuedById.has(m.time)) queuedById.set(m.time, m.id);

  // Every future slot of every live wave is "wanted" — protected from the
  // sweep even when it's too soon to (re)schedule, so a reminder about to
  // fire is never yanked out from under itself.
  /** @type {Set<number>} */
  const wantedTimes = new Set();
  const plan = waves.map((w) => {
    const times = reminderFireTimes(w.baseAt);
    for (const t of times) if (t > now) wantedTimes.add(t);
    return { wave: w, times };
  });

  /** @type {Record<string, string[]>} */
  const idsByWave = {};
  let posted = 0;
  for (const { wave, times } of plan) {
    /** @type {string[]} */
    const ids = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < now + NTFY_MIN_DELAY_SEC) continue; // past / too-soon to schedule
      let id = queuedById.get(t);
      if (!id) {
        id = await postOne({ topic, token, fireAt: t, now, n: i + 1, universeId });
        queuedById.set(t, id);
        posted++;
      }
      ids.push(id);
    }
    idsByWave[wave.id] = ids;
  }

  const orphanIds = ours.filter((m) => !wantedTimes.has(m.time)).map((m) => m.id);
  const cancelled = await cancelWaveReminders({ ids: orphanIds, topic, token });

  return { idsByWave, posted, cancelled };
};
