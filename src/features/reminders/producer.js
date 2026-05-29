// @ts-check

// Reminder producer — the single game-side writer of this universe's
// reminder state, and the driver behind both notification kinds.
//
// # What it does
//
// Whenever OGame's event box refreshes (`oge:eventBoxLoaded`, fired by
// `bridges/eventBoxHook.js`), this module reads `#eventContent` — exactly
// the passive DOM read the badge feature does (see `features/badges.js`),
// no traffic to the game — and hands `sync/reminders.syncReminders`:
//
//   - the clustered expedition return-flight WAVES (auto-detected), and
//   - every present fleet leg (`{ id, arrivalAt }`), so the AD-HOC
//     reconcile can drop reminders whose row has vanished.
//
// `syncReminders` reconciles the per-universe gist file AND this
// universe's slice of the ntfy.sh queue (one message per future slot),
// for both kinds, in a single read-modify-write. ntfy holds the delayed
// pushes server-side; this module does NOT keep watch after the sync.
//
// # Arm / disarm / cancel
//
// The event-list UI (`./eventList.js`) doesn't touch the gist itself — it
// calls the {@link installReminderProducer} API (`armAdhoc`, `disarmAdhoc`,
// `cancelWave`). Each enqueues a mutation and forces the next debounced
// run, so EVERY gist write goes through this one producer: a single writer
// means the wave and ad-hoc slices can never clobber each other. A
// mutation whose sync fails is re-queued (never silently lost).
//
// # Why it almost never calls the API
//
// We keep the last-synced scan signature (wave return-times + present-leg
// ids/arrivals) in memory and skip the gist round-trip whenever it
// matches. So the gist is only touched when something genuinely changed: a
// send, a re-send, a landing, a fleet recalled — or a user arm/disarm
// (which forces a run regardless). Comfortably inside GitHub's rate budget.
//
// # Triggers
//
//   - `oge:eventBoxLoaded` — the main driver. Dormant only while BOTH
//     kinds are disabled.
//   - reminder-setting change — forces one sync so a toggle/token edit
//     reaches ntfy immediately.
//   - arm/disarm/cancel — forces one sync carrying the mutation.
//
// All go through a short debounce so a burst coalesces.
//
// @see ../../domain/waves.js     — wave clustering (pure)
// @see ../../domain/adhoc.js     — ad-hoc reconcile (pure)
// @see ../../sync/reminders.js   — gist IO + reconcile + preview mirror
// @see ./eventList.js            — the event-list badge UI (API consumer)

import { clusterWaves, DEFAULT_CLUSTER_GAP_SECONDS } from '../../domain/waves.js';
/** @typedef {import('../../domain/waves.js').WaveCandidate} WaveCandidate */
/** @typedef {import('../../domain/waves.js').Wave} Wave */
/** @typedef {import('../../domain/adhoc.js').AdhocReminder} AdhocReminder */
import { settingsStore } from '../../state/settings.js';
import { syncReminders } from '../../sync/reminders.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { debounce } from '../../lib/debounce.js';
import { safeLS } from '../../lib/storage.js';
import {
  readPending, writePending, pushPending, applyAdhocCmds, applyWaveCmds,
} from './pending.js';

/**
 * Selector for expedition return-flight rows. Identical predicate to the
 * badge feature: own expedition mission (`15`) on its way home
 * (`return-flight="true"`). One such row exists per in-flight
 * expedition, carrying the home-return epoch in `data-arrival-time`.
 */
const RETURN_ROW_SELECTOR =
  '#eventContent tr.eventFleet[data-mission-type="15"][data-return-flight="true"]';

/**
 * Debounce window for the sync runner. Long enough to coalesce a burst
 * of event-box refreshes, short enough that a send registers promptly.
 */
const DEBOUNCE_MS = 1500;

/**
 * @typedef {import('../../domain/waves.js').ReturnEntry} ReturnEntry
 */

/**
 * Extract expedition return-flights from a DOM root. Pure-ish: reads the
 * DOM but holds no state and returns a fresh array, so it can be unit
 * tested against a happy-dom fixture (see the matching test).
 *
 *   - `returnAt` — `data-arrival-time` parsed as an integer (epoch s).
 *     Doubles as the wave-identity carrier (see `domain/waves.js`).
 *   - `origin` — `.coordsOrigin` text with brackets/whitespace stripped
 *     to a dense `"g:s:p"` (matches the coord normalisation badges uses).
 *
 * @param {ParentNode} [root=document]
 * @returns {ReturnEntry[]}
 */
export const extractReturnEntries = (root = document) => {
  /** @type {ReturnEntry[]} */
  const out = [];
  for (const row of root.querySelectorAll(RETURN_ROW_SELECTOR)) {
    const arrivalAttr = row.getAttribute('data-arrival-time');
    const returnAt = arrivalAttr ? parseInt(arrivalAttr, 10) : NaN;
    const coordsText = row.querySelector('.coordsOrigin')?.textContent || '';
    const origin = coordsText.replace(/[\s[\]]/g, '');
    out.push({ returnAt, origin });
  }
  return out;
};

/**
 * Selector for every fleet leg currently in the event list — one
 * `<tr class="eventFleet" id="eventRow-<n>">` per in-flight leg (any
 * mission, any direction). The `eventRow-` id prefix is the stable
 * per-leg identity ad-hoc reminders key on; `data-arrival-time` is the
 * leg's arrival epoch.
 */
const PRESENT_ROW_SELECTOR = '#eventContent tr.eventFleet[id^="eventRow-"]';

/**
 * Extract every present fleet leg as `{ id, arrivalAt }` — the
 * authoritative "what exists right now" set the ad-hoc reconcile matches
 * armed reminders against (vanished ⇒ the reminder is dropped). Pure-ish
 * DOM read, same passive style as {@link extractReturnEntries}.
 *
 * @param {ParentNode} [root=document]
 * @returns {import('../../domain/adhoc.js').PresentFleet[]}
 */
export const extractPresentFleets = (root = document) => {
  /** @type {import('../../domain/adhoc.js').PresentFleet[]} */
  const out = [];
  for (const row of root.querySelectorAll(PRESENT_ROW_SELECTOR)) {
    const id = /** @type {HTMLElement} */ (row).id;
    const arrivalAttr = row.getAttribute('data-arrival-time');
    const arrivalAt = arrivalAttr ? parseInt(arrivalAttr, 10) : NaN;
    if (id && Number.isFinite(arrivalAt)) out.push({ id, arrivalAt });
  }
  return out;
};

/**
 * Compact signature of one scan — the wave-candidate return-times plus
 * the present fleet legs (id + arrival). Two scans with the same
 * signature need no gist round-trip (the reconcile would be a no-op).
 *
 * The wave half uses `returnAts` because the reconcile matches on
 * return-time overlap. The present half (`id:arrivalAt` per leg) makes a
 * fleet appearing / landing / being recalled — which moves the ad-hoc
 * cleanup — trigger a sync too. Both halves are sorted so DOM ordering
 * noise doesn't produce a spurious mismatch.
 *
 * @param {WaveCandidate[]} candidates
 * @param {import('../../domain/adhoc.js').PresentFleet[]} present
 * @returns {string}
 */
const signatureOf = (candidates, present) =>
  JSON.stringify({
    w: candidates.map((c) => c.returnAts).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
    p: present.map((f) => `${f.id}:${f.arrivalAt}`).sort(),
  });

/** localStorage key for the persisted last-successful scan signature. */
const sigKeyFor = (/** @type {string} */ universeId) => `oge_reminderSig_${universeId}`;

/**
 * The producer's public handle: a dispose fn plus the event-list actions.
 * Each action persists its intent to localStorage (reload-safe, see
 * `./pending.js`) and forces the next sync.
 *
 * @typedef {object} ReminderProducer
 * @property {() => void} dispose
 * @property {(entry: AdhocReminder) => void} armAdhoc    Arm (or re-arm) a fleet leg.
 * @property {(id: string) => void} disarmAdhoc           Cancel an armed leg.
 * @property {(waveId: string) => void} cancelWave        Tombstone an expedition wave.
 * @property {(waveId: string) => void} resendWave        Re-schedule a tombstoned wave's series.
 */

/** Idempotency sentinel — holds the producer handle while installed. */
/** @type {ReminderProducer | null} */
let installed = null;

/**
 * Install the reminder producer. Idempotent — a second call while
 * installed returns the existing handle.
 *
 * @param {{ onSynced?: () => void }} [opts]  `onSynced` is called after every
 *   run (success or failure) — a reliable same-tab signal for the event-list
 *   UI to re-read the freshly-written mirror, instead of depending on
 *   `chrome.storage.onChanged` firing in the writer's own context.
 * @returns {ReminderProducer}
 */
export const installReminderProducer = (opts = {}) => {
  if (installed) return installed;
  const onSynced = opts.onSynced;

  const universeId = parseUniverseId(location.host);

  // Last scan signature we successfully synced — PERSISTED in localStorage
  // (per universe) so a reload whose event list is unchanged skips the
  // whole gist + ntfy round-trip. OGame reloads on every click, so without
  // this every click would re-sync. A failed sync never advances it, so
  // the next load retries; the pending queue + settings edits force a run
  // regardless.
  let lastSig = safeLS.get(sigKeyFor(universeId)) || '';
  // Forces the next run past the signature short-circuit (settings edits;
  // a queued user action is detected separately, below).
  let pendingForce = false;

  const run = async () => {
    const forceSettings = pendingForce;
    pendingForce = false;

    // Snapshot the persisted intent queue. Its length lets us clear ONLY
    // what we drained after a successful sync — anything the user clicks
    // during the await stays queued for the next run.
    const pending = readPending(universeId);
    const force = forceSettings || pending.length > 0;

    const s = settingsStore.get();
    const config = {
      masterEnabled: s.remindersMasterEnabled,
      enabled: s.reminderEnabled,
      adhocEnabled: s.adhocEnabled,
      ntfyToken: s.reminderNtfyToken,
      schedule: s.reminderSchedule,
    };
    // Dormant unless the master switch is on AND at least one kind is — or
    // something forces a push (a settings toggle we must act on, e.g. the
    // master just went off and we must sweep, or a queued user action).
    const anyActive = config.masterEnabled && (config.enabled || config.adhocEnabled);
    if (!anyActive && !force) return;

    const candidates = clusterWaves(extractReturnEntries(), { gapSeconds: DEFAULT_CLUSTER_GAP_SECONDS });
    const present = extractPresentFleets();
    const sig = signatureOf(candidates, present);
    if (sig === lastSig && !force) return;

    const adhocCmds = pending.filter((c) => c.kind === 'arm' || c.kind === 'disarm');
    const waveCmds = pending.filter((c) => c.kind === 'cancelWave' || c.kind === 'resendWave');
    const adhocMutate = adhocCmds.length
      ? (/** @type {AdhocReminder[]} */ entries) => applyAdhocCmds(entries, adhocCmds)
      : undefined;
    const waveMutate = waveCmds.length
      ? (/** @type {Wave[]} */ waves) => applyWaveCmds(waves, waveCmds)
      : undefined;

    const now = Math.floor(Date.now() / 1000);
    try {
      const res = await syncReminders(
        config, { waveCandidates: candidates, present, adhocMutate, waveMutate }, now, universeId,
      );
      if (res.ok) {
        lastSig = sig;
        safeLS.set(sigKeyFor(universeId), sig);
        // Drop the commands we applied; keep any the user queued meanwhile.
        writePending(universeId, readPending(universeId).slice(pending.length));
      } else {
        // Leave the pending queue intact and re-try on the next trigger.
        pendingForce = true;
      }
    } catch {
      // Network / gist error — keep pending, retry next trigger.
      pendingForce = true;
    } finally {
      // Tell the UI to re-read the (possibly just-written) mirror — reliable
      // in-tab signal, independent of chrome.storage.onChanged.
      if (onSynced) onSynced();
    }
  };

  const scheduleRun = debounce(() => { void run(); }, DEBOUNCE_MS);

  const force = () => { pendingForce = true; scheduleRun(); };

  /** @param {AdhocReminder} entry */
  const armAdhoc = (entry) => { pushPending(universeId, { kind: 'arm', entry }); force(); };
  /** @param {string} id */
  const disarmAdhoc = (id) => { pushPending(universeId, { kind: 'disarm', id }); force(); };
  /** @param {string} waveId */
  const cancelWave = (waveId) => { pushPending(universeId, { kind: 'cancelWave', waveId }); force(); };
  /** @param {string} waveId */
  const resendWave = (waveId) => { pushPending(universeId, { kind: 'resendWave', waveId }); force(); };

  const onEventBox = () => scheduleRun();
  document.addEventListener('oge:eventBoxLoaded', onEventBox);

  // Force a push on any reminder-setting change so toggle/token edits in
  // the in-game Settings panel propagate immediately.
  /** @param {ReturnType<typeof settingsStore.get>} s */
  const pickReminderSig = (s) =>
    JSON.stringify({
      m: s.remindersMasterEnabled,
      e: s.reminderEnabled, t: s.reminderNtfyToken, s: s.reminderSchedule,
      a: s.adhocEnabled,
    });
  let prevReminderSig = pickReminderSig(settingsStore.get());
  const unsubConfig = settingsStore.subscribe((next) => {
    const sig = pickReminderSig(next);
    if (sig === prevReminderSig) return;
    prevReminderSig = sig;
    force();
  });

  // Initial pass: the event box may already be populated when we install,
  // and a reload may have left a pending intent to finish.
  scheduleRun();

  installed = {
    dispose: () => {
      document.removeEventListener('oge:eventBoxLoaded', onEventBox);
      unsubConfig();
      installed = null;
    },
    armAdhoc,
    disarmAdhoc,
    cancelWave,
    resendWave,
  };
  return installed;
};

/**
 * Test-only reset for the module-scope install sentinel.
 *
 * @returns {void}
 */
export const _resetReminderProducerForTest = () => {
  if (installed) installed.dispose();
  installed = null;
};
