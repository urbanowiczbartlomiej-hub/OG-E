// @ts-check
//
// ISOLATED-world holder of the fleet2 ownership session (T5).
//
// Pure decisions live in domain/fleetOwnership.js; this module owns the two
// pieces of page-scoped state they need:
//   • the active ownership session — claimed by whoever performs the
//     fleet1→fleet2 transition (the courier's select(), or sendExpedition when it
//     clicks AGR's routine-7), and
//   • the last checkTarget observation (coords + fleet composition), fed by
//     the oge:checkTargetResult bridge event.
//
// Both are deliberately in-memory only: a page reload resets the game's
// fleetdispatch form to step 1, so persisting a session would only let a
// stale claim outlive the state it described.

import { resolveFleet2Completion } from '../../domain/fleetOwnership.js';
import { CHECK_TARGET_RESULT_EVENT } from '../../lib/ogeEvents.js';

/** @type {import('../../domain/fleetOwnership.js').OwnershipSession | null} */
let session = null;

/** @type {import('../../domain/fleetOwnership.js').CheckTargetObservation | null} */
let lastCheckTarget = null;

/** @type {((e: Event) => void) | null} */
let onCheckTarget = null;

/**
 * Start observing checkTarget results. Idempotent; safe to call from every
 * consumer's install (the courier, sendExpedition) — only the first call attaches.
 *
 * @returns {void}
 */
export const installFleetOwnership = () => {
  if (onCheckTarget) return;
  onCheckTarget = (e) => {
    const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
    if (!d || typeof d.position !== 'number') return;
    lastCheckTarget = {
      position: d.position,
      ships: d.ships && typeof d.ships === 'object' ? d.ships : null,
    };
  };
  document.addEventListener(CHECK_TARGET_RESULT_EVENT, onCheckTarget);
};

/**
 * Claim the fleet2 state for `owner`. Call at the moment the owner initiates
 * the fleet1→fleet2 transition. Overwrites any previous claim — by then the
 * game has already rebuilt fleet2 for the new initiator, so the old session
 * describes a state that no longer exists.
 *
 * @param {string} owner One of the domain OWNER_* ids.
 * @returns {void}
 */
export const claimFleet2 = (owner) => {
  session = { owner };
};

/**
 * May `claimant` complete the current fleet2 state? See
 * domain/fleetOwnership.js for the decision table.
 *
 * @param {string} claimant One of the domain OWNER_* ids.
 * @returns {{ allowed: boolean, holder: string }}
 */
export const mayCompleteFleet2 = (claimant) =>
  resolveFleet2Completion(session, lastCheckTarget, claimant);

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetFleetOwnershipForTest = () => {
  if (onCheckTarget) document.removeEventListener(CHECK_TARGET_RESULT_EVENT, onCheckTarget);
  onCheckTarget = null;
  session = null;
  lastCheckTarget = null;
};
