// @ts-check

// ntfy.sh queue reconciler. The only piece of OG-E that actually
// talks to ntfy.sh — everything upstream just hands us a wave + topic +
// token. There is no `wrangler`-deployed Worker any more; ntfy.sh's own
// queue is the cron.
//
// # Why "reconciler", not "scheduler"
//
// This module is NOT a timer-based scheduler (that's `sync/scheduler.js`,
// which owns debounces + the in-flight lock). It is a STATELESS reconciler:
// each pass polls ntfy's server-side scheduled queue and converges it to
// exactly one message per future slot of every live wave (see "The queue is
// the source of truth" below). The delay/cron lives entirely in ntfy's
// `X-Delay` queue; we just diff desired-vs-actual and post/cancel the
// difference. The name was changed from `ntfyScheduler` so it stops
// inviting the "two schedulers — merge them?" question (the answer is no;
// they share no mechanism).
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
// free-form schedule setting (parsed by `offsetsForSchedule`); the default
// is four messages over an hour (`0m, 10m, 30m, 60m`). The setting resolves
// to a list of offsets in seconds from the wave's locked base time
// (`baseAt`); slot i fires at `baseAt + offsetsSec[i]`.
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
// # No backoff (by design)
//
// Unlike the gist client (`sync/gist.js`, which retries with exponential
// backoff on a 429/5xx), the ntfy publish path has NO retry or backoff. It
// doesn't need one: scheduling is the idempotent reconciliation above, so a
// failed/aborted pass simply leaves the queue as-is and the NEXT reconcile
// re-converges. A non-2xx POST throws (caller surfaces the error); a 2xx
// with no readable `id` is logged via `lib/logger` and throws too — the
// message scheduled but we lost its cancellation handle, and the next
// reconcile re-discovers it by title (keep if it still matches a live slot,
// cancel otherwise). The reconcile loop IS the recovery mechanism.
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

import { parseDurationList, humanizeOffset } from '../domain/duration.js';
import {
  renderTemplate,
  iconFileFor,
  splitLabel,
  defaultReminderTemplates,
} from '../domain/reminderTemplates.js';
import { logger } from '../lib/logger.js';

/* global fetch */

/**
 * Return the `auth=…` query-string parameter that authenticates the
 * request without an `Authorization` header.
 *
 * The value is the base64 of the ENTIRE `Authorization` header — for a
 * bearer token, `base64("Bearer " + token)` — url-safe (`+`→`-`, `/`→`_`)
 * with the `=` padding stripped. That is exactly what ntfy.sh documents:
 *
 *   echo -n "Bearer faketoken" | base64 -w0 | tr -d '='
 *
 * (its own example `?auth=QmFzaWM…` decodes to `Basic base64(user:pass)`,
 * confirming the value is the encoded header line, not bare credentials).
 *
 * # The bug this replaced
 *
 * We used to send `btoa(':' + token)` — the inner Basic-auth credential
 * blob with NO `Basic `/`Bearer ` scheme and NO outer base64. ntfy could
 * not parse it as an auth header, so it silently fell back to ANONYMOUS
 * publishing. Because our topic (`oge-<sha256(token)>`) is public and
 * unreserved, the POSTs still succeeded and notifications still arrived —
 * but they were never attributed to the account (the dashboard showed 0
 * sent) and were rate-limited per-IP, defeating the entire reason the
 * token exists (see the per-account rate-limit note below).
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
 * @returns {string}  Ready-to-append query param, e.g. `auth=QmVhcmVyIHRr…`.
 */
export const ntfyAuthParam = (token) =>
  'auth=' + btoa('Bearer ' + token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Default wave reminder schedule, in seconds AFTER the wave returns —
 * `0m, 10m, 30m, 60m`. Used when the (free-form) schedule setting is empty
 * or all-garbage. Must stay in sync with the `reminderSchedule` default in
 * `state/settings.js`.
 *
 * Four nudges spanning an hour — long enough that an AFK player should
 * notice, short enough that an already-resent wave doesn't keep vibrating
 * into the next day. The player can override the cadence entirely from the
 * Settings panel; the number of pushes is simply the length of their list.
 */
export const DEFAULT_WAVE_OFFSETS_SEC = [0, 600, 1800, 3600];

/**
 * Resolve the wave-schedule SETTING to a list of OFFSETS (in seconds) from
 * the wave's locked `baseAt`; slot i fires at `baseAt + offsetsSec[i]`. The
 * setting is a free-form, minutes-first duration list (e.g.
 * `"0m, 10m, 30m, 60m"`, parsed by {@link parseDurationList}); negatives are
 * dropped — a wave reminder can't fire before the wave is back. Falls back
 * to {@link DEFAULT_WAVE_OFFSETS_SEC} when the parse yields nothing (empty /
 * all-garbage / a value left over from an older preset key). The number of
 * pushes per wave is the length of the list, and the escalation ladder is
 * spread across it by {@link priorityForSlot}.
 *
 * @param {string} [schedule]
 * @returns {number[]}
 */
export const offsetsForSchedule = (schedule) => {
  const offsets = parseDurationList(schedule ?? '', { signed: false });
  return offsets.length ? offsets : DEFAULT_WAVE_OFFSETS_SEC;
};

/** ntfy's documented minimum `X-Delay` value (anything smaller would be rejected). */
const NTFY_MIN_DELAY_SEC = 10;

/**
 * ntfy's documented MAXIMUM `X-Delay` — three days. A reminder whose fire
 * time is further out than this can't be scheduled, so the UI blocks
 * arming it and the orchestration excludes it from the queue (defense in
 * depth). Exported so the event-list badge can grey out far-future fleets.
 */
export const NTFY_MAX_DELAY_SEC = 3 * 24 * 60 * 60;

/**
 * GitHub raw ref the notification icons are pinned to: the running
 * extension's version tag (`vX.Y.Z`) so the icon a push points at is
 * immutable per release. `X-Icon` is fetched by the ntfy *app*, not the
 * extension, so it must be a public URL — `moz-extension://` and `data:`
 * URIs do not work. We read the version from `chrome.runtime.getManifest()`
 * (available in both the content-script and the dashboard origins); in Node
 * tests `chrome` is absent, so we fall back to the `main` branch ref.
 * Computed once at module load.
 *
 * NOTE: a new icon file (e.g. `icon_red.png`) only resolves once the tag
 * that includes it is pushed — it must ship in the SAME release that first
 * references it, or the ntfy app gets a 404 and shows no icon.
 */
const ICON_REF = (() => {
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
  return ref;
})();

/** @param {string} file @returns {string} public https URL of an icon in `icons/`. */
const iconUrl = (file) =>
  `https://raw.githubusercontent.com/urbanowiczbartlomiej-hub/OG-E/${ICON_REF}/icons/${file}`;

/** Default OG-E notification icon. */
const OGE_ICON_URL = iconUrl('icon128.png');

// (A standalone red-icon constant used to live here for auto-applying an
// urgent icon to max-priority reminders. It's gone now that the red icon is a
// selectable template preset — `resolveIconUrl(template.icon)` resolves it via
// `iconFileFor`, so per-kind icon choice covers the urgent case.)

/**
 * Resolve a template's preset icon id to its public https URL. The id→file
 * mapping is the pure {@link iconFileFor}; the URL wrapping (release ref)
 * lives here. Used by every kind so a custom icon choice reaches ntfy.
 *
 * @param {string} iconId  a `PRESET_ICONS` id.
 * @returns {string}
 */
const resolveIconUrl = (iconId) => iconUrl(iconFileFor(iconId));

/**
 * Format an epoch second as a locale `HH:MM` clock — the `{returnTime}` /
 * `{arrivalTime}` (and its `{landTime}` alias) wildcard value.
 *
 * @param {number} epochSec
 * @returns {string}
 */
const clock = (epochSec) =>
  new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
 * resolved schedule. Pure — exported for the tests.
 *
 * `offsetsSec` defaults to {@link DEFAULT_WAVE_OFFSETS_SEC}, so callers that
 * don't care about the schedule (and the tests) get the default cadence.
 *
 * @param {number} baseAt
 * @param {number[]} [offsetsSec]  Offsets from `baseAt`, in seconds.
 * @returns {number[]}
 */
export const reminderFireTimes = (
  baseAt,
  offsetsSec = DEFAULT_WAVE_OFFSETS_SEC,
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
 * Fixed ntfy priority per notification kind.
 *
 * Expedition-wave reminders stay at "default" (3) — they're background
 * nudges. They used to escalate 3→4→5 across the series, but that
 * competed for attention with the notifications the player marks ON
 * PURPOSE. Those intentional marks are the ad-hoc fleet reminders, so
 * they ring at "max" (5). One flat priority per kind, no per-slot ladder.
 */
export const WAVE_PRIORITY = 3;
export const ADHOC_PRIORITY = 5;

/**
 * Publish one message at `fireAt`. Generic over notification kind: the
 * caller supplies the `title` (which doubles as the per-kind queue filter
 * — see {@link reconcileQueue}), `body`, `priority`, and `icon` URL.
 *
 * Splits the immediate vs delayed path: ntfy rejects `X-Delay` values
 * below {@link NTFY_MIN_DELAY_SEC}, so within that window we publish
 * without the header and let it deliver straight away.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.fireAt    Absolute epoch seconds when this push should land.
 * @param {number} args.now
 * @param {string} args.title     Push title (also the per-kind queue filter).
 * @param {string} args.body      Notification body, baked in at post time.
 * @param {number} args.priority  ntfy priority (1–5).
 * @param {string} [args.icon]    Icon URL; defaults to the standard OG-E icon.
 * @returns {Promise<string>}     ntfy message id (the cancellation handle).
 */
const postMessage = async ({ topic, token, fireAt, now, title, body, priority, icon }) => {
  const delay = fireAt - now;
  /** @type {Record<string, string>} */
  const headers = {
    Title: title,
    Priority: String(priority),
    Icon: icon || OGE_ICON_URL,
  };
  if (delay >= NTFY_MIN_DELAY_SEC) headers['X-Delay'] = String(fireAt);

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
  if (!json.id) {
    // A 2xx with no readable `id` means the message DID schedule on ntfy
    // (the POST succeeded) but we have no cancellation handle for it — a
    // latent orphan. There is no backoff/retry here (see header "No backoff");
    // we surface it via the logger and throw so this reconcile pass aborts.
    // The next reconcile poll re-discovers the message by its title and folds
    // it back into the queue (keep if it matches a live slot, cancel if not),
    // so the orphan self-heals without a dedicated retry path.
    logger.warn('ntfy publish: 2xx response missing id (orphaned schedule; next reconcile will reconcile by title)');
    throw new Error('ntfy publish: response missing id');
  }
  return json.id;
};

/**
 * One scheduled "series" handed to {@link reconcileQueue}: a stable
 * identity plus the future fire slots it wants on the queue. Each slot
 * carries the message to publish at that moment.
 *
 * @typedef {object} QueueSlot
 * @property {number} fireAt    Absolute epoch SECONDS to deliver at.
 * @property {string} body      Notification body (baked in at post time).
 * @property {number} priority  ntfy priority (1–5).
 * @property {string} [icon]    Icon URL (baked in at post time); optional —
 *   {@link postMessage} falls back to the standard OG-E icon.
 *
 * @typedef {object} QueueSeries
 * @property {string}     id     Identity; the reconcile keys returned ids by it.
 * @property {QueueSlot[]} slots Desired future slots, in fire order.
 */

/**
 * Reconcile ONE notification kind's slice of the shared ntfy queue so it
 * holds exactly one message per FUTURE slot of every supplied series — no
 * more, no less. This is the whole scheduling contract; callers expand
 * their domain objects (waves, ad-hoc fleets, …) into {@link QueueSeries}
 * and store the returned id sets.
 *
 * Idempotent and self-healing. Safe to run on every sync and after any
 * number of interrupted prior runs (the mobile page-reload case):
 *
 *   - **Kind + universe isolation.** Only messages whose title is exactly
 *     `title` are considered "ours". The topic is shared across OGame
 *     servers AND across notification kinds (it's derived from the ntfy
 *     access token), so every other server's schedule AND every other
 *     kind's schedule (waves vs ad-hoc use different titles) is invisible
 *     here and never cancelled.
 *   - **Post the gaps.** For each series, each slot wants a message at
 *     `slot.fireAt`. We post only the slots far enough in the future to
 *     schedule (`>= now + NTFY_MIN_DELAY`) AND absent from the queue.
 *     Slots already queued are reused by their existing id.
 *   - **Sweep the rest.** Any of our future messages whose fire time
 *     matches no live slot is cancelled — that covers finished/landed
 *     items, user-dismissed items, lost-write partials, and time drift.
 *
 * Pass `series: []` (e.g. feature disabled) to cancel everything queued
 * for this title.
 *
 * Per-message POST failures throw (the caller retries next tick); per-id
 * cancellation failures are swallowed inside {@link cancelWaveReminders}.
 *
 * Note: slots are matched to queued messages by fire TIME, so two slots
 * of the same kind sharing the exact same epoch second collapse to one
 * message (set semantics) — the same property the wave path always had.
 *
 * @param {object} args
 * @param {QueueSeries[]} args.series  Live series for this kind.
 * @param {string} args.topic
 * @param {string} args.token  ntfy.sh access token (sent as a query param, not Bearer).
 * @param {number} args.now    Epoch SECONDS — injected for testability.
 * @param {string} args.title  Exact push title for this kind; doubles as the
 *   "ours" queue filter. Different kinds MUST use different titles.
 * @param {Array<{ id: string, time: number, title?: string }>} [args.queue]
 *   Pre-fetched scheduled queue (from {@link fetchScheduledMessages}). When
 *   given, we skip the poll and filter this snapshot — lets one sync
 *   reconcile multiple kinds (waves + ad-hoc) off a SINGLE ntfy poll, which
 *   matters because OGame reloads the page (and re-runs the producer) on
 *   every click. Posts under one title don't affect another's filter, so
 *   sharing the snapshot across kinds is safe.
 * @returns {Promise<{ idsBySeries: Record<string, string[]>, posted: number, cancelled: number }>}
 *   `idsBySeries` maps each series id to its slot message ids in fire order.
 */
const reconcileQueue = async ({ series, topic, token, now, title, queue }) => {
  const all = queue ?? await fetchScheduledMessages({ topic, token, now });
  const ours = all.filter((m) => m.title === title);

  // time -> id for a message already queued under this title (first wins).
  /** @type {Map<number, string>} */
  const queuedByTime = new Map();
  for (const m of ours) if (!queuedByTime.has(m.time)) queuedByTime.set(m.time, m.id);

  // Every future slot is "wanted" — protected from the sweep even when
  // it's too soon to (re)schedule, so a message about to fire is never
  // yanked out from under itself.
  /** @type {Set<number>} */
  const wantedTimes = new Set();
  for (const s of series) for (const slot of s.slots) if (slot.fireAt > now) wantedTimes.add(slot.fireAt);

  /** @type {Record<string, string[]>} */
  const idsBySeries = {};
  let posted = 0;
  for (const s of series) {
    /** @type {string[]} */
    const ids = [];
    for (const slot of s.slots) {
      if (slot.fireAt < now + NTFY_MIN_DELAY_SEC) continue; // past / too-soon to schedule
      let id = queuedByTime.get(slot.fireAt);
      if (!id) {
        id = await postMessage({
          topic, token, fireAt: slot.fireAt, now,
          title, body: slot.body, priority: slot.priority, icon: slot.icon,
        });
        queuedByTime.set(slot.fireAt, id);
        posted++;
      }
      ids.push(id);
    }
    idsBySeries[s.id] = ids;
  }

  const orphanIds = ours.filter((m) => !wantedTimes.has(m.time)).map((m) => m.id);
  const cancelled = await cancelWaveReminders({ ids: orphanIds, topic, token });

  return { idsBySeries, posted, cancelled };
};

/**
 * Render context for one expedition-wave slot. We can't expose fleet count /
 * origins: the schedule is queued the instant the FIRST expedition of a wave
 * is detected — before the rest of the burst is sent — precisely so a browser
 * close mid-send still leaves reminders queued. So `{returnTime}` (when the
 * wave returns) plus the slot index are the only details we can state
 * honestly (see `domain/reminderTemplates.TEMPLATE_FIELDS.wave`).
 *
 * @param {string} universeId
 * @param {number} baseAt  Wave's locked schedule anchor (epoch s).
 * @param {number} i       Zero-based slot index.
 * @param {number} total   Total slots in this wave's schedule.
 * @returns {Record<string, string | number>}
 */
const waveCtx = (universeId, baseAt, i, total) => ({
  server: universeId,
  // A wave is always an Expedition series; exposing `{mission}` keeps the
  // three editors uniform (see `domain/reminderTemplates` COMMON_FIELDS).
  mission: 'Expedition',
  returnTime: clock(baseAt),
  index: i + 1,
  total,
});

/**
 * Reconcile this universe's EXPEDITION-WAVE slice of the queue. Thin
 * wrapper over {@link reconcileQueue}: expands each wave into a series of
 * slots (fire times from the active preset, flat {@link WAVE_PRIORITY}),
 * and maps the generic result back to the historical `idsByWave` shape so
 * existing callers/tests are unaffected.
 *
 * `baseAt` is the wave's locked schedule anchor. The caller persists it on
 * first sight and feeds it back unchanged, so the slot times stay stable
 * across scans even as the earliest live return drifts.
 *
 * Pass `waves: []` (feature disabled) to cancel everything wave-related
 * queued for this universe.
 *
 * @param {object} args
 * @param {Array<{ id: string, baseAt: number }>} args.waves  Live, non-dismissed waves.
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.now         Epoch SECONDS — injected for testability.
 * @param {string} args.universeId  OGame server id; the title prefix + queue filter.
 * @param {number[]} [args.offsetsSec]  Reminder offsets (seconds from each wave's
 *   `baseAt`) for the active schedule. Defaults to
 *   {@link DEFAULT_WAVE_OFFSETS_SEC} so callers/tests get the default cadence.
 * @param {import('../domain/reminderTemplates.js').ReminderTemplate} [args.template]
 *   The wave message customisation (body / icon / priority). Defaults to the
 *   built-in wave template (reproduces the historical message).
 * @param {Array<{ id: string, time: number, title?: string }>} [args.queue]
 *   Pre-fetched queue snapshot (see {@link reconcileQueue}) — lets the
 *   caller share one poll across kinds.
 * @returns {Promise<{ idsByWave: Record<string, string[]>, posted: number, cancelled: number }>}
 */
export const reconcileWaveQueue = async ({
  waves, topic, token, now, universeId,
  offsetsSec = DEFAULT_WAVE_OFFSETS_SEC,
  template = defaultReminderTemplates().wave,
  queue,
}) => {
  const icon = resolveIconUrl(template.icon);
  /** @type {QueueSeries[]} */
  const series = waves.map((w) => {
    const times = reminderFireTimes(w.baseAt, offsetsSec);
    return {
      id: w.id,
      slots: times.map((fireAt, i) => ({
        fireAt,
        body: renderTemplate(template.body, waveCtx(universeId, w.baseAt, i, times.length)),
        priority: template.priority,
        icon,
      })),
    };
  });
  const { idsBySeries, posted, cancelled } = await reconcileQueue({
    series, topic, token, now, title: titleFor(universeId), queue,
  });
  return { idsByWave: idsBySeries, posted, cancelled };
};

/**
 * The ntfy push title for this universe's AD-HOC fleet reminders. Distinct
 * from {@link titleFor} (the wave title) so the two kinds never sweep each
 * other on the shared topic, and prefixed with the universe id so other
 * servers' ad-hoc reminders stay invisible here too.
 *
 * @param {string} universeId
 * @returns {string}
 */
export const adhocTitleFor = (universeId) => `[${universeId}] Fleet`;

/**
 * Reconcile this universe's AD-HOC slice of the queue. Each armed entry is
 * a single-slot series fired at its `fireAt`. The body is rendered here from
 * the ad-hoc {@link import('../domain/reminderTemplates.js').ReminderTemplate}
 * against the entry's detail (the shared wildcard set: `{server}`,
 * `{mission}`, `{coords}`, `{origin}`, `{originName}`, `{target}`,
 * `{targetName}`, `{shipCount}`, `{arrivalTime}`); priority + icon come from
 * the template. `{label}` stays in context as an unadvertised back-compat
 * alias for bodies saved before the wildcard cleanup.
 *
 * Same idempotent reconcile as waves, under the ad-hoc title, so arming on
 * mobile survives the send-reload and the queue self-heals. Pass
 * `entries: []` to cancel every ad-hoc reminder queued for this universe.
 *
 * @param {object} args
 * @param {Array<{ id: string, fireAt: number, arrivalAt: number, label: string,
 *   origin?: string, originName?: string, target?: string, targetName?: string,
 *   shipCount?: number }>} args.entries
 *   Armed entries (the label is the `${mission} → [${coords}]` string; the
 *   origin/target/ship metadata feeds the matching wildcards).
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.now         Epoch SECONDS.
 * @param {string} args.universeId
 * @param {import('../domain/reminderTemplates.js').ReminderTemplate} [args.template]
 *   Ad-hoc message customisation; defaults to the built-in ad-hoc template.
 * @param {Array<{ id: string, time: number, title?: string }>} [args.queue]
 *   Pre-fetched queue snapshot (see {@link reconcileQueue}) — lets the
 *   caller share one poll across kinds.
 * @returns {Promise<{ idsByEntry: Record<string, string[]>, posted: number, cancelled: number }>}
 */
export const reconcileAdhocQueue = async ({
  entries, topic, token, now, universeId,
  template = defaultReminderTemplates().adhoc,
  queue,
}) => {
  const icon = resolveIconUrl(template.icon);
  /** @type {QueueSeries[]} */
  const series = entries.map((e) => {
    const { mission, coords } = splitLabel(e.label);
    const body = renderTemplate(template.body, {
      server: universeId, label: e.label, mission, coords,
      origin: e.origin ?? '', originName: e.originName ?? '',
      target: e.target ?? '', targetName: e.targetName ?? '',
      shipCount: Number.isFinite(e.shipCount) ? Number(e.shipCount).toLocaleString() : '',
      arrivalTime: clock(e.arrivalAt),
    });
    return { id: e.id, slots: [{ fireAt: e.fireAt, body, priority: template.priority, icon }] };
  });
  const { idsBySeries, posted, cancelled } = await reconcileQueue({
    series, topic, token, now, title: adhocTitleFor(universeId), queue,
  });
  return { idsByEntry: idsBySeries, posted, cancelled };
};

/**
 * The ntfy push title for this universe's FLEET-SAVE reminders. Distinct
 * from both {@link titleFor} (waves) and {@link adhocTitleFor} (ad-hoc) so
 * the three kinds never sweep each other on the shared topic, and prefixed
 * with the universe id so other servers' FS reminders stay invisible here.
 *
 * @param {string} universeId
 * @returns {string}
 */
export const fsTitleFor = (universeId) => `[${universeId}] Fleet save`;

/**
 * Render context for one fleet-save slot. States where/when the fleet lands,
 * its ship count, and whether THIS slot is before / at / after landing
 * (`{offset}`), so the push reads honestly on its own. Ship count is
 * locale-formatted for readability when the template references `{shipCount}`.
 *
 * @param {string} universeId
 * @param {{ label: string, arrivalAt: number, shipCount?: number,
 *   origin?: string, originName?: string, target?: string, targetName?: string }} e
 * @param {number} fireAt    Epoch SECONDS this slot fires.
 * @returns {Record<string, string | number>}
 */
const fsCtx = (universeId, e, fireAt) => {
  const { mission, coords } = splitLabel(e.label);
  return {
    server: universeId,
    label: e.label,
    mission,
    coords,
    origin: e.origin ?? '',
    originName: e.originName ?? '',
    target: e.target ?? '',
    targetName: e.targetName ?? '',
    shipCount: Number.isFinite(e.shipCount) ? Number(e.shipCount).toLocaleString() : '',
    // `arrivalTime` is the unified, advertised name shared with ad-hoc;
    // `landTime` stays as an UNADVERTISED back-compat alias so a body saved
    // before the wildcard cleanup still renders (it's no longer a chip).
    arrivalTime: clock(e.arrivalAt),
    landTime: clock(e.arrivalAt),
    offset: humanizeOffset(fireAt - e.arrivalAt),
  };
};

/**
 * Reconcile this universe's FLEET-SAVE slice of the queue. Each detected FS
 * is a MULTI-slot series fired at each of its `fireAts` (the relative-offset
 * schedule resolved against the leg's arrival), at flat {@link ADHOC_PRIORITY}
 * — an FS is high-value, so it rings as urgently as a player-armed reminder.
 *
 * Same idempotent reconcile as waves/ad-hoc, under the distinct FS title, so
 * a send-reload on mobile self-heals. Slots beyond ntfy's 3-day cap are
 * dropped here (ntfy would reject the `X-Delay` and the producer would retry
 * forever); past / too-soon slots are skipped inside {@link reconcileQueue}.
 * Pass `entries: []` to cancel every FS reminder queued for this universe.
 *
 * @param {object} args
 * @param {Array<{ id: string, arrivalAt: number, label: string, shipCount?: number, fireAts: number[] }>} args.entries
 * @param {string} args.topic
 * @param {string} args.token
 * @param {number} args.now         Epoch SECONDS.
 * @param {string} args.universeId
 * @param {import('../domain/reminderTemplates.js').ReminderTemplate} [args.template]
 *   Fleet-save message customisation; defaults to the built-in FS template.
 * @param {Array<{ id: string, time: number, title?: string }>} [args.queue]
 *   Pre-fetched queue snapshot (see {@link reconcileQueue}) — lets the caller
 *   share one poll across kinds.
 * @returns {Promise<{ idsByEntry: Record<string, string[]>, posted: number, cancelled: number }>}
 */
export const reconcileFleetSaveQueue = async ({
  entries, topic, token, now, universeId,
  template = defaultReminderTemplates().fleetSave,
  queue,
}) => {
  const icon = resolveIconUrl(template.icon);
  /** @type {QueueSeries[]} */
  const series = entries.map((e) => ({
    id: e.id,
    slots: e.fireAts
      .filter((fireAt) => fireAt <= now + NTFY_MAX_DELAY_SEC)
      .map((fireAt) => ({
        fireAt,
        body: renderTemplate(template.body, fsCtx(universeId, e, fireAt)),
        priority: template.priority,
        icon,
      })),
  }));
  const { idsBySeries, posted, cancelled } = await reconcileQueue({
    series, topic, token, now, title: fsTitleFor(universeId), queue,
  });
  return { idsByEntry: idsBySeries, posted, cancelled };
};
