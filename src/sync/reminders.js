// @ts-check

// Reminder-state gist IO — the transport between the extension and the
// Cloudflare Worker.
//
// # The separate plain-JSON file
//
// The cross-device sync payload lives in `oge-data.json.gz.b64`
// (gzip+base64, schema 3) and `fetchGistData` rejects anything that
// isn't schema 3. The reminder state must NOT go there. Instead we keep
// it in a SECOND file in the same gist, {@link REMINDER_FILENAME}, as
// plain pretty-printed JSON. Two payoffs:
//
//   - the Worker reads it with a bare `JSON.parse` (no gunzip in a
//     Worker), and
//   - the schema-3 reader never trips over it.
//
// # Field ownership (avoids write races)
//
// The gist file has three top-level blocks with distinct owners:
//
//   - `config`      — written by the extension (mirrors the global
//                     reminder config the user edits on the histogram tab).
//   - `waves`       — written by the extension (the reconciled wave set).
//   - `notifyState` — written by the WORKER (per-wave notifyCount /
//                     lastNotifiedAt).
//
// Each side preserves the other's block on write. The extension does
// touch `notifyState` in exactly one controlled way: it RESETS the
// counters for a wave whose `nextWaveAt` just jumped forward (a detected
// re-send) and PRUNES counters for waves that disappeared. Both are pure
// transforms from `domain/waves`.
//
// # Histogram preview mirror
//
// The histogram page is extension-origin and cannot read the game
// origin's localStorage (where the gist token lives). To let it render a
// live preview we mirror the gist id + token + last-written state into
// `chrome.storage.local`. This is a deliberate, product-owner-approved
// exception to the "never mirror the token" rule in `state/settings.js`:
// chrome.storage is extension-private (not web-reachable) and the live
// preview is the concrete benefit.
//
// @see ../domain/waves.js — reconcileWaves / applyResets / pruneNotifyState
// @see ../state/reminderConfig.js — the config block this writes

/* global fetch */

import { gh, ensureGistV3, getToken, getGistId } from './gist.js';
import { chromeStore } from '../lib/storage.js';
import {
  reconcileWaves,
  applyResets,
  pruneNotifyState,
} from '../domain/waves.js';

/**
 * @typedef {import('../domain/waves.js').Wave} Wave
 * @typedef {import('../domain/waves.js').NotifyEntry} NotifyEntry
 * @typedef {import('../state/reminderConfig.js').ReminderConfig} ReminderConfig
 */

/** Filename of the plain-JSON reminder-state file inside the OG-E gist. */
export const REMINDER_FILENAME = 'oge-reminders.json';

/** Schema version of the reminder file. Bumped only on breaking shape changes. */
export const REMINDER_SCHEMA_VERSION = 1;

/** chrome.storage.local key holding the last-written reminder state (preview). */
export const REMINDER_MIRROR_KEY = 'oge_reminderMirror';

/** chrome.storage.local key holding the gist id (so the histogram can fetch live). */
export const REMINDER_GIST_ID_KEY = 'oge_reminderGistId';

/** chrome.storage.local key holding the gist token (preview-fetch only). */
export const REMINDER_TOKEN_KEY = 'oge_reminderToken';

/**
 * Full shape of {@link REMINDER_FILENAME}.
 *
 * @typedef {object} ReminderState
 * @property {number} version
 * @property {string} updatedAt          ISO timestamp of the last write.
 * @property {ReminderConfig} config     Extension-owned config block.
 * @property {Wave[]} waves              Extension-owned reconciled waves.
 * @property {Record<string, NotifyEntry>} notifyState  Worker-owned counters.
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
 * Structural-equality check over the parts the extension owns plus the
 * notifyState it may have mutated. Ignores `updatedAt` (always changes)
 * so an otherwise-identical state doesn't trigger a pointless PATCH and
 * a no-op gist revision.
 *
 * @param {ReminderState | null} a
 * @param {ReminderState} b
 * @returns {boolean}
 */
const sameState = (a, b) => {
  if (!a) return false;
  /** @param {ReminderState} s @returns {string} */
  const pick = (s) =>
    JSON.stringify({ config: s.config, waves: s.waves, notifyState: s.notifyState });
  return pick(a) === pick(b);
};

/**
 * Mirror the just-written state (plus the gist id + token) into
 * `chrome.storage.local` so the histogram page can render a live
 * preview and, if it wants fresher data, fetch the gist directly.
 *
 * Best-effort: failures are swallowed (preview is non-critical).
 *
 * @param {ReminderState} state
 * @returns {Promise<void>}
 */
const mirrorForPreview = async (state) => {
  try {
    await Promise.all([
      chromeStore.set(REMINDER_MIRROR_KEY, state),
      chromeStore.set(REMINDER_GIST_ID_KEY, getGistId()),
      chromeStore.set(REMINDER_TOKEN_KEY, getToken()),
    ]);
  } catch {
    // Preview mirror is non-critical — never let it break a wave push.
  }
};

/**
 * The core extension-side round-trip: take the waves just observed in
 * the event list, reconcile them with what the gist already holds, and
 * write the result back (only when something changed).
 *
 * Steps:
 *   1. Bail when no token is configured — the gist is the only transport
 *      and without a token we can't read or write it. The histogram tab
 *      tells the user to set one.
 *   2. Read the existing file for the previous waves + the worker's
 *      notifyState.
 *   3. {@link reconcileWaves} — merge prev/current by origin-set identity
 *      (new / re-sent / idle-and-kept), yielding the wave set to store
 *      and the ids whose counters must reset.
 *   4. {@link applyResets} + {@link pruneNotifyState} on the notifyState
 *      (resets for re-sends, drop counters for vanished waves).
 *   5. PATCH only when the owned blocks actually changed; always refresh
 *      the preview mirror.
 *
 * @param {ReminderConfig} config   Current global config (from the store).
 * @param {Wave[]} currentWaves     Freshly clustered waves from the DOM.
 * @param {number} now              Epoch SECONDS, injected by the caller.
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, waves?: Wave[] }>}
 */
export const syncReminderWaves = async (config, currentWaves, now) => {
  if (!getToken()) return { ok: false, reason: 'no-token' };

  const existing = await readReminderState();
  const prevWaves = existing?.waves ?? [];
  const prevNotify = existing?.notifyState ?? {};

  const { waves, resetIds } = reconcileWaves(prevWaves, currentWaves, now);
  const notifyState = pruneNotifyState(applyResets(prevNotify, resetIds), waves);

  /** @type {ReminderState} */
  const next = {
    version: REMINDER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    config,
    waves,
    notifyState,
  };

  const changed = !sameState(existing, next);
  if (changed) await writeReminderState(next);
  await mirrorForPreview(next);
  return { ok: true, changed, waves };
};
