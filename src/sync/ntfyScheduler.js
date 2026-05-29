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
// The number of pushes per wave and their spacing come from the player's
// chosen schedule preset (`REMINDER_PRESETS`); the default `standard`
// preset is SIX messages 10 minutes apart. Every preset is a list of
// offsets in seconds from the wave's locked base time (`baseAt`); slot i
// fires at `baseAt + offsetsSec[i]`.
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
 * Total reminders queued per wave in the DEFAULT (`standard`) preset.
 * Six × ten minutes ≈ one hour of nudges — long enough that an AFK
 * player should notice, short enough that an already-acknowledged-but-
 * not-yet-resent wave doesn't keep vibrating into the next day. Other
 * presets queue a different count (see {@link REMINDER_PRESETS}).
 */
export const REMINDER_COUNT = 6;

/** Gap, in seconds, between consecutive reminders in the `standard` preset. */
export const REMINDER_INTERVAL_SEC = 600;

/**
 * Selectable reminder schedules. Each preset is a list of OFFSETS (in
 * seconds) from the wave's locked `baseAt`; slot i fires at
 * `baseAt + offsetsSec[i]`. The number of pushes per wave is simply the
 * length of the list, and the escalation ladder is spread across that
 * length by {@link priorityForSlot}.
 *
 * Three fixed presets (no free-form tuning — see the product note in
 * `features/settingsUi/sections/reminders.js`):
 *
 *   - `standard`  — 6 pushes, every 10 min (0–50 min). The historical
 *     default; offsets equal `REMINDER_COUNT × REMINDER_INTERVAL_SEC`.
 *   - `short`     — 4 pushes, every 5 min (0–15 min). Tighter, quieter.
 *   - `fibonacci` — 8 pushes at Fibonacci-minute offsets
 *     (0, 3, 5, 8, 13, 21, 34, 55 min): dense early nudging that thins
 *     out, spanning ~1 h.
 *
 * @type {Record<string, { label: string, offsetsSec: number[] }>}
 */
export const REMINDER_PRESETS = {
  standard: {
    label: '6 × 10 min',
    offsetsSec: Array.from({ length: REMINDER_COUNT }, (_, i) => i * REMINDER_INTERVAL_SEC),
  },
  short: {
    label: '4 × 5 min',
    offsetsSec: [0, 300, 600, 900],
  },
  fibonacci: {
    label: '8 × Fibonacci (0–55 min)',
    offsetsSec: [0, 180, 300, 480, 780, 1260, 2040, 3300],
  },
};

/** Preset key used when none is configured / an unknown key is stored. */
export const DEFAULT_REMINDER_SCHEDULE = 'standard';

/**
 * Resolve a schedule key to its offset list, falling back to the
 * {@link DEFAULT_REMINDER_SCHEDULE} preset for an unknown / empty key
 * (e.g. a value written by a newer version, or a hand-edited setting).
 *
 * @param {string} [schedule]
 * @returns {number[]}
 */
export const offsetsForSchedule = (schedule) =>
  (REMINDER_PRESETS[schedule ?? ''] ?? REMINDER_PRESETS[DEFAULT_REMINDER_SCHEDULE]).offsetsSec;

/** ntfy's documented minimum `X-Delay` value (anything smaller would be rejected). */
const NTFY_MIN_DELAY_SEC = 10;

/* global chrome */

/**
 * Public https URL of the OG-E notification icon, pinned to the running
 * extension's version tag so it is immutable per release. `X-Icon` is
 * fetched by the ntfy *app*, not the extension, so it must be a public
 * URL — `moz-extension://` and `data:` URIs do not work. We read the
 * version from `chrome.runtime.getManifest()` (available in both the
 * content-script and the dashboard origins); in Node tests `chrome` is
 * absent, so we fall back to the `main` branch ref. Computed once at
 * module load.
 */
const OGE_ICON_URL = (() => {
  let ref = 'main';
  try {
    const c = /** @type {{ runtime?: { getManifest?: () => { version?: string } } }} */ (
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis)).chrome
    );
    const v = c?.runtime?.getManifest?.().version;
    if (typeof v === 'string' && v) ref = 'v' + v;
  } catch {
    // No chrome runtime (tests / unexpected context) — keep `main`.
  }
  return `https://raw.githubusercontent.com/urbanowiczbartlomiej-hub/OG-E/${ref}/icons/icon128.png`;
})();

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
 * Absolute fire times for a wave whose schedule is anchored at `baseAt`
 * (epoch seconds): `baseAt + offsetsSec[i]` for every offset in the
 * chosen preset. Pure — exported for the tests.
 *
 * `offsetsSec` defaults to the {@link DEFAULT_REMINDER_SCHEDULE}
 * (`standard`) preset, so callers that don't care about the schedule
 * (and the legacy tests) keep the historical 6×10-min behaviour.
 *
 * @param {number} baseAt
 * @param {number[]} [offsetsSec]  Offsets from `baseAt`, in seconds.
 * @returns {number[]}
 */
export const reminderFireTimes = (
  baseAt,
  offsetsSec = REMINDER_PRESETS[DEFAULT_REMINDER_SCHEDULE].offsetsSec,
) => offsetsSec.map((o) => baseAt + o);

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
 * ntfy priority for slot `i` (0-indexed) of a series of `total` reminders.
 * The escalation ladder is spread evenly across the series in three
 * bands — start at "default" (3) so the first ping doesn't yank the user
 * out of whatever they're doing, climb to "high" (4) around the middle,
 * and cap at "max" (5) for the final third. Generalises the old fixed
 * 3,3,4,4,5,5 ladder so any preset length escalates sensibly:
 *
 *   - 6 slots → 3,3,4,4,5,5  (unchanged from the historical default)
 *   - 4 slots → 3,4,5,5
 *   - 8 slots → 3,3,3,4,4,5,5,5
 *
 * A single-slot series is treated as max urgency.
 *
 * Exported for the tests; runtime callers go through `postOne`.
 *
 * @param {number} i      Zero-based slot index.
 * @param {number} total  Total slots in this wave's schedule.
 * @returns {number}
 */
export const priorityForSlot = (i, total) => {
  if (total <= 1) return 5;
  const p = i / (total - 1); // 0 → first, 1 → last
  if (p < 1 / 3) return 3;
  if (p < 2 / 3) return 4;
  return 5;
};

/**
 * Escalation emoji tag for a priority band, appended after `rocket` so
 * the urgency reads at a glance in the notification list:
 *
 *   3 → ⏳ hourglass · 4 → ⚠️ warning · 5 → 🚨 rotating_light
 *
 * @param {number} priority
 * @returns {string}  Comma-separated ntfy `Tags` value.
 */
const tagsForPriority = (priority) => {
  const escalation = priority >= 5 ? 'rotating_light' : priority >= 4 ? 'warning' : 'hourglass';
  return `rocket,${escalation}`;
};

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
 * @param {number} args.i       Zero-based slot index in this wave's schedule.
 * @param {number} args.total   Total slots in this wave's schedule.
 * @param {number} args.baseAt  Wave's locked schedule anchor (epoch s); the
 *   earliest known return time, shown in the body so the player sees WHEN
 *   the wave came home.
 * @param {string} args.universeId  Server id, used as the title prefix.
 * @returns {Promise<string>}
 */
const postOne = async ({ topic, token, fireAt, now, i, total, baseAt, universeId }) => {
  const delay = fireAt - now;
  const priority = priorityForSlot(i, total);
  /** @type {Record<string, string>} */
  const headers = {
    Title: titleFor(universeId),
    Tags: tagsForPriority(priority),
    Priority: String(priority),
    Icon: OGE_ICON_URL,
  };
  if (delay >= NTFY_MIN_DELAY_SEC) headers['X-Delay'] = String(fireAt);

  // Local return time, baked in at post time (the ntfy app shows the body
  // verbatim). We can't list fleet count / origins: the schedule is queued
  // the instant the FIRST expedition of a wave is detected — before the
  // rest of the burst is sent — precisely so a browser close mid-send still
  // leaves reminders queued. So `baseAt` (when the wave returns) is the only
  // detail we can state honestly.
  const when = new Date(baseAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = `Expeditions back (${when}) — reminder #${i + 1}/${total}.`;
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
 * @param {number[]} [args.offsetsSec]  Reminder offsets (seconds from each wave's
 *   `baseAt`) for the active schedule preset. Defaults to the `standard`
 *   preset so existing callers/tests keep the 6×10-min behaviour. Changing
 *   the preset moves slot times, so the next reconcile sweeps the old
 *   message set and posts the new one — by design.
 * @returns {Promise<{ idsByWave: Record<string, string[]>, posted: number, cancelled: number }>}
 *   `idsByWave` maps each wave id to its slot message ids in fire order.
 */
export const reconcileWaveQueue = async ({
  waves, topic, token, now, universeId,
  offsetsSec = REMINDER_PRESETS[DEFAULT_REMINDER_SCHEDULE].offsetsSec,
}) => {
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
    const times = reminderFireTimes(w.baseAt, offsetsSec);
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
        id = await postOne({
          topic, token, fireAt: t, now,
          i, total: times.length, baseAt: wave.baseAt, universeId,
        });
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
