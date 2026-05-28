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
// One global file per gist. Three top-level blocks:
//
//   - `config`      — `{ enabled }`, plus any token mirrored for the
//                     histogram preview (gist id + gist token).
//   - `waves`       — the reconciled wave set (output of
//                     `domain/waves.reconcileWaves`).
//   - `notifyState` — per-wave bookkeeping. As of v1.3.1 each entry
//                     holds the IDs of the ntfy.sh scheduled messages
//                     queued for that wave, so a re-send can cancel
//                     them before delivery (no separate cron worker).
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
// @see ../domain/waves.js — reconcileWaves / applyResets / pruneNotifyState
// @see ../state/settings.js — `reminderEnabled` / `reminderNtfyToken`
// @see ../features/histogram/reminders.js — the preview consumer

/* global fetch */

import { gh, ensureGistV3, getToken, getGistId } from './gist.js';
import { chromeStore } from '../lib/storage.js';
import {
  reconcileWaves,
  applyRenames,
  applyResets,
  pruneNotifyState,
} from '../domain/waves.js';
import {
  scheduleWaveReminders,
  cancelWaveReminders,
  fetchScheduledMessages,
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

/** Filename of the plain-JSON reminder-state file inside the OG-E gist. */
export const REMINDER_FILENAME = 'oge-reminders.json';

/** Schema version of the reminder file. Bumped only on breaking shape changes. */
export const REMINDER_SCHEMA_VERSION = 1;

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
 * Full shape of {@link REMINDER_FILENAME}. Reminder config is NOT in the
 * gist any more — it lives in localStorage settings at the game origin
 * (see `state/settings.js`). The gist is purely the wave list + the
 * `scheduledMessageIds` cancellation handles, durable across browser
 * restarts.
 *
 * @typedef {object} ReminderState
 * @property {number} version
 * @property {string} updatedAt          ISO timestamp of the last write.
 * @property {Wave[]} waves              Reconciled wave set.
 * @property {Record<string, NotifyEntry>} notifyState  Per-wave bookkeeping
 *   (scheduled ntfy.sh message ids for cancellation).
 */

/**
 * Read and parse the reminder file from the gist. Returns `null` when
 * the gist has no such file yet (first run) or the content can't be
 * parsed (hand-edited / corrupt — the next write rebuilds it).
 *
 * @returns {Promise<ReminderState | null>}
 */
export const readReminderState = async () => {
  const id = await ensureGistV3();
  const gist = await gh(`/gists/${id}`);
  const file = gist?.files?.[REMINDER_FILENAME];
  if (!file) return null;
  const text =
    file.truncated && file.raw_url
      ? await (await fetch(file.raw_url)).text()
      : file.content;
  try {
    return /** @type {ReminderState} */ (JSON.parse(text));
  } catch {
    return null;
  }
};

/**
 * Write the reminder file (plain JSON, pretty-printed). Creates /
 * discovers the gist as needed via {@link ensureGistV3}.
 *
 * @param {ReminderState} state
 * @returns {Promise<void>}
 */
export const writeReminderState = async (state) => {
  const id = await ensureGistV3();
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [REMINDER_FILENAME]: { content: JSON.stringify(state, null, 2) } },
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
 * Best-effort: failures are swallowed (preview is non-critical, never
 * let it break a wave write).
 *
 * @param {ReminderState} state
 * @param {string} ntfyToken  Current ntfy access token from Settings.
 * @returns {Promise<void>}
 */
const mirrorForPreview = async (state, ntfyToken) => {
  try {
    await Promise.all([
      chromeStore.set(REMINDER_MIRROR_KEY, state),
      chromeStore.set(REMINDER_GIST_ID_KEY, getGistId()),
      chromeStore.set(REMINDER_TOKEN_KEY, getToken()),
      chromeStore.set(REMINDER_NTFY_TOKEN_KEY, ntfyToken),
    ]);
  } catch {
    // Best-effort — see above.
  }
};

/**
 * The core extension-side round-trip:
 *
 *   1. Bail when no GitHub token is configured (no way to read/write the
 *      gist). The histogram tab tells the user.
 *   2. Read the existing reminder file; build prev waves + notifyState.
 *   3. {@link reconcileWaves} — overlap-aware match producing the wave
 *      set to store, the ids whose schedules must reset (re-send), and
 *      a rename channel for adopted supersets.
 *   4. Apply renames so per-wave `scheduledMessageIds` follow their
 *      wave's new identity.
 *   5. Talk to ntfy.sh: cancel messages for waves that vanished and for
 *      waves that need rescheduling; schedule six fresh pushes (every
 *      ten minutes) for each new or re-sent wave. When the feature is
 *      disabled, cancel everything we ever queued. Failures inside the
 *      ntfy loop are isolated per wave — one bad slot doesn't block the
 *      gist write or the other waves.
 *   6. Finalise notifyState (drop resets + dead entries; install the
 *      fresh schedule ids) and PATCH the gist only when the owned
 *      blocks actually changed.
 *   7. Refresh the histogram preview mirror.
 *
 * @param {ReminderConfig} config   Current config (from the store).
 * @param {Wave[]} currentWaves     Freshly clustered waves from the DOM.
 * @param {number} now              Epoch SECONDS, injected by the caller.
 * @param {string} universeId       OGame server id, used only as a label in
 *   ntfy.sh push titles (`[s163-pl] Expeditions back`).
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, waves?: Wave[], scheduled?: number, cancelled?: number }>}
 */
export const syncReminderWaves = async (config, currentWaves, now, universeId) => {
  if (!getToken()) return { ok: false, reason: 'no-token' };

  const existing = await readReminderState();
  const prevWaves = existing?.waves ?? [];
  const prevNotify = existing?.notifyState ?? {};

  const { waves, resetIds, renames } = reconcileWaves(prevWaves, currentWaves, now);
  const renamed = applyRenames(prevNotify, renames);

  // Figure out which waves need a fresh schedule and which old message
  // ids to cancel. Done BEFORE we mutate notifyState further so we can
  // still see the prior `scheduledMessageIds`.
  const outIds = new Set(waves.map((w) => w.id));
  const resetSet = new Set(resetIds);
  /** @type {Wave[]} */
  const toSchedule = [];
  /** @type {string[]} */
  const toCancel = [];

  for (const w of waves) {
    const prev = renamed[w.id];
    const isReset = resetSet.has(w.id);
    const isBrandNew = !prev;
    if (isReset || isBrandNew) {
      toSchedule.push(w);
      if (prev?.scheduledMessageIds) toCancel.push(...prev.scheduledMessageIds);
    }
    // else: in-flight unchanged — keep its existing schedule
  }
  for (const [id, entry] of Object.entries(renamed)) {
    if (outIds.has(id)) continue;
    if (entry.scheduledMessageIds) toCancel.push(...entry.scheduledMessageIds);
  }

  // Start the next notifyState from the pruned + reset shape; we'll
  // overwrite entries for waves we successfully (re)schedule below.
  /** @type {Record<string, NotifyEntry>} */
  const notifyState = pruneNotifyState(applyResets(renamed, resetIds), waves);

  // ntfy operations — skip when disabled OR no token (we still persist
  // the reconciled gist state so the histogram preview stays current).
  const gistId = await ensureGistV3();
  const topic = await deriveNtfyTopic(gistId);
  let cancelled = 0;
  let scheduled = 0;

  if (config.ntfyToken && topic) {
    if (!config.enabled) {
      // Feature off → cancel everything we ever queued, including
      // schedules for in-flight waves we'd normally have left alone.
      const everyId = [];
      for (const entry of Object.values(renamed)) {
        if (entry.scheduledMessageIds) everyId.push(...entry.scheduledMessageIds);
      }
      cancelled += await cancelWaveReminders({
        ids: everyId, topic, token: config.ntfyToken,
      });
      // Strip schedules from notifyState so re-enabling triggers fresh schedules.
      for (const id of Object.keys(notifyState)) delete notifyState[id];
    } else {
      // Cancel obsolete first so we don't race the new schedule.
      cancelled += await cancelWaveReminders({
        ids: toCancel, topic, token: config.ntfyToken,
      });
      for (const wave of toSchedule) {
        try {
          const newIds = await scheduleWaveReminders({
            wave, topic, token: config.ntfyToken, now, universeId,
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
    }

    // Orphan sweep: anything still queued on ntfy that doesn't appear
    // in our final notifyState is a leftover from an earlier sync that
    // lost track of an id (a 401 on cancel, a mid-iteration crash, a
    // pre-token-mirror schedule). Cancel them so the user doesn't get
    // ghosts. Failures here are non-fatal — orphans live until they
    // either fire or `expires` ticks past.
    try {
      const ours = new Set();
      for (const e of Object.values(notifyState)) {
        if (e.scheduledMessageIds) for (const id of e.scheduledMessageIds) ours.add(id);
      }
      const queue = await fetchScheduledMessages({ topic, token: config.ntfyToken, now });
      const orphanIds = queue.map((m) => m.id).filter((id) => !ours.has(id));
      if (orphanIds.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[oge] cancelling ${orphanIds.length} orphan ntfy message(s)`);
        cancelled += await cancelWaveReminders({
          ids: orphanIds, topic, token: config.ntfyToken,
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
  if (changed) await writeReminderState(next);
  await mirrorForPreview(next, config.ntfyToken);
  return { ok: true, changed, waves, scheduled, cancelled };
};
