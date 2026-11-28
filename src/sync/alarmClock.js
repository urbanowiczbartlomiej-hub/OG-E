// @ts-check

// AlarmClock-state gist IO — backing store for the expedition alarmClock
// feature.
//
// # The separate plain-JSON file
//
// The cross-device sync payload lives in `oge-data.json.gz.b64`
// (gzip+base64, schema 1 — see gist.js `SCHEMA_VERSION`) and
// `fetchGistData` rejects anything that isn't that schema. The alarmClock
// state must NOT go there. Instead we keep
// it in separate files in the same gist, one per universe (see
// {@link alarmClockFilenameFor}), as plain pretty-printed JSON.
//
// # What's stored
//
// One file per OGame universe per gist (multi-universe isolation, v3 —
// see {@link ALARM_CLOCK_FILENAME_PREFIX}). Two top-level blocks:
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
// the first alarmClock fires a minute late. In exchange the schedule is
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
// The OG-E Dashboard's AlarmClock tab renders a live view of what's
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
// @see ../state/settings.js — `alarmClockEnabled` / `alarmClockNtfyToken`
// @see ../features/dashboard/alarmClock.js — the preview consumer

import { getToken, getGistId } from './gist.js';
import { chromeStore } from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import { reconcileWaves, isWaveCommitted } from '../domain/waves.js';
import { reconcileAdhoc, parseAdhocOffsets } from '../domain/adhoc.js';
import {
  reconcileFleetSaves, detectFsLandings, parseFsOffsets,
  GUARDIAN_INTERVAL_SEC,
} from '../domain/fleetSave.js';
import {
  offsetsForSchedule, fetchQueue, postReminder, cancelReminders, renderReminder,
  titlesFor, NTFY_MAX_DELAY_SEC, NTFY_MIN_DELAY_SEC,
} from './ntfyReconciler.js';
import { clickUrlFor, decodeClick, planQueue, seriesInQueue } from '../domain/ntfyQueue.js';

/**
 * @typedef {import('../domain/waves.js').Wave} Wave
 * @typedef {import('../domain/waves.js').NotifyEntry} NotifyEntry
 * @typedef {import('../domain/adhoc.js').AdhocAlarmClock} AdhocAlarmClock
 * @typedef {import('../domain/adhoc.js').PresentFleet} PresentFleet
 * @typedef {import('../domain/fleetSave.js').FleetSaveAlarmClock} FleetSaveAlarmClock
 * @typedef {import('../domain/fleetSave.js').FleetSaveCandidate} FleetSaveCandidate
 * @typedef {import('../domain/fleetSave.js').LandedFleetSave} LandedFleetSave
 */

/**
 * Minimal config shape the producer passes in. Mirrors the alarmClock
 * fields of `Settings` so this module does not depend on the settings
 * typedef (any caller that yields the right shape works — useful for
 * tests).
 *
 * @typedef {object} AlarmClockConfig
 * @property {boolean} [masterEnabled] Master switch for the whole section.
 *   When false, NEITHER kind is queued (everything is swept) regardless of
 *   the per-kind flags. Absent ⇒ treated as on (back-compat for direct callers).
 * @property {boolean} enabled       Auto expedition-WAVE alarmClock on/off.
 * @property {boolean} [fsEnabled]   Fleet-save auto-detection on/off. When
 *   false, detected entries are kept in state but nothing is queued on ntfy.
 * @property {number} [fsThreshold]   Minimum total ships to classify as a save.
 * @property {string} [fsOffsets]     FS alarmClock offsets relative to arrival
 *   (comma-separated minutes-first durations; see `domain/fleetSave.parseFsOffsets`).
 * @property {number} [fsMinFlightSec] Minimum flight time (s) for a NEW save —
 *   excludes short planet⇄moon hops. The gate runs once, then the save is
 *   locked (see `domain/fleetSave.reconcileFleetSaves`).
 * @property {boolean} [guardianEnabled]  Bare-fleet guardian push on/off.
 * @property {number} [guardianIntervalSec]  Seconds after landing the guardian
 *   push fires (falls back to GUARDIAN_INTERVAL_SEC when absent).
 * @property {string} ntfyToken
 * @property {string} [schedule]  Free-form wave alarmClock schedule — a
 *   minutes-first duration list (see `ntfyReconciler.offsetsForSchedule`).
 *   Falls back to the default cadence when absent / empty. Waves only.
 * @property {string} [adhocSchedule]  Free-form ad-hoc alarmClock schedule — a
 *   minutes-first SIGNED offset list relative to arrival (see
 *   `domain/adhoc.parseAdhocOffsets`). Applied live to every armed entry.
 * @property {Record<import('../domain/alarmClockTemplates.js').AlarmClockKind, import('../domain/alarmClockTemplates.js').AlarmClockTemplate>} [templates]
 *   Per-kind message customisation (body / icon / priority). The EFFECTIVE
 *   templates for this universe (already resolved against any per-server
 *   override by the producer). Absent ⇒ each reconcile uses its built-in
 *   default (reproduces the historical message).
 */

/**
 * Filename prefix of the per-universe alarmClock-state files inside the
 * OG-E gist. The full filename is `${ALARM_CLOCK_FILENAME_PREFIX}${universeId}.json`.
 *
 * Multi-universe isolation rule (v3): each OGame universe owns its OWN
 * file in the shared gist. Universe A's content script writes
 * `oge-alarmClock-s163-pl.json`, universe B's writes
 * `oge-alarmClock-s201-pl.json`. GitHub's gist PATCH operates per file,
 * so one universe never clobbers another's waves or notifyState. This
 * fixes the v2-era ping-pong where two universes sharing one file
 * cancelled each other's ntfy schedules repeatedly until ntfy.sh
 * rate-limited the account.
 */
export const ALARM_CLOCK_FILENAME_PREFIX = 'oge-alarmClock-';

/**
 * Build the gist filename for a universe.
 *
 * @param {string} universeId  e.g. `'s163-pl'`. See `lib/universeId.js`.
 * @returns {string}
 */
export const alarmClockFilenameFor = (universeId) =>
  `${ALARM_CLOCK_FILENAME_PREFIX}${universeId}.json`;

/**
 * Regex matching all per-universe alarmClock filenames in a gist.
 * Capture group 1 is the universeId. Used by the dashboard to
 * enumerate every universe currently in the gist.
 */
export const ALARM_CLOCK_FILENAME_RE = /^oge-alarmClock-([^/]+)\.json$/;

/**
 * Schema version of the alarmClock file.
 *
 *   - v1: time-based wave identity (pre-1.3.2). `Wave.id` was
 *     `'w_' + nextWaveAt`, with a 300 s drift tolerance in reconcile.
 *   - v2: return-time-set overlap identity, single shared file
 *     `oge-alarmClock.json` — broken in multi-universe setups.
 *   - v3: same identity model as v2, but the file is now scoped per
 *     universe (`oge-alarmClock-<universeId>.json`). Mirror in
 *     chrome.storage is also keyed per universe. We do NOT migrate v2
 *     state — the next sync drops it and the orphan sweep cancels any
 *     v2-era ntfy messages still queued.
 *   - v4: adds the ad-hoc per-fleet alarmClock blocks (`adhoc` +
 *     `adhocNotify`) alongside the existing wave blocks. Migration from
 *     v3 is ADDITIVE — `readAlarmClockState` accepts v3 and defaults the
 *     new arrays empty, so existing wave schedules survive the upgrade.
 *   - v5: adds the fleet-save auto-detection blocks (`fleetSave` +
 *     `fleetSaveNotify`). Migration from v3/v4 is ADDITIVE — older files
 *     read forward with the new blocks defaulted empty.
 *   - v6: adds `landedFleetSave` — fleet-saves whose row has vanished
 *     (landed), kept until re-saved/departed/dismissed so the planet markers
 *     flag the still-exposed fleet. Migration from v3/v4/v5 is ADDITIVE —
 *     defaults to empty.
 *   - v7: DROPS `landedFleetSave` again. The durable "fleet sitting exposed"
 *     state moved to the unified fleet-reminder store
 *     (`state/fleetReminders.js`, synced via the `fleetRemindersPerUniverse`
 *     data-gist slot); this file now only carries the in-flight FS set that
 *     landings are DETECTED from (see `domain/fleetSave.detectFsLandings`).
 *     v6's field is simply ignored on read — no migration.
 */
export const ALARM_CLOCK_SCHEMA_VERSION = 7;

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
 * app UI) can read these alarmClock (fleet-movement intel) and inject
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

/** chrome.storage.local key holding the last-written alarmClock state (preview). */
export const ALARM_CLOCK_MIRROR_KEY = 'oge_alarmClockMirror';

/** chrome.storage.local key holding the gist id (so the dashboard can fetch live). */
export const ALARM_CLOCK_GIST_ID_KEY = 'oge_alarmClockGistId';

/** chrome.storage.local key holding the gist token (preview-fetch only). */
export const ALARM_CLOCK_TOKEN_KEY = 'oge_alarmClockToken';

/**
 * chrome.storage.local key holding the ntfy.sh access token. Mirrored
 * from game-origin Settings (`oge_alarmClockNtfyToken` in localStorage)
 * so the OG-E Dashboard, which runs at extension origin, can call
 * ntfy's queue endpoint without re-asking the user for the token.
 */
export const ALARM_CLOCK_NTFY_TOKEN_KEY = 'oge_alarmClockNtfyTokenMirror';

/**
 * Full shape of a per-universe alarmClock file (see {@link alarmClockFilenameFor}).
 * AlarmClock config lives in localStorage settings at the game origin (see
 * `state/settings.js`). The gist is purely the wave list + per-wave
 * bookkeeping (`baseAt` anchor + queued `scheduledMessageIds`), a cache of
 * the ntfy queue that is durable across browser restarts.
 *
 * @typedef {object} AlarmClockState
 * @property {number} version
 * @property {string} updatedAt          ISO timestamp of the last write.
 * @property {Wave[]} waves              Reconciled wave set.
 * @property {Record<string, NotifyEntry>} notifyState  Per-wave bookkeeping
 *   (scheduled ntfy.sh message ids for cancellation).
 * @property {AdhocAlarmClock[]} adhoc     Player-armed per-fleet alarmClock.
 * @property {Record<string, NotifyEntry>} adhocNotify  Per-ad-hoc bookkeeping
 *   (scheduled ntfy.sh message ids), keyed by event-row id.
 * @property {FleetSaveAlarmClock[]} fleetSave  Auto-detected fleet-save alarmClock.
 * @property {Record<string, NotifyEntry>} fleetSaveNotify  Per-FS bookkeeping
 *   (scheduled ntfy.sh message ids), keyed by event-row id.
 */

/**
 * Structural-equality check over the parts we persist. Ignores
 * `updatedAt` (always changes) so an otherwise-identical state doesn't
 * trigger a pointless PATCH and a no-op gist revision.
 *
 * @param {AlarmClockState | null} a
 * @param {AlarmClockState} b
 * @returns {boolean}
 */
const sameState = (a, b) => {
  if (!a) return false;
  /** @param {AlarmClockState} s @returns {string} */
  const pick = (s) => JSON.stringify({
    waves: s.waves, notifyState: s.notifyState,
    adhoc: s.adhoc, adhocNotify: s.adhocNotify,
    fleetSave: s.fleetSave, fleetSaveNotify: s.fleetSaveNotify,
  });
  return pick(a) === pick(b);
};

/**
 * Mirror the just-written state (plus the gist id + tokens) into
 * `chrome.storage.local` so the OG-E Dashboard's AlarmClock tab can
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
 * @param {AlarmClockState} state
 * @param {string} ntfyToken  Current ntfy access token from Settings.
 * @returns {Promise<void>}
 */
const mirrorForPreview = async (universeId, state, ntfyToken) => {
  try {
    const existing = await chromeStore.get(ALARM_CLOCK_MIRROR_KEY);
    /** @type {Record<string, AlarmClockState>} */
    const dict = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? { .../** @type {Record<string, AlarmClockState>} */ (existing) }
      : {};
    dict[universeId] = state;
    await Promise.all([
      chromeStore.set(ALARM_CLOCK_MIRROR_KEY, dict),
      chromeStore.set(ALARM_CLOCK_GIST_ID_KEY, getGistId()),
      chromeStore.set(ALARM_CLOCK_TOKEN_KEY, getToken()),
      // ntfyToken is global — last writer wins, all universes share.
      // Only mirror a syntactically valid token, so garbage typed into
      // one universe's Settings can't poison the global mirror.
      ...(isValidNtfyToken(ntfyToken) ? [chromeStore.set(ALARM_CLOCK_NTFY_TOKEN_KEY, ntfyToken)] : []),
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
 * by a valid mirrored one — the player otherwise sees "no alarmClock"
 * with no obvious cause.
 *
 * @param {string} configToken  `ntfyToken` as passed by the producer.
 * @returns {Promise<string>}
 */
const resolveNtfyToken = async (configToken) => {
  if (isValidNtfyToken(configToken)) return configToken;
  const mirrored = await chromeStore.get(ALARM_CLOCK_NTFY_TOKEN_KEY);
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
 * universe's alarmClock file. Reconciles BOTH notification kinds (auto
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
 * @param {AlarmClockConfig} config  Current config (from the store).
 * @param {object} dom             DOM-derived inputs for this scan.
 * @param {import('../domain/waves.js').ReturnEntry[]} dom.waveReturns
 *   Every expedition return row observed this scan (row id + return time).
 *   Grouping and identity are decided inside {@link reconcileWaves}.
 * @param {PresentFleet[]} dom.present  Every fleet leg currently in the
 *   event list (id + arrivalAt) — the authoritative set ad-hoc cleanup
 *   matches against. MUST come from a real event-box read.
 * @param {(prev: AdhocAlarmClock[]) => AdhocAlarmClock[]} [dom.adhocMutate]
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
 * @param {FleetSaveAlarmClock[]} [dom.localFleetSave]  The producer's LOCAL
 *   pre-pass FS set (classified with no gist dependency). Unioned into the
 *   gist's `prevFs` by id (gist wins a clash) so a lock made offline survives
 *   into the shared set — and so a landing whose leg only this device ever
 *   classified is still detected here.
 * @param {Record<string, number>} [dom.guardianAcked]  Acked guardian landings as
 *   `bodyKey → ackedAt`; bumps the push to `max(landedAt, ackedAt) + interval`.
 * @param {Array<{ bodyKey: string, landedAt: number }>} [dom.fleetReminders]
 *   The currently-ARMED fleet reminders (`state/fleetReminders.js` — the
 *   unified auto+manual store). These drive the guardian escalation push;
 *   landings detected THIS run are unioned in so their push schedules in the
 *   same round (the producer persists them to the store right after).
 * @param {string[]} [dom.fleetReminderCleared]  Body keys whose reminder the
 *   player cleared (`on: false` marks) — their guardian push is swept.
 * @param {number} now             Epoch SECONDS, injected by the caller.
 * @param {string} universeId      OGame server id; ntfy push title prefix.
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, scheduled?: number, cancelled?: number, fleetSave?: FleetSaveAlarmClock[], landings?: LandedFleetSave[], failedKinds?: Record<string, string> }>}
 *   `failedKinds` maps each notification kind whose pushes could NOT be
 *   queued this round to a short reason — the caller surfaces it in game
 *   (see `state/ntfyHealth.js`). Empty when everything queued.
 *   `fleetSave` is the reconciled (locked) FS set for this scan — surfaced so
 *   the caller can republish it for passive consumers (the planet markers,
 *   which never import alarmClock). `landings` are the fleet-saves detected as
 *   just-landed this run — the caller arms the fleet-reminder store with them.
 *   Absent on early `{ ok: false }` returns.
 */
export const syncAlarmClock = async (config, dom, now, universeId) => {
  const {
    waveReturns, present, adhocMutate, waveMutate,
    fleetSaveCandidates = [], fsCancelById = {}, localFleetSave = [],
    guardianAcked = {}, fleetReminders = [], fleetReminderCleared = [],
  } = dom;

  // The ntfy queue is the state (docs/ntfy-queue-plan.md): no ntfy token, no
  // queue to read — nothing can be scheduled. GitHub plays no part any more.
  const ntfyToken = await resolveNtfyToken(config.ntfyToken);
  if (!ntfyToken) return { ok: false, reason: 'no-ntfy-token' };
  const topic = await deriveNtfyTopic(ntfyToken);
  if (!topic) return { ok: false, reason: 'no-ntfy-token' };

  // Master switch gates every kind; absent ⇒ on (direct-caller back-compat).
  const master = config.masterEnabled !== false;
  const waveActive = master && Boolean(config.enabled);
  const adhocActive = master;
  const fsActive = master && Boolean(config.fsEnabled);
  const guardianOn = master && Boolean(config.guardianEnabled);

  // ── Read the shared state: this universe's identified messages ────────
  // One poll for every kind. A poll failure throws → the producer retries.
  const titles = titlesFor(universeId);
  /** @type {Record<string, 'ad' | 'fs' | 'wv' | 'fr'>} */
  const kindByTitle = { [titles.ad]: 'ad', [titles.fs]: 'fs', [titles.wv]: 'wv', [titles.fr]: 'fr' };
  const raw = await fetchQueue({ topic, token: ntfyToken });
  /** @type {Record<'ad' | 'fs' | 'wv' | 'fr', import('../domain/ntfyQueue.js').QueuedMessage[]>} */
  const queueByKind = { ad: [], fs: [], wv: [], fr: [] };
  /** Old-format (pre-identity) messages of ours, by title — migration only. */
  /** @type {Array<{ id: string, time: number, title: string }>} */
  const legacy = [];
  for (const m of raw) {
    const kind = m.title ? kindByTitle[m.title] : undefined;
    if (!kind) continue; // another universe / not ours
    const identity = decodeClick(m.click);
    if (identity && identity.kind === kind) queueByKind[kind].push({ id: m.id, time: m.time, identity });
    else if (!identity && m.time > now) legacy.push({ id: m.id, time: m.time, title: /** @type {string} */ (m.title) });
  }
  const queued = {
    ad: seriesInQueue(queueByKind.ad),
    fs: seriesInQueue(queueByKind.fs),
    wv: seriesInQueue(queueByKind.wv),
    fr: seriesInQueue(queueByKind.fr),
  };

  /** Own-leg metadata by row id, for message bodies. */
  const legById = new Map(fleetSaveCandidates.map((c) => [c.id, c]));

  /** @type {Record<'ad' | 'fs' | 'wv' | 'fr', import('../domain/ntfyQueue.js').WantedSeries[]>} */
  const wanted = { ad: [], fs: [], wv: [], fr: [] };
  /** @type {Record<'ad' | 'fs' | 'wv' | 'fr', Set<string>>} */
  const gone = { ad: new Set(), fs: new Set(), wv: new Set(), fr: new Set() };
  /** Leg metadata per series key, for rendering new slots. */
  /** @type {Map<string, Parameters<typeof renderReminder>[0]['leg']>} */
  const legOf = new Map();

  // ── Ad-hoc ──────────────────────────────────────────────────────────
  // Armed = the queue holds the leg's series. The local intent queue adds
  // (arm) / removes (disarm) on top; a leg gone from the event list (landed or
  // recalled) drops out and its future pings are swept.
  /** @type {AdhocAlarmClock[]} */
  const prevAdhoc = [...queued.ad.values()].map((id) => {
    const leg = legById.get(id.key);
    return {
      id: id.key,
      arrivalAt: id.anchor,
      label: leg?.label ?? '',
      ...(leg ? {
        origin: leg.origin, originName: leg.originName, target: leg.target,
        targetName: leg.targetName, shipCount: leg.shipCount,
      } : {}),
    };
  });
  const adhocWorking = adhocMutate ? adhocMutate(prevAdhoc) : prevAdhoc;
  const workingIds = new Set(adhocWorking.map((e) => e.id));
  for (const e of prevAdhoc) if (!workingIds.has(e.id)) gone.ad.add(`ad:${e.id}`); // disarmed here
  const { entries: adhoc } = reconcileAdhoc(adhocWorking, present);
  const keptAdhoc = new Set(adhoc.map((e) => e.id));
  for (const e of adhocWorking) if (!keptAdhoc.has(e.id)) gone.ad.add(`ad:${e.id}`); // row gone
  const adhocOffsets = parseAdhocOffsets(config.adhocSchedule ?? '');
  if (adhocActive) {
    for (const e of adhoc) {
      wanted.ad.push({ kind: 'ad', key: e.id, anchor: e.arrivalAt, plan: adhocOffsets });
      legOf.set(`ad:${e.id}`, e);
    }
  }

  // ── Fleet saves ─────────────────────────────────────────────────────
  // The queue IS the lock: a leg any device classified (its series is queued)
  // stays a fleet-save everywhere; this device's own classification (the local
  // pre-pass) adds new ones. Landing = a known FS whose row is gone past its
  // arrival; a gone row's remaining pings are swept (the player is back).
  /** @type {FleetSaveAlarmClock[]} */
  const queuedFs = [...queued.fs.values()].map((id) => {
    const leg = legById.get(id.key);
    return {
      id: id.key,
      arrivalAt: id.anchor,
      shipCount: leg?.shipCount ?? 0,
      label: leg?.label ?? '',
      landingKey: id.extra ?? leg?.landingKey ?? '',
      offsetsSec: id.plan,
      fireAts: id.plan.map((o) => id.anchor + o),
    };
  });
  const queuedFsIds = new Set(queuedFs.map((e) => e.id));
  const prevFs = [...queuedFs, ...localFleetSave.filter((e) => !queuedFsIds.has(e.id))];
  const fleetSave = reconcileFleetSaves(prevFs, fleetSaveCandidates, {
    threshold: config.fsThreshold ?? 0,
    offsetsSec: parseFsOffsets(config.fsOffsets ?? ''),
    minFlightSec: config.fsMinFlightSec ?? 0,
    now,
    cancelledById: fsCancelById,
  });
  const landings = fsActive ? detectFsLandings(prevFs, fleetSaveCandidates, now) : [];
  const liveFsIds = new Set(fleetSaveCandidates.map((c) => c.id));
  for (const e of queuedFs) if (!liveFsIds.has(e.id)) gone.fs.add(`fs:${e.id}`);
  if (fsActive) {
    for (const e of fleetSave) {
      const q = queued.fs.get(`fs:${e.id}`);
      // A slot the player cancelled HERE that the queued plan still lists →
      // rewrite the series without it (new generation; other devices follow).
      const cut = fsCancelById[e.id] ?? [];
      const rewrite = Boolean(q && cut.some((o) => q.plan.includes(o)));
      wanted.fs.push({
        kind: 'fs', key: e.id, anchor: e.arrivalAt, plan: e.offsetsSec,
        ...(e.landingKey ? { extra: e.landingKey } : {}),
        ...(rewrite ? { rewrite: true } : {}),
      });
      legOf.set(`fs:${e.id}`, e);
    }
  }

  // ── Fleet reminders (guardian) ──────────────────────────────────────
  // One push per armed FR, `interval` after landing (or after the last ack).
  // Not event-list based: it lives until the mark is cleared. An ack moves the
  // anchor → new generation.
  const guardianIntervalSec = config.guardianIntervalSec ?? GUARDIAN_INTERVAL_SEC;
  /** @type {Map<string, number>} */
  const frLanded = new Map();
  for (const m of fleetReminders) frLanded.set(m.bodyKey, m.landedAt);
  for (const l of landings) frLanded.set(l.bodyKey, l.landedAt);
  for (const bodyKey of fleetReminderCleared) if (!frLanded.has(bodyKey)) gone.fr.add(`fr:${bodyKey}`);
  if (guardianOn) {
    for (const [bodyKey, landedAt] of frLanded) {
      wanted.fr.push({
        kind: 'fr', key: bodyKey,
        anchor: Math.max(landedAt, guardianAcked[bodyKey] ?? 0),
        plan: [guardianIntervalSec],
      });
    }
  }

  // ── Expedition waves ────────────────────────────────────────────────
  // Wave grouping stays device-local (event-list returns → waves); the queue
  // carries each wave's anchor. A local wave ADOPTS a queued wave series whose
  // anchor is close (another device saw the same wave first), so two devices
  // never schedule the same wave twice. A queued wave nobody here explains,
  // whose anchor already passed, has landed → swept.
  const local = await readLocalAlarmClock(universeId);
  const prevWaves = local?.waves ?? [];
  const prevNotify = local?.notifyState ?? {};
  const prevWavesMutated = waveMutate ? waveMutate(prevWaves) : prevWaves;
  const { waves } = reconcileWaves(prevWavesMutated, waveReturns, now);
  /** @type {Record<string, NotifyEntry>} */
  const notifyState = {};
  /** @type {Set<string>} */
  const adoptedKeys = new Set();
  /** @type {Map<string, string>} local wave id → its queue key */
  const waveKeyOf = new Map();
  const queuedWaves = [...queued.wv.values()];
  for (const w of waves) {
    let baseAt = prevNotify[w.id]?.baseAt ?? w.anchorAt ?? w.nextWaveAt;
    const match = queuedWaves.find((q) => !adoptedKeys.has(q.key)
      && Math.abs(q.anchor - baseAt) <= WAVE_ADOPT_SEC);
    if (match) {
      baseAt = match.anchor;
      adoptedKeys.add(match.key);
    }
    const key = match ? match.key : `w${baseAt}`;
    waveKeyOf.set(w.id, key);
    notifyState[w.id] = { baseAt, scheduledMessageIds: [] };
    if (w.cancelled) gone.wv.add(`wv:${key}`);
    else if (waveActive && isWaveCommitted(w)) {
      wanted.wv.push({ kind: 'wv', key, anchor: baseAt, plan: offsetsForSchedule(config.schedule) });
    }
  }
  for (const q of queuedWaves) {
    if (!adoptedKeys.has(q.key) && q.anchor <= now) gone.wv.add(`wv:${q.key}`);
  }

  // ── Converge the queue, kind by kind ────────────────────────────────
  // KIND ORDER IS A SAFETY PROPERTY: fleet-save and ad-hoc first, waves last,
  // and one kind's failure (budget spent, network) never aborts the others.
  /** @type {Record<string, string>} kind → short failure reason */
  const failedKinds = {};
  /** @type {Record<string, string>} */
  const failName = { fs: 'fleetSave', ad: 'adhoc', fr: 'guardian', wv: 'wave' };
  /** @type {Record<string, import('../domain/alarmClockTemplates.js').AlarmClockTemplate | undefined>} */
  const templateOf = { ad: config.templates?.adhoc, fs: config.templates?.fleetSave, wv: config.templates?.wave };
  /** @type {Map<string, string[]>} series key → its live message ids (preview) */
  const idsBySeries = new Map();
  let scheduled = 0;
  let cancelled = 0;
  for (const kind of /** @type {const} */ (['fs', 'ad', 'fr', 'wv'])) {
    try {
      const { post, cancel } = planQueue({
        wanted: wanted[kind], queue: queueByKind[kind], gone: gone[kind],
        now, minDelaySec: NTFY_MIN_DELAY_SEC, maxDelaySec: NTFY_MAX_DELAY_SEC,
      });
      const cancelSet = new Set(cancel);
      for (const m of queueByKind[kind]) {
        if (m.time <= now || cancelSet.has(m.id)) continue;
        const k = `${kind}:${m.identity.key}`;
        idsBySeries.set(k, [...(idsBySeries.get(k) ?? []), m.id]);
      }
      // Migration: an old-format message at a time we are about to post would
      // ring twice — retire it in favour of the identified one.
      const postTimes = new Set(post.map((p) => p.fireAt));
      const retire = legacy.filter((m) => m.title === titles[kind] && postTimes.has(m.time)).map((m) => m.id);
      for (const order of post) {
        const id = order.identity;
        const k = `${kind}:${id.key}`;
        const look = renderReminder({
          kind, universeId, anchor: id.anchor, fireAt: order.fireAt,
          i: Math.max(0, id.plan.indexOf(id.slot)), total: id.plan.length,
          template: templateOf[kind], leg: legOf.get(k),
          coords: id.key.split(':').slice(0, 3).join(':'),
        });
        const msgId = await postReminder({
          topic, token: ntfyToken, fireAt: order.fireAt, now,
          title: look.title, body: look.body, priority: look.priority, icon: look.icon,
          click: clickUrlFor(universeId, id),
        });
        idsBySeries.set(k, [...(idsBySeries.get(k) ?? []), msgId]);
        scheduled++;
      }
      const toCancel = [...cancel, ...retire];
      if (toCancel.length) cancelled += await cancelReminders({ ids: toCancel, topic, token: ntfyToken });
    } catch (err) {
      failedKinds[failName[kind]] = err instanceof Error ? err.message : String(err);
      logger.warn(`alarmClock: ntfy reconcile failed for ${failName[kind]}`, err);
    }
  }
  if (scheduled > 0 || cancelled > 0) {
    // eslint-disable-next-line no-console
    console.log(`[oge] alarmClock reconciled: +${scheduled} queued, -${cancelled} cancelled`);
  }

  // ── Local bookkeeping + dashboard mirror ────────────────────────────
  for (const w of waves) {
    notifyState[w.id].scheduledMessageIds = idsBySeries.get(`wv:${waveKeyOf.get(w.id)}`) ?? [];
  }
  /** @type {Record<string, NotifyEntry>} */
  const adhocNotify = {};
  for (const e of adhoc) adhocNotify[e.id] = { scheduledMessageIds: idsBySeries.get(`ad:${e.id}`) ?? [] };
  /** @type {Record<string, NotifyEntry>} */
  const fleetSaveNotify = {};
  for (const e of fleetSave) fleetSaveNotify[e.id] = { scheduledMessageIds: idsBySeries.get(`fs:${e.id}`) ?? [] };

  /** @type {AlarmClockState} */
  const next = {
    version: ALARM_CLOCK_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    waves,
    notifyState,
    adhoc,
    adhocNotify,
    fleetSave,
    fleetSaveNotify,
  };
  const changed = !sameState(local, next);
  await mirrorForPreview(universeId, next, ntfyToken);
  return { ok: true, changed, scheduled, cancelled, fleetSave, landings, failedKinds };
};

/**
 * Two devices that see the same expedition wave may anchor it a little apart
 * (each locks the earliest return it saw first). Within this window a local
 * wave adopts the series already queued instead of scheduling its own.
 */
const WAVE_ADOPT_SEC = 180;

/**
 * This device's last alarm-clock state for a universe (wave grouping + their
 * anchors). Device-local: the shared state is the ntfy queue; this only keeps
 * wave identity stable between scans. Same record the dashboard mirror shows.
 *
 * @param {string} universeId
 * @returns {Promise<AlarmClockState | null>}
 */
const readLocalAlarmClock = async (universeId) => {
  try {
    const dict = await chromeStore.get(ALARM_CLOCK_MIRROR_KEY);
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return null;
    const s = /** @type {Record<string, AlarmClockState>} */ (dict)[universeId];
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
};
