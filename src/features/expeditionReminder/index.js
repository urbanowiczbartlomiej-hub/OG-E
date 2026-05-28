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
// pushes the result into the gist's `oge-reminders.json`
// (`sync/reminders.syncReminderWaves`). From there the Cloudflare Worker
// takes over the timing entirely; this feature does NOT keep watch after
// the write.
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
//   - reminder-config change — forces one push so enabling/disabling, a
//     new ntfy topic, changed hours, etc. reach the gist immediately
//     (and thus the Worker) without waiting for the next event refresh.
//
// Both go through a short debounce so a burst of refreshes coalesces.
//
// @see ../../domain/waves.js     — clustering (pure)
// @see ../../sync/reminders.js   — gist IO + reconcile + preview mirror
// @see ../../state/reminderConfig.js — the global config store

import { clusterWaves, DEFAULT_CLUSTER_GAP_SECONDS } from '../../domain/waves.js';
import { settingsStore } from '../../state/settings.js';
import { syncReminderWaves } from '../../sync/reminders.js';
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
 *   - `fleetId` — the numeric suffix of the row's `eventRow-<id>` id.
 *   - `returnAt` — `data-arrival-time` parsed as an integer (epoch s).
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
    const fleetId = (row.id || '').replace(/^eventRow-/, '');
    const coordsText = row.querySelector('.coordsOrigin')?.textContent || '';
    const origin = coordsText.replace(/[\s[\]]/g, '');
    out.push({ fleetId, returnAt, origin });
  }
  return out;
};

/**
 * Compact signature of a wave set — id + nextWaveAt per wave. Two sets
 * with the same signature need no gist write (the reconcile would be a
 * no-op). Sorted by id so ordering noise from the DOM doesn't produce a
 * spurious mismatch.
 *
 * @param {import('../../domain/waves.js').Wave[]} waves
 * @returns {string}
 */
const signatureOf = (waves) =>
  JSON.stringify(
    waves.map((w) => [w.id, w.nextWaveAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

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
    const config = { enabled: s.reminderEnabled, ntfyToken: s.reminderNtfyToken };
    // Dormant when off — unless a settings change is forcing a push
    // (e.g. the user just toggled it off and we must cancel scheduled
    // ntfys).
    if (!config.enabled && !force) return;

    const waves = clusterWaves(extractReturnEntries(), { gapSeconds: DEFAULT_CLUSTER_GAP_SECONDS });
    const sig = signatureOf(waves);
    if (sig === lastSig && !force) return;

    const now = Math.floor(Date.now() / 1000);
    const universeId = parseUniverseId(location.host);
    const res = await syncReminderWaves(config, waves, now, universeId);
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
    JSON.stringify({ e: s.reminderEnabled, t: s.reminderNtfyToken });
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
