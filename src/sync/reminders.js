// @ts-check

// Reminder-state gist IO — backing store for the expedition reminder
// feature.
//
// # The separate plain-JSON file
//
// The cross-device sync payload lives in `oge-data.json.gz.b64`
// (gzip+base64, schema 3) and `fetchGistData` rejects anything that
// isn't schema 3. The reminder state must NOT go there. Instead we keep
// it in a SECOND file in the same gist, {@link REMINDER_FILENAME}, as
// plain pretty-printed JSON.
//
// # What's stored
//
// One global file per gist. Two top-level blocks:
//
//   - `waves`       — the reconciled wave set (output of
//                     `domain/waves.reconcileWaves`).
//   - `notifyState` — per-wave bookkeeping. Each entry holds the IDs of
//                     the ntfy.sh scheduled messages queued for that
//                     wave, so a re-send / cleanup pass can cancel them
//                     before delivery.
//
// # Lock-at-birth scheduling rule
//
// ntfy.sh messages are scheduled **exactly once per wave**, at the
// moment the wave is detected as brand-new. Subsequent observations of
// the same wave (matched by fleet-ID overlap in `reconcileWaves`) do
// not re-schedule, do not adjust, do not cancel anything. The six
// timestamps freeze on the first `nextWaveAt` we ever saw for that wave.
//
// This is a deliberate trade-off: if a later send adds a fleet whose
// return is earlier than the first one we observed, the first reminder
// fires a minute late. In exchange we get a wave whose identity AND
// schedule are completely immutable from creation to landing, with no
// stacked-schedule bug possible.
//
// # OG-E Dashboard preview mirror
//
// The OG-E Dashboard's Reminders tab renders a live view of what's
// queued. That page is at extension origin and cannot read the game
// origin's localStorage (where the gist token lives), so on every
// sync the game side mirrors the last-written state plus the gist
// id + token into `chrome.storage.local`. Two consumers: a fast
// fallback render from the snapshot, and a live `fetch` against the
// gist for fresh data when the token is mirrored.
//
// The token mirror is a deliberate, product-owner-approved exception
// to the "never mirror the token" rule in `state/settings.js`:
// `chrome.storage` is extension-private (not web-reachable) and the
// live preview is the concrete benefit.
//
// @see ../domain/waves.js — reconcileWaves / pruneNotifyState
// @see ../state/settings.js — `reminderEnabled` / `reminderNtfyToken`
// @see ../features/histogram/reminders.js — the preview consumer

/* global fetch */

import { gh, ensureGistV3, getToken, getGistId } from './gist.js';
import { chromeStore } from '../lib/storage.js';
import { reconcileWaves, pruneNotifyState } from '../domain/waves.js';
import {
  scheduleWaveReminders,
  cancelWaveReminders,
  fetchScheduledMessages,
  REMINDER_COUNT,
  REMINDER_INTERVAL_SEC,
} from './ntfyScheduler.js';

/**
 * @typedef {import('../domain/waves.js').Wave} Wave
 * @typedef {import('../domain/waves.js').NotifyEntry} NotifyEntry
 */

/**
 * Minimal config shape the producer passes in. Mirrors the two
 * reminder-related fields of `Settings` so this module does not depend
 * on the settings typedef (any caller that yields the right shape
 * works — useful for tests).
 *
 * @typedef {object} ReminderConfig
 * @property {boolean} enabled
 * @property {string} ntfyToken
 */

/**
 * Filename prefix of the per-universe reminder-state files inside the
 * OG-E gist. The full filename is `${REMINDER_FILENAME_PREFIX}${universeId}.json`.
 *
 * Multi-universe isolation rule (v3): each OGame universe owns its OWN
 * file in the shared gist. Universe A's content script writes
 * `oge-reminders-s163-pl.json`, universe B's writes
 * `oge-reminders-s201-pl.json`. GitHub's gist PATCH operates per file,
 * so one universe never clobbers another's waves or notifyState. This
 * fixes the v2-era ping-pong where two universes sharing one file
 * cancelled each other's ntfy schedules repeatedly until ntfy.sh
 * rate-limited the account.
 */
export const REMINDER_FILENAME_PREFIX = 'oge-reminders-';

/**
 * Build the gist filename for a universe.
 *
 * @param {string} universeId  e.g. `'s163-pl'`. See `lib/universeId.js`.
 * @returns {string}
 */
export const reminderFilenameFor = (universeId) =>
  `${REMINDER_FILENAME_PREFIX}${universeId}.json`;

/**
 * Regex matching all per-universe reminder filenames in a gist.
 * Capture group 1 is the universeId. Used by the dashboard to
 * enumerate every universe currently in the gist.
 */
export const REMINDER_FILENAME_RE = /^oge-reminders-([^/]+)\.json$/;

/**
 * Schema version of the reminder file.
 *
 *   - v1: time-based wave identity (pre-1.3.2). `Wave.id` was
 *     `'w_' + nextWaveAt`, with a 300 s drift tolerance in reconcile.
 *   - v2: return-time-set overlap identity, single shared file
 *     `oge-reminders.json` — broken in multi-universe setups.
 *   - v3: same identity model as v2, but the file is now scoped per
 *     universe (`oge-reminders-<universeId>.json`). Mirror in
 *     chrome.storage is also keyed per universe. We do NOT migrate v2
 *     state — the next sync drops it and the orphan sweep cancels any
 *     v2-era ntfy messages still queued.
 */
export const REMINDER_SCHEMA_VERSION = 3;

/**
 * Derive the ntfy.sh topic deterministically from the gist id. Topics
 * are public-by-URL, so we want a string an attacker can't guess — but
 * we also want one canonical channel without extra configuration. SHA-
 * 256 over the gist id (already a 32-char hex secret rendered private
 * by the gist token) gives us exactly that.
 *
 *   - `oge-` prefix → recognisable in the ntfy app.
 *   - 22 hex chars → 88 bits of entropy, plenty for an unguessable
 *     topic, while staying short enough for the ntfy UI.
 *
 * Returns the empty string when `gistId` is falsy (preview before the
 * gist has been set up).
 *
 * @param {string} gistId
 * @returns {Promise<string>}
 */
export const deriveNtfyTopic = async (gistId) => {
  if (!gistId) return '';
  const bytes = new TextEncoder().encode(gistId);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return 'oge-' + hex.slice(0, 22);
};

/** chrome.storage.local key holding the last-written reminder state (preview). */
export const REMINDER_MIRROR_KEY = 'oge_reminderMirror';

/** chrome.storage.local key holding the gist id (so the dashboard can fetch live). */
export const REMINDER_GIST_ID_KEY = 'oge_reminderGistId';

/** chrome.storage.local key holding the gist token (preview-fetch only). */
export const REMINDER_TOKEN_KEY = 'oge_reminderToken';

/**
 * chrome.storage.local key holding the ntfy.sh access token. Mirrored
 * from game-origin Settings (`oge_reminderNtfyToken` in localStorage)
 * so the OG-E Dashboard, which runs at extension origin, can call
 * ntfy's queue endpoint without re-asking the user for the token.
 */
export const REMINDER_NTFY_TOKEN_KEY = 'oge_reminderNtfyTokenMirror';

/**
 * Full shape of {@link REMINDER_FILENAME}. Reminder config lives in
 * localStorage settings at the game origin (see `state/settings.js`).
 * The gist is purely the wave list + the `scheduledMessageIds`
 * cancellation handles, durable across browser restarts.
 *
 * @typedef {object} ReminderState
 * @property {number} version
 * @property {string} updatedAt          ISO timestamp of the last write.
 * @property {Wave[]} waves              Reconciled wave set.
 * @property {Record<string, NotifyEntry>} notifyState  Per-wave bookkeeping
 *   (scheduled ntfy.sh message ids for cancellation).
 */

/**
 * Read and parse this universe's reminder file from the gist. Returns
 * `null` when the gist has no such file yet (first run) or the content
 * can't be parsed (hand-edited / corrupt — the next write rebuilds it).
 *
 * State at older schema versions is treated as absent: we never
 * migrate, we just start fresh and let the orphan sweep clean up any
 * ntfy messages the old code had scheduled.
 *
 * @param {string} universeId
 * @returns {Promise<ReminderState | null>}
 */
export const readReminderState = async (universeId) => {
  const id = await ensureGistV3();
  const gist = await gh(`/gists/${id}`);
  const file = gist?.files?.[reminderFilenameFor(universeId)];
  if (!file) return null;
  const text =
    file.truncated && file.raw_url
      ? await (await fetch(file.raw_url)).text()
      : file.content;
  try {
    const parsed = /** @type {ReminderState} */ (JSON.parse(text));
    if (parsed?.version !== REMINDER_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Write this universe's reminder file (plain JSON, pretty-printed).
 * Creates / discovers the gist as needed via {@link ensureGistV3}.
 *
 * @param {string} universeId
 * @param {ReminderState} state
 * @returns {Promise<void>}
 */
export const writeReminderState = async (universeId, state) => {
  const id = await ensureGistV3();
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [reminderFilenameFor(universeId)]: { content: JSON.stringify(state, null, 2) },
      },
    }),
  });
};

/**
 * Structural-equality check over the parts we persist. Ignores
 * `updatedAt` (always changes) so an otherwise-identical state doesn't
 * trigger a pointless PATCH and a no-op gist revision.
 *
 * @param {ReminderState | null} a
 * @param {ReminderState} b
 * @returns {boolean}
 */
const sameState = (a, b) => {
  if (!a) return false;
  /** @param {ReminderState} s @returns {string} */
  const pick = (s) => JSON.stringify({ waves: s.waves, notifyState: s.notifyState });
  return pick(a) === pick(b);
};

/**
 * Mirror the just-written state (plus the gist id + tokens) into
 * `chrome.storage.local` so the OG-E Dashboard's Reminders tab can
 * render a live preview. Two GET calls the dashboard makes need the
 * mirrored credentials: the gist fetch (gist token) and the ntfy
 * queue fetch (ntfy token).
 *
 * The mirror is a dict keyed by universeId so multiple universes
 * (multiple OGame tabs from different servers) coexist in the same
 * `chrome.storage.local`. Each producer reads-modifies-writes only
 * its own slot, never touching the others.
 *
 * Best-effort: failures are swallowed (preview is non-critical, never
 * let it break a wave write).
 *
 * @param {string} universeId
 * @param {ReminderState} state
 * @param {string} ntfyToken  Current ntfy access token from Settings.
 * @returns {Promise<void>}
 */
const mirrorForPreview = async (universeId, state, ntfyToken) => {
  try {
    const existing = await chromeStore.get(REMINDER_MIRROR_KEY);
    /** @type {Record<string, ReminderState>} */
    const dict = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? { .../** @type {Record<string, ReminderState>} */ (existing) }
      : {};
    dict[universeId] = state;
    await Promise.all([
      chromeStore.set(REMINDER_MIRROR_KEY, dict),
      chromeStore.set(REMINDER_GIST_ID_KEY, getGistId()),
      chromeStore.set(REMINDER_TOKEN_KEY, getToken()),
      // ntfyToken is global — last writer wins, all universes share.
      ...(ntfyToken ? [chromeStore.set(REMINDER_NTFY_TOKEN_KEY, ntfyToken)] : []),
    ]);
  } catch {
    // Best-effort — see above.
  }
};

/**
 * Resolve the ntfy access token to use. Prefers the value the caller
 * passed in (from per-origin localStorage Settings), falling back to
 * the chrome.storage mirror so a universe whose Settings panel hasn't
 * been touched still gets reminders once any other universe sets one.
 *
 * @param {string} configToken  `ntfyToken` as passed by the producer.
 * @returns {Promise<string>}
 */
const resolveNtfyToken = async (configToken) => {
  if (configToken) return configToken;
  const mirrored = await chromeStore.get(REMINDER_NTFY_TOKEN_KEY);
  return typeof mirrored === 'string' ? mirrored : '';
};

/**
 * The core extension-side round-trip:
 *
 *   1. Bail when no GitHub token is configured (no way to read/write the
 *      gist). The histogram tab tells the user.
 *   2. Read the existing reminder file; build prev waves + notifyState.
 *   3. {@link reconcileWaves} — fleet-ID overlap matching producing the
 *      wave set to store, the ids of waves that fell out (landed or
 *      swept by the brand-new cleanup rule), and a flag indicating
 *      whether at least one brand-new wave was stamped.
 *   4. Talk to ntfy.sh: cancel scheduled message IDs for every dropped
 *      wave. Schedule six fresh pushes (every ten minutes) for each
 *      brand-new wave. Matched waves are NEVER re-scheduled — their
 *      schedule was locked at birth. When the feature is disabled,
 *      cancel everything we ever queued.
 *   5. Refresh the histogram preview mirror.
 *
 * @param {ReminderConfig} config   Current config (from the store).
 * @param {import('../domain/waves.js').WaveCandidate[]} currentCandidates
 *   Freshly clustered wave candidates from the DOM (no id yet).
 * @param {number} now              Epoch SECONDS, injected by the caller.
 * @param {string} universeId       OGame server id, used only as a label in
 *   ntfy.sh push titles (`[s163-pl] Expeditions back`).
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, waves?: Wave[], scheduled?: number, cancelled?: number }>}
 */
export const syncReminderWaves = async (config, currentCandidates, now, universeId) => {
  if (!getToken()) return { ok: false, reason: 'no-token' };

  // Token resolution: prefer per-origin localStorage value; fall back
  // to the global chrome.storage mirror so a universe that hasn't been
  // configured manually still works once any other universe has set
  // its ntfy token.
  const ntfyToken = await resolveNtfyToken(config.ntfyToken);

  const existing = await readReminderState(universeId);
  const prevWaves = existing?.waves ?? [];
  const prevNotify = existing?.notifyState ?? {};

  const { waves, droppedIds } = reconcileWaves(prevWaves, currentCandidates, now);

  // Brand-new waves are the ones whose id does NOT appear in prevNotify.
  // Matched waves carry their prev id forward, so prevNotify[w.id] exists.
  /** @type {Wave[]} */
  const toSchedule = waves.filter((w) => !prevNotify[w.id]);

  // Anything dropped (landed or swept) feeds toCancel.
  /** @type {string[]} */
  const toCancel = [];
  for (const id of droppedIds) {
    const e = prevNotify[id];
    if (e?.scheduledMessageIds) toCancel.push(...e.scheduledMessageIds);
  }

  // Start the next notifyState from the prev shape, pruned to the live
  // set; we'll add entries for brand-new waves we successfully schedule.
  /** @type {Record<string, NotifyEntry>} */
  const notifyState = pruneNotifyState(prevNotify, waves);

  const gistId = await ensureGistV3();
  const topic = await deriveNtfyTopic(gistId);
  let cancelled = 0;
  let scheduled = 0;

  if (ntfyToken && topic) {
    if (!config.enabled) {
      // Feature off → cancel everything we ever queued, including
      // schedules for in-flight waves we'd normally have left alone.
      const everyId = [];
      for (const entry of Object.values(prevNotify)) {
        if (entry.scheduledMessageIds) everyId.push(...entry.scheduledMessageIds);
      }
      cancelled += await cancelWaveReminders({
        ids: everyId, topic, token: ntfyToken,
      });
      // Strip schedules from notifyState so re-enabling triggers fresh schedules.
      for (const id of Object.keys(notifyState)) delete notifyState[id];
    } else {
      // Cancel dropped first so we don't race a brand-new schedule.
      cancelled += await cancelWaveReminders({
        ids: toCancel, topic, token: ntfyToken,
      });
      for (const wave of toSchedule) {
        try {
          const newIds = await scheduleWaveReminders({
            wave, topic, token: ntfyToken, now, universeId,
          });
          notifyState[wave.id] = { scheduledMessageIds: newIds };
          scheduled += newIds.length;
        } catch (e) {
          // One bad wave: log and carry on. Next sync tick will retry
          // because we never advance `lastSig` on a failed schedule.
          // eslint-disable-next-line no-console
          console.warn(`[oge] schedule failed for ${wave.id}:`, e);
        }
      }
      if (scheduled > 0) {
        const fireTimes = toSchedule.flatMap((w) => {
          const times = [];
          for (let i = 0; i < REMINDER_COUNT; i++) {
            const t = w.nextWaveAt + i * REMINDER_INTERVAL_SEC;
            if (t > now) times.push(new Date(t * 1000).toLocaleTimeString());
          }
          return times;
        });
        // eslint-disable-next-line no-console
        console.log(`[oge] scheduled ${scheduled} ntfy reminder(s) → ${fireTimes.join(', ')}`);
      }
    }

    // Orphan sweep: anything still queued on ntfy that doesn't appear
    // in our final notifyState is a leftover — a 401 on cancel, a
    // mid-iteration crash, a v1→v2 schema migration that wiped our
    // local map of ids. Cancel them so the user doesn't get ghosts.
    // Failures here are non-fatal — orphans live until they either
    // fire or `expires` ticks past.
    try {
      const ours = new Set();
      for (const e of Object.values(notifyState)) {
        if (e.scheduledMessageIds) for (const id of e.scheduledMessageIds) ours.add(id);
      }
      const queue = await fetchScheduledMessages({ topic, token: ntfyToken, now });
      const orphanIds = queue.map((m) => m.id).filter((id) => !ours.has(id));
      if (orphanIds.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[oge] cancelling ${orphanIds.length} orphan ntfy message(s)`);
        cancelled += await cancelWaveReminders({
          ids: orphanIds, topic, token: ntfyToken,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[oge] orphan sweep failed:', e);
    }
  }

  /** @type {ReminderState} */
  const next = {
    version: REMINDER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    waves,
    notifyState,
  };

  const changed = !sameState(existing, next);
  if (changed) await writeReminderState(universeId, next);
  await mirrorForPreview(universeId, next, ntfyToken);
  return { ok: true, changed, waves, scheduled, cancelled };
};
