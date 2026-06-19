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
// `ntfyReconciler.reconcileWaveQueue`, which polls the queue and converges
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
// @see ../features/dashboard/reminders.js — the preview consumer

/* global fetch */

import { gh, ensureGist, getToken, getGistId } from './gist.js';
import { chromeStore } from '../lib/storage.js';
import { reconcileWaves, pruneNotifyState } from '../domain/waves.js';
import {
  reconcileAdhoc, pruneAdhocNotify, parseAdhocOffsets, adhocFireTimes,
} from '../domain/adhoc.js';
import { reconcileFleetSaves, pruneFsNotify, parseFsOffsets } from '../domain/fleetSave.js';
import {
  reconcileWaveQueue, reconcileAdhocQueue, reconcileFleetSaveQueue,
  offsetsForSchedule, fetchScheduledMessages,
} from './ntfyReconciler.js';

/**
 * @typedef {import('../domain/waves.js').Wave} Wave
 * @typedef {import('../domain/waves.js').NotifyEntry} NotifyEntry
 * @typedef {import('../domain/adhoc.js').AdhocReminder} AdhocReminder
 * @typedef {import('../domain/adhoc.js').PresentFleet} PresentFleet
 * @typedef {import('../domain/fleetSave.js').FleetSaveReminder} FleetSaveReminder
 * @typedef {import('../domain/fleetSave.js').FleetSaveCandidate} FleetSaveCandidate
 */

/**
 * Minimal config shape the producer passes in. Mirrors the reminder
 * fields of `Settings` so this module does not depend on the settings
 * typedef (any caller that yields the right shape works — useful for
 * tests).
 *
 * @typedef {object} ReminderConfig
 * @property {boolean} [masterEnabled] Master switch for the whole section.
 *   When false, NEITHER kind is queued (everything is swept) regardless of
 *   the per-kind flags. Absent ⇒ treated as on (back-compat for direct callers).
 * @property {boolean} enabled       Auto expedition-WAVE reminders on/off.
 * @property {boolean} [fsEnabled]   Fleet-save auto-detection on/off. When
 *   false, detected entries are kept in state but nothing is queued on ntfy.
 * @property {number} [fsThreshold]   Minimum total ships to classify as a save.
 * @property {string} [fsOffsets]     FS reminder offsets relative to arrival
 *   (comma-separated minutes-first durations; see `domain/fleetSave.parseFsOffsets`).
 * @property {number} [fsMinFlightSec] Minimum flight time (s) for a NEW save —
 *   excludes short planet⇄moon hops. The gate runs once, then the save is
 *   locked (see `domain/fleetSave.reconcileFleetSaves`).
 * @property {string} ntfyToken
 * @property {string} [schedule]  Free-form wave reminder schedule — a
 *   minutes-first duration list (see `ntfyReconciler.offsetsForSchedule`).
 *   Falls back to the default cadence when absent / empty. Waves only.
 * @property {string} [adhocSchedule]  Free-form ad-hoc reminder schedule — a
 *   minutes-first SIGNED offset list relative to arrival (see
 *   `domain/adhoc.parseAdhocOffsets`). Applied live to every armed entry.
 * @property {Record<import('../domain/reminderTemplates.js').ReminderKind, import('../domain/reminderTemplates.js').ReminderTemplate>} [templates]
 *   Per-kind message customisation (body / icon / priority). The EFFECTIVE
 *   templates for this universe (already resolved against any per-server
 *   override by the producer). Absent ⇒ each reconcile uses its built-in
 *   default (reproduces the historical message).
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
 *   - v4: adds the ad-hoc per-fleet reminder blocks (`adhoc` +
 *     `adhocNotify`) alongside the existing wave blocks. Migration from
 *     v3 is ADDITIVE — `readReminderState` accepts v3 and defaults the
 *     new arrays empty, so existing wave schedules survive the upgrade.
 *   - v5: adds the fleet-save auto-detection blocks (`fleetSave` +
 *     `fleetSaveNotify`). Migration from v3/v4 is ADDITIVE — older files
 *     read forward with the new blocks defaulted empty.
 */
export const REMINDER_SCHEMA_VERSION = 5;

/** Schema versions we can read (and normalise forward). */
const READABLE_SCHEMA_VERSIONS = new Set([3, 4, 5]);

/**
 * Derive the ntfy.sh topic deterministically from the ntfy access
 * token. Topics are public-by-URL, so we want a string an attacker
 * can't guess — but we also want one canonical channel without extra
 * configuration. SHA-256 over the token gives us exactly that.
 *
 *   - `oge-` prefix → recognisable in the ntfy app.
 *   - 22 hex chars → an 88-bit topic. SHA-256 does NOT manufacture
 *     entropy: the topic's real unpredictability is bounded by the
 *     token's, i.e. `min(88, entropy(token))`. A ntfy `tk_…` token is
 *     high-entropy random, so in practice the full 88 bits hold — but a
 *     weak hand-picked token would yield a weak topic, hash or no hash.
 *     Keeping the FIRST 22 of the 64 hex digits is a plain truncation, and
 *     that is safe: every SHA-256 output bit is independently pseudorandom,
 *     so the retained 88 bits carry full entropy (there is no "weak end" —
 *     truncating a hash is standard practice and never weakens the kept
 *     bits). Exposing only 88 of 256 bits also strengthens preimage
 *     resistance — the public topic can't be walked back to the token.
 *
 * # Security model — the topic IS the secret
 *
 * On the public ntfy.sh instance topics are open by default: reading or
 * publishing to a topic needs no auth, and reserving a topic (an ACL that
 * binds it to the token owner) requires a paid/self-hosted plan. The
 * token we send on every request (see `ntfyAuthParam`) lifts the
 * anonymous per-IP rate limit — it does NOT gate the channel. So the
 * channel's confidentiality rests entirely on the topic staying secret:
 * 88 unguessable bits defend against brute force, but anyone who LEARNS
 * the topic (it is a URL — it leaks into proxy logs, history, the ntfy
 * app UI) can read these reminders (fleet-movement intel) and inject
 * fakes. This is an accepted trade-off for low-sensitivity data; for full
 * isolation the user should reserve the topic on their ntfy account.
 *
 * # Why the token, not the gist id (changed in v1.8.0)
 *
 * The topic used to be derived from the gist id, which tied the push
 * channel to cloud-sync setup even though ntfy and the gist are
 * otherwise independent concerns. Deriving from the ntfy token instead
 * makes the channel "belong to" the ntfy account: it appears the moment
 * a token is set, the gist stays purely the durable state cache, and the
 * dashboard can explain the two halves separately (topic ← ntfy, state ←
 * gist). SHA-256 is one-way, so publishing the derived topic never
 * reveals the token (the topic is public; the token is not).
 *
 * Returns the empty string when `ntfyToken` is falsy (no token set yet),
 * which the callers treat as "ntfy not configured — skip scheduling".
 *
 * @param {string} ntfyToken  The ntfy.sh access token (`tk_…`).
 * @returns {Promise<string>}
 */
export const deriveNtfyTopic = async (ntfyToken) => {
  if (!ntfyToken) return '';
  const bytes = new TextEncoder().encode(ntfyToken);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return 'oge-' + hex.slice(0, 22);
};

/**
 * Mask a derived topic for display. The topic is a capability secret (see the
 * security note on {@link deriveNtfyTopic}) — treat it like a password — so the
 * dashboard and the settings panel show it masked by default behind a reveal
 * toggle. The non-secret `oge-` label stays visible (it's public scaffolding,
 * recognisable in the ntfy app); the random remainder becomes bullets. Pure.
 *
 * Anything that isn't one of our topics (the empty string, a `— (no token…)`
 * placeholder) passes through unchanged, so callers can mask whatever the
 * topic field currently holds without special-casing the placeholder.
 *
 * @param {string} topic
 * @returns {string}
 */
export const maskTopic = (topic) => {
  if (typeof topic !== 'string' || !topic.startsWith('oge-')) return topic;
  return 'oge-' + '•'.repeat(topic.length - 'oge-'.length);
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
 * @property {AdhocReminder[]} adhoc     Player-armed per-fleet reminders.
 * @property {Record<string, NotifyEntry>} adhocNotify  Per-ad-hoc bookkeeping
 *   (scheduled ntfy.sh message ids), keyed by event-row id.
 * @property {FleetSaveReminder[]} fleetSave  Auto-detected fleet-save reminders.
 * @property {Record<string, NotifyEntry>} fleetSaveNotify  Per-FS bookkeeping
 *   (scheduled ntfy.sh message ids), keyed by event-row id.
 */

/**
 * Read and parse this universe's reminder file from the gist. Returns
 * `null` when the gist has no such file yet (first run) or the content
 * can't be parsed (hand-edited / corrupt — the next write rebuilds it).
 *
 * Accepts schema v3 and v4 and normalises forward: a v3 file (no ad-hoc
 * blocks) comes back with `adhoc: []` / `adhocNotify: {}` so callers
 * always see the v4 shape and existing wave schedules survive the
 * upgrade. Versions outside {@link READABLE_SCHEMA_VERSIONS} are treated
 * as absent (start fresh; the orphan sweep clears their stale ntfy
 * messages).
 *
 * @param {string} universeId
 * @returns {Promise<ReminderState | null>}
 */
const readReminderState = async (universeId) => {
  const id = await ensureGist();
  const gist = await gh(`/gists/${id}`);
  const file = gist?.files?.[reminderFilenameFor(universeId)];
  if (!file) return null;
  const text =
    file.truncated && file.raw_url
      ? await (await fetch(file.raw_url)).text()
      : file.content;
  try {
    const parsed = /** @type {ReminderState} */ (JSON.parse(text));
    if (!READABLE_SCHEMA_VERSIONS.has(parsed?.version)) return null;
    return {
      ...parsed,
      waves: parsed.waves ?? [],
      notifyState: parsed.notifyState ?? {},
      adhoc: parsed.adhoc ?? [],
      adhocNotify: parsed.adhocNotify ?? {},
      fleetSave: parsed.fleetSave ?? [],
      fleetSaveNotify: parsed.fleetSaveNotify ?? {},
    };
  } catch {
    return null;
  }
};

/**
 * Write this universe's reminder file (plain JSON, pretty-printed).
 * Creates / discovers the gist as needed via {@link ensureGist}.
 *
 * @param {string} universeId
 * @param {ReminderState} state
 * @returns {Promise<void>}
 */
const writeReminderState = async (universeId, state) => {
  const id = await ensureGist();
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
  const pick = (s) => JSON.stringify({
    waves: s.waves, notifyState: s.notifyState,
    adhoc: s.adhoc, adhocNotify: s.adhocNotify,
    fleetSave: s.fleetSave, fleetSaveNotify: s.fleetSaveNotify,
  });
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
 * The core extension-side round-trip — the SINGLE writer of this
 * universe's reminder file. Reconciles BOTH notification kinds (auto
 * expedition waves + player-armed ad-hoc fleets) in one read-modify-write,
 * so the two never clobber each other's slice of the gist:
 *
 *   1. Bail when no GitHub token is configured (no way to read/write the
 *      gist). The dashboard tells the user.
 *   2. Read the existing file (v3/v4 normalised) → prev waves + ad-hoc.
 *   3. {@link reconcileWaves} — live wave set (landed waves fall out; the
 *      brand-new cleanup rule tombstones near-term matched waves on a
 *      fresh send).
 *   4. {@link reconcileAdhoc} — apply the optional user mutation (arm /
 *      disarm), then drop armed entries whose event row vanished and
 *      reschedule any whose arrival moved.
 *   5. {@link reconcileWaveQueue} + {@link reconcileAdhocQueue} — converge
 *      each kind's slice of the ntfy queue (distinct titles → no
 *      cross-cancel). Disabled kind ⇒ pass an empty live set ⇒ its
 *      messages are swept (ad-hoc ENTRIES are still kept in state, just
 *      not queued). Ad-hoc entries beyond ntfy's 3-day cap are kept but
 *      not queued (defense in depth; arming is already blocked past it).
 *   6. Persist the resulting id sets; refresh the dashboard mirror.
 *
 * @param {ReminderConfig} config  Current config (from the store).
 * @param {object} dom             DOM-derived inputs for this scan.
 * @param {import('../domain/waves.js').WaveCandidate[]} dom.waveCandidates
 *   Freshly clustered expedition-return candidates (no id yet).
 * @param {PresentFleet[]} dom.present  Every fleet leg currently in the
 *   event list (id + arrivalAt) — the authoritative set ad-hoc cleanup
 *   matches against. MUST come from a real event-box read.
 * @param {(prev: AdhocReminder[]) => AdhocReminder[]} [dom.adhocMutate]
 *   Optional user mutation applied before reconcile (arm adds an entry,
 *   disarm removes one). Omitted on the periodic event-box-driven pass.
 * @param {(prev: Wave[]) => Wave[]} [dom.waveMutate]
 *   Optional user mutation on the PREV wave set, applied before
 *   {@link reconcileWaves} (used by the event-list "cancel this wave"
 *   action to tombstone a wave game-side; the flag is then carried
 *   forward by the overlap match). Omitted on the periodic pass.
 * @param {FleetSaveCandidate[]} [dom.fleetSaveCandidates]  Every OWN fleet leg
 *   present this scan (id + arrival + ship count + label). The full candidate
 *   set; {@link reconcileFleetSaves} applies the ship + flight-time gates
 *   against the persisted (locked) save set, and a landed/recalled leg simply
 *   isn't present so its queue is swept.
 * @param {Record<string, number[]>} [dom.fsCancelById]  Per-fleet-save offsets
 *   the player cancelled (see `domain/fleetSave.fsOffsetsToCancel`); dropped
 *   from that save's series so the queue reconcile sweeps just those slots.
 * @param {number} now             Epoch SECONDS, injected by the caller.
 * @param {string} universeId      OGame server id; ntfy push title prefix.
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, scheduled?: number, cancelled?: number, fleetSave?: FleetSaveReminder[] }>}
 *   `fleetSave` is the reconciled (locked) FS set for this scan — surfaced so
 *   the caller can republish the ids for passive consumers (the planet-badge
 *   feature marks FS fleets without importing reminders). Absent on early
 *   `{ ok: false }` returns.
 */
export const syncReminders = async (config, dom, now, universeId) => {
  if (!getToken()) return { ok: false, reason: 'no-token' };

  const { waveCandidates, present, adhocMutate, waveMutate, fleetSaveCandidates = [], fsCancelById = {} } = dom;

  // Token resolution: prefer per-origin localStorage value; fall back
  // to the global chrome.storage mirror so a universe that hasn't been
  // configured manually still works once any other universe has set
  // its ntfy token.
  const ntfyToken = await resolveNtfyToken(config.ntfyToken);

  const existing = await readReminderState(universeId);
  const prevWaves = existing?.waves ?? [];
  const prevNotify = existing?.notifyState ?? {};
  const prevAdhoc = existing?.adhoc ?? [];
  const prevAdhocNotify = existing?.adhocNotify ?? {};
  const prevFs = existing?.fleetSave ?? [];
  const prevFsNotify = existing?.fleetSaveNotify ?? {};

  const prevWavesMutated = waveMutate ? waveMutate(prevWaves) : prevWaves;
  const { waves } = reconcileWaves(prevWavesMutated, waveCandidates, now);

  const adhocWorking = adhocMutate ? adhocMutate(prevAdhoc) : prevAdhoc;
  const { entries: adhoc } = reconcileAdhoc(adhocWorking, present);

  // Fleet-saves: gate new candidates on ship count + flight time, carry
  // forward (lock) anything already classified, drop the vanished. The lock
  // is why a save observed 2 min before landing keeps its queued pings.
  const fleetSave = reconcileFleetSaves(prevFs, fleetSaveCandidates, {
    threshold: config.fsThreshold ?? 0,
    offsetsSec: parseFsOffsets(config.fsOffsets ?? ''),
    minFlightSec: config.fsMinFlightSec ?? 0,
    now,
    cancelledById: fsCancelById,
  });

  // Each wave's schedule is anchored at a base time locked on first sight
  // (`baseAt`). Re-derive it from the prev bookkeeping when we have it;
  // fall back to the current earliest return for a wave we've not yet
  // recorded. Stable across scans → stable slot times → idempotent reconcile.
  /** @param {Wave} w */
  const baseAtFor = (w) => prevNotify[w.id]?.baseAt ?? w.nextWaveAt;

  const topic = await deriveNtfyTopic(ntfyToken);

  // Default: keep prev bookkeeping pruned to the live sets. Only replaced
  // when we actually reach ntfy (token + topic present).
  /** @type {Record<string, NotifyEntry>} */
  let notifyState = pruneNotifyState(prevNotify, waves);
  /** @type {Record<string, NotifyEntry>} */
  let adhocNotify = pruneAdhocNotify(prevAdhocNotify, adhoc);
  /** @type {Record<string, NotifyEntry>} */
  let fsNotify = pruneFsNotify(prevFsNotify, fleetSave);
  let cancelled = 0;
  let scheduled = 0;

  // Master switch gates every kind; absent ⇒ on (direct-caller back-compat).
  const master = config.masterEnabled !== false;
  const waveActive = master && config.enabled;
  // Ad-hoc per-fleet reminders are always on; the master switch is their only gate.
  const adhocActive = master;
  const fsActive = master && Boolean(config.fsEnabled);

  if (ntfyToken && topic) {
    // One queue poll, shared by both kinds — OGame reloads (and re-runs
    // this producer) on every click, so halving the ntfy polls per sync
    // meaningfully cuts request volume.
    const queue = await fetchScheduledMessages({ topic, token: ntfyToken, now });

    // ── Expedition waves ───────────────────────────────────────────────
    // Live waves ntfy should keep queued. Dismissed waves and — when wave
    // reminders are off (master off, or auto-wave off) — ALL waves are
    // excluded, so the reconciler sweeps their messages. Idempotent against
    // ntfy's own queue, so an interrupted prior run just converges.
    const liveWaves = waveActive
      ? waves.filter((w) => !w.cancelled).map((w) => ({ id: w.id, baseAt: baseAtFor(w) }))
      : [];
    const waveRes = await reconcileWaveQueue({
      waves: liveWaves, topic, token: ntfyToken, now, universeId,
      offsetsSec: offsetsForSchedule(config.schedule), template: config.templates?.wave, queue,
    });

    // Rebuild notifyState from the reconciler's authoritative id sets so
    // the gist always mirrors what's actually on the queue.
    notifyState = {};
    for (const w of waves) {
      const ids = (!waveActive || w.cancelled) ? [] : (waveRes.idsByWave[w.id] ?? []);
      notifyState[w.id] = { baseAt: baseAtFor(w), scheduledMessageIds: ids };
    }

    // ── Ad-hoc fleets ──────────────────────────────────────────────────
    // A multi-slot series per armed entry: the per-universe ad-hoc schedule
    // (signed offsets relative to arrival) resolved live against each leg's
    // arrival, with the per-leg push metadata forwarded so the body's
    // {origin}/{target}/{direction}/{shipCount} wildcards fill. The 3-day cap
    // is applied inside reconcileAdhocQueue. Disabled ⇒ no live entries ⇒
    // messages swept (entries themselves stay in state).
    const adhocOffsets = parseAdhocOffsets(config.adhocSchedule ?? '');
    const liveAdhoc = adhocActive
      ? adhoc.map((e) => ({
          id: e.id,
          arrivalAt: e.arrivalAt,
          label: e.label,
          origin: e.origin,
          originName: e.originName,
          target: e.target,
          targetName: e.targetName,
          shipCount: e.shipCount,
          fireAts: adhocFireTimes(e.arrivalAt, adhocOffsets),
        }))
      : [];
    const adhocRes = await reconcileAdhocQueue({
      entries: liveAdhoc, topic, token: ntfyToken, now, universeId,
      template: config.templates?.adhoc, queue,
    });

    adhocNotify = {};
    for (const e of adhoc) {
      const ids = adhocActive ? (adhocRes.idsByEntry[e.id] ?? []) : [];
      adhocNotify[e.id] = { scheduledMessageIds: ids };
    }

    // ── Fleet saves ────────────────────────────────────────────────────
    // A multi-slot series per detected FS (offsets relative to arrival).
    // Disabled ⇒ no live entries ⇒ messages swept (entries stay in state).
    // The whole set is recomputed from the live event list each scan, so a
    // landed/recalled FS isn't present here and its future slots are swept —
    // which is exactly the "auto-cancel post-landing pings once you're back
    // in-game" behaviour.
    const liveFs = fsActive ? fleetSave : [];
    const fsRes = await reconcileFleetSaveQueue({
      entries: liveFs, topic, token: ntfyToken, now, universeId,
      template: config.templates?.fleetSave, queue,
    });

    fsNotify = {};
    for (const e of fleetSave) {
      const ids = fsActive ? (fsRes.idsByEntry[e.id] ?? []) : [];
      fsNotify[e.id] = { scheduledMessageIds: ids };
    }

    scheduled = waveRes.posted + adhocRes.posted + fsRes.posted;
    cancelled = waveRes.cancelled + adhocRes.cancelled + fsRes.cancelled;
    if (scheduled > 0 || cancelled > 0) {
      // eslint-disable-next-line no-console
      console.log(`[oge] reminders reconciled: +${scheduled} queued, -${cancelled} cancelled`);
    }
  }

  /** @type {ReminderState} */
  const next = {
    version: REMINDER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    waves,
    notifyState,
    adhoc,
    adhocNotify,
    fleetSave,
    fleetSaveNotify: fsNotify,
  };

  const changed = !sameState(existing, next);
  if (changed) await writeReminderState(universeId, next);
  await mirrorForPreview(universeId, next, ntfyToken);
  return { ok: true, changed, scheduled, cancelled, fleetSave };
};
