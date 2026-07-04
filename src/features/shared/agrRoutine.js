// @ts-check
//
// Shared AGR-routine dispatch primitives — the fleet1 "click AGR's routine,
// wait for it to transition to fleet2, then fire the native dispatch" sequence,
// parametrised by routine id (7 = expeditions, 6 = fleet save) and the
// ownership owner. Both sendExpedition and the bare-fleet guardian drive AGR the
// same way; a feature cannot import another feature, so the common steps live
// here in shared/.
//
// What stays with each caller: the LABELS, the navigation, and the per-feature
// gates. This module owns only the AGR/native mechanics + the ownership claim.
//
// @see ../sendExpedition/index.js — routine 7 (expeditions).
// @see ../alarmClock/guardian.js   — routine 6 (fleet save).

import { GAME } from '../../lib/gameDom.js';
import { safeClick, waitFor } from '../../lib/dom.js';
import { claimFleet2, mayCompleteFleet2 } from './fleetOwnership.js';

/** How long to wait for AGR's routine / the dispatch control (ms). */
export const ROUTINE_POLL_TIMEOUT_MS = 15_000;
/** Poll gap while waiting (ms). */
export const ROUTINE_POLL_INTERVAL_MS = 300;

/**
 * Classify why a routine wait gave up. `'absent'` = the `#ago_routine_N`
 * element isn't in the DOM ⇒ AGR's routine is disabled in fleet settings
 * (actionable: tell the user to enable it). `'timeout'` = present but never
 * became ready ⇒ a transient hiccup; stay quiet and let the user retry.
 *
 * @param {boolean} hasRoutineEl  whether `#ago_routine_N` exists right now.
 * @returns {'absent' | 'timeout'}
 */
export const classifyRoutineFailure = (hasRoutineEl) =>
  hasRoutineEl ? 'timeout' : 'absent';

/**
 * Phase 2 — prepare a fleet via AGR routine `routineId`, starting from fleet1.
 * Waits for the routine's `.ago_routine_check`; when it reads "ready"
 * (`ago_routine_check_3`) it claims ownership for `owner`, clicks the routine to
 * drive AGR's fleet1→fleet2 transition, and waits for the native dispatch
 * control + AGR's fleet2 panel to render. Resolves a tagged outcome the caller
 * maps to its own labels.
 *
 *   - `'prepared'`   — fleet2 is up; the caller's next tap can dispatch.
 *   - `'noShips'`    — routine present but `_check_1`/`_check_2` (nothing to
 *     send). Only possible with `requireCheckReady` (expeditions).
 *   - `'routineOff'` — `#ago_routine_N` absent ⇒ the AGR routine is disabled.
 *   - `'timeout'`    — present but never became ready in time.
 *
 * `requireCheckReady` (default true) gates the click on AGR's expedition-style
 * `.ago_routine_check` widget reading `_check_3` (ready). Routines WITHOUT that
 * widget — fleet save (6) — pass `false`: the routine is clickable as soon as
 * its element exists, and whether AGR then transitions to fleet2 is the real
 * readiness signal (a no-fleet body just never reaches fleet2 ⇒ `'timeout'`).
 *
 * @param {{ routineId: number, owner: string, requireCheckReady?: boolean }} opts
 * @returns {Promise<'prepared' | 'noShips' | 'routineOff' | 'timeout'>}
 */
export const prepareViaRoutine = async ({ routineId, owner, requireCheckReady = true }) => {
  const id = `ago_routine_${routineId}`;
  const routine = await waitFor(
    () => {
      const el = document.getElementById(id);
      if (!el) return null;
      // With the expedition-style check widget, wait for it to exist; without
      // one (fleet save), the routine element's mere presence means "ready".
      return requireCheckReady ? (el.querySelector('.ago_routine_check') ? el : null) : el;
    },
    { timeoutMs: ROUTINE_POLL_TIMEOUT_MS, intervalMs: ROUTINE_POLL_INTERVAL_MS },
  );

  if (!routine) {
    return classifyRoutineFailure(document.getElementById(id) !== null) === 'absent'
      ? 'routineOff'
      : 'timeout';
  }

  if (requireCheckReady) {
    const check = routine.querySelector('.ago_routine_check');
    // Anything other than the "ready" state (`_check_3`) means no fillable fleet.
    if (!check?.classList.contains('ago_routine_check_3')) return 'noShips';
  }

  // Ready. Claim BEFORE the transition so the follow-up dispatch tap passes the
  // ownership gate. The 50 ms second click shakes loose a half-idled AGR.
  claimFleet2(owner);
  safeClick(routine);
  setTimeout(() => safeClick(routine), 50);

  const ready = await waitFor(
    () =>
      document.querySelector(GAME.FD_DISPATCH) && document.getElementById(GAME.AGO_FLEET2_MAIN)
        ? true
        : null,
    { timeoutMs: ROUTINE_POLL_TIMEOUT_MS, intervalMs: ROUTINE_POLL_INTERVAL_MS },
  );
  return ready ? 'prepared' : 'timeout';
};

/**
 * Whether the native dispatch control is genuinely sendable right now: it
 * exists, the game has cleared its not-ready `.off` class, AND AGR's fleet2
 * panel is up. Mirrors `fleetCourier.readyToDispatch()`'s `.off` check (kept
 * inline to avoid a shared↔shared import cycle) plus the panel guard. A `.off`
 * dispatch is in the DOM but disabled — clicking it is a no-op server-side, so
 * treating "present" as "ready" is the bug this guards against.
 *
 * @returns {boolean}
 */
const dispatchReady = () => {
  const dispatch = document.querySelector(GAME.FD_DISPATCH);
  return (
    !!dispatch &&
    !dispatch.classList.contains(GAME.FD_DISABLED_CLASS) &&
    document.getElementById(GAME.AGO_FLEET2_MAIN) !== null
  );
};

/**
 * Phase 1 — the fleet2 panel + native dispatch are already up. Verify the
 * ownership session belongs to `owner`, then fire the dispatch.
 *
 *   - `'sent'`     — dispatch clicked.
 *   - `'foreign'`  — fleet2 belongs to someone else; the caller should bail
 *     (e.g. restart from a bare fleetdispatch) rather than send.
 *   - `'notReady'` — the dispatch control / fleet2 panel isn't actually there
 *     yet, OR the control is present but still `.off` (AGR is mid-fill). A tap
 *     here must NOT report success: clicking a `.off` button launches nothing.
 *
 * @param {{ owner: string }} opts
 * @returns {'sent' | 'foreign' | 'notReady'}
 */
export const dispatchPrepared = ({ owner }) => {
  if (!dispatchReady()) return 'notReady';
  if (!mayCompleteFleet2(owner).allowed) return 'foreign';
  safeClick(document.querySelector(GAME.FD_DISPATCH));
  return 'sent';
};

/**
 * Phase 1, patient variant — send as soon as the native dispatch is truly
 * ready. Fires immediately when {@link dispatchPrepared} already can; otherwise
 * the control is present-but-`.off` (AGR still filling the fleet), so it polls
 * until the game clears `.off`, then sends. This makes a single tap on a loaded
 * fleet2 always launch, even when tapped mid-fill — the high-volume case where
 * an eager tap used to hit a `.off` button and silently do nothing.
 *
 *   - `'sent'` / `'foreign'` — as {@link dispatchPrepared}.
 *   - `'timeout'`            — never became sendable within the poll window.
 *
 * @param {{ owner: string }} opts
 * @returns {Promise<'sent' | 'foreign' | 'timeout'>}
 */
export const dispatchWhenReady = async ({ owner }) => {
  const r = dispatchPrepared({ owner });
  if (r !== 'notReady') return r;

  const ready = await waitFor(() => (dispatchReady() ? true : null), {
    timeoutMs: ROUTINE_POLL_TIMEOUT_MS,
    intervalMs: ROUTINE_POLL_INTERVAL_MS,
  });
  if (!ready) return 'timeout';

  const after = dispatchPrepared({ owner });
  // A `.off`→ready transition can't reintroduce 'notReady'; if it somehow does
  // (control yanked between poll and click), surface it as a quiet timeout.
  return after === 'notReady' ? 'timeout' : after;
};
