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
      document.querySelector(GAME.FD_DISPATCH) && document.getElementById('ago_fleet2_main')
        ? true
        : null,
    { timeoutMs: ROUTINE_POLL_TIMEOUT_MS, intervalMs: ROUTINE_POLL_INTERVAL_MS },
  );
  return ready ? 'prepared' : 'timeout';
};

/**
 * Phase 1 — the fleet2 panel + native dispatch are already up. Verify the
 * ownership session belongs to `owner`, then fire the dispatch.
 *
 *   - `'sent'`     — dispatch clicked.
 *   - `'foreign'`  — fleet2 belongs to someone else; the caller should bail
 *     (e.g. restart from a bare fleetdispatch) rather than send.
 *   - `'notReady'` — the dispatch control / fleet2 panel isn't actually there.
 *
 * @param {{ owner: string }} opts
 * @returns {'sent' | 'foreign' | 'notReady'}
 */
export const dispatchPrepared = ({ owner }) => {
  const dispatch = document.querySelector(GAME.FD_DISPATCH);
  const fleetPanel = document.getElementById('ago_fleet2_main');
  if (!dispatch || !fleetPanel) return 'notReady';
  if (!mayCompleteFleet2(owner).allowed) return 'foreign';
  safeClick(dispatch);
  return 'sent';
};
