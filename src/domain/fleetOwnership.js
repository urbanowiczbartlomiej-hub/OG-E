// @ts-check
//
// Pure ownership logic for the fleetdispatch fleet1→fleet2 transition (T5).
//
// The problem this solves: the game keeps ONE global fleet2 state, and every
// OG-E button can see it. A button that did NOT initiate the transition (the
// player armed an attack by hand, AGR's routine-7 prepared an expedition,
// another OG-E button's tap-1 ran select()) could still "complete" it —
// dispatching a fleet composition and mission it is not responsible for.
//
// The model: whoever performs the fleet1→fleet2 transition claims an
// in-memory OWNERSHIP SESSION (page-scoped — a reload resets both the game's
// form and our session, so no persistence is wanted). A button may complete
// fleet2 only when:
//   • the session is its own (normal two-tap flow, incl. re-entry retries), or
//   • there is NO session and the last observed checkTarget matches the
//     EXPEDITION PROFILE — then only the expedition button may adopt it.
//     This covers AGR routine-7, which builds fleet2 outside our courier so
//     no session exists; the game still fires checkTarget on the transition
//     and its request body carries the fleet composition (`am<id>=<count>`).
// Everything else is foreign: the button must not touch it and should send
// the player to a bare fleetdispatch instead (a clean fleet1 to start from).
//
// This module is pure: plain functions over plain data, no DOM, no timers.
// The stateful side (listening to oge:checkTargetResult, holding the session)
// lives in features/shared/fleetOwnership.js.

import { SHIP_PATHFINDER } from './rules.js';

/** Expeditions are the only mission that targets slot 16 of a system. */
export const EXPEDITION_POSITION = 16;

/**
 * Ownership identities. Deliberately a closed vocabulary owned by the domain
 * (not free-form feature names): resolveFleet2Completion encodes a rule about
 * WHO may adopt an expedition fleet2, so the ids it compares against must be
 * stable domain values, not strings scattered across features.
 */
export const OWNER_EXP = 'exp';
export const OWNER_COL = 'col';
export const OWNER_FS = 'fs';
export const OWNER_SPY = 'spy';

/**
 * @typedef {object} OwnershipSession
 * @property {string} owner One of the OWNER_* ids.
 */

/**
 * @typedef {object} CheckTargetObservation
 * @property {number} position Target position from the request body.
 * @property {Record<number, number> | null} ships Fleet composition from the
 *   request body's `am<id>=<count>` pairs; `null` when the body had none
 *   (the game omits them when no ships are selected).
 */

/**
 * Does a checkTarget observation look like an expedition dispatch?
 *
 * Rule (calibrated with the user, sessions 9): AGR's routine-7 always sends
 * to position 16 and always includes at least one Pathfinder. Position 16 is
 * not a valid target for any other OG-E flow, so the pair is practically
 * unambiguous. Cargo ships are usually present too, but are NOT required —
 * requiring them would only add a way to fail closed on unusual configs.
 *
 * @param {CheckTargetObservation | null | undefined} ct
 * @returns {boolean}
 */
export const isExpeditionCheckTarget = (ct) => {
  if (!ct || ct.position !== EXPEDITION_POSITION) return false;
  const ships = ct.ships;
  if (!ships) return false;
  return (ships[SHIP_PATHFINDER] || 0) >= 1;
};

/**
 * Decide whether `claimant` may complete the CURRENT fleet2 state.
 *
 * @param {OwnershipSession | null} session Active ownership session, or
 *   `null` when nobody claimed the transition (manual play, AGR routine,
 *   or a flow that predates this page's scripts).
 * @param {CheckTargetObservation | null} lastCheckTarget Most recent
 *   checkTarget observed on this page, or `null` when none fired yet.
 * @param {string} claimant OWNER_* id of the button asking.
 * @returns {{ allowed: boolean,
 *   holder: 'self' | 'expedition' | 'unknown' | string }}
 *   `holder` names who the fleet2 belongs to: `'self'` (proceed), the owning
 *   session's id (another OG-E button), `'expedition'` (session-less
 *   routine-7 profile), or `'unknown'` (session-less, non-expedition —
 *   assume the player's own manual send and keep hands off).
 */
export const resolveFleet2Completion = (session, lastCheckTarget, claimant) => {
  if (session) {
    return session.owner === claimant
      ? { allowed: true, holder: 'self' }
      : { allowed: false, holder: session.owner };
  }
  if (isExpeditionCheckTarget(lastCheckTarget)) {
    return { allowed: claimant === OWNER_EXP, holder: 'expedition' };
  }
  return { allowed: false, holder: 'unknown' };
};
