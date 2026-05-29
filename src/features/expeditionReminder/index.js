// @ts-check

// Expedition-reminder feature — the producer side of the push-reminder
// system.
//
// # What it does
//
// Whenever OGame's event box refreshes (`oge:eventBoxLoaded`, fired by
// `bridges/eventBoxHook.js`), this feature reads the expedition
// return-flight rows out of `#eventContent` — exactly the passive DOM
// read the badge feature does (see `features/badges.js`), no traffic to
// the game — clusters them into waves (`domain/waves.clusterWaves`), and
// hands them to `sync/reminders.syncReminderWaves`. That reconciles the
// per-universe reminder file in the gist AND this universe's slice of the
// ntfy.sh scheduled queue. ntfy holds the delayed pushes server-side and
// fires them on time; this feature does NOT keep watch after the sync.
//
// # Why it almost never calls the API
//
// A wave set is stable for the whole ~16-minute flight. We keep the
// last-pushed signature (ids + nextWaveAt) in memory and skip the gist
// round-trip whenever the current signature matches. So the gist is only
// touched when something genuinely changed: a fresh send, a re-send
// (returns jump forward), or all fleets landing (waves drop to zero).
// That keeps us comfortably inside GitHub's rate budget even though the
// event box refreshes often.
//
// # Triggers
//
//   - `oge:eventBoxLoaded` — the main driver. Skipped entirely while the
//     feature is disabled (no DOM read, no API).
//   - reminder-config change — forces one sync so enabling/disabling or
//     an ntfy-token edit reaches ntfy immediately (cancel the queue on
//     disable, repopulate it on enable) without waiting for an event refresh.
//
// Both go through a short debounce so a burst of refreshes coalesces.
//
// @see ../../domain/waves.js     — clustering (pure)
// @see ../../sync/reminders.js   — gist IO + reconcile + preview mirror
// @see ../../state/reminderConfig.js — the global config store

import { clusterWaves, DEFAULT_CLUSTER_GAP_SECONDS } from '../../domain/waves.js';
/** @typedef {import('../../domain/waves.js').WaveCandidate} WaveCandidate */
import { settingsStore } from '../../state/settings.js';
import { syncReminders } from '../../sync/reminders.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { debounce } from '../../lib/debounce.js';

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

/** Idempotency sentinel — holds the dispose fn while installed. */
/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the expedition-reminder producer. Idempotent — a second call
 * while installed returns the existing dispose fn.
 *
 * @returns {() => void} Dispose: removes the event listener, unsubscribes
 *   from the config store, and clears the install sentinel.
 */
export const installExpeditionReminder = () => {
  if (installed) return installed;

  // Last wave-set signature we successfully pushed. Reset to '' on
  // install so the first trigger after a page load always pushes once
  // (re-affirming state, refreshing the preview mirror, and re-keeping
  // any idle waves that dropped out of the event box while we were away).
  let lastSig = '';
  // Set by the config-change handler to force the next run past the
  // signature short-circuit, so config edits always reach the gist.
  let pendingForce = false;

  const run = async () => {
    const force = pendingForce;
    pendingForce = false;
    const s = settingsStore.get();
    const config = {
      enabled: s.reminderEnabled,
      adhocEnabled: s.adhocEnabled,
      ntfyToken: s.reminderNtfyToken,
      schedule: s.reminderSchedule,
    };
    // Dormant only when BOTH kinds are off — unless a settings change is
    // forcing a push (e.g. the user just toggled one off and we must
    // sweep its scheduled ntfys).
    if (!config.enabled && !config.adhocEnabled && !force) return;

    const candidates = clusterWaves(extractReturnEntries(), { gapSeconds: DEFAULT_CLUSTER_GAP_SECONDS });
    const present = extractPresentFleets();
    const sig = signatureOf(candidates, present);
    if (sig === lastSig && !force) return;

    const now = Math.floor(Date.now() / 1000);
    const universeId = parseUniverseId(location.host);
    const res = await syncReminders(config, { waveCandidates: candidates, present }, now, universeId);
    // Only advance the cached signature on a successful push. A failed
    // attempt (e.g. no token, rate-limited) leaves lastSig stale so the
    // next trigger retries instead of silently skipping.
    if (res.ok) lastSig = sig;
  };

  const scheduleRun = debounce(() => { void run(); }, DEBOUNCE_MS);

  const onEventBox = () => scheduleRun();
  document.addEventListener('oge:eventBoxLoaded', onEventBox);

  // Force a push on any reminder-setting change so enable/disable
  // and token edits in the in-game Settings panel propagate immediately
  // (cancel scheduled messages on disable, schedule them on enable).
  /** @param {ReturnType<typeof settingsStore.get>} s */
  const pickReminderSig = (s) =>
    JSON.stringify({
      e: s.reminderEnabled, t: s.reminderNtfyToken, s: s.reminderSchedule,
      a: s.adhocEnabled,
    });
  let prevReminderSig = pickReminderSig(settingsStore.get());
  const unsubConfig = settingsStore.subscribe((next) => {
    const sig = pickReminderSig(next);
    if (sig === prevReminderSig) return;
    prevReminderSig = sig;
    pendingForce = true;
    scheduleRun();
  });

  // Initial pass: the event box may already be populated when we install
  // (we run at DOMContentLoaded; the eventbox XHR sometimes lands first).
  scheduleRun();

  installed = () => {
    document.removeEventListener('oge:eventBoxLoaded', onEventBox);
    unsubConfig();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset for the module-scope install sentinel.
 *
 * @returns {void}
 */
export const _resetExpeditionReminderForTest = () => {
  if (installed) installed();
  installed = null;
};
