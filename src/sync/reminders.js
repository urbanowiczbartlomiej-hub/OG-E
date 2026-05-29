// @ts-check

// Reminder-state gist IO — backing store for the expedition reminder
// feature.
//
// # The separate plain-JSON file
//
// The cross-device sync payload lives in `oge-data.json.gz.b64`
// (gzip+base64, schema 3) and `fetchGistData` rejects anything that
// isn't schema 3. The reminder state must NOT go there. Instead we keep
// it in separate files in the same gist, one per universe (see
// {@link reminderFilenameFor}), as plain pretty-printed JSON.
//
// # What's stored
//
// One file per OGame universe per gist (multi-universe isolation, v3 —
// see {@link REMINDER_FILENAME_PREFIX}). Two top-level blocks:
//
//   - `waves`       — the reconciled wave set (output of
//                     `domain/waves.reconcileWaves`).
//   - `notifyState` — per-wave bookkeeping. Each entry holds the locked
//                     schedule anchor (`baseAt`) and the IDs of the
//                     ntfy.sh messages currently queued for that wave.
//                     The gist is a CACHE of the queue, not the source of
//                     truth — see the scheduling rule below.
//
// # Idempotent scheduling, locked at birth
//
// The queue on ntfy.sh — not the gist — is the source of truth for what
// is scheduled. Every sync hands the live waves to
// `ntfyScheduler.reconcileWaveQueue`, which polls the queue and converges
// it to exactly one message per future slot of every live wave: it posts
// only missing slots and cancels only messages that belong to no live
// wave. We then write whatever ids ended up on the queue back to the gist.
//
// Each wave's slot times are anchored at `baseAt`, locked the first time
// we record the wave and fed back unchanged on later scans, so the six
// timestamps stay put even as the earliest live return drifts. Trade-off:
// if a later send adds a fleet returning earlier than the first we saw,
// the first reminder fires a minute late. In exchange the schedule is
// immutable from creation to landing.
//
// Why reconcile instead of "schedule once, never touch again": on mobile,
// *sending a fleet reloads the page* and kills the content script mid-
// sync. The old "POST six, then write the ids" sequence routinely lost the
// gist write after only some POSTs landed, so the next load saw no record,
// treated the wave as brand-new, and stacked another partial schedule —
// the 7×/5×/3× duplicate-notification bug. Reconciling against the queue
// makes a mid-sync reload harmless: the next load just converges.
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
import { reconcileWaveQueue } from './ntfyScheduler.js';

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
 * Full shape of a per-universe reminder file (see {@link reminderFilenameFor}).
 * Reminder config lives in localStorage settings at the game origin (see
 * `state/settings.js`). The gist is purely the wave list + per-wave
 * bookkeeping (`baseAt` anchor + queued `scheduledMessageIds`), a cache of
 * the ntfy queue that is durable across browser restarts.
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
      // Only mirror a syntactically valid token, so garbage typed into
      // one universe's Settings can't poison the global mirror.
      ...(isValidNtfyToken(ntfyToken) ? [chromeStore.set(REMINDER_NTFY_TOKEN_KEY, ntfyToken)] : []),
    ]);
  } catch {
    // Best-effort — see above.
  }
};

/**
 * ntfy.sh access-token format. Tokens look like `tk_` + at least 20
 * alphanumeric characters (see https://docs.ntfy.sh/config/#access-
 * tokens). We require this shape strictly because the Settings input
 * is a freeform text field — users have historically pasted other
 * things into it (most amusingly: a copy of the dashboard preview
 * text), and ntfy's response to a malformed token is a 401 that
 * Firefox surfaces as a CORS preflight failure. Treating any value
 * that doesn't match this pattern as "not configured" lets the
 * chrome.storage fallback kick in instead, which usually has the
 * correct token from another universe.
 */
const NTFY_TOKEN_RE = /^tk_[A-Za-z0-9]{20,}$/;

/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidNtfyToken = (token) =>
  typeof token === 'string' && NTFY_TOKEN_RE.test(token);

/**
 * Resolve the ntfy access token to use. Validates the per-origin
 * Settings value against the ntfy `tk_…` format; if it's missing,
 * empty, or syntactically wrong, falls back to the chrome.storage
 * mirror. Returns `''` only when both sources fail validation, which
 * causes the producer to skip ntfy scheduling entirely (no garbage
 * 401-triggering POSTs).
 *
 * Also logs a console hint when a malformed local token is overridden
 * by a valid mirrored one — the player otherwise sees "no reminders"
 * with no obvious cause.
 *
 * @param {string} configToken  `ntfyToken` as passed by the producer.
 * @returns {Promise<string>}
 */
const resolveNtfyToken = async (configToken) => {
  if (isValidNtfyToken(configToken)) return configToken;
  const mirrored = await chromeStore.get(REMINDER_NTFY_TOKEN_KEY);
  if (isValidNtfyToken(mirrored)) {
    if (configToken) {
      // eslint-disable-next-line no-console
      console.warn(
        '[oge] ntfy token in this universe\'s Settings is malformed; ' +
        'using the value mirrored from another universe instead. ' +
        'Fix the Settings field to silence this warning.',
      );
    }
    return mirrored;
  }
  return '';
};

/**
 * The core extension-side round-trip:
 *
 *   1. Bail when no GitHub token is configured (no way to read/write the
 *      gist). The histogram tab tells the user.
 *   2. Read the existing reminder file; build prev waves + notifyState.
 *   3. {@link reconcileWaves} — return-time-set overlap matching, producing
 *      the live wave set to store (landed waves fall out; the brand-new
 *      cleanup rule drops near-term matched waves on a fresh send).
 *   4. {@link reconcileWaveQueue} — converge this universe's slice of the
 *      ntfy.sh queue to exactly one message per future slot of every live,
 *      non-dismissed wave: post the gaps, cancel the orphans. Idempotent,
 *      so it self-heals after a reload-interrupted prior run. When the
 *      feature is disabled, pass no live waves → everything is swept.
 *      Persist the resulting id sets (+ `baseAt`) back into notifyState.
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

  const { waves } = reconcileWaves(prevWaves, currentCandidates, now);

  // Each wave's schedule is anchored at a base time locked on first sight
  // (`baseAt`). Re-derive it from the prev bookkeeping when we have it;
  // fall back to the current earliest return for a wave we've not yet
  // recorded. Stable across scans → stable slot times → idempotent reconcile.
  /** @param {Wave} w */
  const baseAtFor = (w) => prevNotify[w.id]?.baseAt ?? w.nextWaveAt;

  const gistId = await ensureGistV3();
  const topic = await deriveNtfyTopic(gistId);

  // Default: keep prev bookkeeping pruned to the live set. Only replaced
  // when we actually reach ntfy (token + topic present).
  /** @type {Record<string, NotifyEntry>} */
  let notifyState = pruneNotifyState(prevNotify, waves);
  let cancelled = 0;
  let scheduled = 0;

  if (ntfyToken && topic) {
    // The live waves ntfy should keep queued. Dismissed waves and — when
    // the feature is off — ALL waves are excluded, so the reconciler
    // sweeps their messages off the queue. Everything is idempotent and
    // reconciled against ntfy's own queue, so an interrupted prior run
    // (the mobile page-reload mid-sync case) simply converges next time
    // instead of stacking partial, uncancellable schedules.
    const liveForNtfy = config.enabled
      ? waves.filter((w) => !w.cancelled).map((w) => ({ id: w.id, baseAt: baseAtFor(w) }))
      : [];

    const { idsByWave, posted, cancelled: swept } = await reconcileWaveQueue({
      waves: liveForNtfy, topic, token: ntfyToken, now, universeId,
    });
    scheduled = posted;
    cancelled = swept;

    // Rebuild notifyState from the reconciler's authoritative id sets so
    // the gist always mirrors what's actually on the queue (the stored
    // ids feed the Dashboard's cross-universe orphan backstop).
    notifyState = {};
    for (const w of waves) {
      const ids = (!config.enabled || w.cancelled) ? [] : (idsByWave[w.id] ?? []);
      notifyState[w.id] = { baseAt: baseAtFor(w), scheduledMessageIds: ids };
    }

    if (posted > 0 || swept > 0) {
      // eslint-disable-next-line no-console
      console.log(`[oge] reminders reconciled: +${posted} queued, -${swept} cancelled`);
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
